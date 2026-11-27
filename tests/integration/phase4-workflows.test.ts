import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call, closeDatabases, itemBody, movementKey, resetDatabase, seedActors, testPool,
  uniqueSuffix, type Actors, type Handlers,
} from "./harness";
import * as resources from "@/app/api/operations/[resource]/route";
import * as equipment from "@/app/api/operations/equipment/route";
import * as equipmentItem from "@/app/api/operations/equipment/[id]/route";
import * as equipmentTelemetry from "@/app/api/operations/equipment/[id]/telemetry/route";
import * as equipmentHistory from "@/app/api/operations/equipment/[id]/telemetry/history/route";
import * as downtime from "@/app/api/operations/equipment/[id]/downtime/route";
import * as downtimeEvent from "@/app/api/operations/equipment/[id]/downtime/[eventId]/route";
import * as simulate from "@/app/api/operations/telemetry/simulate/route";
import * as plans from "@/app/api/operations/maintenance/plans/route";
import * as scheduler from "@/app/api/operations/maintenance/scheduler/route";
import * as workOrders from "@/app/api/operations/maintenance/work-orders/route";
import * as workOrder from "@/app/api/operations/maintenance/work-orders/[id]/route";
import * as checklist from "@/app/api/operations/maintenance/work-orders/[id]/checklist/[checklistId]/route";
import * as parts from "@/app/api/operations/maintenance/work-orders/[id]/parts/route";
import * as costs from "@/app/api/operations/maintenance/work-orders/[id]/costs/route";
import * as projectPlanning from "@/app/api/operations/projects/[id]/planning/route";
import * as workCenters from "@/app/api/operations/production/work-centers/route";
import * as shifts from "@/app/api/operations/production/shifts/route";
import * as assignments from "@/app/api/operations/production/assignments/route";
import * as productionEvents from "@/app/api/operations/production/[id]/events/route";
import * as productionDowntime from "@/app/api/operations/production/downtime/route";

const dynamicCall = <P extends object>(
  handler: (request: Request, context: { params: Promise<P> }) => Promise<Response>,
  params: P,
  options: Parameters<typeof call>[1] = {},
) =>
  call((request) => handler(request,{ params: Promise.resolve(params) }),options);
const addResource = (handler: Handlers, resource: string, body: Record<string, unknown>, cookie: string) =>
  call((request) => resources.POST(request,{ params: Promise.resolve({ resource }) }),{
    method:"POST",cookie,body,
  });

let h: Handlers;
let actors: Actors;
let projectId = "";
let assetId = "";
let secondAssetId = "";
let viewerId = "";
let workOrderId = "";

beforeAll(async () => {
  await resetDatabase();
  h = await import("./harness").then((module) => module.loadHandlers());
  actors = await seedActors(h);
  viewerId = (await testPool().query("SELECT id FROM users WHERE email=$1",[actors.viewer.email])).rows[0].id as string;
});

afterAll(closeDatabases);

