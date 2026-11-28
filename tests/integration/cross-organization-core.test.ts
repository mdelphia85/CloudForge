import { afterAll, beforeAll, expect, it } from "vitest";
import {
  call, closeDatabases, loadHandlers, resetDatabase, seedActors, testPool,
  type Actors, type Handlers,
} from "./harness";
import * as inventory from "@/app/api/inventory/route";
import * as inventoryMoves from "@/app/api/inventory/movements/route";
import * as resources from "@/app/api/operations/[resource]/route";
import * as status from "@/app/api/operations/[resource]/[id]/route";

let actors: Actors;
let h: Handlers;
let otherOrgId: string;
let otherProjectId: string;
const otherSku = "OTHER-ORG-SKU";

const resource = (name: string, method: "GET" | "POST", cookie: string, body?: Record<string,unknown>) =>
  call((request) => method==="POST"
    ? resources.POST(request,{params:Promise.resolve({resource:name})})
    : resources.GET(request,{params:Promise.resolve({resource:name})}),
    {method, cookie,body});

beforeAll(async()=>{
  await resetDatabase();
  h=await loadHandlers();
  actors=await seedActors(h);
  // TEST-ONLY: remove the safety index in a disposable PostgreSQL database to
  // demonstrate cross-org attempts. The production schema still blocks this!
  await testPool().query("DROP INDEX organizations_single_installation_only");
  const other=await testPool().query<{id:string}>(
    "INSERT INTO organizations(identifier,name,status) VALUES ('other-test-company','Other Test Company','active') RETURNING id",
  );
  otherOrgId=other.rows[0].id;
  const project=await testPool().query<{id:string}>(
    `INSERT INTO projects(organization_id,code,name,customer,created_by)
      VALUES($1,'ORG-B-SECRET','Secret Project','Other Customer',$2) RETURNING id`,
    [otherOrgId,actors.admin.id],
  );
  otherProjectId=project.rows[0].id;
  const item=await testPool().query<{id:string}>(
    `INSERT INTO inventory_items(organization_id,sku,name,category,unit,reorder_point,created_by)
       VALUES($1,$2,'Competitor Secret Stock','Electrical','ea',3,$3) RETURNING id`,
    [otherOrgId,otherSku,actors.admin.id],
  );
  await testPool().query(
    "INSERT INTO inventory_stock(organization_id,item_id,location,bin,on_hand,updated_by) VALUES($1,$2,'Other warehouse','Z-9',100,$3)",
    [otherOrgId,item.rows[0].id,actors.admin.id],
  );
});
afterAll(closeDatabases);

it("never reveals a second company's inventory or projects through core lists",async()=>{
  const items=await call(inventory.GET,{cookie:actors.admin.cookie});
  expect(items.status).toBe(200);
  expect(items.body.items.some((item:{sku:string})=>item.sku===otherSku)).toBe(false);
  const projects=await resource("projects","GET",actors.admin.cookie);
  expect(projects.status).toBe(200);
  expect(projects.body.records.some((row:{id:string})=>row.id===otherProjectId)).toBe(false);
  const overview=await call(h.status.GET,{cookie:actors.admin.cookie});
  expect(overview.status).toBe(200);
});

it("rejects cross-organization associations and status mutations",async()=>{
  const injected=await resource("tasks","POST",actors.admin.cookie,{
    project_id:otherProjectId,title:"Cross-organization task",discipline:"engineering",
  });
  expect(injected.status).toBe(400);
  const equipment=await resource("assets","POST",actors.admin.cookie,{
    project_id:otherProjectId,asset_tag:"ORG-A-CROSS",name:"Foreign equipment",customer_site:"Fake site",
  });
  expect(equipment.status).toBe(400);
  const changed=await call(request=>status.PATCH(request,{
    params:Promise.resolve({resource:"projects",id:otherProjectId}),
  }),{method:"PATCH",cookie:actors.admin.cookie,body:{status:"active"}});
  expect(changed.status).toBe(404);
});

it("does not reveal or modify another company's stock using SKU or movement records",async()=>{
  const history=await call(inventoryMoves.GET,{
    cookie:actors.admin.cookie,path:"/api/inventory/movements?sku="+otherSku,
  });
  expect(history.status).toBe(200);
  expect(history.body.movements).toEqual([]);

  const receipt=await call(inventoryMoves.POST,{
    method:"POST",cookie:actors.admin.cookie,
    body:{
      type:"receipt",sku:otherSku,quantity:"5",location:"Other warehouse",bin:"Z-9",
      idempotencyKey:"other-company-movement-test-key",
    },
  });
  expect(receipt.status).toBe(404);
  const stock=await testPool().query<{on_hand:string}>(
    "SELECT on_hand::text FROM inventory_stock s JOIN inventory_items i ON i.id=s.item_id WHERE i.sku=$1 AND s.organization_id=$2",
    [otherSku,otherOrgId],
  );
  expect(stock.rows[0].on_hand).toBe("100.000");
});

it("database foreign keys reject cross-company inventory and engineering references",async()=>{
  const originalOrg = (await testPool().query<{ id:string }>(
    "SELECT id FROM organizations WHERE identifier='existing-installation'",
  )).rows[0].id;
  await expect(testPool().query(
    `INSERT INTO engineering_documents(organization_id,project_id,title,kind,created_by)
      VALUES($1,$2,'Illegitimate Cross-Tenant Drawing','drawing',$3)`,
    [originalOrg,otherProjectId,actors.admin.id],
  )).rejects.toMatchObject({code:"23503"});
  const itemId=(await testPool().query<{id:string}>(
    "SELECT id FROM inventory_items WHERE organization_id=$1 AND sku=$2",
    [otherOrgId,otherSku],
  )).rows[0].id;
  await expect(testPool().query(
    `INSERT INTO inventory_stock(organization_id,item_id,location,bin,on_hand,updated_by)
      VALUES($1,$2,'Wrong Tenant','W-1',1,$3)`,
    [originalOrg,itemId,actors.admin.id],
  )).rejects.toMatchObject({code:"23503"});
});

it("allows the same business SKU and project code in separate organizations, but not duplicates within one",async()=>{
  const originalOrg=(await testPool().query<{id:string}>(
    "SELECT id FROM organizations WHERE identifier='existing-installation'",
  )).rows[0].id;
  const item=await testPool().query<{id:string}>(
    `INSERT INTO inventory_items(organization_id,sku,name,category,unit,reorder_point,created_by)
      VALUES($1,$2,'Duplicate identifier allowed across organizations','Electrical','ea',0,$3)
      RETURNING id`,
    [originalOrg,otherSku,actors.admin.id],
  );
  expect(item.rows).toHaveLength(1);
  await expect(testPool().query(
    `INSERT INTO inventory_items(organization_id,sku,name,category,unit,reorder_point,created_by)
      VALUES($1,$2,'Duplicate not allowed within org','Electrical','ea',0,$3)`,
    [originalOrg,otherSku,actors.admin.id],
  )).rejects.toMatchObject({code:"23505"});
  const project=await testPool().query<{id:string}>(
    `INSERT INTO projects(organization_id,code,name,customer,created_by)
      VALUES($1,'ORG-B-SECRET','Same project code independently','Different customer',$2) RETURNING id`,
    [originalOrg,actors.admin.id],
  );
  expect(project.rows).toHaveLength(1);
  await expect(testPool().query(
    `INSERT INTO projects(organization_id,code,name,customer,created_by)
      VALUES($1,'ORG-B-SECRET','Colliding same-tenant code','Different customer',$2)`,
    [originalOrg,actors.admin.id],
  )).rejects.toMatchObject({code:"23505"});
});
