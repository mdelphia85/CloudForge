import "server-only";
import type { AuthenticatedUser } from "@/server/auth";
import { getPool, inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import { audit, positive, requireProject, requireUuid, shortText } from "./shared";

type BomLine = { itemId: string; quantity: string; notes: string };
type ChangeLink = { type: "document" | "bomRevision" | "asset" | "productionJob"; id: string };
type DocumentRevisionEvidence = { linkId: string; revisionId: string };

function parseBomLines(value: unknown): BomLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) {
    throw new HttpError(400, "INVALID_LINES", "A BOM revision requires 1 to 500 item lines.");
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new HttpError(400, "INVALID_LINE", "Each BOM line must be an object.");
    }
    const line = entry as Record<string, unknown>;
    const itemId = requireUuid(line.itemId, "itemId");
    if (seen.has(itemId)) throw new HttpError(400, "DUPLICATE_ITEM", "A BOM revision cannot contain duplicate inventory items.");
    seen.add(itemId);
    return {
      itemId,
      quantity: positive(line.requiredQty, "requiredQty"),
      notes: line.notes === undefined || line.notes === "" ? "" : shortText(line.notes, "notes", 1000),
    };
  });
}

function parseLinks(value: unknown): ChangeLink[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, "INVALID_LINKS", "Links must be an array of up to 100 records.");
  const types = ["document", "bomRevision", "asset", "productionJob"] as const;
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new HttpError(400, "INVALID_LINK", "Each change link must be an object.");
    const link = entry as Record<string, unknown>;
    if (typeof link.type !== "string" || !types.includes(link.type as ChangeLink["type"])) {
      throw new HttpError(400, "INVALID_LINK", "Choose a valid engineering change link type.");
    }
    return { type: link.type as ChangeLink["type"], id: requireUuid(link.id, "linkId") };
  });
}

function parseDocumentRevisionEvidence(value: unknown): DocumentRevisionEvidence[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new HttpError(400, "INVALID_IMPLEMENTATION_EVIDENCE", "Document revision evidence must be an array of up to 100 records.");
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new HttpError(400, "INVALID_IMPLEMENTATION_EVIDENCE", "Each document revision record must be an object.");
    }
    const record = entry as Record<string, unknown>;
    const linkId = requireUuid(record.linkId, "linkId");
    if (seen.has(linkId)) {
      throw new HttpError(400, "INVALID_IMPLEMENTATION_EVIDENCE", "A linked document can have only one implemented revision.");
    }
    seen.add(linkId);
    return { linkId, revisionId: requireUuid(record.revisionId, "revisionId") };
  });
}

export async function listBomRevisions(projectId?: string) {
  const result = await getPool().query(
    "SELECT r.id,r.project_id AS \"projectId\",p.code AS \"projectCode\",r.revision_code AS \"revisionCode\",r.status, " +
      "r.change_notes AS \"changeNotes\",r.created_at AS \"createdAt\",u.display_name AS \"createdBy\", " +
      "r.approved_at AS \"approvedAt\",COALESCE(jsonb_agg(jsonb_build_object('itemId',l.item_id,'sku',i.sku, " +
      "'itemName',i.name,'requiredQty',l.required_qty::text,'notes',l.notes) ORDER BY i.sku) FILTER(WHERE l.id IS NOT NULL),'[]'::jsonb) AS lines " +
      "FROM engineering_bom_revisions r JOIN projects p ON p.id=r.project_id JOIN users u ON u.id=r.created_by " +
      "LEFT JOIN engineering_bom_revision_lines l ON l.bom_revision_id=r.id LEFT JOIN inventory_items i ON i.id=l.item_id " +
      "WHERE ($1::uuid IS NULL OR r.project_id=$1) GROUP BY r.id,p.code,u.display_name ORDER BY r.created_at DESC LIMIT 200",
    [projectId ?? null],
  );
  return result.rows;
}

