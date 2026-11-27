import "server-only";
import type { PoolClient } from "pg";
import type { AuthenticatedUser } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import { evaluateAlarms } from "@/server/phase5/alarms";
import { audit, requireAssetAccess, requireOperationsRole, requireUuid } from "./shared";

export type Quality = "good" | "uncertain" | "bad";
type SimulationMode = "normal" | "stopped" | "fault" | "stale" | "offline" | "out_of_order" | "invalid";
export type Tag = {
  id: string;
  tag_name: string;
  data_type: "number" | "boolean" | "string";
  semantic_type: string;
  minimum: string | null;
  maximum: string | null;
};
type ProviderReading = {
  tagName: string;
  value: unknown;
  observedAt: Date;
  quality: Quality;
  idempotencyKey: string;
};

const STALE_AFTER_SECONDS = 90;
const DISCONNECTED_AFTER_SECONDS = 180;
const RETENTION_DAYS = 30;
const MAX_HISTORY_DAYS = 365;
const MAX_INGEST_AGE_DAYS = RETENTION_DAYS;
const MAX_RAW_SAMPLES = 2000;

export interface ReadOnlyTelemetryProvider {
  readonly id: "simulated";
  sample(assetId: string, assetCreatedAt: Date, tags: Tag[], mode: SimulationMode): Promise<{
    connected: boolean;
    readings: ProviderReading[];
    error: string;
  }>;
}

class SimulatedTelemetryProvider implements ReadOnlyTelemetryProvider {
  readonly id = "simulated" as const;

  async sample(assetId: string, assetCreatedAt: Date, tags: Tag[], mode: SimulationMode) {
    if (mode === "offline") return { connected: false, readings: [], error: "Simulated source disconnected." };
    const now = new Date();
    const observedAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    if (mode === "stale") observedAt.setTime(observedAt.getTime() - 10 * 60_000);
    if (mode === "out_of_order") observedAt.setTime(observedAt.getTime() - 24 * 60 * 60_000);
    const elapsedSeconds = Math.max(0, Math.floor((observedAt.getTime() - assetCreatedAt.getTime()) / 1000));
    const values: Record<string, unknown> = {
      machine_state: mode === "fault" ? "fault" : mode === "stopped" ? "stopped" : "running",
      runtime_seconds: Math.floor(elapsedSeconds * 0.8),
      cycle_count: Math.floor(elapsedSeconds / 15),
      temperature_c: mode === "invalid" ? 999 : 42 + (elapsedSeconds % 70) / 10,
      alarm_code: mode === "fault" ? "SIM-OVERLOAD" : "",
      production_count: Math.floor(elapsedSeconds / 15),
    };
    return {
      connected: true,
      error: "",
      readings: tags.map((tag) => ({
        tagName: tag.tag_name,
        value: values[tag.tag_name] ?? (tag.data_type === "number" ? 0 : ""),
        observedAt,
        quality: "good" as Quality,
        idempotencyKey: `sim:${assetId}:${tag.tag_name}:${mode}:${observedAt.toISOString()}`,
      })),
    };
  }
}

const simulator: ReadOnlyTelemetryProvider = new SimulatedTelemetryProvider();

export function telemetryFreshness(
  observedAt: Date | string | null,
  now: Date,
): "fresh" | "stale" | "missing" {
  if (!observedAt) return "missing";
  const timestamp = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (Number.isNaN(timestamp.getTime())) return "missing";
  return now.getTime() - timestamp.getTime() <= STALE_AFTER_SECONDS * 1000 ? "fresh" : "stale";
}

