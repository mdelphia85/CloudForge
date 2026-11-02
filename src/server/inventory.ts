import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import type { AuthenticatedUser } from "@/server/auth";

export type InventoryItem = {
  sku: string;
  name: string;
  category: string;
  location: string;
  bin: string;
  onHand: string;
  reorder: string;
  unit: string;
  state: "Healthy" | "Low stock" | "Out of stock";
  updated: string;
};

export type ItemInput = {
  sku: string;
  name: string;
  category: string;
  location: string;
  bin: string;
  onHand: string;
  reorder: string;
  unit: string;
};

export type MovementInput = {
  type: "receipt" | "issue" | "transfer" | "count";
  sku: string;
  quantity: string;
  location?: string;
  bin?: string;
  sourceLocation?: string;
  sourceBin?: string;
  destinationLocation?: string;
  destinationBin?: string;
  reference?: string;
  idempotencyKey: string;
};

const numericPattern = /^\d{1,12}(?:\.\d{1,3})?$/;
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : null;

export function parseItemInput(value: Record<string, unknown>): ItemInput {
  const sku = text(value.sku, 64)?.toUpperCase();
  const name = text(value.name, 200);
  const category = text(value.category, 100);
  const location = text(value.location, 160);
  const bin = text(value.bin, 100);
  const unit = text(value.unit, 32);
  const onHand = typeof value.onHand === "string" || typeof value.onHand === "number" ? String(value.onHand) : "";
  const reorder = typeof value.reorder === "string" || typeof value.reorder === "number" ? String(value.reorder) : "";

  if (!sku || !/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(sku)
    || !name || !category || !location || !bin || !unit
    || !numericPattern.test(onHand) || !numericPattern.test(reorder)) {
    throw new HttpError(400, "INVALID_ITEM", "Provide a valid SKU, item details, location, bin, unit, and non-negative quantities (up to 3 decimal places).");
  }
  return { sku, name, category, location, bin, unit, onHand, reorder };
}

export function parseMovementInput(
  value: Record<string, unknown>,
  idempotencyKey: string | null,
): MovementInput {
  const type = value.type;
  const sku = text(value.sku, 64)?.toUpperCase();
  const quantity = typeof value.quantity === "string" || typeof value.quantity === "number" ? String(value.quantity) : "";
  const key = idempotencyKey ?? text(value.idempotencyKey, 128);

  if (!["receipt", "issue", "transfer", "count"].includes(String(type))
    || !sku || !/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(sku)
    || !numericPattern.test(quantity)
    || !key || key.length < 8 || key.length > 128) {
    throw new HttpError(400, "INVALID_MOVEMENT", "Provide a valid movement type, SKU, quantity, and idempotency key.");
  }

  const fields = {
    location: text(value.location, 160) ?? undefined,
    bin: text(value.bin, 100) ?? undefined,
    sourceLocation: text(value.sourceLocation, 160) ?? undefined,
    sourceBin: text(value.sourceBin, 100) ?? undefined,
    destinationLocation: text(value.destinationLocation, 160) ?? undefined,
    destinationBin: text(value.destinationBin, 100) ?? undefined,
    reference: text(value.reference, 160) ?? undefined,
  };
  if (type === "transfer" && (!fields.sourceLocation || !fields.sourceBin || !fields.destinationLocation || !fields.destinationBin)) {
    throw new HttpError(400, "INVALID_MOVEMENT", "Transfers require source and destination locations and bins.");
  }
  if (type === "transfer" && fields.sourceLocation === fields.destinationLocation && fields.sourceBin === fields.destinationBin) {
    throw new HttpError(400, "INVALID_MOVEMENT", "Transfer source and destination must be different.");
  }
  if ((type === "receipt" || type === "count") && (!fields.location || !fields.bin)) {
    throw new HttpError(400, "INVALID_MOVEMENT", "Receipts and counts require a location and bin.");
  }
  if (type === "issue" && (!fields.sourceLocation || !fields.sourceBin)) {
    throw new HttpError(400, "INVALID_MOVEMENT", "Issues require a source location and bin.");
  }
  if (type !== "count" && Number(quantity) <= 0) {
    throw new HttpError(400, "INVALID_MOVEMENT", "Movement quantity must be greater than zero.");
  }
  return { type: type as MovementInput["type"], sku, quantity, idempotencyKey: key, ...fields };
}

export async function listInventory(): Promise<InventoryItem[]> {
  const result = await getPool().query<InventoryItem>(
    `SELECT i.sku, i.name, i.category, s.location, s.bin,
            s.on_hand::text AS "onHand", i.reorder_point::text AS reorder, i.unit,
            CASE WHEN s.on_hand = 0 THEN 'Out of stock'
                 WHEN s.on_hand <= i.reorder_point THEN 'Low stock'
                 ELSE 'Healthy' END AS state,
            floor(extract(epoch FROM s.updated_at) * 1000)::text AS updated
       FROM inventory_stock s
       JOIN inventory_items i ON i.id = s.item_id
      ORDER BY i.name, s.location, s.bin`,
  );
  return result.rows;
}

