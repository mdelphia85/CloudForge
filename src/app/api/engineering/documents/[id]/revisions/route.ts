import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { getPool, inTransaction } from "@/server/db";
import { errorResponse, HttpError, requireSameOrigin } from "@/server/errors";
import { audit, operationsError, requireUuid, shortText } from "@/server/operations";

type Context={params:Promise<{id:string}>};
const MAX_UPLOAD_BYTES=50*1024*1024;

export async function GET(request:Request,{params}:Context) {
  try {
    await requireUser(request);
    const {id}=await params;
    const result=await getPool().query(
      "SELECT r.id,r.document_id,r.revision,r.file_name,r.content_type,r.byte_size,r.sha256," +
      "r.status,r.change_notes,r.created_at,r.approved_at,u.display_name AS uploaded_by_name " +
      "FROM engineering_revisions r JOIN users u ON u.id=r.uploaded_by " +
      "WHERE r.document_id=$1 ORDER BY r.revision DESC LIMIT 100",
      [requireUuid(id)],
    );
    return NextResponse.json({revisions:result.rows},{headers:{"Cache-Control":"no-store"}});
  } catch(error) {return errorResponse(error);}
}

export async function POST(request:Request,{params}:Context) {
  try {
    requireSameOrigin(request);
    const user=await requireUser(request);
    requireRole(user,"admin","operator");
    const {id}=await params;
    const documentId=requireUuid(id);
    const contentLength=Number(request.headers.get("content-length"));
    if(Number.isFinite(contentLength) && contentLength>MAX_UPLOAD_BYTES+16384)
      throw new HttpError(413,"FILE_TOO_LARGE","Files must be 50 MB or less.");
    const contentType=request.headers.get("content-type") ?? "";
    if(!contentType.startsWith("multipart/form-data"))
      throw new HttpError(415,"INVALID_UPLOAD","Use multipart/form-data.");
    const data=await request.formData();
    const file=data.get("file");
    if(!(file instanceof File) || file.size===0 || file.size>MAX_UPLOAD_BYTES)
      throw new HttpError(400,"INVALID_FILE","Select a nonempty file of 50 MB or less.");
    const original=file.name.split(/[\\/]/).pop()??"";
    if(original.length<1||original.length>180||/[\x00-\x1F\x7F]/.test(original)||original==="."||original==="..")
      throw new HttpError(400,"INVALID_NAME","File name is invalid.");
    const rawNotes=data.get("notes");
    const notes=typeof rawNotes==="string" && rawNotes.trim() ? shortText(rawNotes,"notes",1000) : "";
    const bytes=Buffer.from(await file.arrayBuffer());
    if(bytes.length>MAX_UPLOAD_BYTES) throw new HttpError(413,"FILE_TOO_LARGE","File exceeds 50 MB.");
    const sha256=createHash("sha256").update(bytes).digest("hex");
    const result=await inTransaction(async client=>{
      // Lock document row: two simultaneous uploads cannot use the same revision number.
      const doc=await client.query<{id:string}>(
        "SELECT id FROM engineering_documents WHERE id=$1 FOR UPDATE",[documentId],
      );
      if(!doc.rowCount) throw new HttpError(404,"DOCUMENT_NOT_FOUND","Document not found.");
      const next=await client.query<{revision:number}>(
        "SELECT COALESCE(max(revision),0)::int+1 AS revision FROM engineering_revisions WHERE document_id=$1",
        [documentId],
      );
      const revision=next.rows[0].revision;
      const inserted=await client.query<{id:string}>(
        "INSERT INTO engineering_revisions "+
        "(document_id,revision,file_name,content_type,byte_size,sha256,file_data,change_notes,uploaded_by) "+
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
        [documentId,revision,original,"application/octet-stream",bytes.length,sha256,bytes,notes,user.id],
      );
      await audit(client,user,"engineering.revision_uploaded","engineering_document",documentId,
        {revisionId:inserted.rows[0].id,revision,fileName:original,sha256,byteSize:bytes.length});
      return {id:inserted.rows[0].id,revision,sha256,status:"draft"};
    });
    return NextResponse.json(result,{status:201});
  } catch(error) { return errorResponse(operationsError(error)); }
}