export function validateTelemetryReading(tag: Tag, reading: ProviderReading, now: Date) {
  if (!(reading.observedAt instanceof Date) || Number.isNaN(reading.observedAt.getTime())) {
    throw new HttpError(400, "INVALID_TIMESTAMP", `Telemetry timestamp for ${tag.tag_name} is invalid.`);
  }
  if (reading.observedAt.getTime() > now.getTime() + 30_000) {
    throw new HttpError(400, "CLOCK_DRIFT", `Telemetry timestamp for ${tag.tag_name} is more than 30 seconds in the future.`);
  }
  if (reading.observedAt.getTime() < now.getTime() - MAX_INGEST_AGE_DAYS * 86_400_000) {
    throw new HttpError(400, "SAMPLE_TOO_OLD", `Telemetry timestamp for ${tag.tag_name} is outside the raw-ingest retention window.`);
  }
  if (!["good", "uncertain", "bad"].includes(reading.quality)) {
    throw new HttpError(400, "INVALID_QUALITY", `Telemetry quality for ${tag.tag_name} is invalid.`);
  }
  if (typeof reading.idempotencyKey !== "string" || reading.idempotencyKey.length < 8 || reading.idempotencyKey.length > 200) {
    throw new HttpError(400, "INVALID_KEY", "Telemetry readings require an idempotency key from 8 to 200 characters.");
  }

  let value: string;
  let numericValue: string | null = null;
  let quality = reading.quality;
  if (tag.data_type === "number") {
    const numeric = typeof reading.value === "number" ? reading.value :
      typeof reading.value === "string" && reading.value.trim() ? Number(reading.value) : Number.NaN;
    if (!Number.isFinite(numeric)) {
      throw new HttpError(400, "INVALID_VALUE", `Telemetry value for ${tag.tag_name} must be a finite number.`);
    }
    value = String(numeric);
    const belowMin = tag.minimum !== null && numeric < Number(tag.minimum);
    const aboveMax = tag.maximum !== null && numeric > Number(tag.maximum);
    if (belowMin || aboveMax) quality = "bad";
    else if (quality !== "bad") numericValue = numeric.toFixed(6);
  } else if (tag.data_type === "boolean") {
    if (typeof reading.value !== "boolean") {
      throw new HttpError(400, "INVALID_VALUE", `Telemetry value for ${tag.tag_name} must be boolean.`);
    }
    value = String(reading.value);
  } else {
    if (typeof reading.value !== "string" || reading.value.length > 1000) {
      throw new HttpError(400, "INVALID_VALUE", `Telemetry value for ${tag.tag_name} must be a string of at most 1000 characters.`);
    }
    value = reading.value;
  }
  if (tag.semantic_type === "state" && !["running", "stopped", "fault", "unknown"].includes(value)) {
    throw new HttpError(400, "INVALID_STATE", "Machine state must be running, stopped, fault, or unknown.");
  }
  return { value, numericValue, quality };
}

async function rollupExpiredSamples(client: PoolClient) {
  const result = await client.query<{ deleted: number }>(
    "WITH expired AS MATERIALIZED (" +
      "SELECT id,tag_id,date_trunc('hour',observed_at) AS bucket_start,value,numeric_value,quality,observed_at,received_at " +
      "FROM asset_telemetry_samples WHERE observed_at < now()-($1::int * interval '1 day') " +
      "ORDER BY observed_at LIMIT 5000 FOR UPDATE SKIP LOCKED" +
    "), aggregates AS (" +
      "SELECT tag_id,bucket_start,count(*)::int AS sample_count,count(numeric_value)::int AS numeric_count, " +
      "COALESCE(sum(numeric_value),0)::numeric(30,6) AS numeric_sum,min(numeric_value) AS numeric_min,max(numeric_value) AS numeric_max " +
      "FROM expired GROUP BY tag_id,bucket_start" +
    "), latest AS (" +
      "SELECT DISTINCT ON (tag_id,bucket_start) tag_id,bucket_start,value,numeric_value,quality,observed_at " +
      "FROM expired ORDER BY tag_id,bucket_start,observed_at DESC,received_at DESC" +
    "), merged AS (" +
      "INSERT INTO asset_telemetry_hourly_rollups(tag_id,bucket_start,sample_count,numeric_count,numeric_sum,numeric_min,numeric_max,last_value,last_numeric_value,last_quality,last_observed_at) " +
      "SELECT a.tag_id,a.bucket_start,a.sample_count,a.numeric_count,a.numeric_sum,a.numeric_min,a.numeric_max,l.value,l.numeric_value,l.quality,l.observed_at " +
      "FROM aggregates a JOIN latest l USING(tag_id,bucket_start) " +
      "ON CONFLICT(tag_id,bucket_start) DO UPDATE SET " +
      "sample_count=asset_telemetry_hourly_rollups.sample_count+EXCLUDED.sample_count, " +
      "numeric_count=asset_telemetry_hourly_rollups.numeric_count+EXCLUDED.numeric_count, " +
      "numeric_sum=asset_telemetry_hourly_rollups.numeric_sum+EXCLUDED.numeric_sum, " +
      "numeric_min=LEAST(asset_telemetry_hourly_rollups.numeric_min,EXCLUDED.numeric_min), " +
      "numeric_max=GREATEST(asset_telemetry_hourly_rollups.numeric_max,EXCLUDED.numeric_max), " +
      "last_value=CASE WHEN EXCLUDED.last_observed_at>asset_telemetry_hourly_rollups.last_observed_at THEN EXCLUDED.last_value ELSE asset_telemetry_hourly_rollups.last_value END, " +
      "last_numeric_value=CASE WHEN EXCLUDED.last_observed_at>asset_telemetry_hourly_rollups.last_observed_at THEN EXCLUDED.last_numeric_value ELSE asset_telemetry_hourly_rollups.last_numeric_value END, " +
      "last_quality=CASE WHEN EXCLUDED.last_observed_at>asset_telemetry_hourly_rollups.last_observed_at THEN EXCLUDED.last_quality ELSE asset_telemetry_hourly_rollups.last_quality END, " +
      "last_observed_at=GREATEST(asset_telemetry_hourly_rollups.last_observed_at,EXCLUDED.last_observed_at) " +
      "RETURNING tag_id,bucket_start" +
    "), deleted AS (" +
      "DELETE FROM asset_telemetry_samples s USING expired e WHERE s.id=e.id RETURNING s.id" +
    ") SELECT count(*)::int AS deleted FROM deleted",
    [RETENTION_DAYS],
  );
  return result.rows[0]?.deleted ?? 0;
}

