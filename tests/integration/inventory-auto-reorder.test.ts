import { afterAll, beforeAll, expect, it } from "vitest";
import {
  call, closeDatabases, itemBody, loadHandlers, movementKey, resetDatabase,
  seedActors, testPool, type Actors, type Handlers,
} from "./harness";
import * as reorder from "@/app/api/inventory/reorder/route";

let h:Handlers;
let actors:Actors;
const inventoryPath="/api/inventory";
const reorderPath="/api/inventory/reorder";
const movePath="/api/inventory/movements";

const configuration=(sku:string,enabled:boolean,reorderPoint:string,replenishQuantity:string,cookie?:string)=>
  call(reorder.PATCH,{
    method:"PATCH",path:reorderPath,cookie:cookie??actors.admin.cookie,
    body:{sku,enabled,reorderPoint,replenishQuantity},
  });
const item=(sku:string,onHand:string,reorderPoint="10")=>
  call(h.inventory.POST,{
    method:"POST",path:inventoryPath,cookie:actors.admin.cookie,
    body:itemBody({sku,onHand,reorder:reorderPoint}),
  });
const movement=(sku:string,type:"issue"|"receipt"|"transfer"|"count",details:Record<string,unknown>)=>
  call(h.movements.POST,{
    method:"POST",path:movePath,cookie:actors.operator.cookie,
    body:{type,sku,idempotencyKey:movementKey(),...details},
  });
const requests=(sku:string)=>testPool().query<{id:string;status:string;quantity:string;request_origin:string}>(
  `SELECT pr.id,pr.status,pr.quantity::text AS quantity,pr.request_origin
    FROM purchase_requests pr JOIN inventory_items i ON i.id=pr.item_id
    WHERE i.sku=$1 AND pr.request_origin='auto_reorder' ORDER BY pr.created_at`,[sku],
);

beforeAll(async()=>{
  await resetDatabase();
  h=await loadHandlers();
  actors=await seedActors(h);
});
afterAll(closeDatabases);

it("defaults every existing and new SKU to Auto Reorder disabled",async()=>{
  const created=await item("AUTO-OFF","12");
  expect(created.status).toBe(201);
  const listed=await call(h.inventory.GET,{cookie:actors.viewer.cookie,path:inventoryPath});
  const record=listed.body.items.find((value:{sku:string})=>value.sku==="AUTO-OFF");
  expect(record).toMatchObject({
    autoReorderEnabled:false,autoReorderQuantity:"0.000",reorder:"10.000",
    totalOnHand:"12.000",
  });
  expect((await movement("AUTO-OFF","issue",{
    quantity:"4",sourceLocation:"Main warehouse",sourceBin:"A-01",
  })).status).toBe(200);
  expect((await requests("AUTO-OFF")).rows).toEqual([]);
});

it("enabling below threshold creates one internal purchase request, not an external purchase order",async()=>{
  const response=await configuration("AUTO-OFF",true,"10","24");
  expect(response.status).toBe(200);
  expect(response.body.createdRequestId).toBeTruthy();
  expect((await requests("AUTO-OFF")).rows).toMatchObject([
    {status:"requested",quantity:"24.000",request_origin:"auto_reorder"},
  ]);
  const existing=await configuration("AUTO-OFF",true,"10","24");
  expect(existing.status).toBe(200);
  expect(existing.body.createdRequestId).toBeNull();
  expect((await requests("AUTO-OFF")).rows).toHaveLength(1);
  expect((await testPool().query("SELECT id FROM purchase_orders")).rows).toEqual([]);
  const queue=await call(reorder.GET,{cookie:actors.viewer.cookie,path:reorderPath});
  expect(queue.status).toBe(200);
  expect(queue.body.requests.find((row:{sku:string})=>row.sku==="AUTO-OFF")).toMatchObject({
    status:"requested",quantity:"24.000",autoReorderEnabled:true,
  });
});

