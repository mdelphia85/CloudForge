import "server-only";
import type { PoolClient } from "pg";
import { getPool, inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import type { AuthenticatedUser } from "@/server/auth";

export type Resource = "projects" | "tasks" | "assets" | "bom" | "documents" |
  "production" | "purchasing" | "service";
export const RESOURCES: Resource[] = [
  "projects", "tasks", "assets", "bom", "documents", "production", "purchasing", "service",
];

type FieldType = "text" | "uuid" | "positive" | "date" | "choice" | "sku";
type Field = { key: string; type: FieldType; required?: boolean; max?: number; values?: readonly string[] };
type ResourceSpec = { table: string; fields: Field[]; read: string; label: string };

const field = (key: string, type: FieldType, required = false, max = 200, values?: readonly string[]): Field =>
  ({ key, type, required, max, values });

const SPECS: Record<Resource, ResourceSpec> = {
  projects: {
    table: "projects", label: "project",
    fields: [
      field("code","text",true,40), field("name","text",true), field("customer","text",true,160),
      field("description","text",false,2000), field("priority","choice",false,0,["low","normal","high"]),
      field("due_date","date"), field("owner_user_id","uuid"),
    ],
    read: "SELECT p.*,u.display_name AS owner_name FROM projects p LEFT JOIN users u ON u.id=p.owner_user_id ORDER BY p.created_at DESC LIMIT 200",
  },
  tasks: {
    table: "project_tasks", label: "task",
    fields: [
      field("project_id","uuid",true), field("title","text",true,240),
      field("discipline","choice",true,0,["engineering","project","production","field_service"]),
      field("notes","text",false,2000), field("assignee_id","uuid"), field("due_date","date"),
    ],
    read: "SELECT t.*,p.code AS project_code,u.display_name AS assignee_name FROM project_tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=t.assignee_id ORDER BY t.created_at DESC LIMIT 200",
  },
  assets: {
    table: "engineering_assets", label: "equipment",
    fields: [
      field("project_id","uuid"),field("asset_tag","text",true,80),field("name","text",true),
      field("customer_site","text",true),field("area","text",false,200),
      field("plc_make","text",false,100),field("plc_model","text",false,100),
      field("hmi_make","text",false,100),field("hmi_model","text",false,100),
      field("notes","text",false,2000),
    ],
    read: "SELECT a.*,p.code AS project_code FROM engineering_assets a LEFT JOIN projects p ON p.id=a.project_id ORDER BY a.created_at DESC LIMIT 200",
  },
  bom: {
    table: "engineering_bom_lines", label: "BOM line",
    fields: [
      field("project_id","uuid",true),field("sku","sku",true,64),
      field("required_qty","positive",true),field("revision","text",false,50),
      field("notes","text",false,1000),
    ],
    read: "SELECT b.*,p.code AS project_code,i.sku,i.name AS item_name,i.unit FROM engineering_bom_lines b JOIN projects p ON p.id=b.project_id JOIN inventory_items i ON i.id=b.item_id ORDER BY b.created_at DESC LIMIT 200",
  },
  documents: {
    table: "engineering_documents", label: "engineering document",
    fields: [
      field("project_id","uuid"),field("asset_id","uuid"),field("title","text",true),
      field("kind","choice",true,0,["drawing","spec","bom","manual","sop","plc","hmi","other"]),
    ],
    read: "SELECT d.*,p.code AS project_code,a.asset_tag, (SELECT COUNT(*)::int FROM engineering_revisions r WHERE r.document_id=d.id) AS revisions, (SELECT max(revision) FROM engineering_revisions r WHERE r.document_id=d.id AND r.status='approved') AS approved_revision FROM engineering_documents d LEFT JOIN projects p ON p.id=d.project_id LEFT JOIN engineering_assets a ON a.id=d.asset_id ORDER BY d.created_at DESC LIMIT 200",
  },
  production: {
    table: "production_jobs", label: "production job",
    fields: [
      field("project_id","uuid",true),field("asset_id","uuid"),field("job_code","text",true,60),
      field("title","text",true),field("planned_qty","positive",true),
      field("assigned_to","uuid"),field("due_date","date"),
    ],
    read: "SELECT j.*,p.code AS project_code,a.asset_tag FROM production_jobs j JOIN projects p ON p.id=j.project_id LEFT JOIN engineering_assets a ON a.id=j.asset_id ORDER BY j.created_at DESC LIMIT 200",
  },
  purchasing: {
    table: "purchase_requests", label: "purchase request",
    fields: [
      field("project_id","uuid"),field("sku","sku",true,64),
      field("quantity","positive",true),field("supplier","text",false,200),
      field("reference","text",false,120),field("needed_by","date"),
    ],
    read: "SELECT r.*,p.code AS project_code,i.sku,i.name AS item_name,i.unit FROM purchase_requests r LEFT JOIN projects p ON p.id=r.project_id JOIN inventory_items i ON i.id=r.item_id ORDER BY r.created_at DESC LIMIT 200",
  },
  service: {
    table: "field_service_jobs", label: "field service job",
    fields: [
      field("project_id","uuid"),field("asset_id","uuid",true),
      field("title","text",true),field("assigned_to","uuid"),
      field("scheduled_date","date"),field("notes","text",false,2000),
    ],
    read: "SELECT s.*,a.asset_tag,a.customer_site,p.code AS project_code,u.display_name AS technician_name FROM field_service_jobs s JOIN engineering_assets a ON a.id=s.asset_id LEFT JOIN projects p ON p.id=s.project_id LEFT JOIN users u ON u.id=s.assigned_to ORDER BY s.created_at DESC LIMIT 200",
  },
};

export function isResource(value: string): value is Resource {
  return RESOURCES.includes(value as Resource);
}

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export function requireUuid(value: unknown, name = "ID"): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new HttpError(400, "INVALID_ID", "A valid " + name + " is required.");
  }
  return value;
}
export function shortText(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > max) {
    throw new HttpError(400, "INVALID_FIELD", name + " must be 1–" + max + " characters.");
  }
  return value.trim();
}
export function positive(value: unknown, name: string): string {
  const str = String(value ?? "");
  if (!/^\d{1,12}(?:\.\d{1,3})?$/.test(str) || Number(str) <= 0) {
    throw new HttpError(400, "INVALID_QUANTITY", name + " must be positive, with up to three decimals.");
  }
  return str;
}
function parseValue(value: unknown, rule: Field): unknown {
  if (value === undefined || value === null || value === "") {
    if (rule.required) throw new HttpError(400, "MISSING_FIELD", rule.key + " is required.");
    return undefined;
  }
  switch (rule.type) {
    case "text": return shortText(value, rule.key, rule.max);
    case "uuid": return requireUuid(value, rule.key);
    case "positive": return positive(value, rule.key);
    case "date":
      if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d$/.test(value) ||
          Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value)
        throw new HttpError(400,"INVALID_DATE",rule.key+" must be a valid YYYY-MM-DD date.");
      return value;
    case "choice":
      if (typeof value !== "string" || !rule.values?.includes(value))
        throw new HttpError(400,"INVALID_CHOICE",rule.key+" has an invalid value.");
      return value;
    case "sku":
      if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value))
        throw new HttpError(400,"INVALID_SKU","Supply an existing inventory SKU.");
      return value.toUpperCase();
  }
}