export async function listApprovedDocumentRevisions() {
  const result = await getPool().query(
    "SELECT r.id,r.document_id AS \"documentId\",r.revision,r.file_name AS \"fileName\", " +
      "d.title,d.kind,d.project_id AS \"projectId\",d.asset_id AS \"assetId\" " +
      "FROM engineering_revisions r JOIN engineering_documents d ON d.id=r.document_id " +
      "WHERE r.status='approved' ORDER BY d.title,r.revision DESC LIMIT 500",
  );
  return result.rows;
}

export async function createBomRevision(body: Record<string, unknown>, user: AuthenticatedUser) {
  const projectId = requireUuid(body.projectId, "projectId");
  const revisionCode = shortText(body.revisionCode, "revisionCode", 40);
  const changeNotes = body.changeNotes === undefined || body.changeNotes === "" ? "" : shortText(body.changeNotes, "changeNotes", 2000);
  const lines = parseBomLines(body.lines);
  return inTransaction(async (client) => {
    await requireProject(client, projectId);
    const revision = await client.query<{ id: string }>(
      "INSERT INTO engineering_bom_revisions(project_id,revision_code,change_notes,created_by) VALUES($1,$2,$3,$4) RETURNING id",
      [projectId, revisionCode, changeNotes, user.id],
    );
    for (const line of lines) {
      const item = await client.query("SELECT id FROM inventory_items WHERE id=$1 AND is_active=true", [line.itemId]);
      if (!item.rowCount) throw new HttpError(404, "ITEM_NOT_FOUND", "An active inventory item is required for every BOM line.");
      await client.query(
        "INSERT INTO engineering_bom_revision_lines(bom_revision_id,item_id,required_qty,notes) VALUES($1,$2,$3,$4)",
        [revision.rows[0].id, line.itemId, line.quantity, line.notes],
      );
    }
    await audit(client, user, "engineering.bom_revision.created", "engineering_bom_revision", revision.rows[0].id, {
      projectId, revisionCode, lineCount: lines.length,
    });
    return { id: revision.rows[0].id };
  });
}

export async function transitionBomRevision(id: string, action: unknown, user: AuthenticatedUser) {
  if (action !== "submit" && action !== "approve") throw new HttpError(400, "INVALID_ACTION", "Choose submit or approve.");
  if (action === "approve" && user.role !== "admin") throw new HttpError(403, "FORBIDDEN", "Only an administrator can approve a BOM revision.");
  return inTransaction(async (client) => {
    const result = await client.query<{ project_id: string; status: string; revision_code: string }>(
      "SELECT project_id,status,revision_code FROM engineering_bom_revisions WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!result.rowCount) throw new HttpError(404, "NOT_FOUND", "BOM revision not found.");
    const row = result.rows[0];
    await client.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [row.project_id]);
    const expected = action === "submit" ? ["draft", "legacy"] : ["review"];
    if (!expected.includes(row.status)) {
      const state = action === "submit" ? "draft or provisional legacy" : "review";
      throw new HttpError(409, "INVALID_TRANSITION", `Only a ${state} BOM revision can be ${action === "submit" ? "submitted" : "approved"}.`);
    }
    if (action === "approve") {
      await client.query(
        "UPDATE engineering_bom_revisions SET status='superseded',updated_at=now() WHERE project_id=$1 AND status='approved' AND id<>$2",
        [row.project_id, id],
      );
      await client.query(
        "UPDATE engineering_bom_revisions SET status='approved',approved_by=$2,approved_at=now(),updated_at=now() WHERE id=$1",
        [id, user.id],
      );
    } else {
      await client.query("UPDATE engineering_bom_revisions SET status='review',updated_at=now() WHERE id=$1", [id]);
    }
    await audit(client, user, `engineering.bom_revision.${action === "submit" ? "submitted" : "approved"}`, "engineering_bom_revision", id, {
      projectId: row.project_id, revisionCode: row.revision_code,
    });
    return { id, status: action === "submit" ? "review" : "approved" };
  });
}

