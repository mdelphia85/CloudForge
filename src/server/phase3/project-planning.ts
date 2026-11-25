import "server-only";
import type { AuthenticatedUser } from "@/server/auth";
import { getPool, inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import { audit, nonNegativeMoney, optionalDate, optionalText, positive, requireUuid, shortText } from "./shared";
import { getMaterialShortages } from "./materials";

export async function getProjectPlanning(projectId: string) {
  const [project, tasks, milestones, resources, costs, dependencies, milestoneDependencies, readiness,
    purchaseOrders, productionJobs, serviceJobs, engineeringDocuments] = await Promise.all([
    getPool().query(
      "SELECT p.*,u.display_name AS owner_name FROM projects p LEFT JOIN users u ON u.id=p.owner_user_id WHERE p.id=$1",
      [projectId],
    ),
    getPool().query(
      "SELECT t.*,u.display_name AS assignee_name FROM project_tasks t LEFT JOIN users u ON u.id=t.assignee_id " +
        "WHERE t.project_id=$1 ORDER BY t.created_at",
      [projectId],
    ),
    getPool().query(
      "SELECT m.*,u.display_name AS assignee_name FROM project_milestones m LEFT JOIN users u ON u.id=m.assignee_id " +
        "WHERE m.project_id=$1 ORDER BY m.due_date NULLS LAST,m.code",
      [projectId],
    ),
    getPool().query(
      "SELECT r.*,u.display_name AS user_name FROM project_resources r JOIN users u ON u.id=r.user_id " +
        "WHERE r.project_id=$1 ORDER BY u.display_name,r.discipline",
      [projectId],
    ),
    getPool().query(
      "SELECT *, (quantity*estimated_unit_cost)::text AS estimated_total, (quantity*actual_unit_cost)::text AS actual_total " +
        "FROM project_cost_entries WHERE project_id=$1 ORDER BY created_at DESC LIMIT 300",
      [projectId],
    ),
    getPool().query(
      "SELECT d.task_id AS \"taskId\",d.depends_on_task_id AS \"dependsOnTaskId\",t.title AS \"taskTitle\",p.title AS \"dependsOnTitle\" " +
        "FROM project_task_dependencies d JOIN project_tasks t ON t.id=d.task_id " +
        "JOIN project_tasks p ON p.id=d.depends_on_task_id WHERE d.project_id=$1 ORDER BY t.title,p.title",
      [projectId],
    ),
    getPool().query(
      "SELECT d.milestone_id AS \"milestoneId\",d.depends_on_milestone_id AS \"dependsOnMilestoneId\", " +
        "m.title AS \"milestoneTitle\",p.title AS \"dependsOnTitle\" FROM project_milestone_dependencies d " +
        "JOIN project_milestones m ON m.id=d.milestone_id JOIN project_milestones p ON p.id=d.depends_on_milestone_id " +
        "WHERE d.project_id=$1 ORDER BY m.title,p.title",
      [projectId],
    ),
    getMaterialShortages(projectId),
    getPool().query(
      "SELECT po.id,po.po_number AS \"poNumber\",po.status,po.expected_delivery AS \"expectedDelivery\",s.name AS \"supplierName\"," +
        "coalesce(sum(l.ordered_qty),0)::text AS \"orderedQty\",coalesce(sum(l.received_qty),0)::text AS \"receivedQty\" " +
        "FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN purchase_order_lines l ON l.purchase_order_id=po.id " +
        "WHERE po.project_id=$1 OR l.project_id=$1 GROUP BY po.id,s.name ORDER BY po.created_at DESC",
      [projectId],
    ),
    getPool().query(
      "SELECT id,job_code,title,status,planned_qty::text AS planned_qty,completed_qty::text AS completed_qty,scrap_qty::text AS scrap_qty " +
        "FROM production_jobs WHERE project_id=$1 ORDER BY created_at DESC",
      [projectId],
    ),
    getPool().query(
      "SELECT s.id,s.title,s.status,s.scheduled_date,a.asset_tag,a.name AS asset_name,u.display_name AS technician_name " +
        "FROM field_service_jobs s JOIN engineering_assets a ON a.id=s.asset_id LEFT JOIN users u ON u.id=s.assigned_to " +
        "WHERE s.project_id=$1 ORDER BY s.created_at DESC",
      [projectId],
    ),
    getPool().query(
      "SELECT d.id,d.title,d.kind,(SELECT count(*)::int FROM engineering_revisions r WHERE r.document_id=d.id) AS revisions," +
        "(SELECT max(revision) FROM engineering_revisions r WHERE r.document_id=d.id AND r.status='approved') AS approved_revision " +
        "FROM engineering_documents d WHERE d.project_id=$1 OR d.asset_id IN " +
        "(SELECT id FROM engineering_assets WHERE project_id=$1) ORDER BY d.created_at DESC",
      [projectId],
    ),
  ]);
  if (!project.rowCount) throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found.");
  return {
    project: project.rows[0],
    tasks: tasks.rows,
    milestones: milestones.rows,
    resources: resources.rows,
    costs: costs.rows,
    taskDependencies: dependencies.rows,
    milestoneDependencies: milestoneDependencies.rows,
    materialReadiness: readiness,
    purchaseOrders: purchaseOrders.rows,
    productionJobs: productionJobs.rows,
    serviceJobs: serviceJobs.rows,
    engineeringDocuments: engineeringDocuments.rows,
  };
}

export async function updateProjectPlanning(
  projectId: string,
  body: Record<string, unknown>,
  user: AuthenticatedUser,
) {
  const action = body.action;
  if (typeof action !== "string") throw new HttpError(400, "INVALID_ACTION", "Choose a project planning action.");
  return inTransaction(async (client) => {
    const project = await client.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [projectId]);
    if (!project.rowCount) throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found.");
    if (action === "milestone") {
      const code = shortText(body.code, "code", 40).toUpperCase();
      const title = shortText(body.title, "title", 200);
      const dueDate = optionalDate(body.dueDate, "dueDate");
      const assignee = body.assigneeId ? requireUuid(body.assigneeId, "assigneeId") : null;
      const notes = optionalText(body.notes, "notes", 2000);
      if (assignee) {
        const found = await client.query("SELECT id FROM users WHERE id=$1 AND is_active=true", [assignee]);
        if (!found.rowCount) throw new HttpError(404, "USER_NOT_FOUND", "Milestone assignee is not active.");
      }
      const created = await client.query<{ id: string }>(
        "INSERT INTO project_milestones(project_id,code,title,due_date,assignee_id,notes,created_by) " +
          "VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [projectId, code, title, dueDate, assignee, notes, user.id],
      );
      await audit(client, user, "project.milestone.created", "project_milestone", created.rows[0].id, { projectId, code });
      return { id: created.rows[0].id };
    }

    if (action === "task") {
      const title = shortText(body.title, "title", 240);
      const discipline = body.discipline;
      if (discipline !== "engineering" && discipline !== "project" &&
          discipline !== "production" && discipline !== "field_service") {
        throw new HttpError(400, "INVALID_DISCIPLINE", "Choose a valid task discipline.");
      }
      const dueDate = optionalDate(body.dueDate, "dueDate");
      const assignee = body.assigneeId ? requireUuid(body.assigneeId, "assigneeId") : null;
      const notes = optionalText(body.notes, "notes", 2000);
      if (assignee) {
        const found = await client.query("SELECT id FROM users WHERE id=$1 AND is_active=true", [assignee]);
        if (!found.rowCount) throw new HttpError(404, "USER_NOT_FOUND", "Task assignee is not active.");
      }
      const created = await client.query<{ id: string }>(
        "INSERT INTO project_tasks(project_id,title,discipline,assignee_id,due_date,notes,created_by) " +
          "VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [projectId, title, discipline, assignee, dueDate, notes, user.id],
      );
      await audit(client, user, "project.task.created", "project_task", created.rows[0].id, {
        projectId, discipline, assigneeId: assignee,
      });
      return { id: created.rows[0].id };
    }

    if (action === "taskStatus") {
      const taskId = requireUuid(body.taskId, "taskId");
      const next = body.status;
      if (next !== "todo" && next !== "in_progress" && next !== "blocked" && next !== "done") {
        throw new HttpError(400, "INVALID_STATUS", "Choose a valid task status.");
      }
      const task = await client.query<{ status: string }>(
        "SELECT status FROM project_tasks WHERE id=$1 AND project_id=$2 FOR UPDATE",
        [taskId, projectId],
      );
      if (!task.rowCount) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found.");
      const allowed: Record<string, string[]> = {
        todo: ["in_progress", "blocked", "done"],
        in_progress: ["blocked", "done"],
        blocked: ["in_progress", "done"],
        done: [],
      };
      if (!allowed[task.rows[0].status]?.includes(next)) {
        throw new HttpError(409, "INVALID_TRANSITION", `A ${task.rows[0].status} task cannot change to ${next}.`);
      }
      if (next === "done") {
        const pending = await client.query(
          "SELECT 1 FROM project_task_dependencies d JOIN project_tasks t ON t.id=d.depends_on_task_id " +
            "WHERE d.task_id=$1 AND t.status<>'done' LIMIT 1",
          [taskId],
        );
        if (pending.rowCount) throw new HttpError(409, "DEPENDENCY_PENDING", "Complete prerequisite tasks before this task.");
      }
      await client.query("UPDATE project_tasks SET status=$2,updated_at=now() WHERE id=$1", [taskId, next]);
      await audit(client, user, "project.task.status_changed", "project_task", taskId, {
        from: task.rows[0].status, to: next,
      });
      return { id: taskId, status: next };
    }

    if (action === "milestoneStatus") {
      const milestoneId = requireUuid(body.milestoneId, "milestoneId");
      const next = body.status;
      if (next !== "planned" && next !== "in_progress" && next !== "blocked" && next !== "completed") {
        throw new HttpError(400, "INVALID_STATUS", "Choose a valid milestone status.");
      }
      const milestone = await client.query<{ status: string }>(
        "SELECT status FROM project_milestones WHERE id=$1 AND project_id=$2 FOR UPDATE",
        [milestoneId, projectId],
      );
      if (!milestone.rowCount) throw new HttpError(404, "MILESTONE_NOT_FOUND", "Milestone not found.");
      if (next === "completed") {
        const pending = await client.query(
          "SELECT 1 FROM project_milestone_dependencies d JOIN project_milestones m ON m.id=d.depends_on_milestone_id " +
            "WHERE d.milestone_id=$1 AND m.status<>'completed' LIMIT 1",
          [milestoneId],
        );
        if (pending.rowCount) throw new HttpError(409, "DEPENDENCY_PENDING", "Complete prerequisite milestones before this milestone.");
      }
      await client.query("UPDATE project_milestones SET status=$2,updated_at=now() WHERE id=$1", [milestoneId, next]);
      await audit(client, user, "project.milestone.status_changed", "project_milestone", milestoneId, {
        from: milestone.rows[0].status, to: next,
      });
      return { id: milestoneId, status: next };
    }

    if (action === "resource") {
      const userId = requireUuid(body.userId, "userId");
      const discipline = shortText(body.discipline, "discipline", 80);
      const allocation = nonNegativeMoney(body.allocationPercent ?? 100, "allocationPercent");
      const startsOn = optionalDate(body.startsOn, "startsOn");
      const endsOn = optionalDate(body.endsOn, "endsOn");
      const notes = optionalText(body.notes, "notes", 2000);
      if (Number(allocation) <= 0 || Number(allocation) > 100) {
        throw new HttpError(400, "INVALID_ALLOCATION", "Allocation must be greater than 0 and no more than 100 percent.");
      }
      if (startsOn && endsOn && endsOn < startsOn) throw new HttpError(400, "INVALID_DATES", "Resource end date cannot precede its start date.");
      const found = await client.query("SELECT id FROM users WHERE id=$1 AND is_active=true", [userId]);
      if (!found.rowCount) throw new HttpError(404, "USER_NOT_FOUND", "Project resource is not active.");
      const assigned = await client.query<{ allocation: string }>(
        "SELECT coalesce(sum(allocation_percent),0)::text AS allocation FROM project_resources WHERE project_id=$1 AND user_id=$2",
        [projectId, userId],
      );
      if (Number(assigned.rows[0].allocation) + Number(allocation) > 100) {
        throw new HttpError(409, "ALLOCATION_EXCEEDED", "A team member's project allocation cannot exceed 100 percent.");
      }
      const created = await client.query<{ id: string }>(
        "INSERT INTO project_resources(project_id,user_id,discipline,allocation_percent,starts_on,ends_on,notes,assigned_by) " +
          "VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [projectId, userId, discipline, allocation, startsOn, endsOn, notes, user.id],
      );
      await audit(client, user, "project.resource.assigned", "project_resource", created.rows[0].id, { projectId, userId, discipline, allocation });
      return { id: created.rows[0].id };
    }

    if (action === "cost") {
      const costType = body.costType;
      if (costType !== "material" && costType !== "labor" && costType !== "other") throw new HttpError(400, "INVALID_COST_TYPE", "Choose material, labor, or other.");
      const description = shortText(body.description, "description", 240);
      const source = shortText(body.source, "source", 120);
      const unit = shortText(body.unit, "unit", 32);
      const quantity = positive(body.quantity, "quantity");
      const estimated = body.estimatedUnitCost === undefined || body.estimatedUnitCost === "" ? null : nonNegativeMoney(body.estimatedUnitCost, "estimatedUnitCost");
      const actual = body.actualUnitCost === undefined || body.actualUnitCost === "" ? null : nonNegativeMoney(body.actualUnitCost, "actualUnitCost");
      const reference = optionalText(body.sourceReference, "sourceReference", 160);
      if (estimated === null && actual === null) throw new HttpError(400, "MISSING_COST", "Provide an estimated or actual unit cost.");
      const created = await client.query<{ id: string }>(
        "INSERT INTO project_cost_entries(project_id,cost_type,description,source,unit,quantity,estimated_unit_cost,actual_unit_cost,source_reference,created_by) " +
          "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
        [projectId, costType, description, source, unit, quantity, estimated, actual, reference, user.id],
      );
      await audit(client, user, "project.cost.created", "project_cost_entry", created.rows[0].id, { projectId, costType, quantity });
      return { id: created.rows[0].id };
    }

    if (action === "dependency") {
      const type = body.type;
      if (type !== "task" && type !== "milestone") throw new HttpError(400, "INVALID_DEPENDENCY", "Choose a task or milestone dependency.");
      const recordId = requireUuid(body.recordId, "recordId");
      const dependsOnId = requireUuid(body.dependsOnId, "dependsOnId");
      if (recordId === dependsOnId) throw new HttpError(400, "INVALID_DEPENDENCY", "A record cannot depend on itself.");
      const table = type === "task" ? "project_tasks" : "project_milestones";
      const dependencyTable = type === "task" ? "project_task_dependencies" : "project_milestone_dependencies";
      const ownColumn = type === "task" ? "task_id" : "milestone_id";
      const prerequisiteColumn = type === "task" ? "depends_on_task_id" : "depends_on_milestone_id";
      const nodes = await client.query(
        `SELECT id FROM ${table} WHERE project_id=$1 AND id=ANY($2::uuid[])`,
        [projectId, [recordId, dependsOnId]],
      );
      if (nodes.rowCount !== 2) throw new HttpError(404, "DEPENDENCY_RECORD_NOT_FOUND", "Both dependency records must belong to this project.");
      const cycle = await client.query(
        `WITH RECURSIVE chain(id) AS (SELECT $2::uuid UNION SELECT d.${prerequisiteColumn} FROM ${dependencyTable} d JOIN chain c ON d.${ownColumn}=c.id WHERE d.project_id=$3) ` +
          "SELECT 1 FROM chain WHERE id=$1 LIMIT 1",
        [recordId, dependsOnId, projectId],
      );
      if (cycle.rowCount) throw new HttpError(409, "DEPENDENCY_CYCLE", "This dependency would create a cycle.");
      const created = await client.query<{ id: string }>(
        `INSERT INTO ${dependencyTable}(project_id,${ownColumn},${prerequisiteColumn},created_by) VALUES($1,$2,$3,$4) RETURNING id`,
        [projectId, recordId, dependsOnId, user.id],
      );
      await audit(client, user, `project.${type}_dependency.created`, dependencyTable, created.rows[0].id, {
        projectId, recordId, dependsOnId,
      });
      return { id: created.rows[0].id };
    }

    throw new HttpError(400, "INVALID_ACTION", "Unsupported project planning action.");
  });
}