export async function createInventoryItem(input: ItemInput, user: AuthenticatedUser): Promise<void> {
  await inTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO inventory_items (sku, name, category, unit, reorder_point, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.sku, input.name, input.category, input.unit, input.reorder, user.id],
    );
    const itemId = inserted.rows[0].id;
    await client.query(
      `INSERT INTO inventory_stock (item_id, location, bin, on_hand, updated_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [itemId, input.location, input.bin, input.onHand, user.id],
    );
    if (Number(input.onHand) > 0) {
      await client.query(
        `INSERT INTO inventory_movements
          (item_id, movement_type, quantity_delta, to_location, to_bin, reference, actor_user_id, idempotency_key)
         VALUES ($1, 'opening', $2, $3, $4, 'Opening balance', $5, $6)`,
        [itemId, input.onHand, input.location, input.bin, user.id, randomUUID()],
      );
    }
    await writeAudit(client, user.id, "inventory.item.created", "inventory_item", itemId, { sku: input.sku });
  });
}

export async function createMovement(input: MovementInput, user: AuthenticatedUser): Promise<void> {
  await inTransaction(async (client) => {
    const itemResult = await client.query<{ id: string }>(
      "SELECT id FROM inventory_items WHERE sku = $1 AND is_active = true",
      [input.sku],
    );
    const itemId = itemResult.rows[0]?.id;
    if (!itemId) throw new HttpError(404, "ITEM_NOT_FOUND", "Inventory item was not found.");

    let delta = input.quantity;
    const fromLocation = input.sourceLocation;
    const fromBin = input.sourceBin;
    let toLocation = input.location;
    let toBin = input.bin;

    if (input.type === "receipt") {
      await client.query(
        `INSERT INTO inventory_stock (item_id, location, bin, on_hand, updated_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (item_id, location, bin)
         DO UPDATE SET on_hand = inventory_stock.on_hand + EXCLUDED.on_hand,
                       updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [itemId, input.location, input.bin, input.quantity, user.id],
      );
    } else if (input.type === "issue" || input.type === "transfer") {
      const source = await client.query(
        `UPDATE inventory_stock
            SET on_hand = on_hand - $1, updated_at = now(), updated_by = $2
          WHERE item_id = $3 AND location = $4 AND bin = $5 AND on_hand >= $1
          RETURNING id`,
        [input.quantity, user.id, itemId, input.sourceLocation, input.sourceBin],
      );
      if (source.rowCount !== 1) {
        throw new HttpError(409, "INSUFFICIENT_STOCK", "The source bin does not contain enough stock.");
      }
      delta = `-${input.quantity}`;
      if (input.type === "transfer") {
        await client.query(
          `INSERT INTO inventory_stock (item_id, location, bin, on_hand, updated_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (item_id, location, bin)
           DO UPDATE SET on_hand = inventory_stock.on_hand + EXCLUDED.on_hand,
                         updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [itemId, input.destinationLocation, input.destinationBin, input.quantity, user.id],
        );
        toLocation = input.destinationLocation;
        toBin = input.destinationBin;
      } else {
        toLocation = undefined;
        toBin = undefined;
      }
    } else {
      const currentBalance = await client.query<{ onHand: string }>(
        `SELECT on_hand::text AS "onHand" FROM inventory_stock
          WHERE item_id = $1 AND location = $2 AND bin = $3 FOR UPDATE`,
        [itemId, input.location, input.bin],
      );
      if (currentBalance.rowCount !== 1) {
        throw new HttpError(404, "STOCK_NOT_FOUND", "No stock balance exists at that location and bin.");
      }
      await client.query(
        `UPDATE inventory_stock
            SET on_hand = $1, updated_at = now(), updated_by = $2
          WHERE item_id = $3 AND location = $4 AND bin = $5`,
        [input.quantity, user.id, itemId, input.location, input.bin],
      );
      const change = await client.query<{ delta: string }>(
        "SELECT ($1::numeric - $2::numeric)::text AS delta",
        [input.quantity, currentBalance.rows[0].onHand],
      );
      delta = change.rows[0].delta;
    }

    await client.query(
      `INSERT INTO inventory_movements
        (item_id, movement_type, quantity_delta, from_location, from_bin, to_location, to_bin,
         reference, actor_user_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [itemId, input.type, delta, fromLocation, fromBin, toLocation, toBin, input.reference ?? null, user.id, input.idempotencyKey],
    );
    await writeAudit(client, user.id, `inventory.${input.type}`, "inventory_item", itemId, {
      sku: input.sku,
      quantityDelta: delta,
      fromLocation,
      fromBin,
      toLocation,
      toBin,
    });
  });
}

export async function listMovements(sku: string) {
  const result = await getPool().query(
    `SELECT m.movement_type AS type, m.quantity_delta::text AS "quantityDelta",
            m.from_location AS "fromLocation", m.from_bin AS "fromBin",
            m.to_location AS "toLocation", m.to_bin AS "toBin",
            m.reference, floor(extract(epoch FROM m.created_at) * 1000)::text AS "createdAt",
            u.display_name AS "actorName"
       FROM inventory_movements m
       JOIN inventory_items i ON i.id = m.item_id
       JOIN users u ON u.id = m.actor_user_id
      WHERE i.sku = $1
      ORDER BY m.created_at DESC
      LIMIT 50`,
    [sku],
  );
  return result.rows;
}

async function writeAudit(
  client: PoolClient,
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [actorId, action, entityType, entityId, JSON.stringify(details)],
  );
}
