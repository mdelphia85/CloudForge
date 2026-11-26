import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, closeDatabases, itemBody, loadHandlers, movementKey,
  ORIGIN, resetDatabase, seedActors, testPool, type Actors, type Handlers } from "./harness";
import * as resources from "@/app/api/operations/[resource]/route";
import * as updates from "@/app/api/operations/[resource]/[id]/route";
import * as overview from "@/app/api/operations/overview/route";
import * as events from "@/app/api/operations/production/[id]/events/route";
import * as files from "@/app/api/engineering/documents/[id]/revisions/route";
import * as revisions from "@/app/api/engineering/revisions/[id]/route";
import * as releases from "@/app/api/engineering/releases/route";
import * as installs from "@/app/api/operations/service/[id]/installs/route";

let h:Handlers, actors:Actors;
let projectId:string, assetId:string, documentId:string, revisionId:string, jobId:string, serviceId:string;

const add=(resource:string,body:Record<string,unknown>,cookie:string)=>
  call(request=>resources.POST(request,{params:Promise.resolve({resource})}),{method:"POST",cookie,body});
const status=(resource:string,id:string,choice:string,cookie:string)=>
  call(request=>updates.PATCH(request,{params:Promise.resolve({resource,id})}),{
    method:"PATCH",cookie,body:{status:choice},
  });
const writeEvent=(id:string,body:Record<string,unknown>,cookie:string)=>
  call(request=>events.POST(request,{params:Promise.resolve({id})}),{method:"POST",cookie,body});

beforeAll(async()=>{
  await resetDatabase();
  h=await loadHandlers();
  actors=await seedActors(h);
});
afterAll(closeDatabases);

