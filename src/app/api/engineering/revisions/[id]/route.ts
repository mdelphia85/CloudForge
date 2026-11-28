import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { getPool, inTransaction } from "@/server/db";
import { errorResponse, HttpError, requireSameOrigin } from "@/server/errors";
import { audit, operationsError, requireUuid } from "@/server/operations";
type Context={params:Promise<{id:string}>};

export async function GET(request:Request,{params}:Context) {
  try {
    const user=await requireUser(request);
    const {id}=await params;
    const revisionId=requireUuid(id);
    const result=await getPool().query<{
      id:string;document_id:string;file_name:string;sha256:string;kind:string;
      project_id:string|null;asset_id:string|null;status:string;uploaded_by:string;file_data:Buffer;byte_size:number
    }>(
      "SELECT r.id,r.document_id,r.file_name,r.sha256,d.kind,d.project_id,d.asset_id,"+
      "r.status,r.uploaded_by,r.file_data,r.byte_size FROM engineering_revisions r "+
      "JOIN engineering_documents d ON d.id=r.document_id WHERE r.id=$1",[revisionId],
    );
    if(!result.rowCount) throw new HttpError(404,"NOT_FOUND","Revision not found.");
    const row=result.rows[0];
    if(row.status==="approved") {
      if(user.role==="viewer") {
        const assigned=await getPool().query(
          "SELECT 1 FROM field_service_jobs s WHERE s.assigned_to=$1 AND s.status<>'completed' "+
          "AND $2 IN ('plc','hmi','electrical_schematic','mechanical_schematic') AND (s.asset_id=$3 OR ($3 IS NULL AND s.project_id=$4)) LIMIT 1",
          [user.id,row.kind,row.asset_id,row.project_id],
        );
        if(!assigned.rowCount) throw new HttpError(403,"FORBIDDEN","Approved programs are available only to technicians assigned to matching open service work.");
      } else {
        requireRole(user,"admin","operator");
      }
    } else if(user.role!=="admin" && row.uploaded_by!==user.id) {
      throw new HttpError(403,"NOT_APPROVED","Only approved engineering releases may be downloaded.");
    }
    await inTransaction(async client=>{
      await audit(client,user,"engineering.revision_download","engineering_document",row.document_id,
        {revisionId,sha256:row.sha256,status:row.status});
    });
    // Treat PLC/HMI files as opaque downloads. Never execute or render them.
    const safeName=row.file_name.replace(/["\\\r\n]/g,"_").slice(0,180);
    return new NextResponse(new Uint8Array(row.file_data),{
      status:200,
      headers:{
        "Content-Type":"application/octet-stream",
        "Content-Disposition":'attachment; filename="download"; filename*=UTF-8\u0027\u0027'+encodeURIComponent(safeName),
        "Content-Length":String(row.byte_size),
        "X-Content-Type-Options":"nosniff",
        "Cache-Control":"private, no-store, max-age=0",
        "X-File-SHA256":row.sha256,
      },
    });
  } catch(error) {return errorResponse(error);}
}

export async function PATCH(request:Request,{params}:Context) {
  try {
    requireSameOrigin(request);
    const user=await requireUser(request);
    requireRole(user,"admin");
    const {id}=await params;
    const revisionId=requireUuid(id);
    const result=await inTransaction(async client=>{
      const check=await client.query<{document_id:string}>(
        "SELECT document_id FROM engineering_revisions WHERE id=$1",[revisionId],
      );
      if(!check.rowCount) throw new HttpError(404,"NOT_FOUND","Revision not found.");
      const documentId=check.rows[0].document_id;
      await client.query("SELECT id FROM engineering_documents WHERE id=$1 FOR UPDATE",[documentId]);
      const revision=await client.query<{status:string;revision:number}>(
        "SELECT status,revision FROM engineering_revisions WHERE id=$1 FOR UPDATE",[revisionId],
      );
      if(revision.rows[0].status==="approved") return {id:revisionId,status:"approved",alreadyApproved:true};
      if(revision.rows[0].status!=="draft")
        throw new HttpError(409,"IMMUTABLE_REVISION","Superseded revisions cannot be approved again.");
      await client.query(
        "UPDATE engineering_revisions SET status='superseded' WHERE document_id=$1 AND status='approved'",
        [documentId],
      );
      await client.query(
        "UPDATE engineering_revisions SET status='approved',approved_at=now(),approved_by=$2 WHERE id=$1",
        [revisionId,user.id],
      );
      await audit(client,user,"engineering.revision_approved","engineering_document",documentId,
        {revisionId,revision:revision.rows[0].revision});
      return {id:revisionId,status:"approved",alreadyApproved:false};
    });
    return NextResponse.json(result);
  } catch(error) {return errorResponse(operationsError(error));}
}