async function ingest(
  client: PoolClient,
  assetId: string,
  sourceId: string,
  user: AuthenticatedUser,
  tags: Tag[],
  readings: ProviderReading[],
  connected: boolean,
  error: string,
) {
  const tagByName = new Map(tags.map((tag) => [tag.tag_name, tag]));
  const tagNames = new Set<string>();
  const now = new Date();
  let accepted = 0;
  let replayed = 0;
  let outOfOrder = 0;
  for (const reading of readings) {
    const tag = tagByName.get(reading.tagName);
    if (!tag) throw new HttpError(400, "UNKNOWN_TAG", `Telemetry tag ${reading.tagName} is not registered for this equipment.`);
    const sampleIdentity = `${reading.tagName}:${reading.observedAt.toISOString()}`;
    if (tagNames.has(sampleIdentity)) throw new HttpError(400, "DUPLICATE_SAMPLE", "The telemetry batch contains duplicate tag/timestamp pairs.");
    tagNames.add(sampleIdentity);
    const normalized = validateTelemetryReading(tag,reading,now);
    const prior = await client.query<{
      id: string; tag_id: string; value: string; quality: Quality; observed_at: Date; numeric_value: string | null;
    }>(
      "SELECT id,tag_id,value,quality,observed_at,numeric_value::text FROM asset_telemetry_samples WHERE idempotency_key=$1",
      [reading.idempotencyKey],
    );
    if (prior.rowCount) {
      const old = prior.rows[0];
      const numericMatches = old.numeric_value === null
        ? normalized.numericValue === null
        : normalized.numericValue !== null && Number(old.numeric_value) === Number(normalized.numericValue);
      if (old.tag_id !== tag.id || old.value !== normalized.value || old.quality !== normalized.quality ||
          old.observed_at.getTime() !== reading.observedAt.getTime() ||
          !numericMatches) {
        throw new HttpError(409, "KEY_REUSED", "The telemetry idempotency key was already used for a different sample.");
      }
      replayed += 1;
      continue;
    }
    const previous = await client.query<{ latest: Date | null }>(
      "SELECT GREATEST((SELECT max(observed_at) FROM asset_telemetry_samples WHERE tag_id=$1), " +
        "(SELECT max(last_observed_at) FROM asset_telemetry_hourly_rollups WHERE tag_id=$1)) AS latest",
      [tag.id],
    );
    const orderingState = previous.rows[0].latest && reading.observedAt.getTime() < previous.rows[0].latest.getTime()
      ? "out_of_order"
      : "ordered";
    if (orderingState === "out_of_order") outOfOrder += 1;
    await client.query(
      "INSERT INTO asset_telemetry_samples(tag_id,source_id,value,numeric_value,quality,ordering_state,observed_at,idempotency_key,created_by) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [tag.id,sourceId,normalized.value,normalized.numericValue,normalized.quality,orderingState,reading.observedAt,reading.idempotencyKey,user.id],
    );
    if (normalized.quality === "good" && orderingState === "ordered" &&
        telemetryFreshness(reading.observedAt, now) === "fresh") {
      await evaluateAlarms(client, assetId, tag.id, normalized.value, reading.observedAt, user);
    }
    accepted += 1;
  }
  await client.query(
    "UPDATE asset_telemetry_sources SET connection_state=$2,last_seen_at=CASE WHEN $3 THEN now() ELSE last_seen_at END, " +
      "last_error=$4,updated_by=$5,updated_at=now() WHERE id=$1",
    [sourceId,connected ? "connected" : "disconnected",connected,error,user.id],
  );
  const rolledUp = await rollupExpiredSamples(client);
  await audit(client,user,"telemetry.simulation.ingested","engineering_asset",assetId,{
    provider:"simulated",accepted,replayed,outOfOrder,connected,rolledUp,
  });
  return { accepted,replayed,outOfOrder,connected,rolledUp };
}

