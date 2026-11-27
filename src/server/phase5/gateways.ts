import "server-only";
import { createHash, createPublicKey, verify } from "node:crypto";
import type { PoolClient } from "pg";
import { requireRole, type AuthenticatedUser } from "@/server/auth";
import { getPool, inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import { ingestTelemetry, type ProviderReading, type Tag } from "@/server/phase4/telemetry";
import { audit, parseTimestamp, requireUuid, shortText } from "@/server/phase4/shared";

const MAX_AGE_MS = 30 * 86_400_000;

function publicKey(value: unknown): string {
  if (typeof value !== "string" || value.length > 500 ||
      !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(value)) {
    throw new HttpError(400, "INVALID_PUBLIC_KEY", "An Ed25519 public key in PEM format is required.");
  }
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Not Ed25519");
    return key.export({ type: "spki", format: "der" }).toString("base64");
  } catch {
    throw new HttpError(400, "INVALID_PUBLIC_KEY", "An Ed25519 public key in PEM format is required.");
  }
}

function expiry(value: unknown): Date {
  const date = parseTimestamp(value, "expiresAt");
  const delta = date.getTime() - Date.now();
  if (delta <= 0 || delta > 366 * 86_400_000) {
    throw new HttpError(400, "INVALID_EXPIRY", "Gateway expiry must be in the next 366 days.");
  }
  return date;
}

export async function listGateways(user: AuthenticatedUser) {
  requireRole(user, "admin");
  const result = await getPool().query(
    "SELECT g.id,g.name,g.enabled,g.revoked_at AS \"revokedAt\",g.expires_at AS \"expiresAt\",g.created_at AS \"createdAt\", " +
    "g.highest_sequence::text AS \"highestSequence\",count(t.tag_id)::int AS \"tagCount\" " +
    "FROM industrial_gateways g LEFT JOIN gateway_allowed_tags t ON t.gateway_id=g.id GROUP BY g.id ORDER BY g.created_at DESC LIMIT 500",
  );
  return { gateways: result.rows };
}

export async function registerGateway(body: Record<string, unknown>, user: AuthenticatedUser) {
  requireRole(user, "admin");
  const name = shortText(body.name, "name", 160);
  if (name.length < 2) throw new HttpError(400, "INVALID_NAME", "Gateway name must have at least two characters.");
  const key = publicKey(body.publicKey);
  const expiresAt = expiry(body.expiresAt);
  if (!Array.isArray(body.tagIds) || body.tagIds.length < 1 || body.tagIds.length > 100) {
    throw new HttpError(400, "INVALID_TAGS", "Choose between 1 and 100 allowed equipment tags.");
  }
  const tagIds = body.tagIds.map((id) => requireUuid(id, "tagId"));
  if (new Set(tagIds).size !== tagIds.length) throw new HttpError(400, "INVALID_TAGS", "Equipment tags must be unique.");
  return inTransaction(async (client) => {
    const tags = await client.query<{ id: string; asset_id: string; status: string }>(
      "SELECT t.id,t.asset_id,a.status FROM asset_telemetry_tags t JOIN engineering_assets a ON a.id=t.asset_id " +
      "WHERE t.id=ANY($1::uuid[]) AND t.enabled ORDER BY t.id",
      [tagIds],
    );
    if (tags.rowCount !== tagIds.length || tags.rows.some((tag) => tag.status === "retired")) {
      throw new HttpError(400, "INVALID_TAGS", "All allowed tags must belong to active equipment.");
    }
    const gateway = await client.query<{ id: string }>(
      "INSERT INTO industrial_gateways(name,public_key,expires_at,created_by) VALUES($1,$2,$3,$4) RETURNING id",
      [name,key,expiresAt,user.id],
    );
    const gatewayId = gateway.rows[0].id;
    for (const assetId of new Set(tags.rows.map((tag) => tag.asset_id))) {
      const source = await client.query<{ id: string }>(
        "INSERT INTO asset_telemetry_sources(asset_id,provider,gateway_id,updated_by) VALUES($1,'gateway',$2,$3) " +
        "ON CONFLICT(asset_id,provider) DO UPDATE SET gateway_id=EXCLUDED.gateway_id,connection_state='disconnected', " +
        "last_seen_at=NULL,last_status_at=now(),updated_by=EXCLUDED.updated_by,updated_at=now() " +
        "WHERE EXISTS(SELECT 1 FROM industrial_gateways old WHERE old.id=asset_telemetry_sources.gateway_id AND old.revoked_at IS NOT NULL) " +
        "RETURNING id",
        [assetId,gatewayId,user.id],
      );
      if (!source.rowCount) throw new HttpError(409, "GATEWAY_SOURCE_EXISTS", "Equipment already has a gateway source.");
      await client.query("DELETE FROM equipment_alarm_rule_source_state WHERE source_id=$1", [source.rows[0].id]);
    }
    await client.query(
      "INSERT INTO gateway_allowed_tags(gateway_id,tag_id) SELECT $1,unnest($2::uuid[])",
      [gatewayId,tagIds],
    );
    await audit(client,user,"gateway.registered","industrial_gateway",gatewayId,{ name,tagIds,expiresAt });
    return { id: gatewayId };
  });
}

