import "server-only";
import type { AuthenticatedUser } from "@/server/auth";
import { getPool, inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import { deductAvailableStock } from "@/server/inventory-allocation";
import { evaluateAutoReorder } from "@/server/auto-reorder";
import { audit, positive, requireUuid, shortText } from "./shared";

type ServiceJob = { id: string; assigned_to: string | null; status: string; project_id: string | null };

async function requireServiceAccess(
  client: import("pg").PoolClient,
  jobId: string,
  user: AuthenticatedUser,
  lock = false,
): Promise<ServiceJob> {
  const result = await client.query<ServiceJob>(
    `SELECT id,assigned_to,status,project_id FROM field_service_jobs WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    [jobId],
  );
  if (!result.rowCount) throw new HttpError(404, "SERVICE_JOB_NOT_FOUND", "Field-service job not found.");
  const job = result.rows[0];
  if (user.role === "viewer" && job.assigned_to !== user.id) {
    throw new HttpError(403, "FORBIDDEN", "Only the assigned field technician can access this work order.");
  }
  return job;
}

export async function listServiceWork(jobId: string, user: AuthenticatedUser) {
  const job = await getPool().query(
    "SELECT s.*,a.asset_tag,a.name AS asset_name,a.customer_site,p.code AS project_code,u.display_name AS technician_name " +
      "FROM field_service_jobs s JOIN engineering_assets a ON a.id=s.asset_id LEFT JOIN projects p ON p.id=s.project_id " +
      "LEFT JOIN users u ON u.id=s.assigned_to WHERE s.id=$1",
    [jobId],
  );
  if (!job.rowCount) throw new HttpError(404, "SERVICE_JOB_NOT_FOUND", "Field-service job not found.");
  if (user.role === "viewer" && job.rows[0].assigned_to !== user.id) {
    throw new HttpError(403, "FORBIDDEN", "Only the assigned field technician can access this work order.");
  }
  const [parts, updates, programs, installs] = await Promise.all([
    getPool().query(
      "SELECT p.id,p.action,p.quantity::text,p.location,p.bin,p.notes,p.created_at AS \"createdAt\",i.sku,i.name AS \"itemName\",u.display_name AS \"actorName\" " +
        "FROM field_service_parts p JOIN inventory_items i ON i.id=p.item_id JOIN users u ON u.id=p.actor_id " +
        "WHERE p.service_job_id=$1 ORDER BY p.created_at DESC",
      [jobId],
    ),
    getPool().query(
      "SELECT e.id,e.update_type AS \"updateType\",e.status,e.notes,e.created_at AS \"createdAt\",u.display_name AS \"actorName\" " +
        "FROM field_service_updates e JOIN users u ON u.id=e.actor_id WHERE e.service_job_id=$1 ORDER BY e.created_at DESC LIMIT 200",
      [jobId],
    ),
    getPool().query(
      "SELECT r.id AS revision_id,d.id AS document_id,d.title,d.kind,r.revision,r.status, " +
        "r.file_name AS \"fileName\",r.byte_size AS \"fileSize\",r.sha256 " +
        "FROM engineering_documents d JOIN engineering_revisions r ON r.document_id=d.id " +
        "WHERE (d.asset_id=$1 OR (d.asset_id IS NULL AND d.project_id=$2)) " +
        "AND d.kind IN ('plc','hmi') AND r.status='approved' " +
        "ORDER BY d.kind,d.title,r.created_at DESC",
        [job.rows[0].asset_id, job.rows[0].project_id],
    ),
    getPool().query(
        "SELECT i.id,i.result,i.notes,i.performed_at,u.display_name AS technician,r.revision,d.title AS document_title " +
          "FROM field_program_installs i JOIN engineering_revisions r ON r.id=i.revision_id " +
          "JOIN engineering_documents d ON d.id=r.document_id JOIN users u ON u.id=i.performed_by " +
          "WHERE i.service_job_id=$1 ORDER BY i.performed_at DESC LIMIT 100",
        [jobId],
    ),
  ]);
  return { job: job.rows[0], parts: parts.rows, updates: updates.rows, approvedPrograms: programs.rows, installs: installs.rows };
}

export async function listServiceInstalls(jobId: string, user: AuthenticatedUser) {
  return inTransaction(async (client) => {
    await requireServiceAccess(client, jobId, user, true);
    const installs = await client.query(
      "SELECT i.id,i.result,i.notes,i.performed_at,u.display_name AS technician," +
        "r.revision,r.file_name,r.sha256,d.kind,d.title AS document_title " +
        "FROM field_program_installs i JOIN engineering_revisions r ON r.id=i.revision_id " +
        "JOIN engineering_documents d ON d.id=r.document_id JOIN users u ON u.id=i.performed_by " +
        "WHERE i.service_job_id=$1 ORDER BY i.performed_at DESC LIMIT 100",
      [jobId],
    );
    return { installs: installs.rows };
  });
}

export async function recordServicePart(jobId: string, body: Record<string, unknown>, user: AuthenticatedUser) {
  const action = body.action;
  if (action !== "used" && action !== "returned") throw new HttpError(400, "INVALID_ACTION", "Choose used or returned.");
  const sku = shortText(body.sku, "sku", 64).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(sku)) throw new HttpError(400, "INVALID_SKU", "Provide a valid inventory SKU.");
  const quantity = positive(body.quantity, "quantity");
  const location = shortText(body.location, "location", 160);
  const bin = shortText(body.bin, "bin", 100);
  const notes = body.notes === undefined || body.notes === "" ? "" : shortText(body.notes, "notes", 1000);
  const key = shortText(body.idempotencyKey, "idempotencyKey", 128);
  if (key.length < 8) throw new HttpError(400, "INVALID_KEY", "An idempotency key of at least 8 characters is required.");
  return inTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["service-part:" + key]);
    const job = await requireServiceAccess(client, jobId, user, true);
    const previous = await client.query<{
      id: string; service_job_id: string; item_id: string; action: string; location: string; bin: string; notes: string;
    }>(
      "SELECT id,service_job_id,item_id,action,location,bin,notes FROM field_service_parts WHERE idempotency_key=$1",
      [key],
    );
    if (previous.rowCount) {
      const row = previous.rows[0];
      const amount = await client.query<{ matches: boolean }>(
        "SELECT quantity=$1::numeric AS matches FROM field_service_parts WHERE id=$2",
        [quantity, row.id],
      );
      const item = await client.query<{ id: string }>("SELECT id FROM inventory_items WHERE sku=$1", [sku]);
      if (row.service_job_id !== jobId || row.item_id !== item.rows[0]?.id || row.action !== action ||
          row.location !== location || row.bin !== bin || row.notes !== notes || !amount.rows[0].matches) {
        throw new HttpError(409, "KEY_REUSED", "The idempotency key was already used for different part details.");
      }
      return { id: row.id, replayed: true };
    }

    if (job.status === "completed") throw new HttpError(409, "JOB_CLOSED", "Parts cannot be recorded on a completed work order.");
    const item = await client.query<{ id: string }>(
      "SELECT id FROM inventory_items WHERE sku=$1 AND organization_id=$2 AND is_active=true FOR UPDATE",
      [sku,user.organizationId],
    );
    if (!item.rowCount) throw new HttpError(404, "ITEM_NOT_FOUND", "Active inventory item not found.");
    let movement: { id: string };
    if (action === "used") {
      await deductAvailableStock(client, item.rows[0].id, location, bin, quantity, user.id, {
        kind: "field_service_job", id: jobId, projectId: job.project_id ?? undefined,
      });
      const result = await client.query<{ id: string }>(
        "INSERT INTO inventory_movements(item_id,movement_type,quantity_delta,from_location,from_bin,reference,actor_user_id,idempotency_key) " +
          "VALUES($1,'issue',-$2::numeric,$3,$4,$5,$6,$7) RETURNING id",
        [item.rows[0].id, quantity, location, bin, `Field service ${jobId}`, user.id, `service-part:${key}`],
      );
      movement = result.rows[0];
      await evaluateAutoReorder(client,user.organizationId,item.rows[0].id,user.id);
    } else {
      const used = await client.query<{ available: boolean }>(
        "SELECT COALESCE(SUM(CASE WHEN action='used' THEN quantity ELSE -quantity END),0)>=$1::numeric AS available " +
          "FROM field_service_parts WHERE service_job_id=$2 AND item_id=$3 AND location=$4 AND bin=$5",
        [quantity, jobId, item.rows[0].id, location, bin],
      );
      if (!used.rows[0].available) throw new HttpError(409, "RETURN_EXCEEDS_USAGE", "Returned quantity cannot exceed parts previously used from this bin.");
      const stock = await client.query(
        "UPDATE inventory_stock SET on_hand=on_hand+$1::numeric,updated_at=now(),updated_by=$2 " +
          "WHERE item_id=$3 AND location=$4 AND bin=$5 RETURNING id",
        [quantity, user.id, item.rows[0].id, location, bin],
      );
      if (!stock.rowCount) throw new HttpError(404, "STOCK_NOT_FOUND", "The return location/bin does not exist for this item.");
      const result = await client.query<{ id: string }>(
        "INSERT INTO inventory_movements(item_id,movement_type,quantity_delta,to_location,to_bin,reference,actor_user_id,idempotency_key) " +
          "VALUES($1,'receipt',$2::numeric,$3,$4,$5,$6,$7) RETURNING id",
        [item.rows[0].id, quantity, location, bin, `Field service return ${jobId}`, user.id, `service-part:${key}`],
      );
      movement = result.rows[0];
    }
    const record = await client.query<{ id: string }>(
      "INSERT INTO field_service_parts(service_job_id,item_id,action,quantity,location,bin,inventory_movement_id,idempotency_key,notes,actor_id) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
      [jobId, item.rows[0].id, action, quantity, location, bin, movement.id, key, notes, user.id],
    );
    await audit(client, user, `field_service.part.${action}`, "field_service_job", jobId, {
      partId: record.rows[0].id, sku, quantity, location, bin,
    });
    await audit(client, user, action === "used" ? "inventory.issue" : "inventory.receipt", "inventory_item", item.rows[0].id, {
      serviceJobId: jobId, sku, quantity, location, bin,
    });
    return { id: record.rows[0].id, replayed: false };
  });
}

export async function recordServiceUpdate(jobId: string, body: Record<string, unknown>, user: AuthenticatedUser) {
  const type = body.updateType;
  if (type !== "note" && type !== "outcome" && type !== "status") {
    throw new HttpError(400, "INVALID_UPDATE_TYPE", "Choose note, outcome, or status.");
  }
  const notes = shortText(body.notes, "notes", 2000);
  const status = type === "status" ? body.status : null;
  if (type === "status" && status !== "scheduled" && status !== "in_progress" && status !== "completed") {
    throw new HttpError(400, "INVALID_STATUS", "Choose a valid field-service status.");
  }
  if (type !== "status" && body.status !== undefined && body.status !== null) {
    throw new HttpError(400, "INVALID_STATUS", "Status can only be set by a status update.");
  }
  return inTransaction(async (client) => {
    const job = await requireServiceAccess(client, jobId, user, true);
    if (type === "status") {
      const allowed: Record<string, string[]> = {
        open: ["scheduled", "in_progress"],
        scheduled: ["in_progress"],
        in_progress: ["completed"],
      };
      if (!allowed[job.status]?.includes(status as string)) {
        throw new HttpError(409, "INVALID_TRANSITION", `A ${job.status} work order cannot change to ${String(status)}.`);
      }
      await client.query("UPDATE field_service_jobs SET status=$2 WHERE id=$1", [jobId, status]);
    } else if (job.status === "completed") {
      throw new HttpError(409, "JOB_CLOSED", "Completed work orders cannot be updated.");
    }
    const result = await client.query<{ id: string }>(
      "INSERT INTO field_service_updates(service_job_id,update_type,status,notes,actor_id) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [jobId, type, status, notes, user.id],
    );
    await audit(client, user, `field_service.${type}`, "field_service_job", jobId, {
      updateId: result.rows[0].id, status, notes,
    });
    return { id: result.rows[0].id, status };
  });
}

export function serviceJobId(value: unknown): string {
  return requireUuid(value, "serviceJobId");
}