export async function simulateTelemetry(
  assetId: string,
  modeValue: unknown,
  user: AuthenticatedUser,
) {
  requireOperationsRole(user);
  const modes: SimulationMode[] = ["normal","stopped","fault","stale","offline","out_of_order","invalid"];
  const mode = modeValue === undefined ? "normal" : modeValue;
  if (typeof mode !== "string" || !modes.includes(mode as SimulationMode)) {
    throw new HttpError(400,"INVALID_SIMULATION_MODE",`Choose one of: ${modes.join(", ")}.`);
  }
  return inTransaction(async (client) => {
    const asset = await requireAssetAccess(client,assetId,user,true);
    if (asset.status === "retired") throw new HttpError(409,"EQUIPMENT_RETIRED","Telemetry cannot be simulated for retired equipment.");
    const source = await client.query<{ id: string; enabled: boolean; provider: string }>(
      "SELECT id,enabled,provider FROM asset_telemetry_sources WHERE asset_id=$1 FOR UPDATE",
      [assetId],
    );
    if (!source.rowCount || !source.rows[0].enabled) {
      throw new HttpError(409,"TELEMETRY_DISABLED","Telemetry is not enabled for this equipment.");
    }
    if (source.rows[0].provider !== simulator.id) {
      throw new HttpError(409,"PROVIDER_NOT_SUPPORTED","Only the simulated read-only provider is configured.");
    }
    const tagsResult = await client.query<Tag>(
      "SELECT id,tag_name,data_type,semantic_type,minimum::text,maximum::text FROM asset_telemetry_tags " +
        "WHERE asset_id=$1 AND enabled ORDER BY tag_name",
      [assetId],
    );
    const generated = await simulator.sample(assetId,asset.created_at,tagsResult.rows,mode as SimulationMode);
    const result = await ingest(
      client,assetId,source.rows[0].id,user,tagsResult.rows,generated.readings,generated.connected,generated.error,
    );
    return { ...result, mode };
  });
}

function connectionStatus(
  state: string | null,
  lastSeenAt: Date | string | null,
  now: Date,
): "connected" | "disconnected" | "faulted" {
  if (state === "faulted") return "faulted";
  if (state !== "connected" || !lastSeenAt) return "disconnected";
  const seen = lastSeenAt instanceof Date ? lastSeenAt : new Date(lastSeenAt);
  return now.getTime() - seen.getTime() <= DISCONNECTED_AFTER_SECONDS * 1000 ? "connected" : "disconnected";
}

