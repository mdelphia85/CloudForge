import "server-only";
import type { AuthenticatedUser } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import {
  audit,
  idempotencyKey,
  parseTimestamp,
  requireAssetAccess,
  requireOperationsRole,
  requireUuid,
  shortText,
} from "./shared";

export async function listEquipmentDowntime(assetId: string, user: AuthenticatedUser) {
  return inTransaction(async (client) => {
    await requireAssetAccess(client,assetId,user);
    const result = await client.query(
      "SELECT d.id::text AS id,d.source,d.reason,d.started_at AS \"startedAt\",d.ended_at AS \"endedAt\",d.notes, " +
        "d.production_downtime_id AS \"productionDowntimeId\",d.maintenance_work_order_id AS \"maintenanceWorkOrderId\", " +
        "d.idempotency_key AS \"idempotencyKey\",u.display_name AS \"reportedByName\",d.created_at AS \"createdAt\" " +
        "FROM asset_downtime_events d JOIN users u ON u.id=d.reported_by " +
        "WHERE d.asset_id=$1 " +
        "UNION ALL SELECT ('production:'||d.id::text) AS id,'production' AS source,d.reason,d.started_at AS \"startedAt\", " +
        "d.ended_at AS \"endedAt\",d.notes,d.id AS \"productionDowntimeId\",NULL::uuid AS \"maintenanceWorkOrderId\", " +
        "('production:'||d.id::text) AS \"idempotencyKey\",u.display_name AS \"reportedByName\",d.created_at AS \"createdAt\" " +
        "FROM production_downtime d JOIN production_jobs j ON j.id=d.production_job_id " +
        "JOIN users u ON u.id=d.operator_id WHERE j.asset_id=$1 " +
        "AND NOT EXISTS(SELECT 1 FROM asset_downtime_events linked WHERE linked.production_downtime_id=d.id) " +
        "ORDER BY \"startedAt\" DESC LIMIT 500",
      [assetId],
    );
    return { downtime: result.rows };
  });
}
export async function recordEquipmentDowntime(
  assetId: string,
  body: Record<string, unknown>,
  user: AuthenticatedUser,
) {
  requireOperationsRole(user);
  const key = idempotencyKey(body.idempotencyKey);
  const maintenanceWorkOrderId = body.maintenanceWorkOrderId
    ? requireUuid(body.maintenanceWorkOrderId,"maintenanceWorkOrderId")
    : null;
  const productionDowntimeId = body.productionDowntimeId
    ? requireUuid(body.productionDowntimeId,"productionDowntimeId")
    : null;
  const reason = body.reason === undefined ? "" : shortText(body.reason,"reason",240);
  const notes = body.notes === undefined || body.notes === "" ? "" : shortText(body.notes,"notes",1000);
  const startedAt = body.startedAt === undefined || body.startedAt === null || body.startedAt === ""
    ? null
    : parseTimestamp(body.startedAt,"startedAt");
  const endedAt = body.endedAt === undefined || body.endedAt === null || body.endedAt === ""
    ? null
    : parseTimestamp(body.endedAt,"endedAt");
  if (!productionDowntimeId && !startedAt) {
    throw new HttpError(400,"MISSING_FIELD","startedAt is required for equipment downtime.");
  }
  if (productionDowntimeId && startedAt) {
    throw new HttpError(400,"INVALID_SOURCE","Use either a validated production downtime ID or a manual interval, not both.");
  }
  if (!productionDowntimeId && reason.length < 2) {
    throw new HttpError(400,"INVALID_FIELD","reason must be 2–240 characters.");
  }
  if (!productionDowntimeId && endedAt && startedAt && endedAt.getTime() <= startedAt.getTime()) {
    throw new HttpError(400,"INVALID_INTERVAL","Downtime end must be after its start.");
  }

  return inTransaction(async (client) => {
    await requireAssetAccess(client,assetId,user,true);
    let start = startedAt;
    let end = endedAt;
    let finalReason = reason;
    let source: "manual" | "production" = "manual";
    if (productionDowntimeId) {
      const sourceRow = await client.query<{
        started_at: Date; ended_at: Date; reason: string; asset_id: string | null;
      }>(
        "SELECT d.started_at,d.ended_at,d.reason,j.asset_id " +
          "FROM production_downtime d JOIN production_jobs j ON j.id=d.production_job_id WHERE d.id=$1",
        [productionDowntimeId],
      );
      if (!sourceRow.rowCount) throw new HttpError(404,"PRODUCTION_DOWNTIME_NOT_FOUND","The production downtime record does not exist.");
      if (sourceRow.rows[0].asset_id !== assetId) {
        throw new HttpError(409,"WRONG_EQUIPMENT","The production downtime is not associated with this equipment.");
      }
      start = sourceRow.rows[0].started_at;
      end = sourceRow.rows[0].ended_at;
      finalReason = sourceRow.rows[0].reason;
      source = "production";
    } else {
      const now = await client.query<{ now: Date }>("SELECT now()");
      if (startedAt!.getTime() > now.rows[0].now.getTime()) {
        throw new HttpError(400,"FUTURE_DOWNTIME","Equipment downtime cannot start in the future.");
      }
      if (endedAt && endedAt.getTime() > now.rows[0].now.getTime()) {
        throw new HttpError(400,"FUTURE_DOWNTIME","Equipment downtime cannot end in the future.");
      }
    }

    if (maintenanceWorkOrderId) {
      const workOrder = await client.query<{ asset_id: string; status: string }>(
        "SELECT asset_id,status FROM maintenance_work_orders WHERE id=$1",
        [maintenanceWorkOrderId],
      );
      if (!workOrder.rowCount) throw new HttpError(404,"WORK_ORDER_NOT_FOUND","Maintenance work order not found.");
      if (workOrder.rows[0].asset_id !== assetId) {
        throw new HttpError(409,"WRONG_EQUIPMENT","The maintenance work order is not associated with this equipment.");
      }
      if (!["in_progress","completed","closed"].includes(workOrder.rows[0].status)) {
        throw new HttpError(409,"WORK_ORDER_NOT_STARTED","Link downtime to a started or completed corrective work order.");
      }
    }

    const previous = await client.query<{
      id: string; asset_id: string; source: string; reason: string; started_at: Date; ended_at: Date | null;
      production_downtime_id: string | null; maintenance_work_order_id: string | null; notes: string;
    }>(
      "SELECT id,asset_id,source,reason,started_at,ended_at,production_downtime_id,maintenance_work_order_id,notes " +
        "FROM asset_downtime_events WHERE idempotency_key=$1",
      [key],
    );
    if (previous.rowCount) {
      const row = previous.rows[0];
      if (row.asset_id !== assetId || row.source !== source || row.reason !== finalReason ||
          row.started_at.getTime() !== start!.getTime() ||
          (row.ended_at?.getTime() ?? null) !== (end?.getTime() ?? null) ||
          row.production_downtime_id !== productionDowntimeId ||
          row.maintenance_work_order_id !== maintenanceWorkOrderId || row.notes !== notes) {
        throw new HttpError(409,"KEY_REUSED","The idempotency key was already used for different downtime details.");
      }
      return { id: row.id, replayed: true };
    }
    if (!end) {
      const open = await client.query(
        "SELECT id FROM asset_downtime_events WHERE asset_id=$1 AND ended_at IS NULL",
        [assetId],
      );
      if (open.rowCount) throw new HttpError(409,"DOWNTIME_ALREADY_OPEN","Close the active equipment downtime before opening another.");
    }
    const created = await client.query<{ id: string }>(
      "INSERT INTO asset_downtime_events(asset_id,production_downtime_id,maintenance_work_order_id,source,reason,started_at,ended_at,notes,idempotency_key,reported_by) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
      [assetId,productionDowntimeId,maintenanceWorkOrderId,source,finalReason,start,end,notes,key,user.id],
    );
    await audit(client,user,"equipment.downtime.recorded","asset_downtime_event",created.rows[0].id,{
      assetId,productionDowntimeId,maintenanceWorkOrderId,source,startedAt:start,endedAt:end,reason:finalReason,
    });
    return { id: created.rows[0].id, replayed: false };
  });
}