export async function listChangeOrders(projectId?: string) {
  const result = await getPool().query(
    "SELECT c.id,c.change_number AS \"changeNumber\",c.project_id AS \"projectId\",p.code AS \"projectCode\",c.asset_id AS \"assetId\", " +
      "a.asset_tag AS \"assetTag\",c.title,c.reason,c.change_summary AS \"changeSummary\",c.implementation_notes AS \"implementationNotes\", " +
      "c.status,c.created_at AS \"createdAt\",u.display_name AS \"requestedBy\",c.approved_at AS \"approvedAt\", " +
      "COALESCE(jsonb_agg(jsonb_build_object('type',CASE WHEN l.document_id IS NOT NULL THEN 'document' " +
      "WHEN l.bom_revision_id IS NOT NULL THEN 'bomRevision' WHEN l.asset_id IS NOT NULL THEN 'asset' ELSE 'productionJob' END, " +
      "'id',COALESCE(l.document_id,l.bom_revision_id,l.asset_id,l.production_job_id),'linkId',l.id,'documentTitle',d.title) " +
      "ORDER BY l.created_at) FILTER(WHERE l.id IS NOT NULL),'[]'::jsonb) AS links " +
      ",(SELECT COALESCE(jsonb_agg(jsonb_build_object('action',h.action,'notes',h.notes,'actorName',a.display_name, " +
      "'createdAt',h.created_at) ORDER BY h.created_at),'[]'::jsonb) FROM engineering_change_approvals h " +
      "JOIN users a ON a.id=h.actor_id WHERE h.change_order_id=c.id) AS approvals " +
      ",(SELECT COALESCE(jsonb_agg(jsonb_build_object('linkId',e.change_order_link_id,'linkType',CASE " +
      "WHEN el.document_id IS NOT NULL THEN 'document' WHEN el.bom_revision_id IS NOT NULL THEN 'bomRevision' " +
      "WHEN el.asset_id IS NOT NULL THEN 'asset' ELSE 'productionJob' END,'documentTitle',ed.title, " +
      "'documentRevisionId',e.document_revision_id,'revision',dr.revision,'bomRevisionId',e.bom_revision_id, " +
      "'bomRevisionCode',br.revision_code,'notes',e.notes,'verifiedBy',v.display_name,'verifiedAt',e.verified_at) " +
      "ORDER BY e.verified_at),'[]'::jsonb) FROM engineering_change_implementation_evidence e " +
      "JOIN engineering_change_links el ON el.id=e.change_order_link_id " +
      "LEFT JOIN engineering_documents ed ON ed.id=el.document_id " +
      "LEFT JOIN engineering_revisions dr ON dr.id=e.document_revision_id " +
      "LEFT JOIN engineering_bom_revisions br ON br.id=e.bom_revision_id " +
      "JOIN users v ON v.id=e.verified_by WHERE el.change_order_id=c.id) AS \"implementationEvidence\" " +
      "FROM engineering_change_orders c JOIN projects p ON p.id=c.project_id JOIN users u ON u.id=c.requested_by " +
      "LEFT JOIN engineering_assets a ON a.id=c.asset_id LEFT JOIN engineering_change_links l ON l.change_order_id=c.id " +
      "LEFT JOIN engineering_documents d ON d.id=l.document_id " +
      "WHERE ($1::uuid IS NULL OR c.project_id=$1) GROUP BY c.id,p.code,a.asset_tag,u.display_name ORDER BY c.created_at DESC LIMIT 200",
    [projectId ?? null],
  );
  return result.rows;
}

