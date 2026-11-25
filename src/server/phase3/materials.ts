import "server-only";
import type { AuthenticatedUser } from "@/server/auth";
import { getPool, inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import { audit, positive, requireProject, requireUuid, shortText } from "./shared";

type ReservationKind = "project" | "production_job" | "field_service_job";

export async function listReservations() {
  const result = await getPool().query(
    "SELECT r.id,r.item_id,i.sku,i.name AS \"itemName\",r.location,r.bin,r.quantity::text,r.consumed_qty::text AS \"consumedQty\", " +
      "r.status,r.project_id AS \"projectId\",p.code AS \"projectCode\",r.production_job_id AS \"productionJobId\", " +
      "j.job_code AS \"jobCode\",r.field_service_job_id AS \"fieldServiceJobId\",s.title AS \"serviceTitle\" " +
      "FROM inventory_reservations r JOIN inventory_items i ON i.id=r.item_id " +
      "LEFT JOIN projects p ON p.id=r.project_id LEFT JOIN production_jobs j ON j.id=r.production_job_id " +
      "LEFT JOIN field_service_jobs s ON s.id=r.field_service_job_id ORDER BY r.created_at DESC LIMIT 300",
  );
  return result.rows;
}

export async function createReservation(body: Record<string, unknown>, user: AuthenticatedUser) {
  const sku = shortText(body.sku, "sku", 64).toUpperCase();
  const quantity = positive(body.quantity, "quantity");
  const location = shortText(body.location, "location", 160);
  const bin = shortText(body.bin, "bin", 100);
  const key = shortText(body.idempotencyKey, "idempotencyKey", 128);
  if (key.length < 8) throw new HttpError(400, "INVALID_KEY", "An idempotency key of at least 8 characters is required.");
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(sku)) throw new HttpError(400, "INVALID_SKU", "Provide a valid inventory SKU.");

  const rawTarget = body.target;
  if (typeof rawTarget !== "object" || rawTarget === null || Array.isArray(rawTarget)) {
    throw new HttpError(400, "INVALID_TARGET", "Select a project, production job, or field-service job.");
  }
  const target = rawTarget as Record<string, unknown>;
  const kind = target.kind;
  if (kind !== "project" && kind !== "production_job" && kind !== "field_service_job") {
    throw new HttpError(400, "INVALID_TARGET", "Select a project, production job, or field-service job.");
  }
  const targetId = requireUuid(target.id, "targetId");
  const itemResult = await getPool().query<{ id: string }>(
    "SELECT id FROM inventory_items WHERE sku=$1 AND is_active=true",
    [sku],
  );
  if (!itemResult.rowCount) throw new HttpError(404, "ITEM_NOT_FOUND", "Inventory item not found or inactive.");
  const itemId = itemResult.rows[0].id;

  return inTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["reservation:" + key]);
    const previous = await client.query<{
      id: string; item_id: string; location: string; bin: string; quantity: string;
      project_id: string | null; production_job_id: string | null; field_service_job_id: string | null;
    }>(
      "SELECT id,item_id,location,bin,quantity::text,project_id,production_job_id,field_service_job_id " +
        "FROM inventory_reservations WHERE idempotency_key=$1",
      [key],
    );
    if (previous.rowCount) {
      const row = previous.rows[0];
      const quantityMatches = await client.query<{ matches: boolean }>(
        "SELECT quantity=$1::numeric AS matches FROM inventory_reservations WHERE id=$2",
        [quantity, row.id],
      );
      const expectedId = kind === "project" ? row.project_id :
        kind === "production_job" ? row.production_job_id : row.field_service_job_id;
      if (row.item_id !== itemId || row.location !== location || row.bin !== bin ||
          !quantityMatches.rows[0].matches || expectedId !== targetId) {
        throw new HttpError(409, "KEY_REUSED", "The reservation idempotency key was already used for different details.");
      }
      return { id: row.id, replayed: true };
    }

    if (kind === "project") {
      await requireProject(client, targetId);
    } else {
      const table = kind === "production_job" ? "production_jobs" : "field_service_jobs";
      const found = await client.query(`SELECT id FROM ${table} WHERE id=$1 FOR SHARE`, [targetId]);
      if (!found.rowCount) throw new HttpError(404, "TARGET_NOT_FOUND", "Reservation target not found.");
    }

    const stock = await client.query<{ on_hand: string }>(
      "SELECT on_hand::text FROM inventory_stock WHERE item_id=$1 AND location=$2 AND bin=$3 FOR UPDATE",
      [itemId, location, bin],
    );
    if (!stock.rowCount) throw new HttpError(409, "INSUFFICIENT_STOCK", "No stock exists in this location and bin.");
    const available = await client.query<{ sufficient: boolean }>(
      "SELECT $1::numeric-COALESCE(SUM(quantity-consumed_qty),0)>=$2::numeric AS sufficient " +
        "FROM inventory_reservations WHERE item_id=$3 AND location=$4 AND bin=$5 AND status='reserved'",
      [stock.rows[0].on_hand, quantity, itemId, location, bin],
    );
    if (!available.rows[0].sufficient) {
      throw new HttpError(409, "INSUFFICIENT_AVAILABLE_STOCK", "The requested quantity is not available after active reservations.");
    }

    const columns: Record<ReservationKind, string> = {
      project: "project_id",
      production_job: "production_job_id",
      field_service_job: "field_service_job_id",
    };
    const result = await client.query<{ id: string }>(
      `INSERT INTO inventory_reservations(item_id,location,bin,${columns[kind]},quantity,idempotency_key,created_by,updated_by) ` +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id",
      [itemId, location, bin, targetId, quantity, key, user.id],
    );
    await audit(client, user, "inventory.reserved", "inventory_reservation", result.rows[0].id, {
      itemId, sku, quantity, location, bin, targetKind: kind, targetId,
    });
    return { id: result.rows[0].id, replayed: false };
  });
}

