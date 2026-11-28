import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { getPool, inTransaction } from "@/server/db";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { evaluateAutoReorder, parseReorderConfig, saveAutoReorderConfig } from "@/server/auto-reorder";
import { withOrganizationRoute } from "@/server/tenant-context";

const SKU=/^[A-Z0-9][A-Z0-9._-]{0,63}$/;
function requestedSku(value:unknown):string {
  const sku=typeof value==="string"?value.trim().toUpperCase():"";
  if(!SKU.test(sku))throw new HttpError(400,"INVALID_SKU","Provide a valid item SKU.");
  return sku;
}

async function handleGET(request:Request) {
  try {
    const user=await requireUser(request);
    const result=await getPool().query(
      `SELECT pr.id, i.sku, i.name,pr.quantity::text AS quantity,
        pr.status,pr.created_at AS "createdAt",pr.reference,
        i.auto_reorder_enabled AS "autoReorderEnabled"
       FROM purchase_requests pr
       JOIN inventory_items i ON i.id=pr.item_id AND i.organization_id=pr.organization_id
      WHERE pr.organization_id=$1 AND pr.request_origin='auto_reorder'
      ORDER BY pr.created_at DESC LIMIT 200`,
      [user.organizationId],
    );
    return NextResponse.json({requests:result.rows},{headers:{"Cache-Control":"no-store"}});
  }catch(error){return errorResponse(error);}
}

// Save a single SKU's reorder settings. Disabling is immediate and cannot
// cancel or delete previously recorded purchasing requests.
async function handlePATCH(request:Request) {
  try {
    requireSameOrigin(request);
    const user=await requireUser(request);
    requireRole(user,"admin","operator");
    const input=await readJson(request);
    const sku=requestedSku(input.sku);
    const config=parseReorderConfig(input);
    const saved=await inTransaction(client=>saveAutoReorderConfig(
      client,user.organizationId,sku,user.id,config,
    ));
    return NextResponse.json({
      enabled:config.enabled,sku,reorderPoint:config.reorderPoint,
      replenishQuantity:config.replenishQuantity,
      createdRequestId:saved.createdRequestId,
    },{headers:{"Cache-Control":"no-store"}});
  }catch(error){return errorResponse(error);}
}

// Explicit reconciliation for stock changes made through manufacturing,
// maintenance, or other workflows. On ordinary inventory movements the same
// evaluation runs synchronously in the original transaction.
async function handlePOST(request:Request) {
  try {
    requireSameOrigin(request);
    const user=await requireUser(request);
    requireRole(user,"admin","operator");
    const body=await readJson(request);
    const sku=requestedSku(body.sku);
    const result=await inTransaction(async client=>{
      const item=await client.query<{id:string}>(
        "SELECT id FROM inventory_items WHERE organization_id=$1 AND sku=$2 AND is_active FOR UPDATE",
        [user.organizationId,sku],
      );
      if(!item.rowCount)throw new HttpError(404,"ITEM_NOT_FOUND","Inventory item was not found.");
      return evaluateAutoReorder(client,user.organizationId,item.rows[0].id,user.id);
    });
    return NextResponse.json({sku,createdRequestId:result},{headers:{"Cache-Control":"no-store"}});
  }catch(error){return errorResponse(error);}
}

export const GET=withOrganizationRoute(handleGET);
export const PATCH=withOrganizationRoute(handlePATCH);
export const POST=withOrganizationRoute(handlePOST);
