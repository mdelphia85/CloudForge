import "server-only";
import type { AuthenticatedUser } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import { requireAssetAccess, requireUuid } from "./shared";

export type DowntimeInterval = {
  id: string;
  startedAt: Date | string;
  endedAt: Date | string | null;
  reason?: string;
  source?: string;
  productionDowntimeId?: string | null;
  maintenanceWorkOrderId?: string | null;
};

function timestamp(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function unionDuration(intervals: Array<{ start: number; end: number }>): number {
  if (!intervals.length) return 0;
  intervals.sort((left,right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let start = intervals[0].start;
  let end = intervals[0].end;
  for (const interval of intervals.slice(1)) {
    if (interval.start <= end) {
      end = Math.max(end,interval.end);
    } else {
      total += end - start;
      start = interval.start;
      end = interval.end;
    }
  }
  return total + end - start;
}

export function calculateReliabilityMetrics(
  events: DowntimeInterval[],
  windowStart: Date,
  windowEnd: Date,
) {
  const start = windowStart.getTime();
  const end = windowEnd.getTime();
  if (end <= start) throw new RangeError("Reliability window end must be after its start.");
  const intervals = events.flatMap((event) => {
    const eventStart = timestamp(event.startedAt);
    const eventEnd = event.endedAt ? timestamp(event.endedAt) : end;
    const clippedStart = Math.max(start,eventStart);
    const clippedEnd = Math.min(end,eventEnd);
    return clippedEnd > clippedStart ? [{ start: clippedStart, end: clippedEnd }] : [];
  });
  const downtimeMs = unionDuration(intervals);
  const failures = events.filter((event) => {
    const eventStart = timestamp(event.startedAt);
    return eventStart >= start && eventStart < end;
  });
  const completedInWindow = events.filter((event) => {
    if (!event.endedAt) return false;
    const eventEnd = timestamp(event.endedAt);
    return eventEnd >= start && eventEnd < end;
  });
  const closedDurationMs = completedInWindow.reduce(
    (total,event) => total + Math.max(0,timestamp(event.endedAt!) - timestamp(event.startedAt)),
    0,
  );
  const windowMs = end - start;
  const downtimeSeconds = Math.floor(downtimeMs / 1000);
  const mttrSeconds = completedInWindow.length
    ? Math.floor(closedDurationMs / completedInWindow.length / 1000)
    : null;
  return {
    windowSeconds: Math.floor(windowMs / 1000),
    downtimeSeconds,
    availabilityPercent: Math.max(0,100 * (1 - downtimeMs / windowMs)),
    failureCount: failures.length,
    closedFailureCount: completedInWindow.length,
    ongoingFailureCount: events.filter((event) => !event.endedAt &&
      timestamp(event.startedAt) >= start && timestamp(event.startedAt) < end).length,
    mtbfSeconds: failures.length ? Math.floor(Math.max(0,windowMs - downtimeMs) / failures.length / 1000) : null,
    mttrSeconds,
  };
}

function parseDays(value: string | null): number {
  if (value === null) return 30;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new HttpError(400,"INVALID_WINDOW","days must be an integer from 1 to 365.");
  }
  return days;
}

export async function getReliabilityAnalytics(
  user: AuthenticatedUser,
  daysValue: string | null,
  assetIdValue: string | null,
) {
  const days = parseDays(daysValue);
  const requestedAssetId = assetIdValue ? requireUuid(assetIdValue,"assetId") : null;
  return inTransaction(async (client) => {
    const current = await client.query<{ now: Date }>("SELECT now()");
    const windowEnd = current.rows[0].now;
    const windowStart = new Date(windowEnd.getTime() - days * 86_400_000);
    if (requestedAssetId) await requireAssetAccess(client,requestedAssetId,user);

    const assets = await client.query<{
      id: string; asset_tag: string; name: string; status: string;
    }>(
      "SELECT a.id,a.asset_tag,a.name,a.status FROM engineering_assets a " +
        "WHERE ($1::uuid IS NULL OR a.id=$1) AND ($2 <> 'viewer' OR " +
        "EXISTS(SELECT 1 FROM projects p WHERE p.id=a.project_id AND p.created_by=$3) OR " +
        "EXISTS(SELECT 1 FROM project_resources r WHERE r.project_id=a.project_id AND r.user_id=$3) OR " +
        "EXISTS(SELECT 1 FROM field_service_jobs s WHERE s.asset_id=a.id AND s.assigned_to=$3) OR " +
        "EXISTS(SELECT 1 FROM maintenance_work_orders m WHERE m.asset_id=a.id AND m.assigned_to=$3)) " +
        "ORDER BY a.asset_tag LIMIT 500",
      [requestedAssetId,user.role,user.id],
    );
    if (requestedAssetId && !assets.rowCount) throw new HttpError(404,"EQUIPMENT_NOT_FOUND","Equipment not found.");
    const assetIds = assets.rows.map((asset) => asset.id);
    if (!assetIds.length) return { days, from: windowStart.toISOString(), to: windowEnd.toISOString(), equipment: [] };

    const history = await client.query<{
      asset_id: string; id: string; reason: string; source: string; started_at: Date; ended_at: Date | null;
      production_downtime_id: string | null; maintenance_work_order_id: string | null;
      maintenance_title: string | null; production_job_code: string | null; production_status: string | null;
    }>(
      "SELECT d.asset_id,d.id::text AS id,d.reason,d.source,d.started_at,d.ended_at,d.production_downtime_id,d.maintenance_work_order_id, " +
        "m.title AS maintenance_title,j.job_code AS production_job_code,j.status AS production_status " +
        "FROM asset_downtime_events d LEFT JOIN maintenance_work_orders m ON m.id=d.maintenance_work_order_id " +
        "LEFT JOIN production_downtime pd ON pd.id=d.production_downtime_id " +
        "LEFT JOIN production_jobs j ON j.id=pd.production_job_id " +
        "WHERE d.asset_id=ANY($1::uuid[]) AND d.started_at < $3 AND (d.ended_at IS NULL OR d.ended_at > $2) " +
        "UNION ALL " +
        "SELECT j.asset_id,('production:'||d.id::text),d.reason,'production',d.started_at,d.ended_at,d.id,NULL::uuid,NULL::text, " +
        "j.job_code,j.status FROM production_downtime d JOIN production_jobs j ON j.id=d.production_job_id " +
        "WHERE j.asset_id=ANY($1::uuid[]) AND d.started_at < $3 AND d.ended_at > $2 " +
        "AND NOT EXISTS(SELECT 1 FROM asset_downtime_events linked WHERE linked.production_downtime_id=d.id) " +
        "ORDER BY started_at DESC LIMIT 5000",
      [assetIds,windowStart,windowEnd],
    );
    const byAsset = new Map<string, typeof history.rows>();
    for (const event of history.rows) {
      const currentEvents = byAsset.get(event.asset_id) ?? [];
      currentEvents.push(event);
      byAsset.set(event.asset_id,currentEvents);
    }
    const telemetry = await client.query<{
      asset_id: string; provider: string; tag_name: string; value: string; quality: string;
      ordering_state: string; observed_at: Date; received_at: Date;
    }>(
      "SELECT src.asset_id,src.provider,t.tag_name,s.value,s.quality,s.ordering_state,s.observed_at,s.received_at " +
        "FROM asset_telemetry_sources src JOIN asset_telemetry_tags t ON t.asset_id=src.asset_id AND t.enabled " +
        "JOIN LATERAL (SELECT value,quality,ordering_state,observed_at,received_at FROM asset_telemetry_samples " +
        "WHERE source_id=src.id AND tag_id=t.id AND observed_at >= $2 AND observed_at < $3 " +
        "ORDER BY observed_at DESC,received_at DESC LIMIT 1) s ON true WHERE src.asset_id=ANY($1::uuid[])",
      [assetIds,windowStart,windowEnd],
    );
    const telemetryByAsset = new Map<string, typeof telemetry.rows>();
    for (const reading of telemetry.rows) {
      const currentReadings = telemetryByAsset.get(reading.asset_id) ?? [];
      currentReadings.push(reading);
      telemetryByAsset.set(reading.asset_id,currentReadings);
    }
    const equipment = assets.rows.map((asset) => {
      const events = byAsset.get(asset.id) ?? [];
      const metrics = calculateReliabilityMetrics(
        events.map((event) => ({
          id:event.id,
          startedAt:event.started_at,
          endedAt:event.ended_at,
          reason:event.reason,
          source:event.source,
          productionDowntimeId:event.production_downtime_id,
          maintenanceWorkOrderId:event.maintenance_work_order_id,
        })),
        windowStart,
        windowEnd,
      );
      return {
        assetId:asset.id,
        assetTag:asset.asset_tag,
        name:asset.name,
        status:asset.status,
        metrics,
        latestTelemetry:(telemetryByAsset.get(asset.id) ?? []).map((reading) => ({
          provider:reading.provider,
          tagName:reading.tag_name,
          value:reading.value,
          quality:reading.quality,
          orderingState:reading.ordering_state,
          observedAt:reading.observed_at,
          receivedAt:reading.received_at,
        })),
        failureHistory:events.map((event) => ({
          id:event.id,
          reason:event.reason,
          source:event.source,
          startedAt:event.started_at,
          endedAt:event.ended_at,
          productionDowntimeId:event.production_downtime_id,
          maintenanceWorkOrderId:event.maintenance_work_order_id,
          maintenanceTitle:event.maintenance_title,
          productionJobCode:event.production_job_code,
          productionStatus:event.production_status,
        })),
      };
    });
    return { days, from: windowStart.toISOString(), to: windowEnd.toISOString(), equipment };
  });
}
