import "server-only";
import type { AuthenticatedUser } from "@/server/auth";
import { getPool, inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import { audit, positive, requireProject, requireUuid, shortText } from "./shared";

type BomLine = { itemId: string; quantity: string; notes: string };
type ChangeLink = { type: "document" | "bomRevision" | "asset" | "productionJob"; id: string };

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
    const expected = action === "submit" ? "draft" : "review";
    if (row.status !== expected) throw new HttpError(409, "INVALID_TRANSITION", `Only a ${expected} BOM revision can be ${action === "submit" ? "submitted" : "approved"}.`);
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
      "'id',COALESCE(l.document_id,l.bom_revision_id,l.asset_id,l.production_job_id)) ORDER BY l.created_at) FILTER(WHERE l.id IS NOT NULL),'[]'::jsonb) AS links " +
      "FROM engineering_change_orders c JOIN projects p ON p.id=c.project_id JOIN users u ON u.id=c.requested_by " +
      "LEFT JOIN engineering_assets a ON a.id=c.asset_id LEFT JOIN engineering_change_links l ON l.change_order_id=c.id " +
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
    if (action === "implement") {
      const unapproved = await client.query(
        "SELECT 1 FROM engineering_change_links l JOIN engineering_bom_revisions b ON b.id=l.bom_revision_id " +
          "WHERE l.change_order_id=$1 AND b.status<>'approved' LIMIT 1",
        [id],
      );
      if (unapproved.rowCount) throw new HttpError(409, "BOM_NOT_APPROVED", "All linked BOM revisions must be approved before implementation.");
    }
    const next = action === "submit" ? "review" : action === "reject" ? "rejected" : action === "approve" ? "approved" : "implemented";
    if (action === "approve") {
      await client.query("UPDATE engineering_change_orders SET status=$2,approved_by=$3,approved_at=now(),updated_at=now() WHERE id=$1", [id, next, user.id]);
    } else if (action === "implement") {
      await client.query("UPDATE engineering_change_orders SET status=$2,implemented_by=$3,implemented_at=now(),updated_at=now() WHERE id=$1", [id, next, user.id]);
    } else {
      await client.query("UPDATE engineering_change_orders SET status=$2,updated_at=now() WHERE id=$1", [id, next]);
    }
    await client.query(
      "INSERT INTO engineering_change_approvals(change_order_id,action,notes,actor_id) VALUES($1,$2,$3,$4)",
      [id, action === "submit" ? "submitted" : action === "implement" ? "implemented" : action === "approve" ? "approved" : "rejected", notes, user.id],
    );
    await audit(client, user, `engineering.change_order.${action}`, "engineering_change_order", id, {
      from: status, to: next, notes,
    });
    return { id, status: next };
  });
}