export async function closeEquipmentDowntime(
  assetId: string,
  eventId: string,
  body: Record<string, unknown>,
  user: AuthenticatedUser,
) {
  requireOperationsRole(user);
  const endedAt = body.endedAt ? parseTimestamp(body.endedAt,"endedAt") : new Date();
  const notes = body.notes === undefined || body.notes === "" ? "" : shortText(body.notes,"notes",1000);
  return inTransaction(async (client) => {
    await requireAssetAccess(client,assetId,user,true);
    const event = await client.query<{ started_at: Date; ended_at: Date | null; source: string }>(
      "SELECT started_at,ended_at,source FROM asset_downtime_events WHERE id=$1 AND asset_id=$2 FOR UPDATE",
      [eventId,assetId],
    );
    if (!event.rowCount) throw new HttpError(404,"DOWNTIME_NOT_FOUND","Equipment downtime event not found.");
    if (event.rows[0].ended_at) throw new HttpError(409,"DOWNTIME_CLOSED","Equipment downtime has already been closed.");
    if (event.rows[0].source === "production") {
      throw new HttpError(409,"PRODUCTION_DOWNTIME_IMMUTABLE","Production-linked downtime is closed with its original production record.");
    }
    if (endedAt.getTime() <= event.rows[0].started_at.getTime()) {
      throw new HttpError(400,"INVALID_INTERVAL","Downtime end must be after its start.");
    }
    const now = await client.query<{ now: Date }>("SELECT now()");
    if (endedAt.getTime() > now.rows[0].now.getTime()) throw new HttpError(400,"FUTURE_DOWNTIME","Equipment downtime cannot end in the future.");
    await client.query(
      "UPDATE asset_downtime_events SET ended_at=$2,notes=CASE WHEN $3='' THEN notes ELSE $3 END WHERE id=$1",
      [eventId,endedAt,notes],
    );
    await audit(client,user,"equipment.downtime.closed","asset_downtime_event",eventId,{assetId,endedAt,notes});
    return { id: eventId, endedAt };
  });
}
