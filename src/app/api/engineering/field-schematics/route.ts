import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { getPool } from "@/server/db";
import { errorResponse } from "@/server/errors";

// Metadata only. Downloads still require revision-level authorization and are audited.
export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const result = await getPool().query(
      "SELECT r.id,r.document_id,r.revision,r.file_name,r.sha256,r.approved_at," +
        "d.title,d.kind,d.project_id,d.asset_id,a.asset_tag,p.code AS project_code " +
        "FROM engineering_revisions r JOIN engineering_documents d ON d.id=r.document_id " +
        "LEFT JOIN engineering_assets a ON a.id=d.asset_id " +
        "LEFT JOIN projects p ON p.id=d.project_id " +
        "WHERE r.status='approved' AND d.kind IN ('electrical_schematic','mechanical_schematic') " +
        "AND ($1::text <> 'viewer' OR EXISTS (" +
          "SELECT 1 FROM field_service_jobs s WHERE s.assigned_to=$2 " +
          "AND s.status<>'completed' " +
          "AND (s.asset_id=d.asset_id OR (d.asset_id IS NULL AND s.project_id=d.project_id)))) " +
        "ORDER BY r.approved_at DESC LIMIT 200",
      [user.role, user.id],
    );
    return NextResponse.json({ files: result.rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