export async function releaseReservation(id: string, user: AuthenticatedUser) {
  return inTransaction(async (client) => {
    const reservation = await client.query<{ status: string }>(
      "SELECT status FROM inventory_reservations WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!reservation.rowCount) throw new HttpError(404, "NOT_FOUND", "Reservation not found.");
    if (reservation.rows[0].status !== "reserved") {
      throw new HttpError(409, "RESERVATION_CLOSED", "Only active reservations can be released.");
    }
    await client.query(
      "UPDATE inventory_reservations SET status='released',updated_by=$2,updated_at=now() WHERE id=$1",
      [id, user.id],
    );
    await audit(client, user, "inventory.reservation_released", "inventory_reservation", id);
    return { id, status: "released" };
  });
}

export async function getMaterialShortages(projectId?: string) {
  const params = projectId ? [projectId] : [];
  const filter = projectId ? "WHERE p.id=$1" : "";
  const result = await getPool().query(
    `WITH current_revisions AS (
       SELECT DISTINCT ON (project_id) id,project_id FROM engineering_bom_revisions
       WHERE status='approved' ORDER BY project_id,created_at DESC,id DESC
     ), required AS (
       SELECT cr.project_id,l.item_id,sum(l.required_qty)::numeric AS required_qty
       FROM current_revisions cr JOIN engineering_bom_revision_lines l ON l.bom_revision_id=cr.id
       GROUP BY cr.project_id,l.item_id
     ), stock AS (
       SELECT item_id,sum(on_hand)::numeric AS on_hand FROM inventory_stock GROUP BY item_id
     ), reserved AS (
       SELECT r.item_id,coalesce(r.project_id,j.project_id,s.project_id) AS project_id,
         sum(r.quantity-r.consumed_qty)::numeric AS project_total
       FROM inventory_reservations r
       LEFT JOIN production_jobs j ON j.id=r.production_job_id
       LEFT JOIN field_service_jobs s ON s.id=r.field_service_job_id
       WHERE r.status='reserved'
       GROUP BY r.item_id,coalesce(r.project_id,j.project_id,s.project_id)
     ), reserved_total AS (
       SELECT item_id,sum(project_total)::numeric AS total FROM reserved GROUP BY item_id
     ), consumed AS (
       SELECT item_id,project_id,sum(quantity)::numeric AS quantity
       FROM (
         SELECT e.item_id,j.project_id,e.quantity
         FROM production_events e JOIN production_jobs j ON j.id=e.job_id
         WHERE e.kind='material' AND e.item_id IS NOT NULL
         UNION ALL
         SELECT part.item_id,s.project_id,
           CASE WHEN part.action='used' THEN part.quantity ELSE -part.quantity END AS quantity
         FROM field_service_parts part JOIN field_service_jobs s ON s.id=part.service_job_id
       ) uses
       WHERE project_id IS NOT NULL
       GROUP BY item_id,project_id
     ), inbound AS (
       SELECT coalesce(l.project_id,po.project_id) AS project_id,l.item_id,
         sum(l.ordered_qty-l.received_qty)::numeric AS incoming_qty
       FROM purchase_order_lines l JOIN purchase_orders po ON po.id=l.purchase_order_id
       WHERE po.status IN ('submitted','ordered','partially_received') AND l.ordered_qty>l.received_qty
       GROUP BY coalesce(l.project_id,po.project_id),l.item_id
     )
     SELECT p.id AS "projectId",p.code AS "projectCode",i.id AS "itemId",i.sku,i.name AS "itemName",
       r.required_qty::text AS "requiredQty",coalesce(s.on_hand,0)::text AS "onHand",
       coalesce(pr.project_total,0)::text AS "projectReserved",
       coalesce(c.quantity,0)::text AS "consumedQty",
       coalesce(inb.incoming_qty,0)::text AS "incomingQty",
       greatest(r.required_qty-coalesce(c.quantity,0)-coalesce(pr.project_total,0)-
         (coalesce(s.on_hand,0)-coalesce(rt.total,0))-
         coalesce(inb.incoming_qty,0),0)::text AS "shortageQty"
     FROM required r JOIN projects p ON p.id=r.project_id JOIN inventory_items i ON i.id=r.item_id
     LEFT JOIN stock s ON s.item_id=r.item_id
     LEFT JOIN reserved_total rt ON rt.item_id=r.item_id
     LEFT JOIN reserved pr ON pr.item_id=r.item_id AND pr.project_id=r.project_id
     LEFT JOIN consumed c ON c.item_id=r.item_id AND c.project_id=r.project_id
     LEFT JOIN inbound inb ON inb.project_id=r.project_id AND inb.item_id=r.item_id
     ${filter}
     ORDER BY p.code,i.sku`,
    params,
  );
  return result.rows;
}
