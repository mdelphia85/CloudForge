import { withOrganizationRoute } from "@/server/tenant-context";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { errorResponse, HttpError, requireSameOrigin } from "@/server/errors";
import { audit, operationsError, requireUuid, shortText } from "@/server/operations";

// An interim limit while opaque binaries are stored in PostgreSQL. For larger CAD/project
// archives, move to durable private object storage with a streamed ingestion pipeline.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const KINDS = ["plc", "hmi", "electrical_schematic", "mechanical_schematic"] as const;
type Kind = typeof KINDS[number];
const executableExtension = /\.(exe|dll|com|msi|bat|cmd|ps1|vbs|js|mjs|cjs|html?|svg|sh)$/i;

function getOptionalId(value: FormDataEntryValue | null, label: string): string | null {
  if (value === null || value === "") return null;
  return requireUuid(value, label);
}

function requiredFormText(value: FormDataEntryValue | null, label: string, maximum: number): string {
  if (typeof value !== "string") throw new HttpError(400, "INVALID_FIELD", label + " is required.");
  return shortText(value, label, maximum);
}

async function handlePOST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    requireRole(user, "admin", "operator");

    const length = Number(request.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_UPLOAD_BYTES + 65536) {
      throw new HttpError(413, "FILE_TOO_LARGE", "File upload exceeds the 50 MB limit.");
    }
    if (!/^multipart\/form-data(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
      throw new HttpError(415, "INVALID_UPLOAD", "Upload must use multipart/form-data.");
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new HttpError(400, "INVALID_UPLOAD", "Unable to read the file upload.");
    }

    const kindInput = form.get("kind");
    if (typeof kindInput !== "string" || !KINDS.includes(kindInput as Kind)) {
      throw new HttpError(400, "INVALID_KIND", "Choose PLC code, HMI code, electrical schematics, or mechanical schematics.");
    }
    const kind = kindInput as Kind;
    const title = requiredFormText(form.get("title"), "Title", 200);
    if (title.length < 2) throw new HttpError(400, "INVALID_TITLE", "Title must be at least 2 characters.");
    const projectId = getOptionalId(form.get("projectId"), "project ID");
    const assetId = getOptionalId(form.get("assetId"), "equipment ID");
    if (!projectId && !assetId) {
      throw new HttpError(400, "INVALID_ASSOCIATION", "Select a project or equipment record.");
    }

    const noteInput = form.get("notes");
    const notes = typeof noteInput === "string" && noteInput.trim() ? shortText(noteInput, "Change notes", 1000) : "";

    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw new HttpError(400, "INVALID_FILE", "Select a nonempty engineering file.");
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, "FILE_TOO_LARGE", "File must be 50 MB or smaller.");
    }
    const name = file.name.split(/[\\/]/).pop() ?? "";
    if (name.length < 1 || name.length > 180 || /[\x00-\x1f\x7f]/.test(name) || name === "." || name === "..") {
      throw new HttpError(400, "INVALID_NAME", "The engineering file name is invalid.");
    }
    if (executableExtension.test(name)) {
      throw new HttpError(415, "UNSUPPORTED_FILE", "Executable and active-content files cannot be uploaded.");
    }

    // Opaque binary storage: no transformation, execution, preview, or archive extraction.
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length !== file.size || bytes.length > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, "FILE_TOO_LARGE", "File upload exceeds the 50 MB limit.");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const created = await inTransaction(async (client) => {
      if (projectId) {
        const project = await client.query("SELECT id FROM projects WHERE id=$1 AND organization_id=$2", [projectId,user.organizationId]);
        if (!project.rowCount) throw new HttpError(400, "PROJECT_NOT_FOUND", "Selected project was not found.");
      }
      if (assetId) {
        const asset = await client.query<{ project_id: string | null }>(
          "SELECT project_id FROM engineering_assets WHERE id=$1 AND organization_id=$2", [assetId,user.organizationId],
        );
        if (!asset.rowCount) throw new HttpError(400, "EQUIPMENT_NOT_FOUND", "Selected equipment was not found.");
        if (projectId && asset.rows[0].project_id && asset.rows[0].project_id !== projectId) {
          throw new HttpError(400, "PROJECT_EQUIPMENT_MISMATCH", "Equipment belongs to a different project.");
        }
      }

      const document = await client.query<{ id: string }>(
        "INSERT INTO engineering_documents (organization_id,project_id,asset_id,title,kind,created_by) " +
          "VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [user.organizationId,projectId,assetId,title,kind,user.id],
      );
      const documentId = document.rows[0].id;
      const revision = await client.query<{ id: string }>(
        "INSERT INTO engineering_revisions " +
          "(organization_id,document_id,revision,file_name,content_type,byte_size,sha256,file_data,change_notes,uploaded_by) " +
          "VALUES ($1,$2,1,$3,'application/octet-stream',$4,$5,$6,$7,$8) RETURNING id",
        [user.organizationId,documentId,name,bytes.length,sha256,bytes,notes,user.id],
      );
      const revisionId = revision.rows[0].id;
      await audit(client, user, "engineering.document_created", "engineering_documents", documentId, {
        kind, projectId, assetId, title,
      });
      await audit(client, user, "engineering.revision_uploaded", "engineering_document", documentId, {
        revisionId, revision: 1, fileName: name, sha256, byteSize: bytes.length,
      });
      return { documentId, revisionId, revision: 1, kind, sha256, status: "draft" };
    });
    return NextResponse.json(created, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}

export const POST = withOrganizationRoute(handlePOST);