export async function updateGateway(id: string, body: Record<string, unknown>, user: AuthenticatedUser) {
  requireRole(user, "admin");
  const action = body.action;
  if (!["disable","enable","revoke","rotate"].includes(String(action))) {
    throw new HttpError(400, "INVALID_ACTION", "Choose disable, enable, revoke, or rotate.");
  }
  const key = action === "rotate" ? publicKey(body.publicKey) : null;
  const expiresAt = action === "rotate" ? expiry(body.expiresAt) : null;
  return inTransaction(async (client) => {
    const gateway = await client.query<{ revoked_at: Date | null; expires_at: Date }>(
      "SELECT revoked_at,expires_at FROM industrial_gateways WHERE id=$1 FOR UPDATE", [id],
    );
    if (!gateway.rowCount) throw new HttpError(404, "GATEWAY_NOT_FOUND", "Gateway not found.");
    if (gateway.rows[0].revoked_at) throw new HttpError(409, "GATEWAY_REVOKED", "A revoked gateway cannot be changed.");
    if (action === "enable" && gateway.rows[0].expires_at.getTime() <= Date.now()) {
      throw new HttpError(409, "GATEWAY_EXPIRED", "Rotate the expired credential before enabling the gateway.");
    }
    if (action === "rotate") {
      await client.query("UPDATE industrial_gateways SET public_key=$2,expires_at=$3 WHERE id=$1", [id,key,expiresAt]);
    } else if (action === "revoke") {
      await client.query("UPDATE industrial_gateways SET enabled=false,revoked_at=now() WHERE id=$1", [id]);
    } else {
      await client.query("UPDATE industrial_gateways SET enabled=$2 WHERE id=$1", [id,action === "enable"]);
    }
    if (action === "disable" || action === "revoke" || action === "rotate") {
      await client.query(
        "UPDATE asset_telemetry_sources SET connection_state='disconnected',last_status_at=now(),updated_by=$2,updated_at=now() WHERE gateway_id=$1",
        [id,user.id],
      );
    }
    await audit(client,user,`gateway.${action}d`,"industrial_gateway",id,{ expiresAt });
    return { id, action };
  });
}

type GatewayRow = {
  id: string; public_key: string; enabled: boolean; revoked_at: Date | null;
  valid: boolean; highest_sequence: string;
};

function authenticate(gateway: GatewayRow | undefined, timestamp: string, signature: string, payloadHash: string): void {
  const time = Date.parse(timestamp);
  if (!gateway || !gateway.enabled || gateway.revoked_at || !gateway.valid ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(timestamp) ||
      !Number.isFinite(time) || Math.abs(Date.now() - time) > 120_000 ||
      !/^[A-Za-z0-9_-]{86}$/.test(signature)) {
    throw new HttpError(401, "INVALID_GATEWAY_CREDENTIAL", "Gateway authentication failed.");
  }
  const key = createPublicKey({ key: Buffer.from(gateway.public_key, "base64"), type: "spki", format: "der" });
  const canonical = `cloudforge-gateway-v1\n${gateway.id}\n${timestamp}\n${payloadHash}`;
  if (!verify(null, Buffer.from(canonical), key, Buffer.from(signature, "base64url"))) {
    throw new HttpError(401, "INVALID_GATEWAY_CREDENTIAL", "Gateway authentication failed.");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_TELEMETRY", "Telemetry body must be an object.");
  }
  return value as Record<string, unknown>;
}

async function readTelemetryBody(request: Request): Promise<string> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > 60_000) throw new HttpError(413, "BODY_TOO_LARGE", "Telemetry body is too large.");
  if (!request.body) throw new HttpError(400, "INVALID_TELEMETRY", "Telemetry body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > 60_000) {
      await reader.cancel();
      throw new HttpError(413, "BODY_TOO_LARGE", "Telemetry body is too large.");
    }
    chunks.push(part.value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new HttpError(400, "INVALID_TELEMETRY", "Telemetry body must be valid UTF-8.");
  }
}