it("new stock issues and manual reconciliation never duplicate an open request",async()=>{
  const issued=await movement("AUTO-OFF","issue",{
    quantity:"2",sourceLocation:"Main warehouse",sourceBin:"A-01",
  });
  expect(issued.status).toBe(200);
  const reconcile=await call(reorder.POST,{
    method:"POST",path:reorderPath,cookie:actors.operator.cookie,body:{sku:"AUTO-OFF"},
  });
  expect(reconcile.status).toBe(200);
  expect(reconcile.body.createdRequestId).toBeNull();
  expect((await requests("AUTO-OFF")).rows).toHaveLength(1);
});

it("disabling stops future requests without deleting or modifying historical requests",async()=>{
  const disabled=await configuration("AUTO-OFF",false,"10","24");
  expect(disabled.status).toBe(200);
  const before=(await requests("AUTO-OFF")).rows;
  expect(before).toHaveLength(1);
  await testPool().query("UPDATE purchase_requests SET status='cancelled' WHERE id=$1",[before[0].id]);
  expect((await movement("AUTO-OFF","issue",{
    quantity:"1",sourceLocation:"Main warehouse",sourceBin:"A-01",
  })).status).toBe(200);
  expect((await requests("AUTO-OFF")).rows).toHaveLength(1);
  const switchedOn=await configuration("AUTO-OFF",true,"10","6");
  expect(switchedOn.status).toBe(200);
  const after=(await requests("AUTO-OFF")).rows;
  expect(after).toHaveLength(2);
  expect(after.some(row=>row.id===before[0].id&&row.status==="cancelled")).toBe(true);
  expect(after.some(row=>row.status==="requested"&&row.quantity==="6.000")).toBe(true);
});

it("computes threshold from total quantity across bins, never from a low individual bin",async()=>{
  expect((await item("AUTO-BINS","12")).status).toBe(201);
  expect((await configuration("AUTO-BINS",true,"10","40")).status).toBe(200);
  expect((await requests("AUTO-BINS")).rows).toHaveLength(0);
  const transfer=await movement("AUTO-BINS","transfer",{
    quantity:"5",sourceLocation:"Main warehouse",sourceBin:"A-01",
    destinationLocation:"Annex",destinationBin:"B-01",
  });
  expect(transfer.status).toBe(200);
  expect((await requests("AUTO-BINS")).rows).toHaveLength(0);
  const stock=await call(h.inventory.GET,{cookie:actors.admin.cookie,path:inventoryPath});
  expect(stock.body.items.filter((row:{sku:string})=>row.sku==="AUTO-BINS")
    .every((row:{totalOnHand:string})=>row.totalOnHand==="12.000")).toBe(true);
  expect((await movement("AUTO-BINS","issue",{
    quantity:"3",sourceLocation:"Annex",sourceBin:"B-01",
  })).status).toBe(200);
  expect((await requests("AUTO-BINS")).rows).toHaveLength(1);
});