describe("Phase 2 cross-module integration",()=>{
  it("protects all module records from anonymous requests and viewers' writes",async()=>{
    expect((await call(overview.GET)).status).toBe(401);
    expect((await call(req=>resources.GET(req,{params:Promise.resolve({resource:"projects"})}))).status).toBe(401);
    expect((await add("projects",{code:"NO",name:"No write",customer:"test"},actors.viewer.cookie)).status).toBe(403);
  });

  it("creates projects, tasks, equipment and BOM linked to Phase 1 inventory",async()=>{
    const p=await add("projects",{code:"P-001",name:"Press line rebuild",customer:"Example MFG",priority:"high"},actors.admin.cookie);
    expect(p.status).toBe(201);
    projectId=p.body.id;
    const task=await add("tasks",{project_id:projectId,title:"Verify electrical drawings",discipline:"engineering"},actors.operator.cookie);
    expect(task.status).toBe(201);
    const a=await add("assets",{project_id:projectId,asset_tag:"PRESS-01",name:"Stamping press",customer_site:"Plant 7",
      plc_make:"Rockwell",plc_model:"ControlLogix",hmi_make:"Rockwell",hmi_model:"PanelView"},actors.admin.cookie);
    expect(a.status).toBe(201);
    assetId=a.body.id;
    const item=await call(h.inventory.POST,{method:"POST",cookie:actors.admin.cookie,
      body:itemBody({sku:"P-PLC-1",onHand:"10",reorder:"2"})});
    expect(item.status).toBe(201);
    const bom=await add("bom",{project_id:projectId,sku:"P-PLC-1",required_qty:"2",revision:"B"},actors.operator.cookie);
    expect(bom.status).toBe(201);
    const purchase=await add("purchasing",{project_id:projectId,sku:"P-PLC-1",quantity:"3",supplier:"Controls Supply"},actors.operator.cookie);
    expect(purchase.status).toBe(201);
    const all=await call(overview.GET,{cookie:actors.viewer.cookie});
    expect(all.status).toBe(200);
    expect(all.body.projects[0].code).toBe("P-001");
    expect(all.body.bom[0].sku).toBe("P-PLC-1");
    expect(all.body.assets[0].plc_model).toBe("ControlLogix");
    expect(all.body.purchasing[0].project_code).toBe("P-001");
    expect((await status("projects",projectId,"active",actors.operator.cookie)).body.status).toBe("active");
    expect((await status("projects",projectId,"planned",actors.operator.cookie)).status).toBe(409);
  });

  it("records safe atomic production counts and issues Phase 1 inventory with idempotency",async()=>{
    const job=await add("production",{project_id:projectId,asset_id:assetId,job_code:"WO-001",title:"Panel assembly",planned_qty:"2"},actors.admin.cookie);
    expect(job.status).toBe(201);
    jobId=job.body.id;
    expect((await writeEvent(jobId,{kind:"material",quantity:"1",sku:"P-PLC-1",location:"Main warehouse",bin:"A-01",idempotencyKey:movementKey()+"-pre"},actors.operator.cookie)).status).toBe(409);
    expect((await writeEvent(jobId,{kind:"start",idempotencyKey:movementKey()+"-start"},actors.operator.cookie)).status).toBe(201);
    const key=movementKey()+"-material";
    const payload={kind:"material",quantity:"1",sku:"P-PLC-1",location:"Main warehouse",bin:"A-01",idempotencyKey:key};
    const first=await writeEvent(jobId,payload,actors.operator.cookie);
    expect(first.status).toBe(201);
    const replay=await writeEvent(jobId,payload,actors.operator.cookie);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect((await writeEvent(jobId,{...payload,bin:"A-02"},actors.operator.cookie)).status).toBe(409);
    expect((await writeEvent(jobId,{kind:"progress",quantity:"3",idempotencyKey:movementKey()+"-over"},actors.operator.cookie)).status).toBe(409);
    expect((await writeEvent(jobId,{kind:"progress",quantity:"2",idempotencyKey:movementKey()+"-progress"},actors.operator.cookie)).status).toBe(201);
    expect((await writeEvent(jobId,{kind:"complete",idempotencyKey:movementKey()+"-complete"},actors.operator.cookie)).status).toBe(201);
    const count=await testPool().query("SELECT on_hand::text AS count FROM inventory_stock s JOIN inventory_items i ON i.id=s.item_id WHERE i.sku='P-PLC-1'");
    expect(count.rows[0].count).toBe("9.000");
    const move=await testPool().query("SELECT count(*)::int AS n FROM inventory_movements WHERE reference='Production WO-001'");
    expect(move.rows[0].n).toBe(1);
    const jobCheck=await testPool().query("SELECT status,completed_qty::text AS qty FROM production_jobs WHERE id=$1",[jobId]);
    expect(jobCheck.rows[0]).toEqual({status:"completed",qty:"2.000"});
    const log=await call(req=>events.GET(req,{params:Promise.resolve({id:jobId})}),{cookie:actors.viewer.cookie});
    expect(log.body.events).toHaveLength(4);
  });

  it("creates an engineering PLC program and allows only an admin to approve it",async()=>{
    const doc=await add("documents",{project_id:projectId,asset_id:assetId,title:"Press PLC main",kind:"plc"},actors.operator.cookie);
    expect(doc.status).toBe(201);
    documentId=doc.body.id;
    const upload=async(cookie:string)=>{
      const form=new FormData();
      form.set("file",new File([new Uint8Array([0,1,2,3,4])],"press_v1.ACD",{type:"application/octet-stream"}));
      form.set("notes","Bench verified");
      const req=new Request(ORIGIN+"/api/engineering/documents/"+documentId+"/revisions",{
        method:"POST",headers:{"origin":ORIGIN,"cookie":cookie},body:form,
      });
      return files.POST(req,{params:Promise.resolve({id:documentId})});
    };
    expect((await upload(actors.viewer.cookie)).status).toBe(403);
    const created=await upload(actors.operator.cookie);
    expect(created.status).toBe(201);
    revisionId=(await created.json()).id;
    const deny=await call(req=>revisions.GET(req,{params:Promise.resolve({id:revisionId})}),{cookie:actors.viewer.cookie});
    expect(deny.status).toBe(403);
    expect((await call(req=>revisions.PATCH(req,{params:Promise.resolve({id:revisionId})}),{
      method:"PATCH",cookie:actors.operator.cookie,
    })).status).toBe(403);
    const approved=await call(req=>revisions.PATCH(req,{params:Promise.resolve({id:revisionId})}),{
      method:"PATCH",cookie:actors.admin.cookie,
    });
    expect(approved.status).toBe(200);
    const viewerDownload=await revisions.GET(new Request(ORIGIN+"/api/engineering/revisions/"+revisionId,
      {headers:{cookie:actors.viewer.cookie}}),{params:Promise.resolve({id:revisionId})});
    expect(viewerDownload.status).toBe(403);
    const downloadable=await revisions.GET(new Request(ORIGIN+"/api/engineering/revisions/"+revisionId,
      {headers:{cookie:actors.operator.cookie}}),{params:Promise.resolve({id:revisionId})});
    expect(downloadable.status).toBe(200);
    expect(downloadable.headers.get("content-type")).toBe("application/octet-stream");
    expect([...new Uint8Array(await downloadable.arrayBuffer())]).toEqual([0,1,2,3,4]);
    const listed=await call(releases.GET,{cookie:actors.viewer.cookie});
    expect(listed.body.releases.some((x:{id:string})=>x.id===revisionId)).toBe(true);
  });

  it("records the exact approved PLC release on its customer equipment service job",async()=>{
    const viewerId=(await testPool().query("SELECT id FROM users WHERE email=$1",[actors.viewer.email])).rows[0].id as string;
    const job=await add("service",{
      project_id:projectId,asset_id:assetId,title:"Controller commissioning",assigned_to:viewerId,
    },actors.admin.cookie);
    expect(job.status).toBe(201);
    serviceId=job.body.id;
    const result=await call(req=>installs.POST(req,{params:Promise.resolve({id:serviceId})}),{
      method:"POST",cookie:actors.operator.cookie,body:{revisionId,result:"installed",notes:"Installed after site authorization"},
    });
    expect(result.status).toBe(201);
    const history=await call(req=>installs.GET(req,{params:Promise.resolve({id:serviceId})}),{
      cookie:actors.viewer.cookie,
    });
    expect(history.status).toBe(200);
    expect(history.body.installs[0]).toMatchObject({result:"installed",revision:1});
    expect((await status("service",serviceId,"completed",actors.admin.cookie)).status).toBe(409);
    expect((await status("service",serviceId,"in_progress",actors.admin.cookie)).status).toBe(200);
    expect((await status("service",serviceId,"completed",actors.admin.cookie)).status).toBe(200);
    const auditCount=await testPool().query("SELECT count(*)::int AS n FROM audit_events WHERE action='field_service.program_install_recorded'");
    expect(auditCount.rows[0].n).toBe(1);
  });
});