export async function getTelemetryStatus(assetId: string, user: AuthenticatedUser) {
  return inTransaction(async (client) => {
    await requireAssetAccess(client,assetId,user);
    const [source,tags,events] = await Promise.all([
      client.query<{ connection_state: string; last_seen_at: Date | null; last_error: string }>(
        "SELECT connection_state,last_seen_at,last_error FROM asset_telemetry_sources WHERE asset_id=$1",
        [assetId],
      ),
      client.query(
        "SELECT t.id,t.tag_name AS \"tagName\",t.label,t.data_type AS \"dataType\",t.semantic_type AS \"semanticType\",t.unit, " +
          "latest.value,latest.numeric_value::text AS \"numericValue\",latest.quality,latest.ordering_state AS \"orderingState\", " +
          "latest.observed_at AS \"observedAt\",latest.received_at AS \"receivedAt\" " +
          "FROM asset_telemetry_tags t LEFT JOIN LATERAL (SELECT s.value,s.numeric_value,s.quality,s.ordering_state,s.observed_at,s.received_at " +
          "FROM asset_telemetry_samples s WHERE s.tag_id=t.id ORDER BY s.received_at DESC,s.observed_at DESC LIMIT 1) latest ON true " +
          "WHERE t.asset_id=$1 AND t.enabled ORDER BY t.tag_name",
        [assetId],
      ),
      client.query(
        "SELECT s.id,t.tag_name AS \"tagName\",t.label,t.semantic_type AS \"semanticType\",s.value,s.quality, " +
          "s.ordering_state AS \"orderingState\",s.observed_at AS \"observedAt\",s.received_at AS \"receivedAt\" " +
          "FROM asset_telemetry_samples s JOIN asset_telemetry_tags t ON t.id=s.tag_id " +
          "WHERE t.asset_id=$1 AND t.semantic_type IN ('state','alarm') " +
          "ORDER BY s.received_at DESC,s.observed_at DESC LIMIT 200",
        [assetId],
      ),
    ]);
    const now = new Date();
    const sourceRow = source.rows[0];
    const connection = connectionStatus(sourceRow?.connection_state ?? null,sourceRow?.last_seen_at ?? null,now);
    const currentTags = tags.rows.map((tag) => ({
      ...tag,
      freshness: telemetryFreshness(tag.observedAt ?? null,now),
    }));
    return {
      assetId,
      connection,
      lastSeenAt: sourceRow?.last_seen_at ?? null,
      lastError: sourceRow?.last_error ?? "",
      tags: currentTags,
      events: events.rows,
      staleAfterSeconds: STALE_AFTER_SECONDS,
      disconnectedAfterSeconds: DISCONNECTED_AFTER_SECONDS,
      queriedAt: now.toISOString(),
    };
  });
}

export async function getTelemetryHistory(
  assetId: string,
  tagIdValue: unknown,
  daysValue: string | null,
  user: AuthenticatedUser,
) {
  const tagId = requireUuid(tagIdValue,"tagId");
  const days = daysValue === null ? 1 : Number(daysValue);
  if (!Number.isInteger(days) || days < 1 || days > MAX_HISTORY_DAYS) {
    throw new HttpError(400,"INVALID_WINDOW",`days must be an integer from 1 to ${MAX_HISTORY_DAYS}.`);
  }
  return inTransaction(async (client) => {
    await requireAssetAccess(client,assetId,user);
    const tag = await client.query<{ id: string; label: string; unit: string }>(
      "SELECT id,label,unit FROM asset_telemetry_tags WHERE id=$1 AND asset_id=$2 AND enabled",
      [tagId,assetId],
    );
    if (!tag.rowCount) throw new HttpError(404,"TELEMETRY_TAG_NOT_FOUND","Telemetry tag not found for this equipment.");
    const from = new Date(Date.now() - days * 86_400_000);
    const rawFrom = new Date(Math.max(from.getTime(),Date.now() - RETENTION_DAYS * 86_400_000));
    const [rollups, samples] = await Promise.all([
      client.query(
        "SELECT bucket_start AS timestamp,CASE WHEN numeric_count>0 THEN (numeric_sum/numeric_count)::text ELSE last_value END AS value, " +
          "numeric_min::text AS minimum,numeric_max::text AS maximum,sample_count AS \"sampleCount\",last_quality AS quality " +
          "FROM asset_telemetry_hourly_rollups WHERE tag_id=$1 AND bucket_start >= $2 AND bucket_start < $3 ORDER BY bucket_start LIMIT 10000",
        [tagId,from,rawFrom],
      ),
      client.query(
        "SELECT recent.observed_at AS timestamp,recent.value,recent.numeric_value::text AS \"numericValue\", " +
          "recent.quality,recent.ordering_state AS \"orderingState\" FROM (" +
          "SELECT observed_at,value,numeric_value,quality,ordering_state,received_at FROM asset_telemetry_samples " +
          "WHERE tag_id=$1 AND observed_at >= $2 ORDER BY observed_at DESC,received_at DESC LIMIT $3" +
          ") recent ORDER BY recent.observed_at ASC,recent.received_at ASC",
        [tagId,rawFrom,MAX_RAW_SAMPLES],
      ),
    ]);
    return { tag: tag.rows[0], from: from.toISOString(), points: [...rollups.rows,...samples.rows] };
  });
}

export function parseEquipmentId(value: unknown): string {
  return requireUuid(value,"equipmentId");
}