export async function ingestGateway(request: Request) {
  const gatewayId = request.headers.get("x-cloudforge-gateway") ?? "";
  const timestamp = request.headers.get("x-cloudforge-timestamp") ?? "";
  const signature = request.headers.get("x-cloudforge-signature") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(gatewayId)) {
    throw new HttpError(401, "INVALID_GATEWAY_CREDENTIAL", "Gateway authentication failed.");
  }
  const raw = await readTelemetryBody(request);
  const hash = createHash("sha256").update(raw).digest("hex");
  return inTransaction(async (client: PoolClient) => {
    const rows = await client.query<GatewayRow>(
      "SELECT id,public_key,enabled,revoked_at,expires_at>now() AS valid,highest_sequence::text FROM industrial_gateways WHERE id=$1 FOR UPDATE",
      [gatewayId],
    );
    const gateway = rows.rows[0];
    authenticate(gateway,timestamp,signature,hash);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new HttpError(400, "INVALID_JSON", "Telemetry body must be JSON."); }
    const body = record(parsed);
    if (typeof body.sequence !== "number" || !Number.isSafeInteger(body.sequence) || body.sequence < 1) {
      throw new HttpError(400, "INVALID_SEQUENCE", "Telemetry sequence must be a positive safe integer.");
    }
    const sequence = body.sequence;
    const existing = await client.query<{ payload_hash: string; accepted: number; out_of_order: number }>(
      "SELECT payload_hash,accepted,out_of_order FROM gateway_telemetry_batches WHERE gateway_id=$1 AND sequence=$2",
      [gatewayId,sequence],
    );
    if (existing.rowCount) {
      if (existing.rows[0].payload_hash !== hash) throw new HttpError(409, "SEQUENCE_REUSED", "Sequence was already used for a different batch.");
      return { sequence, replayed: true, accepted: existing.rows[0].accepted, outOfOrder: existing.rows[0].out_of_order };
    }
    const assetId = requireUuid(body.assetId,"assetId");
    const capturedAt = parseTimestamp(body.capturedAt,"capturedAt");
    if (capturedAt.getTime() > Date.now() + 30_000 || capturedAt.getTime() < Date.now() - MAX_AGE_MS) {
      throw new HttpError(400, "INVALID_CAPTURE_TIME", "Telemetry capture time is outside the permitted window.");
    }
    if (typeof body.connected !== "boolean" || !Array.isArray(body.readings) || body.readings.length > 100 ||
        (body.connected && body.readings.length === 0) || (!body.connected && body.readings.length !== 0)) {
      throw new HttpError(400, "INVALID_TELEMETRY", "Connected batches require readings; disconnected batches must be empty.");
    }
    if (body.diagnostic !== undefined && (body.connected || body.diagnostic !== "invalid_reading")) {
      throw new HttpError(400, "INVALID_TELEMETRY", "Gateway diagnostic is invalid.");
    }
    const source = await client.query<{ id: string }>(
      "SELECT s.id FROM asset_telemetry_sources s JOIN engineering_assets a ON a.id=s.asset_id " +
      "WHERE s.asset_id=$1 AND s.gateway_id=$2 AND s.enabled AND a.status<>'retired' FOR UPDATE OF s",
      [assetId,gatewayId],
    );
    if (!source.rowCount) throw new HttpError(403, "GATEWAY_NOT_AUTHORIZED", "Gateway is not authorized for this equipment.");
    const allowed = await client.query<Tag>(
      "SELECT t.id,t.tag_name,t.data_type,t.semantic_type,t.minimum::text,t.maximum::text " +
      "FROM asset_telemetry_tags t JOIN gateway_allowed_tags p ON p.tag_id=t.id " +
      "WHERE p.gateway_id=$1 AND t.asset_id=$2 AND t.enabled",
      [gatewayId,assetId],
    );
    const byName = new Map(allowed.rows.map((tag) => [tag.tag_name,tag]));
    const seen = new Set<string>();
    const readings: ProviderReading[] = body.readings.map((item) => {
      const reading = record(item);
      if (typeof reading.tagName !== "string" || !byName.has(reading.tagName) || seen.has(reading.tagName)) {
        throw new HttpError(403, "GATEWAY_TAG_NOT_AUTHORIZED", "A tag is not allowlisted or is duplicated.");
      }
      seen.add(reading.tagName);
      const observedAt = parseTimestamp(reading.observedAt, "observedAt");
      if (observedAt.getTime() > capturedAt.getTime() + 30_000) {
        throw new HttpError(400, "CLOCK_DRIFT", "A reading timestamp is later than its capture time.");
      }
      if (reading.quality !== "good" && reading.quality !== "uncertain" && reading.quality !== "bad") {
        throw new HttpError(400, "INVALID_QUALITY", "Telemetry quality is invalid.");
      }
      return {
        tagName: reading.tagName, value: reading.value, observedAt, quality: reading.quality,
        idempotencyKey: `gateway:${gatewayId}:${sequence}:${byName.get(reading.tagName)!.id}`,
      };
    });
    const result = await ingestTelemetry(
      client,assetId,source.rows[0].id,{ gatewayId },allowed.rows,readings,body.connected,
      body.connected ? "" : body.diagnostic === "invalid_reading"
        ? "Industrial provider returned an invalid value or timestamp; measurements are not live."
        : "Gateway reported an industrial provider disconnection.",
      capturedAt,sequence < Number(gateway.highest_sequence),body.diagnostic === "invalid_reading",
    );
    await client.query(
      "INSERT INTO gateway_telemetry_batches(gateway_id,sequence,payload_hash,asset_id,accepted,out_of_order) VALUES($1,$2,$3,$4,$5,$6)",
      [gatewayId,sequence,hash,assetId,result.accepted,result.outOfOrder],
    );
    await client.query("UPDATE industrial_gateways SET highest_sequence=GREATEST(highest_sequence,$2) WHERE id=$1", [gatewayId,sequence]);
    return { sequence, replayed: false, accepted: result.accepted, outOfOrder: result.outOfOrder };
  });
}
