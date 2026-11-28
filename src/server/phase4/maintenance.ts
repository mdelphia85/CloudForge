import "server-only";
import type { PoolClient } from "pg";
import type { AuthenticatedUser } from "@/server/auth";
import { getPool, inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import { deductAvailableStock } from "@/server/inventory-allocation";
import { evaluateAutoReorder } from "@/server/auto-reorder";
import {
  audit,
  idempotencyKey,
  parsePriority,
  parseTimestamp,
  positive,
  requireAssetAccess,
  requireOperationsRole,
  requireUuid,
  shortText,
} from "./shared";

type PlanTrigger = "calendar" | "runtime" | "cycle";
type MaintenanceWorkOrder = {
  id: string;
  asset_id: string;
  project_id: string | null;
  assigned_to: string | null;
  status: string;
  work_type: string;
};

function recordObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_FIELD", `${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseChecklist(value: unknown): Array<{ label: string; required: boolean }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) {
    throw new HttpError(400, "INVALID_CHECKLIST", "A checklist may contain at most 50 items.");
  }
  return value.map((entry, index) => {
    const item = recordObject(entry, `checklist[${index}]`);
    if (item.required !== undefined && typeof item.required !== "boolean") {
      throw new HttpError(400, "INVALID_CHECKLIST", "Checklist required must be a boolean.");
    }
    return { label: shortText(item.label, `checklist[${index}].label`, 240), required: item.required !== false };
  });
}

function parseIntervalDays(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) {
    throw new HttpError(400, "INVALID_INTERVAL", "Calendar intervalDays must be an integer from 1 to 3650.");
  }
  return parsed;
}

function parseAssignedTo(value: unknown): string | null {
  return value === undefined || value === null || value === "" ? null : requireUuid(value, "assignedTo");
}

async function requireActiveUser(client: PoolClient, userId: string): Promise<void> {
  const result = await client.query("SELECT id FROM users WHERE id=$1 AND is_active=true", [userId]);
  if (!result.rowCount) throw new HttpError(404, "USER_NOT_FOUND", "The selected assignee is not active.");
}