describe("Phase 4 equipment, maintenance, and telemetry", () => {
  it("integrates equipment, simulated telemetry, maintenance inventory, costs, and production downtime", async () => {
    const suffix = uniqueSuffix();
    const project = await addResource(h,"projects",{
      code:`P4-${suffix}`,name:"Equipment reliability",customer:"Example Works",
    },actors.admin.cookie);
    expect(project.status).toBe(201);
    projectId = String(project.body.id);

    const legacyAsset = await addResource(h,"assets",{
      project_id:projectId,asset_tag:`P4-LEGACY-${suffix}`,name:"Legacy equipment entry",customer_site:"Plant A",
    },actors.operator.cookie);
    expect(legacyAsset.status).toBe(201);
    expect((await testPool().query(
      "SELECT count(*)::int AS tags FROM asset_telemetry_tags WHERE asset_id=$1",
      [legacyAsset.body.id],
    )).rows[0].tags).toBe(6);

    const createdAsset = await call(equipment.POST,{
      method:"POST",cookie:actors.operator.cookie,
      body:{
        projectId,assetTag:`P4-ASSET-${suffix}`,name:"Conveyor cell",customerSite:"Plant A",
        manufacturer:"Example",model:"CV-100",serialNumber:`SN-${suffix}`,location:"Line 1",
      },
    });
    expect(createdAsset.status).toBe(201);
    assetId = String(createdAsset.body.id);
    const childAsset = await call(equipment.POST,{
      method:"POST",cookie:actors.operator.cookie,
      body:{
        projectId,assetTag:`P4-CHILD-${suffix}`,name:"Drive motor",customerSite:"Plant A",
        parentAssetId:assetId,
      },
    });
    expect(childAsset.status).toBe(201);
    secondAssetId = String(childAsset.body.id);

    const cycle = await dynamicCall(equipmentItem.PATCH,{id:assetId},{
      method:"PATCH",cookie:actors.operator.cookie,
      body:{parentAssetId:secondAssetId},
    });
    expect(cycle.status).toBe(409);
    expect(cycle.body.code).toBe("EQUIPMENT_HIERARCHY_CYCLE");
    const edited = await dynamicCall(equipmentItem.PATCH,{id:assetId},{
      method:"PATCH",cookie:actors.operator.cookie,
      body:{manufacturer:"Example Controls",serialNumber:"SN-UPDATED"},
    });
    expect(edited.status).toBe(200);
    expect((await dynamicCall(equipmentItem.GET,{id:assetId},{cookie:actors.operator.cookie})).body.equipment)
      .toMatchObject({manufacturer:"Example Controls",serial_number:"SN-UPDATED"});

    const serviceJob = await addResource(h,"service",{
      project_id:projectId,asset_id:assetId,title:"Assigned technician visit",assigned_to:viewerId,
    },actors.operator.cookie);
    expect(serviceJob.status).toBe(201);

    await testPool().query("UPDATE engineering_assets SET created_at=now()-interval '1200 seconds' WHERE id=$1",[assetId]);
    const fault = await call(simulate.POST,{
      method:"POST",cookie:actors.operator.cookie,body:{assetId,mode:"fault"},
    });
    expect(fault.status).toBe(200);
    expect(fault.body.accepted).toBe(6);
    expect((await call(simulate.POST,{
      method:"POST",cookie:actors.operator.cookie,body:{assetId,mode:"fault"},
    })).body.replayed).toBe(6);

    const badQuality = await call(simulate.POST,{
      method:"POST",cookie:actors.operator.cookie,body:{assetId,mode:"invalid"},
    });
    expect(badQuality.status).toBe(200);
    const stale = await call(simulate.POST,{
      method:"POST",cookie:actors.operator.cookie,body:{assetId,mode:"stale"},
    });
    expect(stale.status).toBe(200);
    const outOfOrder = await call(simulate.POST,{
      method:"POST",cookie:actors.operator.cookie,body:{assetId,mode:"out_of_order"},
    });
    expect(outOfOrder.status).toBe(200);
    const telemetry = await dynamicCall(equipmentTelemetry.GET,{id:assetId},{cookie:actors.operator.cookie});
    expect(telemetry.body.connection).toBe("connected");
    expect(telemetry.body.tags).toEqual(expect.arrayContaining([
      expect.objectContaining({tagName:"machine_state",value:"running",freshness:"stale",orderingState:"out_of_order"}),
      expect.objectContaining({tagName:"temperature_c",quality:"bad"}),
    ]));
    const machineStateTag = (telemetry.body.tags as Array<{id:string;tagName:string}>)
      .find((tag) => tag.tagName==="machine_state")!;
    const telemetryHistory = await dynamicCall(equipmentHistory.GET,{id:assetId},{
      cookie:actors.operator.cookie,path:`/api/operations/equipment/${assetId}/telemetry/history?tagId=${machineStateTag.id}&days=2`,
    });
    expect(telemetryHistory.status).toBe(200);
    expect(telemetryHistory.body.points).toEqual(expect.arrayContaining([
      expect.objectContaining({orderingState:"out_of_order"}),
    ]));
    const disconnected = await call(simulate.POST,{
      method:"POST",cookie:actors.operator.cookie,body:{assetId,mode:"offline"},
    });
    expect(disconnected.status).toBe(200);
    expect((await dynamicCall(equipmentTelemetry.GET,{id:assetId},{cookie:actors.operator.cookie})).body.connection).toBe("disconnected");
    const stopped = await call(simulate.POST,{
      method:"POST",cookie:actors.operator.cookie,body:{assetId,mode:"stopped"},
    });
    expect(stopped.status).toBe(200);
    expect((await dynamicCall(equipmentTelemetry.GET,{id:assetId},{cookie:actors.operator.cookie})).body.tags)
      .toEqual(expect.arrayContaining([expect.objectContaining({tagName:"machine_state",value:"stopped"})]));

    const oldTagId = (telemetry.body.tags as Array<{id:string;tagName:string}>)
      .find((tag) => tag.tagName==="temperature_c")!.id;
    const sourceId = (await testPool().query("SELECT id FROM asset_telemetry_sources WHERE asset_id=$1",[assetId])).rows[0].id as string;
    await testPool().query(
      "INSERT INTO asset_telemetry_samples(tag_id,source_id,value,numeric_value,quality,observed_at,idempotency_key,created_by) " +
        "VALUES($1,$2,'77',77,'good',now()-interval '31 days',$3,$4)",
      [oldTagId,sourceId,`old-sample-${suffix}`,actors.admin.id],
    );
    const restored = await call(simulate.POST,{
      method:"POST",cookie:actors.operator.cookie,body:{assetId,mode:"normal"},
    });
    expect(restored.status).toBe(200);
    expect(restored.body.rolledUp).toBeGreaterThanOrEqual(1);
    expect((await testPool().query("SELECT count(*)::int AS n FROM asset_telemetry_samples WHERE idempotency_key=$1",[`old-sample-${suffix}`])).rows[0].n).toBe(0);
    expect((await testPool().query("SELECT sample_count FROM asset_telemetry_hourly_rollups WHERE tag_id=$1",[oldTagId])).rowCount).toBe(1);

    const item = await call(h.inventory.POST,{
      method:"POST",cookie:actors.admin.cookie,
      body:itemBody({sku:`P4-${suffix}`,name:"Drive bearing",onHand:"10",reorder:"0"}),
    });
    expect(item.status).toBe(201);
    const plan = await call(plans.POST,{
      method:"POST",cookie:actors.operator.cookie,
      body:{
        assetId,name:`Daily inspection ${suffix}`,triggerType:"calendar",intervalDays:1,
        nextDueAt:new Date(Date.now()-3*86_400_000).toISOString(),assignedTo:viewerId,
        checklist:[{label:"Inspect safety guards",required:true}],
      },
    });
    expect(plan.status).toBe(201);
    const runtimePlan = await call(plans.POST,{
      method:"POST",cookie:actors.operator.cookie,
      body:{
        assetId,name:`Runtime inspection ${suffix}`,triggerType:"runtime",
        intervalValue:"1000",nextDueValue:"1",
      },
    });
    expect(runtimePlan.status).toBe(201);
    const cyclePlan = await call(plans.POST,{
      method:"POST",cookie:actors.operator.cookie,
      body:{
        assetId,name:`Cycle inspection ${suffix}`,triggerType:"cycle",
        intervalValue:"1000",nextDueValue:"1",
      },
    });
    expect(cyclePlan.status).toBe(201);
    const generated = await call(scheduler.POST,{method:"POST",cookie:actors.operator.cookie});
    expect(generated.status).toBe(200);
    expect(generated.body.workOrdersGenerated).toBeGreaterThanOrEqual(5);
    const replay = await call(scheduler.POST,{method:"POST",cookie:actors.operator.cookie});
    expect(replay.body.workOrdersGenerated).toBe(0);
    for (const planId of [runtimePlan.body.id,cyclePlan.body.id]) {
      expect((await testPool().query(
        "SELECT count(*)::int AS count FROM maintenance_work_orders WHERE plan_id=$1",
        [planId],
      )).rows[0].count).toBe(1);
    }
    const listedOrders = await call(workOrders.GET,{cookie:actors.operator.cookie});
    const scheduledOrder = (listedOrders.body.workOrders as Array<{id:string;planId:string}>)
      .find((order) => order.planId===plan.body.id)!;
    expect(scheduledOrder).toBeDefined();
    workOrderId = scheduledOrder.id;
    const viewerOrder = await dynamicCall(workOrder.GET,{id:workOrderId},{cookie:actors.viewer.cookie});
    expect(viewerOrder.status).toBe(200);
    const checklistId = String((viewerOrder.body.checklist as Array<{id:string}>)[0].id);

    expect((await dynamicCall(workOrder.PATCH,{id:workOrderId},{
      method:"PATCH",cookie:actors.viewer.cookie,body:{action:"start"},
    })).status).toBe(200);
    const incomplete = await dynamicCall(workOrder.PATCH,{id:workOrderId},{
      method:"PATCH",cookie:actors.viewer.cookie,body:{action:"complete"},
    });
    expect(incomplete.status).toBe(409);
    expect(incomplete.body.code).toBe("CHECKLIST_INCOMPLETE");
    expect((await dynamicCall(checklist.PATCH,{id:workOrderId,checklistId},{
      method:"PATCH",cookie:actors.viewer.cookie,body:{result:"pass",notes:"Guards confirmed"},
    })).status).toBe(200);

    const issued = {
      action:"used",sku:`P4-${suffix}`,quantity:"2",location:"Main warehouse",bin:"A-01",unitCost:"10.0000",
      idempotencyKey:`${movementKey()}-phase4-issue`,
    };
    expect((await dynamicCall(parts.POST,{id:workOrderId},{method:"POST",cookie:actors.viewer.cookie,body:issued})).status).toBe(201);
    expect((await dynamicCall(parts.POST,{id:workOrderId},{method:"POST",cookie:actors.viewer.cookie,body:issued})).status).toBe(200);
    expect((await dynamicCall(parts.POST,{id:workOrderId},{method:"POST",cookie:actors.viewer.cookie,body:{...issued,unitCost:"11.0000"}})).status).toBe(409);
    const returned = {
      action:"returned",sku:`P4-${suffix}`,quantity:"0.5",location:"Main warehouse",bin:"A-01",
      idempotencyKey:`${movementKey()}-phase4-return`,
    };
    expect((await dynamicCall(parts.POST,{id:workOrderId},{method:"POST",cookie:actors.viewer.cookie,body:returned})).status).toBe(201);
    const excessiveReturn = await dynamicCall(parts.POST,{id:workOrderId},{
      method:"POST",cookie:actors.viewer.cookie,body:{...returned,quantity:"3",idempotencyKey:`${movementKey()}-phase4-return-extra`},
    });
    expect(excessiveReturn.status).toBe(409);
    expect((await testPool().query(
      "SELECT on_hand::text FROM inventory_stock WHERE item_id=(SELECT id FROM inventory_items WHERE sku=$1) AND location='Main warehouse' AND bin='A-01'",
      [`P4-${suffix}`],
    )).rows[0].on_hand).toBe("8.500");

    const labor = await dynamicCall(costs.POST,{id:workOrderId},{
      method:"POST",cookie:actors.operator.cookie,
      body:{costType:"labor",description:"Technician labor",amount:"25.0000",idempotencyKey:`${movementKey()}-phase4-cost`},
    });
    expect(labor.status).toBe(201);
    expect((await dynamicCall(workOrder.GET,{id:workOrderId},{cookie:actors.viewer.cookie})).body.workOrder.totalCost).toBe("40.0000");
    expect((await dynamicCall(workOrder.PATCH,{id:workOrderId},{
      method:"PATCH",cookie:actors.viewer.cookie,body:{action:"complete"},
    })).status).toBe(200);
    expect((await dynamicCall(workOrder.PATCH,{id:workOrderId},{
      method:"PATCH",cookie:actors.operator.cookie,body:{action:"close"},
    })).status).toBe(200);

    const planning = await dynamicCall(projectPlanning.GET,{id:projectId},{cookie:actors.admin.cookie});
    expect(planning.body.costs).toEqual(expect.arrayContaining([
      expect.objectContaining({source:"maintenance work order",actual_total:"20.0000"}),
      expect.objectContaining({source:"maintenance work order",actual_total:"-5.0000"}),
      expect.objectContaining({source:"maintenance work order",actual_total:"25.0000"}),
    ]));

    const job = await addResource(h,"production",{
      project_id:projectId,asset_id:assetId,job_code:`P4-JOB-${suffix}`,title:"Conveyor trial",planned_qty:"5",
    },actors.operator.cookie);
    expect(job.status).toBe(201);
    const center = await call(workCenters.POST,{
      method:"POST",cookie:actors.operator.cookie,body:{code:`WC-${suffix}`,name:"Conveyor station"},
    });
    const shift = await call(shifts.POST,{
      method:"POST",cookie:actors.operator.cookie,
      body:{code:`SH-${suffix}`,name:"Day shift",startsAt:"07:00",endsAt:"15:00"},
    });
    expect(center.status).toBe(201);
    expect(shift.status).toBe(201);
    expect((await call(assignments.POST,{
      method:"POST",cookie:actors.operator.cookie,
      body:{productionJobId:job.body.id,workCenterId:center.body.id,shiftId:shift.body.id,operatorId:actors.admin.id},
    })).status).toBe(201);
    expect((await dynamicCall(productionEvents.POST,{id:String(job.body.id)},{
      method:"POST",cookie:actors.operator.cookie,body:{kind:"start",idempotencyKey:`${movementKey()}-phase4-start`},
    })).status).toBe(201);
    const startAt = (await testPool().query(
      "SELECT min(created_at) AS value FROM production_events WHERE job_id=$1 AND kind='start'",[job.body.id],
    )).rows[0].value as Date;
    const databaseNow = (await testPool().query("SELECT now() AS value")).rows[0].value as Date;
    const recordedProductionDowntime = await call(productionDowntime.POST,{
      method:"POST",cookie:actors.operator.cookie,
      body:{
        productionJobId:job.body.id,workCenterId:center.body.id,reason:"Drive overload",
        startedAt:startAt.toISOString(),endedAt:databaseNow.toISOString(),
        idempotencyKey:`${movementKey()}-phase4-production-downtime`,
      },
    });
    expect(recordedProductionDowntime.status).toBe(201);
    const linked = await dynamicCall(downtime.POST,{id:assetId},{
      method:"POST",cookie:actors.operator.cookie,
      body:{
        productionDowntimeId:recordedProductionDowntime.body.id,maintenanceWorkOrderId:workOrderId,
        idempotencyKey:`${movementKey()}-phase4-downtime-link`,
      },
    });
    expect(linked.status).toBe(201);
    const downtimeHistory = await dynamicCall(downtime.GET,{id:assetId},{cookie:actors.operator.cookie});
    expect(downtimeHistory.body.downtime).toEqual(expect.arrayContaining([
      expect.objectContaining({productionDowntimeId:recordedProductionDowntime.body.id,source:"production"}),
    ]));
    const analytics = await call((request) => import("@/app/api/operations/analytics/reliability/route").then((route) => route.GET(request)),{
      cookie:actors.operator.cookie,path:"/api/operations/analytics/reliability?days=30",
    });
    expect(analytics.status).toBe(200);
    expect(analytics.body.equipment).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assetId,
        failureHistory:expect.arrayContaining([
          expect.objectContaining({productionJobCode:`P4-JOB-${suffix}`,maintenanceWorkOrderId:workOrderId}),
        ]),
      }),
    ]));
  },60_000);

  it("enforces scoped technician reads and blocks unassigned equipment/work-order access", async () => {
    const suffix = uniqueSuffix();
    expect((await dynamicCall(equipmentItem.GET,{id:assetId},{cookie:actors.viewer.cookie})).status).toBe(200);
    expect((await dynamicCall(equipmentTelemetry.GET,{id:assetId},{cookie:actors.viewer.cookie})).status).toBe(200);
    expect((await dynamicCall(equipmentItem.GET,{id:secondAssetId},{cookie:actors.viewer.cookie})).status).toBe(403);
    expect((await dynamicCall(equipmentTelemetry.GET,{id:secondAssetId},{cookie:actors.viewer.cookie})).status).toBe(403);
    expect((await call(plans.GET,{cookie:actors.viewer.cookie})).status).toBe(403);

    const unassigned = await call(workOrders.POST,{
      method:"POST",cookie:actors.operator.cookie,
      body:{assetId:secondAssetId,title:`Unassigned repair ${suffix}`,workType:"corrective"},
    });
    expect(unassigned.status).toBe(201);
    expect((await dynamicCall(workOrder.GET,{id:String(unassigned.body.id)},{cookie:actors.viewer.cookie})).status).toBe(403);
    expect((await dynamicCall(equipmentItem.DELETE,{id:assetId},{method:"DELETE",cookie:actors.viewer.cookie})).status).toBe(403);
    expect((await call(simulate.POST,{
      method:"POST",cookie:actors.viewer.cookie,body:{assetId,mode:"normal"},
    })).status).toBe(403);

    const viewerWorkOrders = await call(workOrders.GET,{cookie:actors.viewer.cookie});
    expect((viewerWorkOrders.body.workOrders as Array<{id:string}>).some((order) => order.id===workOrderId)).toBe(true);
    expect((viewerWorkOrders.body.workOrders as Array<{id:string}>).some((order) => order.id===String(unassigned.body.id))).toBe(false);
  });

  it("records and closes manual downtime with idempotent, non-future timestamps", async () => {
    const key = `${movementKey()}-phase4-manual-downtime`;
    const body = {
      reason:"Scheduled repair",
      startedAt:new Date(Date.now()-60_000).toISOString(),
      idempotencyKey:key,
    };
    const created = await dynamicCall(downtime.POST,{id:assetId},{
      method:"POST",cookie:actors.operator.cookie,
      body,
    });
    expect(created.status).toBe(201);
    expect((await dynamicCall(downtime.POST,{id:assetId},{
      method:"POST",cookie:actors.operator.cookie,
      body,
    })).status).toBe(200);
    const closed = await dynamicCall(downtimeEvent.PATCH,{id:assetId,eventId:String(created.body.id)},{
      method:"PATCH",cookie:actors.operator.cookie,body:{},
    });
    expect(closed.status).toBe(200);
  });
});
