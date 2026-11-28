import "server-only";
import type { PoolClient } from "pg";
import type { AuthenticatedUser } from "@/server/auth";
import { getPool, inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import { initializeSimulatedTelemetry } from "./default-tags";
import {
  audit,
  optionalText,
  parseDate,
  requireAssetAccess,
  requireOperationsRole,
  requireUuid,
  shortText,
} from "./shared";

type AssetInput = {
  projectId: string | null;
  parentAssetId: string | null;
  assetTag: string;
  name: string;
  customerSite: string;
  area: string;
  location: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  installedOn: string | null;
  status: "active" | "standby" | "maintenance" | "retired";
  plcMake: string;
  plcModel: string;
  hmiMake: string;
  hmiModel: string;
  notes: string;
};

const ASSET_STATUSES = ["active", "standby", "maintenance", "retired"] as const;
function nullableUuid(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireUuid(value, name);
}

function parseStatus(value: unknown, fallback: AssetInput["status"] = "active"): AssetInput["status"] {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && ASSET_STATUSES.includes(value as AssetInput["status"])) {
    return value as AssetInput["status"];
  }
  throw new HttpError(400, "INVALID_STATUS", "Choose active, standby, maintenance, or retired.");
}

function parseAsset(body: Record<string, unknown>, partial = false): Partial<AssetInput> {
  const result: Partial<AssetInput> = {};
  const textFields: Array<[Exclude<keyof AssetInput, "projectId" | "parentAssetId" | "installedOn" | "status">, string, number]> = [
    ["assetTag", "assetTag", 80],
    ["name", "name", 200],
    ["customerSite", "customerSite", 200],
    ["area", "area", 200],
    ["location", "location", 200],
    ["manufacturer", "manufacturer", 160],
    ["model", "model", 160],
    ["serialNumber", "serialNumber", 160],
    ["plcMake", "plcMake", 100],
    ["plcModel", "plcModel", 100],
    ["hmiMake", "hmiMake", 100],
    ["hmiModel", "hmiModel", 100],
    ["notes", "notes", 2000],
  ];
  for (const [key, bodyKey, maximum] of textFields) {
    if (body[bodyKey] !== undefined || !partial) {
      const value = body[bodyKey];
      result[key] = (value === undefined || value === null || value === "") &&
        ["area", "location", "manufacturer", "model", "serialNumber", "plcMake", "plcModel", "hmiMake", "hmiModel", "notes"].includes(bodyKey)
        ? ""
        : shortText(value, bodyKey, maximum);
    }
  }
  if (body.projectId !== undefined || !partial) result.projectId = nullableUuid(body.projectId, "projectId");
  if (body.parentAssetId !== undefined || !partial) result.parentAssetId = nullableUuid(body.parentAssetId, "parentAssetId");
  if (body.installedOn !== undefined || !partial) result.installedOn = parseDate(body.installedOn, "installedOn");
  if (body.status !== undefined || !partial) result.status = parseStatus(body.status);
  return result;
}

async function validateAssetRelations(
  client: PoolClient,
  asset: Pick<AssetInput, "projectId" | "parentAssetId" | "customerSite">,
  currentAssetId?: string,
) {
  if (asset.projectId) {
    const project = await client.query("SELECT id FROM projects WHERE id=$1", [asset.projectId]);
    if (!project.rowCount) throw new HttpError(404, "PROJECT_NOT_FOUND", "The selected project does not exist.");
  }
  if (!asset.parentAssetId) return;
  if (asset.parentAssetId === currentAssetId) {
    throw new HttpError(400, "INVALID_PARENT", "Equipment cannot be its own parent.");
  }
  const parent = await client.query<{ customer_site: string }>(
    "SELECT customer_site FROM engineering_assets WHERE id=$1",
    [asset.parentAssetId],
  );
  if (!parent.rowCount) throw new HttpError(404, "PARENT_NOT_FOUND", "The selected parent equipment does not exist.");
  if (parent.rows[0].customer_site !== asset.customerSite) {
    throw new HttpError(409, "PARENT_SITE_MISMATCH", "Parent and child equipment must belong to the same customer site.");
  }
  if (currentAssetId) {
    const cycle = await client.query(
      "WITH RECURSIVE descendants(id) AS (" +
        "SELECT id FROM engineering_assets WHERE parent_asset_id=$1 " +
        "UNION ALL SELECT a.id FROM engineering_assets a JOIN descendants d ON a.parent_asset_id=d.id" +
        ") SELECT 1 FROM descendants WHERE id=$2 LIMIT 1",
      [currentAssetId, asset.parentAssetId],
    );
    if (cycle.rowCount) throw new HttpError(409, "EQUIPMENT_HIERARCHY_CYCLE", "Equipment hierarchy cannot contain a cycle.");
  }
}