export async function createChangeOrder(body: Record<string, unknown>, user: AuthenticatedUser) {
  const changeNumber = shortText(body.changeNumber, "changeNumber", 60).toUpperCase();
  const projectId = requireUuid(body.projectId, "projectId");
  const assetId = body.assetId ? requireUuid(body.assetId, "assetId") : null;
  const title = shortText(body.title, "title", 200);
  const reason = shortText(body.reason, "reason", 2000);
  const changeSummary = body.changeSummary === undefined || body.changeSummary === "" ? "" : shortText(body.changeSummary, "changeSummary", 2000);
  const implementationNotes = body.implementationNotes === undefined || body.implementationNotes === "" ? "" : shortText(body.implementationNotes, "implementationNotes", 2000);
  const links = parseLinks(body.links);
  return inTransaction(async (client) => {
    await requireProject(client, projectId);
    if (assetId) {
      const asset = await client.query("SELECT id FROM engineering_assets WHERE id=$1 AND project_id=$2", [assetId, projectId]);
      if (!asset.rowCount) throw new HttpError(400, "INVALID_ASSET", "The equipment record must belong to this project.");
    }
    const change = await client.query<{ id: string }>(
      "INSERT INTO engineering_change_orders(change_number,project_id,asset_id,title,reason,change_summary,implementation_notes,requested_by) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [changeNumber, projectId, assetId, title, reason, changeSummary, implementationNotes, user.id],
    );
    const id = change.rows[0].id;
    for (const link of links) {
      const linkTable: Record<ChangeLink["type"], { table: string; column: string; projectColumn: string }> = {
        document: { table: "engineering_documents", column: "document_id", projectColumn: "project_id" },
        bomRevision: { table: "engineering_bom_revisions", column: "bom_revision_id", projectColumn: "project_id" },
        asset: { table: "engineering_assets", column: "asset_id", projectColumn: "project_id" },
        productionJob: { table: "production_jobs", column: "production_job_id", projectColumn: "project_id" },
      };
      const spec = linkTable[link.type];
      const valid = link.type === "document"
        ? await client.query(
          "SELECT d.id FROM engineering_documents d LEFT JOIN engineering_assets a ON a.id=d.asset_id " +
            "WHERE d.id=$1 AND (d.project_id=$2 OR a.project_id=$2)",
          [link.id, projectId],
        )
        : await client.query(
          `SELECT id FROM ${spec.table} WHERE id=$1 AND ${spec.projectColumn}=$2`,
          [link.id, projectId],
        );
      if (!valid.rowCount) throw new HttpError(400, "INVALID_LINK", "Every linked record must belong to the change order project.");
      await client.query(
        `INSERT INTO engineering_change_links(change_order_id,${spec.column}) VALUES($1,$2)`,
        [id, link.id],
      );
    }
    await audit(client, user, "engineering.change_order.created", "engineering_change_order", id, {
      changeNumber, projectId, linkCount: links.length,
    });
    return { id };
  });
}