async function requireWorkOrder(
  client: PoolClient,
  workOrderId: string,
  user: AuthenticatedUser,
  lock = false,
): Promise<MaintenanceWorkOrder> {
  const result = await client.query<MaintenanceWorkOrder>(
    `SELECT id,asset_id,project_id,assigned_to,status,work_type FROM maintenance_work_orders WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    [workOrderId],
  );
  if (!result.rowCount) throw new HttpError(404, "WORK_ORDER_NOT_FOUND", "Maintenance work order not found.");
  const workOrder = result.rows[0];
  await requireAssetAccess(client, workOrder.asset_id, user);
  if (user.role === "viewer" && workOrder.assigned_to !== user.id) {
    throw new HttpError(403, "FORBIDDEN", "Only the assigned technician can access this maintenance work order.");
  }
  return workOrder;
}

export async function listMaintenancePlans(user: AuthenticatedUser) {
  requireOperationsRole(user);
  const result = await getPool().query(
    "SELECT p.id,p.asset_id AS \"assetId\",a.asset_tag AS \"assetTag\",a.name AS \"assetName\",p.name,p.description,p.priority, " +
      "p.trigger_type AS \"triggerType\",p.interval_days AS \"intervalDays\",p.interval_value::text AS \"intervalValue\", " +
      "p.next_due_at AS \"nextDueAt\",p.next_due_value::text AS \"nextDueValue\",p.assigned_to AS \"assignedTo\", " +
      "u.display_name AS \"assigneeName\",p.is_active AS \"isActive\",p.created_at AS \"createdAt\", " +
      "(SELECT count(*)::int FROM maintenance_plan_checklist c WHERE c.plan_id=p.id) AS \"checklistCount\" " +
      "FROM maintenance_plans p JOIN engineering_assets a ON a.id=p.asset_id " +
      "LEFT JOIN users u ON u.id=p.assigned_to ORDER BY p.is_active DESC,p.next_due_at NULLS LAST,a.asset_tag,p.name LIMIT 500",
  );
  return { plans: result.rows };
}

export async function createMaintenancePlan(body: Record<string, unknown>, user: AuthenticatedUser) {
  requireOperationsRole(user);
  const assetId = requireUuid(body.assetId, "assetId");
  const name = shortText(body.name, "name", 200);
  const description = body.description === undefined || body.description === "" ? "" : shortText(body.description, "description", 2000);
  const priority = parsePriority(body.priority);
  const triggerType = body.triggerType;
  if (triggerType !== "calendar" && triggerType !== "runtime" && triggerType !== "cycle") {
    throw new HttpError(400, "INVALID_TRIGGER", "Choose calendar, runtime, or cycle.");
  }
  const assignedTo = parseAssignedTo(body.assignedTo);
  const checklist = parseChecklist(body.checklist);
  let intervalDays: number | null = null;
  let intervalValue: string | null = null;
  let nextDueAt: Date | null = null;
  let nextDueValue: string | null = null;
  if (triggerType === "calendar") {
    intervalDays = parseIntervalDays(body.intervalDays);
    if (body.nextDueAt === undefined) throw new HttpError(400, "MISSING_FIELD", "nextDueAt is required for a calendar plan.");
    nextDueAt = parseTimestamp(body.nextDueAt, "nextDueAt");
  } else {
    intervalValue = positive(body.intervalValue, "intervalValue");
    nextDueValue = positive(body.nextDueValue, "nextDueValue");
  }

  return inTransaction(async (client) => {
    const asset = await requireAssetAccess(client, assetId, user, true);
    if (asset.status === "retired") throw new HttpError(409, "EQUIPMENT_RETIRED", "Maintenance plans cannot be created for retired equipment.");
    if (assignedTo) await requireActiveUser(client, assignedTo);
    const created = await client.query<{ id: string }>(
      "INSERT INTO maintenance_plans(asset_id,name,description,priority,trigger_type,interval_days,interval_value,next_due_at,next_due_value,assigned_to,created_by,updated_by) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING id",
      [assetId,name,description,priority,triggerType,intervalDays,intervalValue,nextDueAt,nextDueValue,assignedTo,user.id],
    );
    for (const [index, item] of checklist.entries()) {
      await client.query(
        "INSERT INTO maintenance_plan_checklist(plan_id,position,label,required) VALUES($1,$2,$3,$4)",
        [created.rows[0].id,index + 1,item.label,item.required],
      );
    }
    await audit(client, user, "maintenance.plan.created", "maintenance_plan", created.rows[0].id, {
      assetId, triggerType, intervalDays, intervalValue, nextDueAt, nextDueValue, checklistCount: checklist.length,
    });
    return { id: created.rows[0].id };
  });
}

export async function updateMaintenancePlan(planId: string, body: Record<string, unknown>, user: AuthenticatedUser) {
  requireOperationsRole(user);
  if (typeof body.isActive !== "boolean" && body.assignedTo === undefined) {
    throw new HttpError(400, "NO_UPDATES", "Provide isActive or assignedTo.");
  }
  const assignedTo = body.assignedTo === undefined ? undefined : parseAssignedTo(body.assignedTo);
  return inTransaction(async (client) => {
    const plan = await client.query<{ asset_id: string; is_active: boolean }>(
      "SELECT asset_id,is_active FROM maintenance_plans WHERE id=$1 FOR UPDATE",
      [planId],
    );
    if (!plan.rowCount) throw new HttpError(404, "PLAN_NOT_FOUND", "Maintenance plan not found.");
    await requireAssetAccess(client, plan.rows[0].asset_id, user);
    if (assignedTo) await requireActiveUser(client, assignedTo);
    const nextActive = typeof body.isActive === "boolean" ? body.isActive : plan.rows[0].is_active;
    await client.query(
      "UPDATE maintenance_plans SET is_active=$2,assigned_to=CASE WHEN $3 THEN $4::uuid ELSE assigned_to END,updated_by=$5,updated_at=now() WHERE id=$1",
      [planId,nextActive,assignedTo !== undefined,assignedTo ?? null,user.id],
    );
    await audit(client, user, "maintenance.plan.updated", "maintenance_plan", planId, {
      isActive: nextActive, assignedTo: assignedTo ?? null,
    });
    return { id: planId, isActive: nextActive };
  });
}

export async function listMaintenanceWorkOrders(user: AuthenticatedUser) {
  const result = await getPool().query(
    "SELECT m.id,m.asset_id AS \"assetId\",a.asset_tag AS \"assetTag\",a.name AS \"assetName\",m.project_id AS \"projectId\", " +
      "m.plan_id AS \"planId\",m.work_type AS \"workType\",m.title,m.description,m.priority,m.status,m.due_at AS \"dueAt\", " +
      "m.assigned_to AS \"assignedTo\",u.display_name AS \"assigneeName\",m.started_at AS \"startedAt\", " +
      "m.completed_at AS \"completedAt\",m.created_at AS \"createdAt\", " +
      "(SELECT count(*)::int FROM maintenance_work_order_checklist c WHERE c.work_order_id=m.id AND c.required AND c.result='pending') AS \"pendingChecklistCount\", " +
      "(SELECT COALESCE(sum(amount),0)::text FROM maintenance_work_order_cost_events c WHERE c.work_order_id=m.id) AS \"totalCost\" " +
      "FROM maintenance_work_orders m JOIN engineering_assets a ON a.id=m.asset_id " +
      "LEFT JOIN users u ON u.id=m.assigned_to " +
      "WHERE $1 <> 'viewer' OR m.assigned_to=$2 ORDER BY m.due_at NULLS LAST,m.created_at DESC LIMIT 500",
    [user.role,user.id],
  );
  return { workOrders: result.rows };
}

export async function createMaintenanceWorkOrder(body: Record<string, unknown>, user: AuthenticatedUser) {
  requireOperationsRole(user);
  const assetId = requireUuid(body.assetId, "assetId");
  const title = shortText(body.title, "title", 200);
  const description = body.description === undefined || body.description === "" ? "" : shortText(body.description, "description", 2000);
  const workType = body.workType === undefined ? "corrective" : body.workType;
  if (workType !== "preventive" && workType !== "corrective") {
    throw new HttpError(400, "INVALID_WORK_TYPE", "Choose preventive or corrective.");
  }
  const priority = parsePriority(body.priority);
  const dueAt = body.dueAt ? parseTimestamp(body.dueAt, "dueAt") : null;
  const assignedTo = parseAssignedTo(body.assignedTo);
  const checklist = parseChecklist(body.checklist);
  return inTransaction(async (client) => {
    const asset = await requireAssetAccess(client, assetId, user, true);
    if (asset.status === "retired") throw new HttpError(409, "EQUIPMENT_RETIRED", "Work orders cannot be created for retired equipment.");
    if (assignedTo) await requireActiveUser(client, assignedTo);
    const created = await client.query<{ id: string }>(
      "INSERT INTO maintenance_work_orders(asset_id,project_id,work_type,title,description,priority,due_at,assigned_to,created_by) " +
        "SELECT id,project_id,$2,$3,$4,$5,$6,$7,$8 FROM engineering_assets WHERE id=$1 RETURNING id",
      [assetId,workType,title,description,priority,dueAt,assignedTo,user.id],
    );
    for (const [index, item] of checklist.entries()) {
      await client.query(
        "INSERT INTO maintenance_work_order_checklist(work_order_id,position,label,required) VALUES($1,$2,$3,$4)",
        [created.rows[0].id,index + 1,item.label,item.required],
      );
    }
    await recordWorkOrderEvent(client, user, created.rows[0].id, "created", {
      assetId, workType, dueAt, checklistCount: checklist.length,
    });
    await audit(client, user, "maintenance.work_order.created", "maintenance_work_order", created.rows[0].id, {
      assetId, workType, dueAt, assignedTo,
    });
    return { id: created.rows[0].id };
  });
}

export async function getMaintenanceWorkOrder(workOrderId: string, user: AuthenticatedUser) {
  return inTransaction(async (client) => {
    await requireWorkOrder(client, workOrderId, user);
    const [order, checklist, parts, costs, events] = await Promise.all([
      client.query(
        "SELECT m.*,a.asset_tag AS \"assetTag\",a.name AS \"assetName\",u.display_name AS \"assigneeName\", " +
          "(SELECT COALESCE(sum(c.amount),0)::text FROM maintenance_work_order_cost_events c WHERE c.work_order_id=m.id) AS \"totalCost\" " +
          "FROM maintenance_work_orders m JOIN engineering_assets a ON a.id=m.asset_id " +
          "LEFT JOIN users u ON u.id=m.assigned_to WHERE m.id=$1",
        [workOrderId],
      ),
      client.query(
        "SELECT c.id,c.position,c.label,c.required,c.result,c.notes,c.updated_at AS \"updatedAt\",u.display_name AS \"updatedByName\" " +
          "FROM maintenance_work_order_checklist c LEFT JOIN users u ON u.id=c.updated_by " +
          "WHERE c.work_order_id=$1 ORDER BY c.position",
        [workOrderId],
      ),
      client.query(
        "SELECT p.id,p.action,p.quantity::text,p.location,p.bin,p.unit_cost::text AS \"unitCost\",p.notes,p.created_at AS \"createdAt\", " +
          "i.sku,i.name AS \"itemName\",i.unit FROM maintenance_work_order_parts p " +
          "JOIN inventory_items i ON i.id=p.item_id WHERE p.work_order_id=$1 ORDER BY p.created_at DESC",
        [workOrderId],
      ),
      client.query(
        "SELECT id,cost_type AS \"costType\",description,amount::text,created_at AS \"createdAt\" " +
          "FROM maintenance_work_order_cost_events WHERE work_order_id=$1 ORDER BY created_at DESC",
        [workOrderId],
      ),
      client.query(
        "SELECT e.id,e.event_type AS \"eventType\",e.details,e.created_at AS \"createdAt\",u.display_name AS actor " +
          "FROM maintenance_work_order_events e JOIN users u ON u.id=e.actor_id " +
          "WHERE e.work_order_id=$1 ORDER BY e.created_at DESC LIMIT 200",
        [workOrderId],
      ),
    ]);
    return { workOrder: order.rows[0], checklist: checklist.rows, parts: parts.rows, costs: costs.rows, events: events.rows };
  });
}

async function recordWorkOrderEvent(
  client: PoolClient,
  user: AuthenticatedUser,
  workOrderId: string,
  eventType: string,
  details: Record<string, unknown>,
) {
  await client.query(
    "INSERT INTO maintenance_work_order_events(work_order_id,event_type,details,actor_id) VALUES($1,$2,$3::jsonb,$4)",
    [workOrderId,eventType,JSON.stringify(details),user.id],
  );
}

export async function updateMaintenanceWorkOrder(
  workOrderId: string,
  body: Record<string, unknown>,
  user: AuthenticatedUser,
) {
  const action = body.action;
  if (action !== "assign" && action !== "start" && action !== "complete" && action !== "close" && action !== "cancel") {
    throw new HttpError(400, "INVALID_ACTION", "Choose assign, start, complete, close, or cancel.");
  }
  if (action === "assign" || action === "close" || action === "cancel") requireOperationsRole(user);
  return inTransaction(async (client) => {
    const order = await requireWorkOrder(client, workOrderId, user, true);
    if (action === "assign") {
      const assignee = parseAssignedTo(body.assignedTo);
      if (assignee) await requireActiveUser(client, assignee);
      await client.query("UPDATE maintenance_work_orders SET assigned_to=$2,updated_at=now() WHERE id=$1", [workOrderId,assignee]);
      await recordWorkOrderEvent(client,user,workOrderId,"assigned",{assignedTo:assignee});
      await audit(client,user,"maintenance.work_order.assigned","maintenance_work_order",workOrderId,{assignedTo:assignee});
      return { id: workOrderId, assignedTo: assignee };
    }

    if (action === "start") {
      if (order.status !== "scheduled") throw new HttpError(409, "INVALID_TRANSITION", "Only scheduled work orders can be started.");
      await client.query(
        "UPDATE maintenance_work_orders SET status='in_progress',started_at=now(),updated_at=now() WHERE id=$1",
        [workOrderId],
      );
    } else if (action === "complete") {
      if (order.status !== "in_progress") throw new HttpError(409, "INVALID_TRANSITION", "Only in-progress work orders can be completed.");
      const incomplete = await client.query(
        "SELECT count(*)::int AS count FROM maintenance_work_order_checklist WHERE work_order_id=$1 AND required AND result='pending'",
        [workOrderId],
      );
      if (incomplete.rows[0].count > 0) {
        throw new HttpError(409, "CHECKLIST_INCOMPLETE", "Complete every required checklist item before completing this work order.");
      }
      await client.query(
        "UPDATE maintenance_work_orders SET status='completed',completed_at=now(),updated_at=now() WHERE id=$1",
        [workOrderId],
      );
    } else if (action === "close") {
      if (order.status !== "completed") throw new HttpError(409, "INVALID_TRANSITION", "Only completed work orders can be closed.");
      await client.query("UPDATE maintenance_work_orders SET status='closed',updated_at=now() WHERE id=$1", [workOrderId]);
    } else {
      if (order.status !== "scheduled") throw new HttpError(409, "INVALID_TRANSITION", "Only scheduled work orders can be cancelled.");
      await client.query("UPDATE maintenance_work_orders SET status='cancelled',updated_at=now() WHERE id=$1", [workOrderId]);
    }
    const eventType = action === "start" ? "started" : action === "complete" ? "completed" : action === "close" ? "closed" : "cancelled";
    await recordWorkOrderEvent(client,user,workOrderId,eventType,{});
    await audit(client,user,`maintenance.work_order.${action}`,"maintenance_work_order",workOrderId,{});
    return { id: workOrderId, status: action === "start" ? "in_progress" : action === "complete" ? "completed" : action === "close" ? "closed" : "cancelled" };
  });
}

export async function updateMaintenanceChecklist(
  workOrderId: string,
  checklistId: string,
  body: Record<string, unknown>,
  user: AuthenticatedUser,
) {
  const result = body.result;
  if (result !== "pass" && result !== "fail" && result !== "not_applicable") {
    throw new HttpError(400, "INVALID_CHECKLIST_RESULT", "Choose pass, fail, or not_applicable.");
  }
  const notes = body.notes === undefined || body.notes === "" ? "" : shortText(body.notes, "notes", 1000);
  return inTransaction(async (client) => {
    const order = await requireWorkOrder(client,workOrderId,user,true);
    if (order.status !== "scheduled" && order.status !== "in_progress") {
      throw new HttpError(409, "WORK_ORDER_CLOSED", "Checklist items can only be updated on scheduled or in-progress work orders.");
    }
    const updated = await client.query(
      "UPDATE maintenance_work_order_checklist SET result=$3,notes=$4,updated_by=$5,updated_at=now() " +
        "WHERE id=$1 AND work_order_id=$2 RETURNING label,required",
      [checklistId,workOrderId,result,notes,user.id],
    );
    if (!updated.rowCount) throw new HttpError(404, "CHECKLIST_ITEM_NOT_FOUND", "Checklist item not found.");
    await recordWorkOrderEvent(client,user,workOrderId,"checklist_updated",{
      checklistId,label:updated.rows[0].label,result,notes,
    });
    await audit(client,user,"maintenance.checklist.updated","maintenance_work_order",workOrderId,{
      checklistId,result,notes,
    });
    return { id: checklistId, result };
  });
}

function nonNegativeMoney(value: unknown, name: string): string {
  const raw = typeof value === "number" || typeof value === "string" ? String(value) : "";
  if (!/^\d{1,11}(?:\.\d{1,4})?$/.test(raw)) {
    throw new HttpError(400, "INVALID_AMOUNT", `${name} must be a non-negative amount with up to four decimal places.`);
  }
  return raw;
}

export async function recordMaintenancePart(
  workOrderId: string,
  body: Record<string, unknown>,
  user: AuthenticatedUser,
) {
  const action = body.action;
  if (action !== "used" && action !== "returned") throw new HttpError(400, "INVALID_ACTION", "Choose used or returned.");
  const sku = shortText(body.sku, "sku", 64).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(sku)) throw new HttpError(400, "INVALID_SKU", "Provide an existing inventory SKU.");
  const quantity = positive(body.quantity, "quantity");
  const location = shortText(body.location, "location", 160);
  const bin = shortText(body.bin, "bin", 100);
  const key = idempotencyKey(body.idempotencyKey);
  const notes = body.notes === undefined || body.notes === "" ? "" : shortText(body.notes, "notes", 1000);
  const submittedUnitCost = body.unitCost === undefined ? null : nonNegativeMoney(body.unitCost, "unitCost");
  if (action === "used" && submittedUnitCost === null) {
    throw new HttpError(400, "MISSING_FIELD", "unitCost is required when issuing a part.");
  }

  return inTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["maintenance-part:" + key]);
    const order = await requireWorkOrder(client,workOrderId,user,true);
    const previous = await client.query<{
      id: string; work_order_id: string; item_id: string; action: string; location: string; bin: string; notes: string; unit_cost: string;
    }>(
      "SELECT id,work_order_id,item_id,action,location,bin,notes,unit_cost::text FROM maintenance_work_order_parts WHERE idempotency_key=$1",
      [key],
    );
    if (previous.rowCount) {
      const row = previous.rows[0];
      const matchesQuantity = await client.query<{ matches: boolean }>(
        "SELECT quantity=$1::numeric AS matches FROM maintenance_work_order_parts WHERE id=$2",
        [quantity,row.id],
      );
      const item = await client.query<{ id: string }>("SELECT id FROM inventory_items WHERE sku=$1", [sku]);
      if (row.work_order_id !== workOrderId || row.item_id !== item.rows[0]?.id || row.action !== action ||
          row.location !== location || row.bin !== bin || row.notes !== notes || !matchesQuantity.rows[0].matches ||
          (action === "used" && Number(row.unit_cost) !== Number(submittedUnitCost))) {
        throw new HttpError(409, "KEY_REUSED", "The idempotency key was already used for different part details.");
      }
      return { id: row.id, replayed: true };
    }
    if (action === "used" && order.status !== "in_progress") {
      throw new HttpError(409, "WORK_ORDER_NOT_STARTED", "Parts can only be issued to an in-progress work order.");
    }
    if (action === "returned" && order.status !== "in_progress" && order.status !== "completed") {
      throw new HttpError(409, "WORK_ORDER_CLOSED", "Parts can only be returned before the work order is closed or cancelled.");
    }
    const item = await client.query<{ id: string; unit: string }>(
      "SELECT id,unit FROM inventory_items WHERE sku=$1 AND ($2='returned' OR is_active=true) AND organization_id=$3 FOR UPDATE",
      [sku,action,user.organizationId],
    );
    if (!item.rowCount) throw new HttpError(404, "ITEM_NOT_FOUND", "Active inventory item not found.");

    let unitCost = submittedUnitCost ?? "0";
    if (action === "used") {
      await deductAvailableStock(client,item.rows[0].id,location,bin,quantity,user.id);
      await evaluateAutoReorder(client,user.organizationId,item.rows[0].id,user.id);
    } else {
      const issued = await client.query<{ remaining: string; remaining_cost: string }>(
        "SELECT COALESCE(SUM(CASE WHEN action='used' THEN quantity ELSE -quantity END),0)::text AS remaining, " +
          "COALESCE(SUM(CASE WHEN action='used' THEN quantity*unit_cost ELSE -quantity*unit_cost END),0)::text AS remaining_cost " +
          "FROM maintenance_work_order_parts WHERE work_order_id=$1 AND item_id=$2 AND location=$3 AND bin=$4",
        [workOrderId,item.rows[0].id,location,bin],
      );
      if (Number(issued.rows[0].remaining) < Number(quantity)) {
        throw new HttpError(409, "RETURN_EXCEEDS_USAGE", "Returned quantity cannot exceed parts issued from this bin.");
      }
      if (Number(issued.rows[0].remaining) <= 0) throw new HttpError(409, "RETURN_EXCEEDS_USAGE", "No issued quantity remains to return.");
      unitCost = (Number(issued.rows[0].remaining_cost) / Number(issued.rows[0].remaining)).toFixed(4);
      const stock = await client.query(
        "UPDATE inventory_stock SET on_hand=on_hand+$1::numeric,updated_at=now(),updated_by=$2 " +
          "WHERE item_id=$3 AND location=$4 AND bin=$5 RETURNING id",
        [quantity,user.id,item.rows[0].id,location,bin],
      );
      if (!stock.rowCount) throw new HttpError(404, "STOCK_NOT_FOUND", "The return location/bin does not exist for this item.");
    }

    const movement = await client.query<{ id: string }>(
      action === "used"
        ? "INSERT INTO inventory_movements(item_id,movement_type,quantity_delta,from_location,from_bin,reference,actor_user_id,idempotency_key) " +
          "VALUES($1,'issue',-$2::numeric,$3,$4,$5,$6,$7) RETURNING id"
        : "INSERT INTO inventory_movements(item_id,movement_type,quantity_delta,to_location,to_bin,reference,actor_user_id,idempotency_key) " +
          "VALUES($1,'receipt',$2::numeric,$3,$4,$5,$6,$7) RETURNING id",
      action === "used"
        ? [item.rows[0].id,quantity,location,bin,`Maintenance ${workOrderId}`,user.id,`maintenance-part:${key}`]
        : [item.rows[0].id,quantity,location,bin,`Maintenance return ${workOrderId}`,user.id,`maintenance-part:${key}`],
    );
    const part = await client.query<{ id: string }>(
      "INSERT INTO maintenance_work_order_parts(work_order_id,item_id,action,quantity,location,bin,unit_cost,inventory_movement_id,idempotency_key,notes,actor_id) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
      [workOrderId,item.rows[0].id,action,quantity,location,bin,unitCost,movement.rows[0].id,key,notes,user.id],
    );
    const amount = (Number(quantity) * Number(unitCost) * (action === "used" ? 1 : -1)).toFixed(4);
    await client.query(
      "INSERT INTO maintenance_work_order_cost_events(work_order_id,project_id,source_part_id,cost_type,description,amount,idempotency_key,actor_id) " +
        "VALUES($1,$2,$3,'material',$4,$5,$6,$7)",
      [workOrderId,order.project_id,part.rows[0].id,`${action === "used" ? "Issued" : "Returned"} ${sku}`,amount,`maintenance-cost:${key}`,user.id],
    );
    await recordWorkOrderEvent(client,user,workOrderId,action === "used" ? "part_issued" : "part_returned",{
      partId:part.rows[0].id,sku,quantity,location,bin,unitCost,
    });
    await audit(client,user,`maintenance.part.${action}`,"maintenance_work_order",workOrderId,{
      partId:part.rows[0].id,sku,quantity,location,bin,unitCost,amount,
    });
    await audit(client,user,action === "used" ? "inventory.issue" : "inventory.receipt","inventory_item",item.rows[0].id,{
      workOrderId,sku,quantity,location,bin,
    });
    return { id: part.rows[0].id, replayed: false, amount };
  });
}

export async function recordMaintenanceCost(
  workOrderId: string,
  body: Record<string, unknown>,
  user: AuthenticatedUser,
) {
  requireOperationsRole(user);
  const costType = body.costType;
  if (costType !== "labor" && costType !== "other") throw new HttpError(400, "INVALID_COST_TYPE", "Choose labor or other.");
  const description = shortText(body.description, "description", 240);
  const amount = nonNegativeMoney(body.amount, "amount");
  const key = idempotencyKey(body.idempotencyKey);
  return inTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["maintenance-cost:" + key]);
    const order = await requireWorkOrder(client,workOrderId,user,true);
    const existing = await client.query<{ id: string; work_order_id: string; cost_type: string; description: string; matches_amount: boolean }>(
      "SELECT id,work_order_id,cost_type,description,amount=$1::numeric AS matches_amount " +
        "FROM maintenance_work_order_cost_events WHERE idempotency_key=$2",
      [amount,key],
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (row.work_order_id !== workOrderId || row.cost_type !== costType || row.description !== description ||
          !row.matches_amount) {
        throw new HttpError(409, "KEY_REUSED", "The idempotency key was already used for different cost details.");
      }
      return { id: row.id, replayed: true };
    }
    if (order.status !== "in_progress" && order.status !== "completed") {
      throw new HttpError(409, "WORK_ORDER_CLOSED", "Costs can only be recorded on in-progress or completed work orders.");
    }
    const inserted = await client.query<{ id: string }>(
      "INSERT INTO maintenance_work_order_cost_events(work_order_id,project_id,cost_type,description,amount,idempotency_key,actor_id) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [workOrderId,order.project_id,costType,description,amount,key,user.id],
    );
    await audit(client,user,"maintenance.cost.recorded","maintenance_work_order",workOrderId,{
      costId:inserted.rows[0].id,costType,description,amount,
    });
    return { id: inserted.rows[0].id, replayed: false };
  });
}

async function readCounter(
  client: PoolClient,
  assetId: string,
  semanticType: PlanTrigger,
): Promise<number | null> {
  const result = await client.query<{ numeric_value: string }>(
    "SELECT s.numeric_value::text FROM asset_telemetry_samples s " +
      "JOIN asset_telemetry_tags t ON t.id=s.tag_id " +
      "JOIN asset_telemetry_sources src ON src.id=s.source_id " +
      "WHERE t.asset_id=$1 AND t.semantic_type=$2 AND t.enabled AND s.quality='good' " +
      "AND s.ordering_state='ordered' AND s.observed_at >= now()-interval '5 minutes' " +
      "AND src.enabled AND src.connection_state='connected' AND src.last_seen_at >= now()-interval '3 minutes' " +
      "AND (src.provider='simulated' OR EXISTS(SELECT 1 FROM industrial_gateways g WHERE g.id=src.gateway_id " +
      "AND g.enabled AND g.revoked_at IS NULL AND g.expires_at>now())) " +
      "AND src.id=(SELECT id FROM asset_telemetry_sources WHERE asset_id=$1 ORDER BY (provider='gateway') DESC LIMIT 1) " +
      "ORDER BY s.observed_at DESC,s.received_at DESC LIMIT 1",
    [assetId,semanticType === "runtime" ? "runtime_counter" : "cycle_counter"],
  );
  return result.rowCount ? Number(result.rows[0].numeric_value) : null;
}

async function createDueWorkOrder(
  client: PoolClient,
  user: AuthenticatedUser,
  plan: { id: string; asset_id: string; project_id: string | null; name: string; description: string; priority: string; assigned_to: string | null },
  dueInstance: string,
  dueAt: Date,
): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    "INSERT INTO maintenance_work_orders(asset_id,project_id,plan_id,due_instance,work_type,title,description,priority,status,due_at,assigned_to,created_by) " +
      "VALUES($1,$2,$3,$4,'preventive',$5,$6,$7,'scheduled',$8,$9,$10) " +
      "ON CONFLICT(plan_id,due_instance) DO NOTHING RETURNING id",
    [plan.asset_id,plan.project_id,plan.id,dueInstance,plan.name,plan.description,plan.priority,dueAt,plan.assigned_to,user.id],
  );
  if (!result.rowCount) return false;
  await client.query(
    "INSERT INTO maintenance_work_order_checklist(work_order_id,source_item_id,position,label,required) " +
      "SELECT $1,id,position,label,required FROM maintenance_plan_checklist WHERE plan_id=$2 ORDER BY position",
    [result.rows[0].id,plan.id],
  );
  await recordWorkOrderEvent(client,user,result.rows[0].id,"created",{
    planId:plan.id,dueInstance,dueAt,
  });
  await audit(client,user,"maintenance.work_order.generated","maintenance_work_order",result.rows[0].id,{
    planId:plan.id,dueInstance,dueAt,
  });
  return true;
}

export async function generateDueMaintenanceWorkOrders(user: AuthenticatedUser) {
  requireOperationsRole(user);
  return inTransaction(async (client) => {
    const plans = await client.query<{
      id: string; asset_id: string; project_id: string | null; name: string; description: string; priority: string;
      trigger_type: PlanTrigger; interval_days: number | null; interval_value: string | null;
      next_due_at: Date | null; next_due_value: string | null; assigned_to: string | null;
    }>(
      "SELECT p.id,p.asset_id,a.project_id,p.name,p.description,p.priority,p.trigger_type,p.interval_days, " +
        "p.interval_value::text,p.next_due_at,p.next_due_value::text,p.assigned_to " +
        "FROM maintenance_plans p JOIN engineering_assets a ON a.id=p.asset_id " +
        "WHERE p.is_active AND a.status<>'retired' ORDER BY p.id FOR UPDATE OF p SKIP LOCKED",
    );
    let generated = 0;
    let scanned = 0;
    const now = new Date();
    for (const plan of plans.rows) {
      if (plan.trigger_type === "calendar") {
        let dueAt = plan.next_due_at;
        if (!dueAt) continue;
        let count = 0;
        while (dueAt.getTime() <= now.getTime() && count < 100) {
          const dueInstance = `calendar:${dueAt.toISOString()}`;
          if (await createDueWorkOrder(client,user,plan,dueInstance,dueAt)) generated += 1;
          dueAt = new Date(dueAt);
          dueAt.setUTCDate(dueAt.getUTCDate() + (plan.interval_days ?? 1));
          count += 1;
        }
        scanned += count;
        if (count) {
          await client.query(
            "UPDATE maintenance_plans SET next_due_at=$2,updated_by=$3,updated_at=now() WHERE id=$1",
            [plan.id,dueAt,user.id],
          );
        }
        continue;
      }
      const counter = await readCounter(client,plan.asset_id,plan.trigger_type);
      if (counter === null || !plan.next_due_value || !plan.interval_value) continue;
      let nextDue = Number(plan.next_due_value);
      const interval = Number(plan.interval_value);
      let count = 0;
      while (counter >= nextDue && count < 100) {
        const dueValue = nextDue.toFixed(3);
        const dueInstance = `${plan.trigger_type}:${dueValue}`;
        if (await createDueWorkOrder(client,user,plan,dueInstance,now)) generated += 1;
        nextDue = Number((nextDue + interval).toFixed(3));
        count += 1;
      }
      scanned += count;
      if (count) {
        await client.query(
          "UPDATE maintenance_plans SET next_due_value=$2,updated_by=$3,updated_at=now() WHERE id=$1",
          [plan.id,nextDue.toFixed(3),user.id],
        );
      }
    }
    await audit(client,user,"maintenance.scheduler.ran","maintenance_plan",plans.rows[0]?.id ?? user.id,{
      plansChecked:plans.rowCount ?? 0,occurrencesScanned:scanned,workOrdersGenerated:generated,
    });
    return { plansChecked: plans.rowCount ?? 0, occurrencesScanned: scanned, workOrdersGenerated: generated };
  });
}

export async function maintenanceOptions(user: AuthenticatedUser) {
  requireOperationsRole(user);
  const [equipment, users, items, projects] = await Promise.all([
    getPool().query(
      "SELECT id,asset_tag AS \"assetTag\",name FROM engineering_assets WHERE status<>'retired' ORDER BY asset_tag LIMIT 500",
    ),
    getPool().query(
      "SELECT id,display_name AS \"displayName\",email,role FROM users WHERE is_active ORDER BY display_name LIMIT 500",
    ),
    getPool().query(
      "SELECT sku,name,unit FROM inventory_items WHERE is_active ORDER BY sku LIMIT 500",
    ),
    getPool().query("SELECT id,code,name FROM projects ORDER BY code LIMIT 500"),
  ]);
  return { equipment: equipment.rows, users: users.rows, items: items.rows, projects: projects.rows };
}