export async function listEquipment(user: AuthenticatedUser) {
  const result = await getPool().query(
    "SELECT a.id,a.project_id AS \"projectId\",p.code AS \"projectCode\",a.parent_asset_id AS \"parentAssetId\", " +
      "parent.asset_tag AS \"parentAssetTag\",a.asset_tag AS \"assetTag\",a.name,a.customer_site AS \"customerSite\", " +
      "a.area,a.location,a.manufacturer,a.model,a.serial_number AS \"serialNumber\",a.installed_on AS \"installedOn\", " +
      "a.status,a.plc_make AS \"plcMake\",a.plc_model AS \"plcModel\",a.hmi_make AS \"hmiMake\",a.hmi_model AS \"hmiModel\", " +
      "a.notes,a.created_at AS \"createdAt\",a.updated_at AS \"updatedAt\",src.connection_state AS \"connectionState\", " +
      "src.last_seen_at AS \"lastSeenAt\",state.value AS \"machineState\",state.quality AS \"stateQuality\",state.observed_at AS \"stateObservedAt\", " +
      "(SELECT count(*)::int FROM maintenance_work_orders m WHERE m.asset_id=a.id) AS \"maintenanceOrderCount\", " +
      "(SELECT count(*)::int FROM field_service_jobs s WHERE s.asset_id=a.id) AS \"serviceJobCount\", " +
      "(SELECT count(*)::int FROM production_jobs j WHERE j.asset_id=a.id) AS \"productionJobCount\" " +
      "FROM engineering_assets a LEFT JOIN projects p ON p.id=a.project_id " +
      "LEFT JOIN engineering_assets parent ON parent.id=a.parent_asset_id " +
      "LEFT JOIN LATERAL (SELECT s.id,s.last_seen_at,CASE WHEN s.provider='gateway' AND " +
        "(NOT g.enabled OR g.revoked_at IS NOT NULL OR g.expires_at<=now()) THEN 'disconnected' ELSE s.connection_state END AS connection_state " +
        "FROM asset_telemetry_sources s LEFT JOIN industrial_gateways g ON g.id=s.gateway_id " +
        "WHERE s.asset_id=a.id ORDER BY (s.provider='gateway') DESC LIMIT 1) src ON true " +
      "LEFT JOIN LATERAL (SELECT s.value,s.quality,s.observed_at FROM asset_telemetry_samples s " +
        "JOIN asset_telemetry_tags t ON t.id=s.tag_id WHERE t.asset_id=a.id AND s.source_id=src.id AND t.semantic_type='state' " +
        "ORDER BY s.received_at DESC,s.observed_at DESC LIMIT 1) state ON true " +
      "WHERE $1 <> 'viewer' OR EXISTS(SELECT 1 FROM projects pr WHERE pr.id=a.project_id AND pr.created_by=$2) " +
      "OR EXISTS(SELECT 1 FROM project_resources r WHERE r.project_id=a.project_id AND r.user_id=$2) " +
      "OR EXISTS(SELECT 1 FROM field_service_jobs fs WHERE fs.asset_id=a.id AND fs.assigned_to=$2) " +
      "OR EXISTS(SELECT 1 FROM maintenance_work_orders mw WHERE mw.asset_id=a.id AND mw.assigned_to=$2) " +
      "ORDER BY a.asset_tag LIMIT 500",
    [user.role, user.id],
  );
  return { equipment: result.rows };
}