it("does not duplicate existing manual purchase requests or unreceived supplier purchase orders",async()=>{
  expect((await item("AUTO-MANUAL","4")).status).toBe(201);
  const itemId=(await testPool().query<{id:string}>(
    "SELECT id FROM inventory_items WHERE sku='AUTO-MANUAL'",
  )).rows[0].id;
  const orgId=(await testPool().query<{id:string}>(
    "SELECT organization_id AS id FROM inventory_items WHERE id=$1",[itemId],
  )).rows[0].id;
  const manual=await testPool().query<{id:string}>(
    `INSERT INTO purchase_requests(organization_id,item_id,quantity,created_by,reference)
       VALUES($1,$2,20,$3,'Manual replenishment in progress') RETURNING id`,
    [orgId,itemId,actors.admin.id],
  );
  const enabled=await configuration("AUTO-MANUAL",true,"10","30");
  expect(enabled.status).toBe(200);
  expect(enabled.body.createdRequestId).toBeNull();
  expect((await requests("AUTO-MANUAL")).rows).toHaveLength(0);
  await testPool().query("UPDATE purchase_requests SET status='cancelled' WHERE id=$1",[manual.rows[0].id]);

  const supplier=await testPool().query<{id:string}>(
    `INSERT INTO suppliers(organization_id,code,name,created_by)
       VALUES($1,'AUTO-TEST-SUP','Supplier for auto test',$2) RETURNING id`,
    [orgId,actors.admin.id],
  );
  const po=await testPool().query<{id:string}>(
    `INSERT INTO purchase_orders(organization_id,po_number,supplier_id,created_by)
       VALUES($1,'AUTO-TEST-PO',$2,$3) RETURNING id`,
    [orgId,supplier.rows[0].id,actors.admin.id],
  );
  await testPool().query(
    `INSERT INTO purchase_order_lines
       (organization_id,purchase_order_id,line_number,item_id,ordered_qty)
       VALUES($1,$2,1,$3,30)`,[orgId,po.rows[0].id,itemId],
  );
  const openPo=await call(reorder.POST,{
    method:"POST",path:reorderPath,cookie:actors.operator.cookie,body:{sku:"AUTO-MANUAL"},
  });
  expect(openPo.status).toBe(200);
  expect(openPo.body.createdRequestId).toBeNull();

  await testPool().query("UPDATE purchase_orders SET status='cancelled' WHERE id=$1",[po.rows[0].id]);
  const nowDue=await call(reorder.POST,{
    method:"POST",path:reorderPath,cookie:actors.operator.cookie,body:{sku:"AUTO-MANUAL"},
  });
  expect(nowDue.status).toBe(200);
  expect(nowDue.body.createdRequestId).toBeTruthy();
  expect((await requests("AUTO-MANUAL")).rows).toHaveLength(1);
});

it("rejects malformed settings and prevents viewers from enabling or disabling reorder",async()=>{
  expect((await configuration("AUTO-BINS",true,"10","0")).status).toBe(400);
  expect((await configuration("AUTO-BINS",false,"10","5",actors.viewer.cookie)).status).toBe(403);
  const invalid=await call(reorder.PATCH,{
    method:"PATCH",path:reorderPath,cookie:actors.admin.cookie,
    body:{sku:"AUTO-BINS",enabled:"true",reorderPoint:"10",replenishQuantity:"5"},
  });
  expect(invalid.status).toBe(400);
});

it("never shows or changes a different organization's reorder settings or generated requests",async()=>{
  const orgB=(await (async()=>{
    await testPool().query("DROP INDEX organizations_single_installation_only");
    return testPool().query<{id:string}>(
      "INSERT INTO organizations(identifier,name) VALUES('auto-reorder-org-b','Second manufacturer') RETURNING id",
    );
  })()).rows[0].id;
  const itemB=await testPool().query<{id:string}>(
    `INSERT INTO inventory_items(organization_id,sku,name,category,unit,reorder_point,created_by,
      auto_reorder_enabled,auto_reorder_quantity)
      VALUES($1,'FOREIGN-AUTO','Foreign item','Fasteners','ea',10,$2,true,50) RETURNING id`,
    [orgB,actors.admin.id],
  );
  await testPool().query(
    `INSERT INTO purchase_requests(organization_id,item_id,quantity,created_by,request_origin)
      VALUES($1,$2,50,$3,'auto_reorder')`,
    [orgB,itemB.rows[0].id,actors.admin.id],
  );
  const list=await call(reorder.GET,{cookie:actors.admin.cookie,path:reorderPath});
  expect(JSON.stringify(list.body)).not.toContain("FOREIGN-AUTO");
  const blocked=await configuration("FOREIGN-AUTO",false,"10","50");
  expect(blocked.status).toBe(404);
  expect((await testPool().query(
    "SELECT auto_reorder_enabled FROM inventory_items WHERE id=$1",
    [itemB.rows[0].id],
  )).rows[0].auto_reorder_enabled).toBe(true);
});
