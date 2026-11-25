import "server-only";
import type { PoolClient } from "pg";
import { HttpError } from "@/server/errors";

export type ReservationTarget =
  | { kind: "project"; id: string }
  | { kind: "production_job"; id: string; projectId?: string }
  | { kind: "field_service_job"; id: string; projectId?: string };

const targetColumn: Record<ReservationTarget["kind"], string> = {
  project: "project_id",
  production_job: "production_job_id",
  field_service_job: "field_service_job_id",
};

export async function deductAvailableStock(
  client: PoolClient,
  itemId: string,
  location: string,
  bin: string,
  quantity: string,
  actorId: string,
  target?: ReservationTarget,
): Promise<void> {
  const stock = await client.query<{ id: string; on_hand: string }>(
    "SELECT id, on_hand::text FROM inventory_stock WHERE item_id=$1 AND location=$2 AND bin=$3 FOR UPDATE",
    [itemId, location, bin],
  );
  if (!stock.rowCount) {
    throw new HttpError(409, "INSUFFICIENT_STOCK", "No stock is available in this location and bin.");
  }

  const filter = !target ? "false" : target.kind === "project"
    ? "project_id=$4"
    : `(${targetColumn[target.kind]}=$4 OR ($5::uuid IS NOT NULL AND project_id=$5))`;
  const reservedParams = !target ? [itemId, location, bin] :
    target.kind === "project" ? [itemId, location, bin, target.id] :
      [itemId, location, bin, target.id, target.projectId ?? null];
  const reserved = await client.query<{ total: string; target: string }>(
    "SELECT COALESCE(SUM(quantity-consumed_qty),0)::text AS total, " +
      `COALESCE(SUM(quantity-consumed_qty) FILTER (WHERE ${filter}),0)::text AS target ` +
      "FROM inventory_reservations WHERE item_id=$1 AND location=$2 AND bin=$3 AND status='reserved'",
    reservedParams,
  );
  const available = await client.query<{ sufficient: boolean; onHandSufficient: boolean }>(
    "SELECT $1::numeric - ($2::numeric - $3::numeric) >= $4::numeric AS sufficient, " +
      "$1::numeric >= $4::numeric AS \"onHandSufficient\"",
    [stock.rows[0].on_hand, reserved.rows[0].total, reserved.rows[0].target, quantity],
  );
  if (!available.rows[0].sufficient) {
    if (!available.rows[0].onHandSufficient) {
      throw new HttpError(409, "INSUFFICIENT_STOCK", "The requested quantity exceeds the stock on hand.");
    }
    throw new HttpError(409, "INSUFFICIENT_AVAILABLE_STOCK", "The requested quantity is reserved or unavailable.");
  }

  await client.query(
    "UPDATE inventory_stock SET on_hand=on_hand-$2::numeric,updated_at=now(),updated_by=$3 WHERE id=$1",
    [stock.rows[0].id, quantity, actorId],
  );

  if (!target || Number(reserved.rows[0].target) === 0) return;
  const allocationPriority = target.kind === "project" ? "" : `CASE WHEN ${targetColumn[target.kind]}=$4 THEN 0 ELSE 1 END, `;
  const allocationFilter = target.kind === "project" ? "project_id=$4" :
    `(${targetColumn[target.kind]}=$4 OR ($5::uuid IS NOT NULL AND project_id=$5))`;
  const rows = await client.query<{ id: string; remaining: string }>(
    "SELECT id,(quantity-consumed_qty)::text AS remaining FROM inventory_reservations " +
      `WHERE item_id=$1 AND location=$2 AND bin=$3 AND status='reserved' AND ${allocationFilter} ` +
      `ORDER BY ${allocationPriority}created_at,id FOR UPDATE`,
    reservedParams,
  );
  let remaining = quantity;
  for (const row of rows.rows) {
    const allocation = await client.query<{ taken: string; remaining: string }>(
      "SELECT LEAST($1::numeric,$2::numeric)::text AS taken, " +
        "GREATEST($1::numeric-$2::numeric,0)::text AS remaining",
      [remaining, row.remaining],
    );
    const taken = allocation.rows[0].taken;
    if (Number(taken) === 0) continue;
    await client.query(
      "UPDATE inventory_reservations SET consumed_qty=consumed_qty+$2::numeric, " +
        "status=CASE WHEN consumed_qty+$2::numeric=quantity THEN 'consumed' ELSE status END, " +
        "updated_by=$3,updated_at=now() WHERE id=$1",
      [row.id, taken, actorId],
    );
    await client.query(
      "INSERT INTO audit_events(actor_user_id,action,entity_type,entity_id,details) " +
        "VALUES($1,'inventory.reservation_consumed','inventory_reservation',$2,$3::jsonb)",
      [actorId, row.id, JSON.stringify({ quantity: taken, itemId, location, bin, target })],
    );
    remaining = allocation.rows[0].remaining;
    if (Number(remaining) === 0) break;
  }
}