export async function createEquipment(body: Record<string, unknown>, user: AuthenticatedUser) {
  requireOperationsRole(user);
  const input = parseAsset(body) as AssetInput;
  return inTransaction(async (client) => {
    await validateAssetRelations(client, input);
    const created = await client.query<{ id: string }>(
      "INSERT INTO engineering_assets(project_id,asset_tag,name,customer_site,area,plc_make,plc_model,hmi_make,hmi_model,notes," +
        "manufacturer,model,serial_number,location,installed_on,status,parent_asset_id,created_by,updated_by) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18) RETURNING id",
      [input.projectId,input.assetTag,input.name,input.customerSite,input.area,input.plcMake,input.plcModel,
        input.hmiMake,input.hmiModel,input.notes,input.manufacturer,input.model,input.serialNumber,input.location,
        input.installedOn,input.status,input.parentAssetId,user.id],
    );
    await initializeSimulatedTelemetry(client, created.rows[0].id, user.id, user.organizationId);
    await audit(client, user, "equipment.created", "engineering_asset", created.rows[0].id, {
      assetTag: input.assetTag, projectId: input.projectId, parentAssetId: input.parentAssetId,
    });
    return { id: created.rows[0].id };
  });
}

export async function getEquipment(assetId: string, user: AuthenticatedUser) {
  return inTransaction(async (client) => {
    await requireAssetAccess(client, assetId, user);
    const [asset, relationships, telemetry, workOrders, downtime, auditTrail] = await Promise.all([
      client.query(
        "SELECT a.*,p.code AS project_code,parent.asset_tag AS parent_asset_tag,creator.display_name AS created_by_name " +
          "FROM engineering_assets a LEFT JOIN projects p ON p.id=a.project_id " +
          "LEFT JOIN engineering_assets parent ON parent.id=a.parent_asset_id " +
          "JOIN users creator ON creator.id=a.created_by WHERE a.id=$1",
        [assetId],
      ),
      client.query(
          "SELECT 'project' AS kind,p.id,p.code AS label,p.status AS detail,p.created_at AS occurred_at " +
            "FROM projects p WHERE p.id=(SELECT project_id FROM engineering_assets WHERE id=$1) " +
          "UNION ALL SELECT 'engineering_document',d.id,d.title,d.kind,d.created_at " +
            "FROM engineering_documents d WHERE d.asset_id=$1 " +
          "UNION ALL SELECT 'production_job',j.id,j.job_code,j.status,j.created_at FROM production_jobs j WHERE j.asset_id=$1 " +
          "UNION ALL SELECT 'field_service_job',s.id,s.title,s.status,s.created_at FROM field_service_jobs s WHERE s.asset_id=$1 " +
          "UNION ALL SELECT 'field_program_install',i.id,d.title,i.result,i.performed_at FROM field_program_installs i " +
            "JOIN field_service_jobs s ON s.id=i.service_job_id JOIN engineering_revisions r ON r.id=i.revision_id " +
            "JOIN engineering_documents d ON d.id=r.document_id WHERE s.asset_id=$1 " +
          "ORDER BY occurred_at DESC LIMIT 100",
        [assetId],
      ),
      client.query(
        "SELECT t.id,t.tag_name AS \"tagName\",t.label,t.data_type AS \"dataType\",t.semantic_type AS \"semanticType\",t.unit, " +
          "latest.value,latest.numeric_value AS \"numericValue\",latest.quality,latest.observed_at AS \"observedAt\",latest.received_at AS \"receivedAt\" " +
          "FROM asset_telemetry_tags t LEFT JOIN LATERAL (SELECT s.value,s.numeric_value,s.quality,s.observed_at,s.received_at " +
          "FROM asset_telemetry_samples s WHERE s.tag_id=t.id AND s.source_id=(SELECT id FROM asset_telemetry_sources " +
          "WHERE asset_id=$1 ORDER BY (provider='gateway') DESC LIMIT 1) ORDER BY s.received_at DESC,s.observed_at DESC LIMIT 1) latest ON true " +
          "WHERE t.asset_id=$1 AND t.enabled ORDER BY t.tag_name",
        [assetId],
      ),
      client.query(
        "SELECT m.id,m.title,m.work_type AS \"workType\",m.status,m.priority,m.due_at AS \"dueAt\",m.started_at AS \"startedAt\", " +
          "m.completed_at AS \"completedAt\",u.display_name AS \"assignedToName\" FROM maintenance_work_orders m " +
          "LEFT JOIN users u ON u.id=m.assigned_to WHERE m.asset_id=$1 ORDER BY m.due_at DESC NULLS LAST,m.created_at DESC LIMIT 100",
        [assetId],
      ),
      client.query(
        "SELECT d.id,d.source,d.reason,d.started_at AS \"startedAt\",d.ended_at AS \"endedAt\",d.notes, " +
          "d.production_downtime_id AS \"productionDowntimeId\",d.maintenance_work_order_id AS \"maintenanceWorkOrderId\", " +
          "d.created_at AS \"createdAt\" FROM asset_downtime_events d WHERE d.asset_id=$1 ORDER BY d.started_at DESC LIMIT 200",
        [assetId],
      ),
      client.query(
        "SELECT e.action,e.details,e.occurred_at AS \"occurredAt\",u.display_name AS actor FROM audit_events e " +
          "JOIN users u ON u.id=e.actor_user_id WHERE e.entity_type='engineering_asset' AND e.entity_id=$1 " +
          "ORDER BY e.occurred_at DESC LIMIT 50",
        [assetId],
      ),
    ]);
    return {
      equipment: asset.rows[0],
      relationships: relationships.rows,
      telemetry: telemetry.rows,
      workOrders: workOrders.rows,
      downtime: downtime.rows,
      audit: auditTrail.rows,
    };
  });
}

