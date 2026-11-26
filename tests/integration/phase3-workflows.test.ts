import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, closeDatabases, itemBody, loadHandlers, movementKey, ORIGIN, resetDatabase, seedActors, testPool, type Actors, type Handlers } from "./harness";
import * as resources from "@/app/api/operations/[resource]/route";
import * as suppliersRoute from "@/app/api/operations/suppliers/route";
import * as purchaseOrders from "@/app/api/operations/purchase-orders/route";
import * as purchaseStatus from "@/app/api/operations/purchase-orders/[id]/status/route";
import * as receive from "@/app/api/operations/purchase-orders/[id]/receive/route";
import * as reservations from "@/app/api/operations/reservations/route";
import * as reservationRelease from "@/app/api/operations/reservations/[id]/route";
import * as materialShortages from "@/app/api/operations/material-shortages/route";
import * as productionEvents from "@/app/api/operations/production/[id]/events/route";
import * as bomRevisions from "@/app/api/operations/engineering/bom-revisions/route";
import * as bomStatus from "@/app/api/operations/engineering/bom-revisions/[id]/status/route";
import * as changeOrders from "@/app/api/operations/engineering/change-orders/route";
import * as changeAction from "@/app/api/operations/engineering/change-orders/[id]/action/route";
import * as planning from "@/app/api/operations/projects/[id]/planning/route";
import * as workCenters from "@/app/api/operations/production/work-centers/route";
import * as shifts from "@/app/api/operations/production/shifts/route";
import * as assignments from "@/app/api/operations/production/assignments/route";
import * as downtime from "@/app/api/operations/production/downtime/route";
import * as serviceParts from "@/app/api/operations/service/[id]/parts/route";
import * as serviceUpdates from "@/app/api/operations/service/[id]/updates/route";
import * as serviceWorklog from "@/app/api/operations/service/[id]/worklog/route";
import * as serviceInstalls from "@/app/api/operations/service/[id]/installs/route";
import * as approvedRevisionsRoute from "@/app/api/operations/engineering/approved-revisions/route";
import * as overview from "@/app/api/operations/overview/route";
import * as uploadRoute from "@/app/api/engineering/documents/[id]/revisions/route";
import * as revisionRoute from "@/app/api/engineering/revisions/[id]/route";

type DynamicHandler<P extends Record<string, string>> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;
type Row = Record<string, unknown>;
const dynamicCall = <P extends Record<string, string>>(
  handler: DynamicHandler<P>,
  params: P,
  options: Parameters<typeof call>[1] = {},
) => call((request) => handler(request, { params: Promise.resolve(params) }), options);
const addResource = (resource: string, body: Record<string, unknown>, cookie: string) =>
  call((request) => resources.POST(request, { params: Promise.resolve({ resource }) }), { method: "POST", cookie, body });

let h: Handlers;
let actors: Actors;
let projectId: string;
let assetId: string;
let itemId: string;
let productionJobId: string;
let serviceJobId: string;
let revisionId: string;
const stockSku = "P3-CTRL-1";

beforeAll(async () => {
  await resetDatabase();
  h = await loadHandlers();
  actors = await seedActors(h);
});
afterAll(closeDatabases);