export async function transitionChangeOrder(
  id: string,
  body: Record<string, unknown>,
  user: AuthenticatedUser,
) {
  const action = body.action;
  if (action !== "submit" && action !== "approve" && action !== "reject" && action !== "implement") {
    throw new HttpError(400, "INVALID_ACTION", "Choose submit, approve, reject, or implement.");
  }
  const notes = body.notes === undefined || body.notes === "" ? "" : shortText(body.notes, "notes", 2000);
  if (action === "implement" && !notes) {
    throw new HttpError(400, "IMPLEMENTATION_NOTES_REQUIRED", "Provide verification and implementation notes before implementing this change.");
  }
  if (action !== "implement" && body.documentRevisions !== undefined) {
    throw new HttpError(400, "INVALID_IMPLEMENTATION_EVIDENCE", "Document revisions can only be supplied when implementing a change.");
  }
  const documentRevisions = action === "implement" ? parseDocumentRevisionEvidence(body.documentRevisions) : [];
  if ((action === "approve" || action === "reject" || action === "implement") && user.role !== "admin") {
    throw new HttpError(403, "FORBIDDEN", "Only an administrator can approve, reject, or implement an engineering change.");
  }
  return inTransaction(async (client) => {
    const change = await client.query<{ status: string; project_id: string }>(
      "SELECT status,project_id FROM engineering_change_orders WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!change.rowCount) throw new HttpError(404, "NOT_FOUND", "Engineering change order not found.");
    const status = change.rows[0].status;
    const allowed: Record<string, string[]> = {
      submit: ["draft"], approve: ["review"], reject: ["review"], implement: ["approved"],
    };
    if (!allowed[action].includes(status)) {
      const verb = action === "submit" ? "submitted" : action === "approve" ? "approved" :
        action === "reject" ? "rejected" : "implemented";
      throw new HttpError(409, "INVALID_TRANSITION", `A ${status} change order cannot be ${verb}.`);
    }
    let implementationEvidenceCount = 0;
    if (action === "implement") {
      const links = await client.query<{
        id: string; document_id: string | null; bom_revision_id: string | null;
      }>(
        "SELECT id,document_id,bom_revision_id FROM engineering_change_links WHERE change_order_id=$1 ORDER BY id FOR UPDATE",
        [id],
      );
      const documentLinks = links.rows.filter((link) => link.document_id !== null);
      if (documentRevisions.length !== documentLinks.length ||
          documentRevisions.some((evidence) => !documentLinks.some((link) => link.id === evidence.linkId))) {
        throw new HttpError(409, "REVISION_EVIDENCE_REQUIRED", "Select an approved revision for every linked engineering document.");
      }

      const revisionsByLink = new Map(documentRevisions.map((evidence) => [evidence.linkId, evidence.revisionId]));
      for (const link of links.rows) {
        if (link.document_id) {
          const revision = await client.query(
            "SELECT id FROM engineering_revisions WHERE id=$1 AND document_id=$2 AND status='approved' FOR SHARE",
            [revisionsByLink.get(link.id), link.document_id],
          );
          if (!revision.rowCount) {
            throw new HttpError(409, "REVISION_NOT_APPROVED", "Implementation evidence must reference an approved revision of its linked document.");
          }
        } else if (link.bom_revision_id) {
          const bom = await client.query(
            "SELECT id FROM engineering_bom_revisions WHERE id=$1 AND status='approved' FOR SHARE",
            [link.bom_revision_id],
          );
          if (!bom.rowCount) {
            throw new HttpError(409, "BOM_NOT_APPROVED", "All linked BOM revisions must be approved before implementation.");
          }
        }
      }

      for (const link of links.rows) {
        await client.query(
          "INSERT INTO engineering_change_implementation_evidence " +
            "(change_order_link_id,document_revision_id,bom_revision_id,notes,verified_by) VALUES($1,$2,$3,$4,$5)",
          [link.id, revisionsByLink.get(link.id) ?? null, link.bom_revision_id, notes, user.id],
        );
      }
      implementationEvidenceCount = links.rowCount ?? links.rows.length;
    }
    const next = action === "submit" ? "review" : action === "reject" ? "rejected" : action === "approve" ? "approved" : "implemented";
    if (action === "approve") {
      await client.query("UPDATE engineering_change_orders SET status=$2,approved_by=$3,approved_at=now(),updated_at=now() WHERE id=$1", [id, next, user.id]);
    } else if (action === "implement") {
      await client.query(
        "UPDATE engineering_change_orders SET status=$2,implemented_by=$3,implemented_at=now(),implementation_notes=$4,updated_at=now() WHERE id=$1",
        [id, next, user.id, notes],
      );
    } else {
      await client.query("UPDATE engineering_change_orders SET status=$2,updated_at=now() WHERE id=$1", [id, next]);
    }
    await client.query(
      "INSERT INTO engineering_change_approvals(change_order_id,action,notes,actor_id) VALUES($1,$2,$3,$4)",
      [id, action === "submit" ? "submitted" : action === "implement" ? "implemented" : action === "approve" ? "approved" : "rejected", notes, user.id],
    );
    await audit(client, user, `engineering.change_order.${action}`, "engineering_change_order", id, {
      from: status, to: next, notes, ...(action === "implement" ? { implementationEvidenceCount } : {}),
    });
    return { id, status: next, ...(action === "implement" ? { implementationEvidenceCount } : {}) };
  });
}