export async function updateEquipment(assetId: string, body: Record<string, unknown>, user: AuthenticatedUser) {
  requireOperationsRole(user);
  const input = parseAsset(body, true);
  if (!Object.keys(input).length) throw new HttpError(400, "NO_UPDATES", "Provide at least one equipment field to update.");
  return inTransaction(async (client) => {
    const current = await requireAssetAccess(client, assetId, user, true);
    const merged = {
      projectId: input.projectId === undefined ? current.project_id : input.projectId,
      parentAssetId: input.parentAssetId === undefined ? null : input.parentAssetId,
      customerSite: input.customerSite === undefined ? current.customer_site : input.customerSite,
    };
    if (input.parentAssetId === undefined) {
      const parent = await client.query<{ parent_asset_id: string | null }>(
        "SELECT parent_asset_id FROM engineering_assets WHERE id=$1",
        [assetId],
      );
      merged.parentAssetId = parent.rows[0].parent_asset_id;
    }
    await validateAssetRelations(client, merged, assetId);
    const nextStatus = input.status ?? current.status as AssetInput["status"];
    if (nextStatus === "retired" && current.status !== "retired") {
      const open = await client.query(
        "SELECT (EXISTS(SELECT 1 FROM maintenance_work_orders WHERE asset_id=$1 AND status IN ('scheduled','in_progress')) " +
          "OR EXISTS(SELECT 1 FROM production_jobs WHERE asset_id=$1 AND status IN ('queued','in_progress','on_hold')) " +
          "OR EXISTS(SELECT 1 FROM field_service_jobs WHERE asset_id=$1 AND status IN ('open','scheduled','in_progress'))) AS exists",
        [assetId],
      );
      if (open.rows[0].exists) throw new HttpError(409, "ACTIVE_WORK", "Complete or cancel active production, service, and maintenance work before retiring equipment.");
    }
    const columns: Record<keyof AssetInput, string> = {
      projectId: "project_id", parentAssetId: "parent_asset_id", assetTag: "asset_tag", name: "name",
      customerSite: "customer_site", area: "area", location: "location", manufacturer: "manufacturer",
      model: "model", serialNumber: "serial_number", installedOn: "installed_on", status: "status",
      plcMake: "plc_make", plcModel: "plc_model", hmiMake: "hmi_make", hmiModel: "hmi_model", notes: "notes",
    };
    const entries = Object.entries(input) as Array<[keyof AssetInput, unknown]>;
    const values: unknown[] = [];
    const sets = entries.map(([key, value]) => {
      values.push(value);
      return `${columns[key]}=$${values.length}`;
    });
    values.push(user.id, assetId);
    await client.query(
      `UPDATE engineering_assets SET ${sets.join(",")},updated_by=$${values.length - 1},updated_at=now() WHERE id=$${values.length}`,
      values,
    );
    await audit(client, user, "equipment.updated", "engineering_asset", assetId, {
      fields: entries.map(([key]) => key),
      status: nextStatus,
    });
    return { id: assetId, status: nextStatus };
  });
}

export async function retireEquipment(assetId: string, user: AuthenticatedUser) {
  return updateEquipment(assetId, { status: "retired" }, user);
}

export async function requireReadableEquipment(assetId: unknown, user: AuthenticatedUser) {
  const id = requireUuid(assetId, "equipmentId");
  return inTransaction(async (client) => {
    const asset = await requireAssetAccess(client, id, user);
    return { id, asset };
  });
}

export function assetText(value: unknown, name: string, max = 200): string {
  return optionalText(value, name, max);
}
