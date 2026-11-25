import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
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
    requireRole(user,"admin","operator");
    const {id}=await params;
    const jobId=requireUuid(id);
    const body=await readJson(request);
    const revisionId=requireUuid(body.revisionId,"revision ID");
    const outcome=body.result;
    if(typeof outcome!=="string"||!["installed","failed","rolled_back"].includes(outcome))
      throw new HttpError(400,"INVALID_RESULT","Choose installed, failed, or rolled_back.");
    const notes=body.notes===undefined || body.notes==="" ? "" : shortText(body.notes,"notes",1000);
    const result=await inTransaction(async client=>{
      const found=await client.query<{asset_id:string;project_id:string|null;status:string}>(
        "SELECT asset_id,project_id,status FROM field_service_jobs WHERE id=$1 FOR UPDATE",[jobId],
      );
      if(!found.rowCount) throw new HttpError(404,"NOT_FOUND","Service job not found.");
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
        "INSERT INTO field_program_installs (service_job_id,revision_id,result,notes,performed_by) " +
        "VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [jobId,revisionId,outcome,notes,user.id],
      );
      await audit(client,user,"field_service.program_install_recorded","field_service_job",jobId,
        {revisionId,outcome,recordId:inserted.rows[0].id});
      return {id:inserted.rows[0].id};
    });
    return NextResponse.json(result,{status:201});
  } catch(error) {return errorResponse(operationsError(error));}
}