export async function audit(client: PoolClient, user: AuthenticatedUser, action: string, entityType: string, entityId: string, details: Record<string, unknown> = {}) {
  await client.query(
    "INSERT INTO audit_events (actor_user_id,action,entity_type,entity_id,details) VALUES ($1,$2,$3,$4,$5::jsonb)",
    [user.id,action,entityType,entityId,JSON.stringify(details)],
  );
}

export async function listResource(resource: Resource): Promise<Record<string,unknown>[]> {
  const result = await getPool().query(SPECS[resource].read);
  return result.rows;
}
export async function listOverview(): Promise<Record<Resource,Record<string,unknown>[]>> {
  const entries = await Promise.all(RESOURCES.map(async resource => [resource, await listResource(resource)] as const));
  return Object.fromEntries(entries) as Record<Resource,Record<string,unknown>[]>;
}

export async function createResource(resource: Resource, payload: Record<string,unknown>, user: AuthenticatedUser) {
  const spec = SPECS[resource];
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const rule of spec.fields) {
    const parsed = parseValue(payload[rule.key],rule);
    if (parsed !== undefined) {
      fields.push(rule.key === "sku" ? "item_id" : rule.key);
      values.push(parsed);
    }
  }
  if (resource === "documents" && !fields.includes("project_id") && !fields.includes("asset_id")) {
    throw new HttpError(400,"INVALID_ASSOCIATION","Select a project or equipment record.");
  }
  if (resource === "projects") {
    // Canonical searchable reference, avoid visually duplicate project codes.
    const i = fields.indexOf("code");
    values[i] = String(values[i]).toUpperCase();
  }
  return inTransaction(async client => {
    const skuAt = spec.fields.findIndex(x=>x.key==="sku");
    if (skuAt >= 0) {
      const i = fields.indexOf("item_id");
      const item = await client.query<{id:string}>("SELECT id FROM inventory_items WHERE sku = $1 AND is_active=true",[values[i]]);
      if (!item.rowCount) throw new HttpError(400,"SKU_NOT_FOUND","Add the SKU to inventory first.");
      values[i]=item.rows[0].id;
    }
    fields.push(resource === "bom" ? "added_by" : "created_by");
    values.push(user.id);
    const columns = fields.join(",");
    const positions = values.map((_,i)=>"$"+(i+1)).join(",");
    const result = await client.query<{id:string}>(
      "INSERT INTO "+spec.table+" ("+columns+") VALUES ("+positions+") RETURNING id",
      values,
    );
    const id=result.rows[0].id;
    await audit(client,user,spec.label+".created",spec.table,id);
    return {id};
  });
}

