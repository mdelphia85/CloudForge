import "server-only";
import type { PoolClient } from "pg";
import { HttpError } from "@/server/errors";

export type ReorderConfig = {
  enabled: boolean;
  reorderPoint: string;
  replenishQuantity: string;
};

const quantityPattern = /^\d{1,12}(?:\.\d{1,3})?$/;
function quantity(value: unknown, field: string): string {
  const raw = typeof value === "number" || typeof value === "string" ? String(value) : "";
  if (!quantityPattern.test(raw)) {
    throw new HttpError(400, "INVALID_REORDER_POLICY",
      field + " must be non-negative with at most three decimal places.");
  }
  return raw;
}

export function parseReorderConfig(input: Record<string, unknown>): ReorderConfig {
  if (typeof input.enabled !== "boolean") {
    throw new HttpError(400, "INVALID_REORDER_POLICY", "Auto Reorder must be enabled or disabled explicitly.");
  }
  const reorderPoint = quantity(input.reorderPoint, "Reorder point");
  const replenishQuantity = quantity(input.replenishQuantity, "Replenishment quantity");
  if (input.enabled && (Number(replenishQuantity) <= 0 || Number(reorderPoint) < 0)) {
    throw new HttpError(400, "INVALID_REORDER_POLICY",
      "Enabled Auto Reorder requires a positive replenishment quantity.");
  }
  return { enabled: input.enabled, reorderPoint, replenishQuantity };
}

/**
 * Requires the caller to hold a FOR UPDATE lock on inventory_items, ensuring
 * inventory changes and admin policy updates follow a consistent lock order.
 * The purchase request is an INTERNAL approval queue entry. No supplier order,
 * purchase order, payment, or outside communication is generated.
 */
export async function evaluateAutoReorder(
  client: PoolClient, organizationId: string, itemId: string, actorUserId: string,
): Promise<string | null> {
  const policy = await client.query<{
    sku: string; enabled: boolean; replenish: string; low: boolean;
  }>(
    `SELECT i.sku, i.auto_reorder_enabled AS enabled,
        i.auto_reorder_quantity::text AS replenish,
        (COALESCE(SUM(s.on_hand),0) <= i.reorder_point) AS low
      FROM inventory_items i
      LEFT JOIN inventory_stock s
        ON s.item_id=i.id AND s.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND i.id=$2 AND i.is_active
      GROUP BY i.id`,
    [organizationId,itemId],
  );
  const row = policy.rows[0];
  if (!row || !row.enabled || !row.low || Number(row.replenish) <= 0) return null;

  const inserted = await client.query<{id:string}>(
    `INSERT INTO purchase_requests
      (organization_id,item_id,quantity,reference,supplier,request_origin,created_by)
      VALUES($1,$2,$3,$4,'','auto_reorder',$5)
      ON CONFLICT (organization_id,item_id)
        WHERE request_origin='auto_reorder' AND status IN ('requested','ordered')
      DO NOTHING RETURNING id`,
    [organizationId,itemId,row.replenish,"AUTO-REORDER "+row.sku,actorUserId],
  );
  const requestId=inserted.rows[0]?.id;
  if (!requestId) return null;
  await client.query(
    `INSERT INTO audit_events
      (actor_user_id,organization_id,action,entity_type,entity_id,details)
      VALUES($1,$2,'inventory.auto_reorder_requested','purchase_request',$3,$4::jsonb)`,
    [actorUserId,organizationId,requestId,JSON.stringify({
      itemId,sku:row.sku,quantity:row.replenish,approved:false,
    })],
  );
  return requestId;
}

export async function saveAutoReorderConfig(
  client:PoolClient,
  organizationId:string, sku:string, actorUserId:string, config:ReorderConfig,
):Promise<{itemId:string;createdRequestId:string|null}> {
  const item=await client.query<{id:string;old_enabled:boolean}>(
    `SELECT id,auto_reorder_enabled AS old_enabled FROM inventory_items
      WHERE sku=$1 AND organization_id=$2 AND is_active FOR UPDATE`,
    [sku,organizationId],
  );
  if(!item.rowCount) throw new HttpError(404,"ITEM_NOT_FOUND","Inventory item was not found.");
  await client.query(
    `UPDATE inventory_items SET auto_reorder_enabled=$3,
      auto_reorder_quantity=$4,reorder_point=$5
      WHERE sku=$1 AND organization_id=$2`,
    [sku,organizationId,config.enabled,config.replenishQuantity,config.reorderPoint],
  );
  await client.query(
    `INSERT INTO audit_events
      (actor_user_id,organization_id,action,entity_type,entity_id,details)
      VALUES($1,$2,'inventory.auto_reorder_configured','inventory_item',$3,$4::jsonb)`,
    [actorUserId,organizationId,item.rows[0].id,JSON.stringify({
      enabled:config.enabled,reorderPoint:config.reorderPoint,
      replenishQuantity:config.replenishQuantity,
    })],
  );
  const createdRequestId=config.enabled
    ? await evaluateAutoReorder(client,organizationId,item.rows[0].id,actorUserId)
    : null;
  return {itemId:item.rows[0].id,createdRequestId};
}
