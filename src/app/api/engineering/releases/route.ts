import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { getPool } from "@/server/db";
import { errorResponse } from "@/server/errors";

async function handleGET(request:Request) {
  try {
    await requireUser(request);
    const result=await getPool().query(
      "SELECT r.id,r.document_id,r.revision,r.file_name,r.sha256,r.approved_at,"+
      "d.title,d.kind,d.project_id,d.asset_id,a.asset_tag,p.code AS project_code "+
      "FROM engineering_revisions r JOIN engineering_documents d ON d.id=r.document_id "+
      "LEFT JOIN engineering_assets a ON a.id=d.asset_id "+
      "LEFT JOIN projects p ON p.id=d.project_id "+
      "WHERE r.status='approved' AND d.kind IN ('plc','hmi') "+
      "ORDER BY r.approved_at DESC LIMIT 200",
    );
    return NextResponse.json({releases:result.rows},{headers:{"Cache-Control":"no-store"}});
  } catch(error) {return errorResponse(error);}
}

export const GET = withOrganizationRoute(handleGET);
