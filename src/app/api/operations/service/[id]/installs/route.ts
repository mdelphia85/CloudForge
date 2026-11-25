import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireUser } from "@/server/auth";
import { getPool,inTransaction } from "@/server/db";
import { errorResponse,HttpError,readJson,requireSameOrigin } from "@/server/errors";
import { audit,operationsError,requireUuid,shortText } from "@/server/operations";
type Context={params:Promise<{id:string}>};

export async function GET(request:Request,{params}:Context) {
  try {
    await requireUser(request);
    const {id}=await params;
    const rows=await getPool().query(
      "SELECT i.id,i.result,i.notes,i.performed_at,u.display_name AS technician,"+
      "r.revision,r.file_name,r.sha256,d.kind,d.title AS document_title " +
      "FROM field_program_installs i JOIN engineering_revisions r ON r.id=i.revision_id " +
      "JOIN engineering_documents d ON d.id=r.document_id JOIN users u ON u.id=i.performed_by " +
      "WHERE i.service_job_id=$1 ORDER BY i.performed_at DESC LIMIT 100",[requireUuid(id)],
    );
    return NextResponse.json({installs:rows.rows},{headers:{"Cache-Control":"no-store"}});
  } catch(error) {return errorResponse(error);}
}

export async function POST(request:Request,{params}:Context) {
  try {
    requireSameOrigin(request);
    const user=await requireUser(request);
    const {id}=await params;
    const jobId=requireUuid(id);
    const body=await readJson(request);
    const revisionId=requireUuid(body.revisionId,"revision ID");
    const idempotencyKey=body.idempotencyKey===undefined
      ? randomUUID()
      : shortText(body.idempotencyKey,"idempotencyKey",128);
    if(idempotencyKey.length<8)
      throw new HttpError(400,"INVALID_KEY","An idempotency key of at least 8 characters is required.");
    const outcome=body.result;
    if(typeof outcome!=="string"||!["installed","failed","rolled_back"].includes(outcome))
      throw new HttpError(400,"INVALID_RESULT","Choose installed, failed, or rolled_back.");
    const notes=body.notes===undefined || body.notes==="" ? "" : shortText(body.notes,"notes",1000);
    const result=await inTransaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",["field-program-install:"+idempotencyKey]);
      const found=await client.query<{asset_id:string;project_id:string|null;status:string;assigned_to:string|null}>(
        "SELECT asset_id,project_id,status,assigned_to FROM field_service_jobs WHERE id=$1 FOR UPDATE",[jobId],
      );
      if(!found.rowCount) throw new HttpError(404,"NOT_FOUND","Service job not found.");
      if(user.role==="viewer"&&found.rows[0].assigned_to!==user.id)
        throw new HttpError(403,"FORBIDDEN","Only the assigned field technician can record this installation.");
      if(user.role!=="viewer"&&user.role!=="admin"&&user.role!=="operator")
        throw new HttpError(403,"FORBIDDEN","You do not have permission to record this installation.");
      const previous=await client.query<{
        id:string;service_job_id:string;revision_id:string;result:string;notes:string;
      }>(
        "SELECT id,service_job_id,revision_id,result,notes FROM field_program_installs WHERE idempotency_key=$1",
        [idempotencyKey],
      );
      if(previous.rowCount) {
        const row=previous.rows[0];
        if(row.service_job_id!==jobId||row.revision_id!==revisionId||row.result!==outcome||row.notes!==notes)
          throw new HttpError(409,"KEY_REUSED","The idempotency key was already used for a different installation record.");
        return {id:row.id,replayed:true};
      }
      if(found.rows[0].status==="completed")
        throw new HttpError(409,"JOB_CLOSED","Cannot record an installation on a completed service job.");
      const rev=await client.query<{status:string;asset_id:string|null;project_id:string|null;kind:string}>(
        "SELECT r.status,d.asset_id,d.project_id,d.kind "+
        "FROM engineering_revisions r JOIN engineering_documents d ON d.id=r.document_id WHERE r.id=$1",
        [revisionId],
      );
      if(!rev.rowCount) throw new HttpError(404,"REVISION_NOT_FOUND","Engineering revision not found.");
      const doc=rev.rows[0], job=found.rows[0];
      if(!["plc","hmi"].includes(doc.kind))
        throw new HttpError(400,"INVALID_DOCUMENT","Only PLC/HMI releases can be recorded as controller installs.");
      if(doc.status!=="approved")
        throw new HttpError(409,"NOT_APPROVED","Field service can install only approved program revisions.");
      if(doc.asset_id!==job.asset_id && !(doc.asset_id===null && doc.project_id!==null && doc.project_id===job.project_id))
        throw new HttpError(409,"WRONG_EQUIPMENT","The approved program is not associated with this equipment or its project.");
      const inserted=await client.query<{id:string}>(
        "INSERT INTO field_program_installs (service_job_id,revision_id,result,notes,performed_by,idempotency_key) " +
        "VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [jobId,revisionId,outcome,notes,user.id,idempotencyKey],
      );
      await audit(client,user,"field_service.program_install_recorded","field_service_job",jobId,
        {revisionId,outcome,recordId:inserted.rows[0].id});
      return {id:inserted.rows[0].id,replayed:false};
    });
    return NextResponse.json(result,{status:result.replayed?200:201});
  } catch(error) {return errorResponse(operationsError(error));}
}