describe("Phase 3 cross-department workflows", () => {
  it("receives purchase orders into inventory with explicit overage authorization and safe replay", async () => {
    const project = await addResource("projects", { code: "P3-001", name: "Press upgrade", customer: "Example Works" }, actors.admin.cookie);
    expect(project.status).toBe(201);
    projectId = project.body.id;
    const item = await call(h.inventory.POST, {
      method: "POST", cookie: actors.admin.cookie,
      body: itemBody({ sku: stockSku, name: "PLC module", onHand: "10", reorder: "2" }),
    });
    expect(item.status).toBe(201);
    const itemRow = await testPool().query("SELECT id FROM inventory_items WHERE sku=$1", [stockSku]);
    itemId = itemRow.rows[0].id;

    const supplier = await call(suppliersRoute.POST, {
      method: "POST", cookie: actors.operator.cookie,
      body: { code: "CTRL-SUP", name: "Controls Supply", email: "orders@example.test", leadTimeDays: 14 },
    });
    expect(supplier.status).toBe(201);
    const po = await call(purchaseOrders.POST, {
      method: "POST", cookie: actors.operator.cookie,
      body: {
        poNumber: "P3-PO-001", supplierId: supplier.body.id, projectId,
        lines: [{ sku: stockSku, quantity: "5", unitPrice: "12.5" }],
      },
    });
    expect(po.status).toBe(201);
    const orderId = po.body.id as string;
    expect((await dynamicCall(purchaseStatus.POST, { id: orderId }, {
      method: "POST", cookie: actors.operator.cookie, body: { status: "submitted" },
    })).status).toBe(200);
    expect((await dynamicCall(purchaseStatus.POST, { id: orderId }, {
      method: "POST", cookie: actors.operator.cookie, body: { status: "ordered" },
    })).status).toBe(200);
    const lineId = (await testPool().query("SELECT id FROM purchase_order_lines WHERE purchase_order_id=$1", [orderId])).rows[0].id as string;
    const firstKey = movementKey() + "-receipt-a";
    const firstReceipt = { lineId, quantity: "4", location: "Main warehouse", bin: "A-01", idempotencyKey: firstKey };
    expect((await dynamicCall(receive.POST, { id: orderId }, {
      method: "POST", cookie: actors.operator.cookie, body: firstReceipt,
    })).status).toBe(201);
    expect((await dynamicCall(receive.POST, { id: orderId }, {
      method: "POST", cookie: actors.operator.cookie, body: firstReceipt,
    })).status).toBe(200);
    const overage = { ...firstReceipt, quantity: "2", idempotencyKey: movementKey() + "-receipt-b" };
    expect((await dynamicCall(receive.POST, { id: orderId }, {
      method: "POST", cookie: actors.operator.cookie, body: overage,
    })).status).toBe(409);
    const authorized = await dynamicCall(receive.POST, { id: orderId }, {
      method: "POST", cookie: actors.admin.cookie, body: { ...overage, authorizeOverage: true },
    });
    expect(authorized.status).toBe(201);
    expect((await dynamicCall(receive.POST, { id: orderId }, {
      method: "POST", cookie: actors.admin.cookie, body: { ...overage, authorizeOverage: true },
    })).status).toBe(200);
    const balance = await testPool().query(
      "SELECT on_hand::text FROM inventory_stock WHERE item_id=$1 AND location='Main warehouse' AND bin='A-01'",
      [itemId],
    );
    expect(balance.rows[0].on_hand).toBe("16.000");
    const receipts = await testPool().query("SELECT count(*)::int AS n FROM purchase_receipts WHERE purchase_order_line_id=$1", [lineId]);
    expect(receipts.rows[0].n).toBe(2);
    expect((await testPool().query(
      "SELECT status FROM purchase_orders WHERE id=$1", [orderId],
    )).rows[0].status).toBe("received");
    const projectPlan = await dynamicCall(planning.GET, { id: projectId }, { cookie: actors.admin.cookie });
    expect(projectPlan.body.purchaseOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ poNumber: "P3-PO-001", status: "received" }),
    ]));
  });

  it("reserves stock atomically, consumes reservations with production issues, and reports shortages", async () => {
    const job = await addResource("production", {
      project_id: projectId, job_code: "P3-WO-001", title: "Panel assembly", planned_qty: "20",
    }, actors.operator.cookie);
    expect(job.status).toBe(201);
    productionJobId = job.body.id;
    const reservationKey = movementKey() + "-reserve";
    const reservation = await call(reservations.POST, {
      method: "POST", cookie: actors.operator.cookie,
      body: {
        sku: stockSku, quantity: "12", location: "Main warehouse", bin: "A-01", idempotencyKey: reservationKey,
        target: { kind: "project", id: projectId },
      },
    });

    {
      const sku = "P3-RESERVE-RACE";
      expect((await call(h.inventory.POST, {
        method: "POST", cookie: actors.admin.cookie,
        body: itemBody({ sku, onHand: "5", reorder: "0" }),
      })).status).toBe(201);
      const reserve = (key: string) => call(reservations.POST, {
        method: "POST", cookie: actors.operator.cookie,
        body: {
          sku, quantity: "4", location: "Main warehouse", bin: "A-01", idempotencyKey: key,
          target: { kind: "project", id: projectId },
        },
      });
      const results = await Promise.all([reserve(movementKey() + "-race-a"), reserve(movementKey() + "-race-b")]);
      expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
      const won = results.find((result) => result.status === 201);
      expect(won).toBeDefined();
      expect((await dynamicCall(reservationRelease.DELETE, { id: won!.body.id }, {
        method: "DELETE", cookie: actors.operator.cookie,
      })).status).toBe(200);
    }
    expect(reservation.status).toBe(201);
    expect((await call(h.movements.POST, {
      method: "POST", cookie: actors.operator.cookie,
      body: { idempotencyKey: movementKey(), type: "issue", sku: stockSku, quantity: "5", sourceLocation: "Main warehouse", sourceBin: "A-01" },
    })).status).toBe(409);
    expect((await dynamicCall(productionEvents.POST, { id: productionJobId }, {
      method: "POST", cookie: actors.operator.cookie, body: { kind: "start", idempotencyKey: movementKey() + "-start" },
    })).status).toBe(201);
    const issue = await dynamicCall(productionEvents.POST, { id: productionJobId }, {
      method: "POST", cookie: actors.operator.cookie,
      body: { kind: "material", sku: stockSku, quantity: "12", location: "Main warehouse", bin: "A-01", idempotencyKey: movementKey() + "-consume" },
    });
    expect(issue.status).toBe(201);
    const consumed = await testPool().query("SELECT status,consumed_qty::text FROM inventory_reservations WHERE id=$1", [reservation.body.id]);
    expect(consumed.rows[0]).toEqual({ status: "consumed", consumed_qty: "12.000" });

    const bom = await call(bomRevisions.POST, {
      method: "POST", cookie: actors.operator.cookie,
      body: { projectId, revisionCode: "A", changeNotes: "Initial released BOM", lines: [{ itemId, requiredQty: "12" }] },
    });
    expect(bom.status).toBe(201);
    expect((await dynamicCall(bomStatus.POST, { id: bom.body.id }, {
      method: "POST", cookie: actors.operator.cookie, body: { action: "submit" },
    })).status).toBe(200);
    expect((await dynamicCall(bomStatus.POST, { id: bom.body.id }, {
      method: "POST", cookie: actors.operator.cookie, body: { action: "approve" },
    })).status).toBe(403);
    expect((await dynamicCall(bomStatus.POST, { id: bom.body.id }, {
      method: "POST", cookie: actors.admin.cookie, body: { action: "approve" },
    })).status).toBe(200);
    const change = await call(changeOrders.POST, {
      method: "POST", cookie: actors.operator.cookie,
      body: {
        changeNumber: "P3-ECO-001", projectId, title: "Revise panel fuse sizing",
        reason: "Field review identified an updated control-load requirement.",
        changeSummary: "Increase the specified fuse rating.", links: [{ type: "bomRevision", id: bom.body.id }],
      },
    });
    expect(change.status).toBe(201);
    expect((await dynamicCall(changeAction.POST, { id: change.body.id }, {
      method: "POST", cookie: actors.operator.cookie, body: { action: "submit" },
    })).status).toBe(200);
    expect((await dynamicCall(changeAction.POST, { id: change.body.id }, {
      method: "POST", cookie: actors.admin.cookie, body: { action: "approve" },
    })).status).toBe(200);
    const missingImplementationNotes = await dynamicCall(changeAction.POST, { id: change.body.id }, {
      method: "POST", cookie: actors.admin.cookie, body: { action: "implement" },
    });
    expect(missingImplementationNotes.status).toBe(400);
    expect(missingImplementationNotes.body.code).toBe("IMPLEMENTATION_NOTES_REQUIRED");
    const implementationNotes = "Verified approved BOM revision A and confirmed the engineering change at the worksite.";
    expect((await dynamicCall(changeAction.POST, { id: change.body.id }, {
      method: "POST", cookie: actors.admin.cookie, body: { action: "implement", notes: implementationNotes },
    })).body.implementationEvidenceCount).toBe(1);
    expect((await testPool().query(
      "SELECT count(*)::int AS n FROM engineering_change_approvals WHERE change_order_id=$1", [change.body.id],
    )).rows[0].n).toBe(3);
    const bomImplementationEvidence = await testPool().query(
      "SELECT e.bom_revision_id,e.document_revision_id,e.notes,e.verified_by " +
        "FROM engineering_change_implementation_evidence e JOIN engineering_change_links l ON l.id=e.change_order_link_id " +
        "WHERE l.change_order_id=$1",
      [change.body.id],
    );
    expect(bomImplementationEvidence.rows[0]).toEqual({
      bom_revision_id: bom.body.id,
      document_revision_id: null,
      notes: implementationNotes,
      verified_by: actors.admin.id,
    });
    const listedChanges = await call(changeOrders.GET, {
      cookie: actors.admin.cookie,
      path: `/api/operations/engineering/change-orders?projectId=${projectId}`,
    });
    expect(listedChanges.body.changeOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({
        changeNumber: "P3-ECO-001",
        changeSummary: "Increase the specified fuse rating.",
        approvals: expect.arrayContaining([
          expect.objectContaining({ action: "submitted" }),
          expect.objectContaining({ action: "approved" }),
          expect.objectContaining({ action: "implemented" }),
        ]),
        implementationEvidence: expect.arrayContaining([
          expect.objectContaining({ linkType: "bomRevision", bomRevisionCode: "A", notes: implementationNotes }),
        ]),
      }),
    ]));
    const nextBom = await call(bomRevisions.POST, {
      method: "POST", cookie: actors.operator.cookie,
      body: { projectId, revisionCode: "B", changeNotes: "Approved follow-up", lines: [{ itemId, requiredQty: "12" }] },
    });
    expect(nextBom.status).toBe(201);
    expect((await dynamicCall(bomStatus.POST, { id: nextBom.body.id }, {
      method: "POST", cookie: actors.operator.cookie, body: { action: "submit" },
    })).status).toBe(200);
    expect((await dynamicCall(bomStatus.POST, { id: nextBom.body.id }, {
      method: "POST", cookie: actors.admin.cookie, body: { action: "approve" },
    })).status).toBe(200);
    const activeBoms = await testPool().query(
      "SELECT count(*)::int AS n FROM engineering_bom_revisions WHERE project_id=$1 AND status='approved'",
      [projectId],
    );
    expect(activeBoms.rows[0].n).toBe(1);
    const shortageResult = await call(materialShortages.GET, {
      cookie: actors.admin.cookie,
      path: `/api/operations/material-shortages?projectId=${projectId}`,
    });
    expect(shortageResult.status).toBe(200);
    expect(shortageResult.body.shortages[0]).toMatchObject({
      demandStatus: "approved", bomStatus: "approved", bomRevisionCode: "A",
      requiredQty: "12.000", consumedQty: "12.000",
    });
    expect(Number(shortageResult.body.shortages[0].shortageQty)).toBe(0);
  });

  it("rejects cyclic dependencies and enforces work-center/shift assignments", async () => {
    const assignedTask = await dynamicCall(planning.POST, { id: projectId }, {
      method: "POST", cookie: actors.operator.cookie,
      body: { action: "task", title: "Verify control wiring", discipline: "engineering", assigneeId: actors.admin.id, dueDate: "2026-02-01" },
    });
    expect(assignedTask.status).toBe(201);
    expect((await dynamicCall(planning.POST, { id: projectId }, {
      method: "POST", cookie: actors.operator.cookie,
      body: { action: "taskStatus", taskId: assignedTask.body.id, status: "done" },
    })).status).toBe(200);
    const one = await addResource("tasks", { project_id: projectId, title: "Wire panel", discipline: "production" }, actors.operator.cookie);
    const two = await addResource("tasks", { project_id: projectId, title: "Test panel", discipline: "production" }, actors.operator.cookie);
    const dependency = (recordId: string, dependsOnId: string) =>
      dynamicCall(planning.POST, { id: projectId }, {
        method: "POST", cookie: actors.operator.cookie, body: { action: "dependency", type: "task", recordId, dependsOnId },
      });
    expect((await dependency(one.body.id, two.body.id)).status).toBe(201);
    const cycle = await dependency(two.body.id, one.body.id);
    expect(cycle.status).toBe(409);
    expect(cycle.body.code).toBe("DEPENDENCY_CYCLE");

    const center = await call(workCenters.POST, {
      method: "POST", cookie: actors.operator.cookie, body: { code: "WC-1", name: "Assembly cell 1" },
    });
    const shift = await call(shifts.POST, {
      method: "POST", cookie: actors.operator.cookie, body: { code: "SHIFT-1", name: "Day", startsAt: "07:00", endsAt: "15:00" },
    });
    expect(center.status).toBe(201);
    expect(shift.status).toBe(201);
    const assigned = await call(assignments.POST, {
      method: "POST", cookie: actors.operator.cookie,
      body: { productionJobId, workCenterId: center.body.id, shiftId: shift.body.id, operatorId: actors.admin.id },
    });
    expect(assigned.status).toBe(201);
    const started = (await testPool().query(
      "SELECT min(created_at) AS started_at FROM production_events WHERE job_id=$1 AND kind='start'",
      [productionJobId],
    )).rows[0].started_at as Date;
    await testPool().query(
      "UPDATE production_job_assignments SET assigned_at=$2 WHERE production_job_id=$1 AND is_active",
      [productionJobId, started],
    );
    const databaseNow = (await testPool().query("SELECT now() AS value")).rows[0].value as Date;
    const downtimeKey = movementKey() + "-downtime";
    const downtimeBody = {
      productionJobId, workCenterId: center.body.id, reason: "Material delay",
      startedAt: started.toISOString(), endedAt: new Date(databaseNow.getTime() - 1000).toISOString(),
      notes: "Awaiting material", idempotencyKey: downtimeKey,
    };
    expect((await call(downtime.POST, { method: "POST", cookie: actors.operator.cookie, body: downtimeBody })).status).toBe(201);
    expect((await call(downtime.POST, { method: "POST", cookie: actors.operator.cookie, body: downtimeBody })).status).toBe(200);
  });

  it("rejects downtime before job creation, before assignment/start, and in the future", async () => {
    const job = await addResource("production", {
      project_id: projectId, job_code: "P3-WO-HISTORY-001", title: "Chronology test job", planned_qty: "1",
    }, actors.operator.cookie);
    expect(job.status).toBe(201);
    const jobId = String(job.body.id);
    await testPool().query("UPDATE production_jobs SET created_at=now()-interval '1 hour' WHERE id=$1", [jobId]);
    const center = await call(workCenters.POST, {
      method: "POST", cookie: actors.operator.cookie, body: { code: "WC-HIST", name: "Chronology cell" },
    });
    const shift = await call(shifts.POST, {
      method: "POST", cookie: actors.operator.cookie,
      body: { code: "SHIFT-HIST", name: "Chronology shift", startsAt: "16:00", endsAt: "23:00" },
    });
    const operatorId = (await testPool().query("SELECT id FROM users WHERE email=$1", [actors.operator.email])).rows[0].id as string;
    const assigned = await call(assignments.POST, {
      method: "POST", cookie: actors.operator.cookie,
      body: { productionJobId: jobId, workCenterId: center.body.id, shiftId: shift.body.id, operatorId },
    });
    expect(assigned.status).toBe(201);
    await testPool().query(
      "UPDATE production_job_assignments SET assigned_at=now()-interval '30 minutes' WHERE production_job_id=$1 AND is_active",
      [jobId],
    );
    const queuedTiming = await testPool().query(
      "SELECT a.assigned_at,now() AS database_now FROM production_job_assignments a " +
        "WHERE a.production_job_id=$1 AND a.is_active",
      [jobId],
    );
    const queuedStart = new Date((queuedTiming.rows[0].assigned_at as Date).getTime() + 1000);
    const queuedEnd = new Date((queuedTiming.rows[0].database_now as Date).getTime() - 1000);
    const queuedDowntime = await call(downtime.POST, {
      method: "POST", cookie: actors.operator.cookie,
      body: {
        productionJobId: jobId, workCenterId: center.body.id, reason: "Premature delay",
        startedAt: queuedStart.toISOString(), endedAt: queuedEnd.toISOString(), idempotencyKey: movementKey() + "-queued",
      },
    });
    expect(queuedDowntime.status).toBe(409);
    expect(queuedDowntime.body.code).toBe("JOB_NOT_ACTIVE");
    expect((await dynamicCall(productionEvents.POST, { id: jobId }, {
      method: "POST", cookie: actors.operator.cookie, body: { kind: "start", idempotencyKey: movementKey() + "-history-start" },
    })).status).toBe(201);
    const timing = await testPool().query(
      "SELECT j.created_at,a.assigned_at," +
        "(SELECT min(e.created_at) FROM production_events e WHERE e.job_id=j.id AND e.kind='start') AS started_at," +
        "now() AS database_now " +
        "FROM production_jobs j JOIN production_job_assignments a ON a.production_job_id=j.id " +
        "WHERE j.id=$1 AND a.is_active",
      [jobId],
    );
    const row = timing.rows[0] as { created_at: Date; assigned_at: Date; started_at: Date; database_now: Date };
    const attempt = (startedAt: Date, endedAt: Date, key: string) =>
      call(downtime.POST, {
        method: "POST", cookie: actors.operator.cookie,
        body: {
          productionJobId: jobId, workCenterId: center.body.id, reason: "Unscheduled delay",
          startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), idempotencyKey: key,
        },
      });

    const beforeJob = await attempt(
      new Date(row.created_at.getTime() - 60_000),
      new Date(row.created_at.getTime() - 30_000),
      movementKey() + "-before-job",
    );
    expect(beforeJob.status).toBe(409);
    expect(beforeJob.body.code).toBe("DOWNTIME_BEFORE_JOB");

    const beforeAssignment = await attempt(
      new Date(row.assigned_at.getTime() - 60_000),
      new Date(row.assigned_at.getTime() - 30_000),
      movementKey() + "-before-assignment",
    );
    expect(beforeAssignment.status).toBe(409);
    expect(beforeAssignment.body.code).toBe("DOWNTIME_BEFORE_ASSIGNMENT");

    const beforeStart = await attempt(
      new Date(row.started_at.getTime() - 60_000),
      new Date(row.started_at.getTime() - 30_000),
      movementKey() + "-before-start",
    );
    expect(beforeStart.status).toBe(409);
    expect(beforeStart.body.code).toBe("DOWNTIME_BEFORE_START");

    const future = await attempt(
      new Date(row.database_now.getTime() + 60_000),
      new Date(row.database_now.getTime() + 120_000),
      movementKey() + "-future",
    );
    expect(future.status).toBe(409);
    expect(future.body.code).toBe("FUTURE_DOWNTIME");
  });

  it("prevents overlapping resource overbooking across projects, including concurrent assignments", async () => {
    const makeProject = async (code: string) => {
      const result = await addResource("projects", { code, name: code, customer: "Example Works" }, actors.admin.cookie);
      expect(result.status).toBe(201);
      return String(result.body.id);
    };
    const addResourceAllocation = (project: string, userId: string, startsOn: string, endsOn: string, allocationPercent: string) =>
      dynamicCall(planning.POST, { id: project }, {
        method: "POST", cookie: actors.operator.cookie,
        body: { action: "resource", userId, discipline: "engineering", startsOn, endsOn, allocationPercent },
      });

    const viewerId = (await testPool().query("SELECT id FROM users WHERE email=$1", [actors.viewer.email])).rows[0].id as string;
    const firstProject = await makeProject("P3-ALLOC-A");
    const secondProject = await makeProject("P3-ALLOC-B");
    expect((await addResourceAllocation(firstProject, viewerId, "2026-01-01", "2026-01-10", "70")).status).toBe(201);
    expect((await addResourceAllocation(secondProject, viewerId, "2026-01-10", "2026-01-15", "30")).status).toBe(201);

    const thirdProject = await makeProject("P3-ALLOC-C");
    const overlap = await addResourceAllocation(thirdProject, viewerId, "2026-01-10", "2026-01-15", "40");
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe("ALLOCATION_EXCEEDED");

    const fourthProject = await makeProject("P3-ALLOC-D");
    expect((await addResourceAllocation(fourthProject, viewerId, "2026-01-11", "2026-01-15", "40")).status).toBe(201);

    const concurrentUserId = actors.admin.id;
    const fifthProject = await makeProject("P3-ALLOC-E");
    const sixthProject = await makeProject("P3-ALLOC-F");
    const concurrent = await Promise.all([
      addResourceAllocation(fifthProject, concurrentUserId, "", "", "60"),
      addResourceAllocation(sixthProject, concurrentUserId, "", "", "60"),
    ]);
    expect(concurrent.map((result) => result.status).sort()).toEqual([201, 409]);
  });

  it("authorizes assigned field technicians to use parts and retrieve/record approved controller programs", async () => {
    const partItem = await call(h.inventory.POST, {
      method: "POST", cookie: actors.admin.cookie,
      body: itemBody({ sku: "P3-SERVICE-1", name: "Service fuse", onHand: "5", reorder: "1" }),
    });
    expect(partItem.status).toBe(201);
    const asset = await addResource("assets", {
      project_id: projectId, asset_tag: "P3-ASSET-1", name: "Press controller", customer_site: "Plant 4",
    }, actors.operator.cookie);
    expect(asset.status).toBe(201);
    assetId = asset.body.id;
    const viewerId = (await testPool().query("SELECT id FROM users WHERE email=$1", [actors.viewer.email])).rows[0].id as string;
    const service = await addResource("service", {
      project_id: projectId, asset_id: assetId, title: "Commission controller", assigned_to: viewerId,
    }, actors.admin.cookie);
    expect(service.status).toBe(201);
    serviceJobId = service.body.id;
    const partKey = movementKey() + "-service-used";
    const used = await dynamicCall(serviceParts.POST, { id: serviceJobId }, {
      method: "POST", cookie: actors.viewer.cookie,
      body: { action: "used", sku: "P3-SERVICE-1", quantity: "2", location: "Main warehouse", bin: "A-01", idempotencyKey: partKey },
    });
    expect(used.status).toBe(201);
    expect((await dynamicCall(serviceParts.POST, { id: serviceJobId }, {
      method: "POST", cookie: actors.viewer.cookie,
      body: { action: "returned", sku: "P3-SERVICE-1", quantity: "1", location: "Main warehouse", bin: "A-01", idempotencyKey: movementKey() + "-service-return" },
    })).status).toBe(201);
    expect((await dynamicCall(serviceUpdates.POST, { id: serviceJobId }, {
      method: "POST", cookie: actors.viewer.cookie, body: { updateType: "note", notes: "Site inspection completed." },
    })).status).toBe(201);
    expect((await dynamicCall(serviceWorklog.GET, { id: serviceJobId }, { cookie: actors.viewer.cookie })).status).toBe(200);
    const partBalance = await testPool().query(
      "SELECT on_hand::text FROM inventory_stock s JOIN inventory_items i ON i.id=s.item_id WHERE i.sku='P3-SERVICE-1'",
    );
    expect(partBalance.rows[0].on_hand).toBe("4.000");

    const doc = await addResource("documents", { project_id: projectId, asset_id: assetId, title: "Press PLC", kind: "plc" }, actors.operator.cookie);
    expect(doc.status).toBe(201);
    const form = new FormData();
    form.set("file", new File([new Uint8Array([9, 8, 7])], "press.ACD", { type: "application/octet-stream" }));
    form.set("notes", "Release candidate");
    const uploadResponse = await uploadRoute.POST(
      new Request(`${ORIGIN}/api/engineering/documents/${doc.body.id}/revisions`, { method: "POST", headers: { origin: ORIGIN, cookie: actors.operator.cookie }, body: form }),
      { params: Promise.resolve({ id: String(doc.body.id) }) },
    );
    expect(uploadResponse.status).toBe(201);
    revisionId = (await uploadResponse.json()).id as string;
    expect((await dynamicCall(revisionRoute.PATCH, { id: revisionId }, { method: "PATCH", cookie: actors.admin.cookie })).status).toBe(200);
    const approvedRevisionList = await call(approvedRevisionsRoute.GET, { cookie: actors.admin.cookie });
    expect(approvedRevisionList.body.revisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: revisionId, documentId: doc.body.id, revision: 1 }),
    ]));
    const programDownload = await revisionRoute.GET(
      new Request(`${ORIGIN}/api/engineering/revisions/${revisionId}`, { headers: { cookie: actors.viewer.cookie } }),
      { params: Promise.resolve({ id: revisionId }) },
    );
    expect(programDownload.status).toBe(200);
    expect(Array.from(new Uint8Array(await programDownload.arrayBuffer()))).toEqual([9, 8, 7]);
    const documentChange = await call(changeOrders.POST, {
      method: "POST", cookie: actors.operator.cookie,
      body: {
        changeNumber: "P3-ECO-DOC-001", projectId, title: "Apply press PLC revision",
        reason: "Approved controls update is required for the press.", links: [{ type: "document", id: doc.body.id }],
      },
    });
    expect(documentChange.status).toBe(201);
    expect((await dynamicCall(changeAction.POST, { id: documentChange.body.id }, {
      method: "POST", cookie: actors.operator.cookie, body: { action: "submit" },
    })).status).toBe(200);
    expect((await dynamicCall(changeAction.POST, { id: documentChange.body.id }, {
      method: "POST", cookie: actors.admin.cookie, body: { action: "approve" },
    })).status).toBe(200);
    const documentLinkId = (await testPool().query(
      "SELECT id FROM engineering_change_links WHERE change_order_id=$1", [documentChange.body.id],
    )).rows[0].id as string;
    const unverifiedImplementation = await dynamicCall(changeAction.POST, { id: documentChange.body.id }, {
      method: "POST", cookie: actors.admin.cookie,
      body: { action: "implement", notes: "The change has been reviewed at the site." },
    });
    expect(unverifiedImplementation.status).toBe(409);
    expect(unverifiedImplementation.body.code).toBe("REVISION_EVIDENCE_REQUIRED");
    const documentImplementationNotes = "Applied approved PLC revision 1 and verified the controller configuration onsite.";
    expect((await dynamicCall(changeAction.POST, { id: documentChange.body.id }, {
      method: "POST", cookie: actors.admin.cookie,
      body: {
        action: "implement", notes: documentImplementationNotes,
        documentRevisions: [{ linkId: documentLinkId, revisionId }],
      },
    })).body.implementationEvidenceCount).toBe(1);
    const listedDocumentChange = await call(changeOrders.GET, {
      cookie: actors.admin.cookie,
      path: `/api/operations/engineering/change-orders?projectId=${projectId}`,
    });
    expect(listedDocumentChange.body.changeOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({
        changeNumber: "P3-ECO-DOC-001",
        approvals: expect.arrayContaining([expect.objectContaining({ action: "implemented", notes: documentImplementationNotes })]),
        implementationEvidence: expect.arrayContaining([
          expect.objectContaining({
            linkType: "document", documentTitle: "Press PLC", documentRevisionId: revisionId,
            revision: 1, notes: documentImplementationNotes,
          }),
        ]),
      }),
    ]));
    const installKey = movementKey() + "-install";
    const installBody = { revisionId, result: "installed", notes: "Commissioned on site", idempotencyKey: installKey };
    const installation = await dynamicCall(serviceInstalls.POST, { id: serviceJobId }, {
      method: "POST", cookie: actors.viewer.cookie, body: installBody,
    });
    expect(installation.status).toBe(201);
    expect((await dynamicCall(serviceInstalls.POST, { id: serviceJobId }, {
      method: "POST", cookie: actors.viewer.cookie, body: installBody,
    })).status).toBe(200);
    expect((await testPool().query("SELECT count(*)::int AS n FROM field_program_installs WHERE service_job_id=$1", [serviceJobId])).rows[0].n).toBe(1);
    for (const cookie of [actors.viewer.cookie, actors.admin.cookie, actors.operator.cookie]) {
      expect((await dynamicCall(serviceInstalls.GET, { id: serviceJobId }, { cookie })).status).toBe(200);
    }
    const projectPlan = await dynamicCall(planning.GET, { id: projectId }, { cookie: actors.admin.cookie });
    expect(projectPlan.body.serviceJobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Commission controller", technician_name: expect.any(String) }),
    ]));
    expect(projectPlan.body.engineeringDocuments).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Press PLC", kind: "plc" }),
    ]));
    const unassigned = await addResource("service", {
      project_id: projectId, asset_id: assetId, title: "Unassigned service visit",
    }, actors.admin.cookie);
    expect((await dynamicCall(serviceWorklog.GET, { id: unassigned.body.id }, { cookie: actors.viewer.cookie })).status).toBe(403);
    expect((await dynamicCall(serviceInstalls.GET, { id: unassigned.body.id }, { cookie: actors.viewer.cookie })).status).toBe(403);
    expect((await dynamicCall(planning.POST, { id: projectId }, {
      method: "POST", cookie: actors.operator.cookie,
      body: {
        action: "resource", userId: viewerId, discipline: "field_service", allocationPercent: "100",
        startsOn: "2026-02-01", endsOn: "2026-02-10",
      },
    })).status).toBe(201);
    const viewerProjectPlan = await dynamicCall(planning.GET, { id: projectId }, { cookie: actors.viewer.cookie });
    expect(viewerProjectPlan.status).toBe(200);
    expect((viewerProjectPlan.body.serviceJobs as Row[]).map((row) => row.id)).toEqual([serviceJobId]);
    const legacyServiceList = await dynamicCall(resources.GET, { resource: "service" }, { cookie: actors.viewer.cookie });
    expect((legacyServiceList.body.records as Row[]).map((row) => row.id)).toEqual([serviceJobId]);
    const legacyOverview = await call(overview.GET, { cookie: actors.viewer.cookie });
    expect((legacyOverview.body.service as Row[]).map((row) => row.id)).toEqual([serviceJobId]);
    expect((await dynamicCall(serviceInstalls.POST, { id: unassigned.body.id }, {
      method: "POST", cookie: actors.viewer.cookie,
      body: { ...installBody, idempotencyKey: movementKey() + "-unauthorized" },
    })).status).toBe(403);
  });
});