const TRANSITIONS: Partial<Record<Resource,Record<string,readonly string[]>>> = {
  projects: {
    planned:["active","on_hold"],active:["on_hold","completed"],
    on_hold:["active","completed"],completed:[],
  },
  tasks: {
    todo:["in_progress","blocked","done"],in_progress:["blocked","done"],
    blocked:["in_progress","done"],done:[],
  },
  purchasing: {
    requested:["ordered","cancelled"],ordered:["received","cancelled"],
    received:[],cancelled:[],
  },
  service: {
    open:["scheduled","in_progress"],scheduled:["in_progress","completed"],
    in_progress:["completed"],completed:[],
  },
};

export async function updateStatus(resource: Resource, id: string, next: unknown, user: AuthenticatedUser) {
  const allowed = TRANSITIONS[resource];
  if (!allowed || typeof next !== "string") throw new HttpError(400,"INVALID_STATUS","This status cannot be edited here.");
  return inTransaction(async client=>{
    const table = SPECS[resource].table;
    const found = await client.query<{status:string}>("SELECT status FROM "+table+" WHERE id=$1 FOR UPDATE",[id]);
    if (!found.rowCount) throw new HttpError(404,"NOT_FOUND","Record not found.");
    const old=found.rows[0].status;
    if (old === next) return {id,status:old};
    if (!allowed[old]?.includes(next)) throw new HttpError(409,"INVALID_TRANSITION","Status cannot change from "+old+" to "+next+".");
    await client.query("UPDATE "+table+" SET status=$2"+(resource==="service"?"":",updated_at=now()")+" WHERE id=$1",[id,next]);
    await audit(client,user,SPECS[resource].label+".status_changed",table,id,{from:old,to:next});
    return {id,status:next};
  });
}

export function operationsError(error: unknown) {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code=String(error.code);
    if (code==="23505") return new HttpError(409,"DUPLICATE","A record with that identifier already exists.");
    if (code==="23503"||code==="23514"||code==="23502") return new HttpError(400,"INVALID_REFERENCE","The record has invalid or conflicting fields.");
  }
  return error;
}
