import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { inTransaction, getPool } from "@/server/db";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { audit, operationsError, positive, requireUuid, shortText } from "@/server/operations";
import { deductAvailableStock } from "@/server/inventory-allocation";

type Context = {params:Promise<{id:string}>};
const KINDS = ["start","hold","resume","progress","scrap","complete","note","material"] as const;
type Kind = typeof KINDS[number];

async function handleGET(request:Request,{params}:Context) {
  try {
    await requireUser(request);
    const {id}=await params;
    const result=await getPool().query(
      "SELECT e.id,e.kind,e.quantity::text,e.notes,e.created_at,u.display_name AS actor_name,i.sku " +
      "FROM production_events e JOIN users u ON u.id=e.actor_id " +
      "LEFT JOIN inventory_items i ON i.id=e.item_id WHERE e.job_id=$1 ORDER BY e.created_at DESC LIMIT 100",
      [requireUuid(id)],
    );
    return NextResponse.json({events:result.rows},{headers:{"Cache-Control":"no-store"}});
  } catch(error) { return errorResponse(error); }
}

async function handlePOST(request:Request,{params}:Context) {
  try {
    requireSameOrigin(request);
    const user=await requireUser(request);
    requireRole(user,"admin","operator");
    const {id}=await params;
    const jobId=requireUuid(id);
    const body=await readJson(request);
    const kind=body.kind;
    if (typeof kind!=="string" || !KINDS.includes(kind as Kind))
      throw new HttpError(400,"INVALID_EVENT","Select a valid production action.");
    const action=kind as Kind;
    const key=shortText(body.idempotencyKey,"idempotencyKey",90);
    if (key.length<8) throw new HttpError(400,"INVALID_KEY","An idempotency key of at least 8 characters is required.");
    const notes=body.notes===undefined ? "" : (typeof body.notes==="string" && body.notes.length<=1000 ? body.notes.trim() : (()=>{throw new HttpError(400,"INVALID_NOTES","Notes too long.");})());
    const quantity=action==="progress"||action==="scrap"||action==="material" ? positive(body.quantity,"quantity") : "0";
    const sku=action==="material" ? shortText(body.sku,"sku",64).toUpperCase() : null;
    const location=action==="material" ? shortText(body.location,"location",160) : null;
    const bin=action==="material" ? shortText(body.bin,"bin",100) : null;

    const result=await inTransaction(async client=>{
      // Serializes concurrent requests with the same key before stock adjustments.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[key]);
      const previous=await client.query<{
        id:string;job_id:string;kind:string;quantity:string;sku:string|null;
        location:string|null;bin:string|null;notes:string;
      }>(
        "SELECT e.id,e.job_id,e.kind,e.quantity::text,e.location,e.bin,e.notes,i.sku " +
        "FROM production_events e LEFT JOIN inventory_items i ON i.id=e.item_id " +
        "WHERE e.idempotency_key=$1",[key],
      );
      if(previous.rowCount) {
        const row=previous.rows[0];
        if(row.job_id!==jobId||row.kind!==action||Number(row.quantity)!==Number(quantity)||
          row.sku!==sku||row.location!==location||row.bin!==bin||row.notes!==notes)
          throw new HttpError(409,"KEY_REUSED","The idempotency key was already used for another event.");
        return {id:row.id,replayed:true};
      }
      const found=await client.query<{status:string;job_code:string;planned_qty:string;completed_qty:string;scrap_qty:string;project_id:string}>(
        "SELECT status,job_code,planned_qty::text,completed_qty::text,scrap_qty::text,project_id FROM production_jobs WHERE id=$1 FOR UPDATE",[jobId],
      );
      if(!found.rowCount) throw new HttpError(404,"NOT_FOUND","Production job not found.");
      const job=found.rows[0];
      const transition: Partial<Record<Kind,string>> = {start:"queued",hold:"in_progress",resume:"on_hold",complete:"in_progress"};
      if(transition[action] && job.status!==transition[action])
        throw new HttpError(409,"INVALID_TRANSITION","This action is not valid while the job is "+job.status+".");
      if(["progress","scrap","material"].includes(action) && job.status!=="in_progress")
        throw new HttpError(409,"INVALID_TRANSITION","Start the job before recording activity.");
      if (job.status==="completed" && action!=="note")
        throw new HttpError(409,"JOB_CLOSED","Completed jobs cannot be modified.");

      let itemId:string|null=null, movementId:string|null=null;
      if(action==="progress"||action==="scrap") {
        const col=action==="progress"?"completed_qty":"scrap_qty";
        const updated=await client.query(
          "UPDATE production_jobs SET "+col+"="+col+"+$2::numeric WHERE id=$1 AND completed_qty+scrap_qty+$2::numeric<=planned_qty RETURNING id",
          [jobId,quantity],
        );
        if(!updated.rowCount) throw new HttpError(409,"EXCEEDS_PLAN","Production count would exceed the planned quantity.");
      }
      if(action==="complete") {
        const updated=await client.query(
          "UPDATE production_jobs SET status='completed' WHERE id=$1 AND completed_qty+scrap_qty=planned_qty RETURNING id",[jobId],
        );
        if(!updated.rowCount) throw new HttpError(409,"INCOMPLETE_QTY","Record all produced or scrapped units before closing the job.");
        await client.query(
          "UPDATE production_job_assignments SET is_active=false,ended_at=now() WHERE production_job_id=$1 AND is_active",
          [jobId],
        );
      } else if(["start","hold","resume"].includes(action)) {
        const status=action==="hold"?"on_hold":"in_progress";
        await client.query("UPDATE production_jobs SET status=$2 WHERE id=$1",[jobId,status]);
      }
      if(action==="material") {
        if(!sku||!location||!bin) throw new HttpError(400,"INVALID_MATERIAL","Material issues require an SKU, location, and bin.");
        const item=await client.query<{id:string}>("SELECT id FROM inventory_items WHERE sku=$1 AND is_active=true",[sku]);
        if(!item.rowCount) throw new HttpError(404,"SKU_NOT_FOUND","Inventory SKU not found.");
        itemId=item.rows[0].id;
        await deductAvailableStock(client,itemId,location,bin,quantity,user.id,{
          kind:"production_job",id:jobId,projectId:job.project_id,
        });
        const move=await client.query<{id:string}>(
          "INSERT INTO inventory_movements (item_id,movement_type,quantity_delta,from_location,from_bin,reference,actor_user_id,idempotency_key) " +
          "VALUES ($1,'issue',-$2::numeric,$3,$4,$5,$6,$7) RETURNING id",
          [itemId,quantity,location,bin,"Production "+job.job_code,user.id,"production:"+key],
        );
        movementId=move.rows[0].id;
        await audit(client,user,"inventory.issue","inventory_item",itemId,{productionJob:jobId,sku,quantity,location,bin});
      }
      const event=await client.query<{id:string}>(
        "INSERT INTO production_events (job_id,kind,quantity,notes,item_id,location,bin,inventory_movement_id,actor_id,idempotency_key) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
        [jobId,action,quantity,notes,itemId,location,bin,movementId,user.id,key],
      );
      await audit(client,user,"production."+action,"production_job",jobId,{eventId:event.rows[0].id,quantity,sku});
      return {id:event.rows[0].id,replayed:false};
    });
    return NextResponse.json(result,{status:result.replayed?200:201});
  } catch(error) { return errorResponse(operationsError(error)); }
}

export const GET = withOrganizationRoute(handleGET);
export const POST = withOrganizationRoute(handlePOST);
