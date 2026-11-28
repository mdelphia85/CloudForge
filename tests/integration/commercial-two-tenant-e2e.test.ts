import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertSafeTestDatabaseUrl } from "./database-guard";
import {
  call, closeDatabases, loadHandlers, ORIGIN, resetDatabase,
  seedActors, STRONG_PASSWORD, testPool, type Actors, type Handlers,
} from "./harness";
import { hashPassword } from "@/server/password";
import * as inventory from "@/app/api/inventory/route";
import * as resources from "@/app/api/operations/[resource]/route";
import * as overview from "@/app/api/operations/overview/route";
import * as uploader from "@/app/api/engineering/uploads/route";
import * as revision from "@/app/api/engineering/revisions/[id]/route";
import * as releases from "@/app/api/engineering/releases/route";
import * as organization from "@/app/api/auth/organization/route";

const root=fileURLToPath(new URL("../../",import.meta.url));
const originalDatabaseUrl=process.env.DATABASE_URL;
const originalPublicKey=process.env.LICENSE_PUBLIC_KEY;
const originalFlags={
  multi:process.env.CLOUDFORGE_MULTI_ORGANIZATION_ENABLED,
  license:process.env.CLOUDFORGE_LICENSE_ENFORCEMENT_REQUIRED,
};
const keys=generateKeyPairSync("ed25519");
const publicKey=keys.publicKey.export({type:"spki",format:"pem"}).toString();
const APP_DB_ROLE="cloudforge_e2e_test";
const APP_DB_PASSWORD="CI-Only-E2E-Database-Password-2026!";

let h:Handlers;
let a:Actors;
let aOrg="";
let bOrg="";
let bCookie="";
let bUserId="";
const projectCode="SANDING-ROBOT";
const sameSku="COMMON-PART-001";

function asAppRoleDatabaseUrl(original:string):string {
  const value=new URL(original);
  value.username=APP_DB_ROLE;
  value.password=APP_DB_PASSWORD;
  return value.toString();
}
async function license(orgId:string,seats:number) {
  const issuedAt=new Date(Date.now()-60_000).toISOString();
  const expiresAt=new Date(Date.now()+86_400_000).toISOString();
  const bytes=Buffer.from(JSON.stringify({
    version:1,licenseId:randomUUID(),organizationId:orgId,
    licenseType:"saas",tier:"engineering",seatLimit:seats,
    modules:["inventory","projects","engineering","production","purchasing","field_service","equipment","telemetry"],
    issuedAt,activatedAt:issuedAt,expiresAt,
  }));
  await testPool().query(
    `INSERT INTO organization_licenses
       (license_id,organization_id,signed_payload,signature,issued_at,activated_at,expires_at,installed_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      JSON.parse(bytes.toString("utf8")).licenseId,orgId,bytes.toString("base64url"),
      sign(null,bytes,keys.privateKey).toString("base64url"),
      issuedAt,issuedAt,expiresAt,a.admin.id,
    ],
  );
}
const resourceGet=(resource:string,cookie:string)=>
  call(request=>resources.GET(request,{params:Promise.resolve({resource})}),{
    cookie,path:"/api/operations/"+resource,
  });

beforeAll(async()=>{
  // Never run this test against a real customer database. The guard rejects
  // production names, provider hosts, and non-test Postgres users.
  const safeUrl=assertSafeTestDatabaseUrl({...process.env,DATABASE_URL:undefined});
  await resetDatabase();
  h=await loadHandlers();
  a=await seedActors(h);
  aOrg=(await testPool().query<{id:string}>(
    "SELECT id FROM organizations WHERE identifier='existing-installation'",
  )).rows[0].id;
  await testPool().query("INSERT INTO platform_owners(user_id) VALUES($1)",[a.admin.id]);

  await testPool().query(`DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cloudforge_e2e_test') THEN
        CREATE ROLE cloudforge_e2e_test LOGIN PASSWORD 'CI-Only-E2E-Database-Password-2026!'
        NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$`);
  await testPool().query("ALTER ROLE cloudforge_e2e_test NOSUPERUSER NOBYPASSRLS LOGIN");
  await testPool().query("GRANT USAGE ON SCHEMA public TO cloudforge_e2e_test");
  await testPool().query(
    "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO cloudforge_e2e_test",
  );
  await testPool().query("GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO cloudforge_e2e_test");

  const activation=spawnSync(process.execPath,["scripts/activate-multiorg.mjs","--apply"],{
    cwd:root,encoding:"utf8",timeout:30_000,
    env:{
      ...process.env,NODE_ENV:"test",DATABASE_URL:safeUrl,
      CLOUDFORGE_APP_DATABASE_ROLE:APP_DB_ROLE,
      CLOUDFORGE_ACTIVATION_APPROVAL:"AUTHORIZE_MULTI_ORGANIZATION_ISOLATION",
      CLOUDFORGE_ACTIVATION_APPROVER_ID:a.admin.id,
    },
  });
  expect(activation.status,`${activation.stdout}\n${activation.stderr}`).toBe(0);

  bOrg=(await testPool().query<{id:string}>(
    "INSERT INTO organizations(identifier,name,status,deployment_type) " +
      "VALUES('second-test-organization','Second Test Organization','active','saas') RETURNING id",
  )).rows[0].id;

  const hash=await hashPassword(STRONG_PASSWORD);
  bUserId=(await testPool().query<{id:string}>(
    "INSERT INTO users(email,display_name,password_hash,role) " +
      "VALUES('second-tenant-admin@example.test','Second Tenant Admin',$1,'viewer') RETURNING id",
    [hash],
  )).rows[0].id;
  await testPool().query(
    "INSERT INTO organization_memberships(organization_id,user_id,role) VALUES($1,$2,'admin')",
    [bOrg,bUserId],
  );
  await license(aOrg,3);
  await license(bOrg,1);
  await testPool().query(
    `INSERT INTO projects(organization_id,code,name,customer,created_by)
       VALUES($1,$2,'Sanding Robot','Example Manufacturer',$3)`,
    [aOrg,projectCode,a.admin.id],
  );
  const initialStock=await testPool().query<{id:string}>(
    `INSERT INTO inventory_items(organization_id,sku,name,category,unit,reorder_point,created_by)
       VALUES($1,$2,'Org A Bolts','Electrical','ea',2,$3) RETURNING id`,
    [aOrg,sameSku,a.admin.id],
  );
  await testPool().query(
    `INSERT INTO inventory_stock(organization_id,item_id,location,bin,on_hand,updated_by)
       VALUES($1,$2,'Plant A','A-01',20,$3)`,
    [aOrg,initialStock.rows[0].id,a.admin.id],
  );

  // Rebind only the APPLICATION connection to the restricted role. The harness
  // adminPool is a separate disposable-database setup/assertion connection.
  await globalThis.cloudForgePool?.end();
  globalThis.cloudForgePool=undefined;
  process.env.DATABASE_URL=asAppRoleDatabaseUrl(safeUrl);
  process.env.LICENSE_PUBLIC_KEY=publicKey;
  process.env.CLOUDFORGE_MULTI_ORGANIZATION_ENABLED="true";
  process.env.CLOUDFORGE_LICENSE_ENFORCEMENT_REQUIRED="true";

  const signedIn=await call(h.login.POST,{
    method:"POST",
    body:{email:"second-tenant-admin@example.test",password:STRONG_PASSWORD},
  });
  expect(signedIn.status,JSON.stringify(signedIn.body)).toBe(200);
  expect(signedIn.sessionCookie).toBeTruthy();
  bCookie=signedIn.sessionCookie!;
},90_000);

afterAll(async()=>{
  await closeDatabases();
  if(originalDatabaseUrl===undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL=originalDatabaseUrl;
  if(originalPublicKey===undefined) delete process.env.LICENSE_PUBLIC_KEY;
  else process.env.LICENSE_PUBLIC_KEY=originalPublicKey;
  if(originalFlags.multi===undefined) delete process.env.CLOUDFORGE_MULTI_ORGANIZATION_ENABLED;
  else process.env.CLOUDFORGE_MULTI_ORGANIZATION_ENABLED=originalFlags.multi;
  if(originalFlags.license===undefined) delete process.env.CLOUDFORGE_LICENSE_ENFORCEMENT_REQUIRED;
  else process.env.CLOUDFORGE_LICENSE_ENFORCEMENT_REQUIRED=originalFlags.license;
});

it("keeps both organizations and memberships separate under the REAL restricted DB account",async()=>{
  const first=await call(organization.GET,{cookie:a.admin.cookie});
  const second=await call(organization.GET,{cookie:bCookie});
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(first.body.organizations.map((x:{id:string})=>x.id)).toEqual([aOrg]);
  expect(second.body.organizations.map((x:{id:string})=>x.id)).toEqual([bOrg]);
  expect(second.body.selectedOrganizationId).toBe(bOrg);
  const loginAudit=await testPool().query<{organization_id:string}>(
    "SELECT organization_id FROM audit_events WHERE actor_user_id=$1 AND action='auth.login' " +
      "ORDER BY occurred_at DESC LIMIT 1",
    [bUserId],
  );
  expect(loginAudit.rows[0]?.organization_id).toBe(bOrg);
});

it("permits identical customer SKUs, but filters stock and projects by signed-in organization",async()=>{
  const created=await call(inventory.POST,{
    method:"POST",cookie:bCookie,path:"/api/inventory",
    body:{
      sku:sameSku,name:"Org B Different Part",category:"Mechanical",unit:"ea",
      reorder:"2",onHand:"10",location:"Plant B",bin:"B-01",
    },
  });
  expect(created.status,JSON.stringify(created.body)).toBe(201);

  const first=await call(inventory.GET,{cookie:a.admin.cookie,path:"/api/inventory"});
  const second=await call(inventory.GET,{cookie:bCookie,path:"/api/inventory"});
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(JSON.stringify(first.body.items)).toContain("Org A Bolts");
  expect(JSON.stringify(second.body.items)).toContain("Org B Different Part");
  expect(JSON.stringify(second.body.items)).not.toContain("Org A Bolts");

  const projectA=await resourceGet("projects",a.admin.cookie);
  const projectB=await resourceGet("projects",bCookie);
  expect(projectA.status).toBe(200);
  expect(projectB.status).toBe(200);
  expect(projectA.body.records).toEqual(expect.arrayContaining([expect.objectContaining({code:projectCode})]));
  expect(projectB.body.records).toEqual([]);
});

it("returns only licensed organization records through workspace overview",async()=>{
  const aResponse=await call(overview.GET,{cookie:a.admin.cookie,path:"/api/operations/overview"});
  const bResponse=await call(overview.GET,{cookie:bCookie,path:"/api/operations/overview"});
  expect(aResponse.status,JSON.stringify(aResponse.body)).toBe(200);
  expect(bResponse.status,JSON.stringify(bResponse.body)).toBe(200);
  expect(aResponse.body.projects).toHaveLength(1);
  expect(bResponse.body.projects).toHaveLength(0);
});

it("blocks cross-organization engineering file downloads even when IDs are known",async()=>{
  const projects=await resourceGet("projects",a.admin.cookie);
  const projectId=String(projects.body.records[0].id);
  const form=new FormData();
  form.set("kind","electrical_schematic");
  form.set("projectId",projectId);
  form.set("title","Sanding Robot Electrical Schematics");
  form.set("notes","Controlled reference drawing");
  form.set("file",new File([new Uint8Array([0,1,2,3,0,255])],"sanding-robot.dwg"));
  const upload=await uploader.POST(new Request(ORIGIN+"/api/engineering/uploads",{
    method:"POST",headers:{origin:ORIGIN,cookie:a.admin.cookie},body:form,
  }));
  expect(upload.status).toBe(201);
  const data=await upload.json();
  const unauthorized=await revision.GET(new Request(ORIGIN+"/api/engineering/revisions/"+data.revisionId,{
    headers:{cookie:bCookie},
  }),{params:Promise.resolve({id:data.revisionId})});
  expect(unauthorized.status).toBe(404);
  const owner=await revision.GET(new Request(ORIGIN+"/api/engineering/revisions/"+data.revisionId,{
    headers:{cookie:a.admin.cookie},
  }),{params:Promise.resolve({id:data.revisionId})});
  expect(owner.status).toBe(200);
  expect(Array.from(new Uint8Array(await owner.arrayBuffer()))).toEqual([0,1,2,3,0,255]);
  const bReleases=await call(releases.GET,{
    cookie:bCookie,path:"/api/engineering/releases",
  });
  expect(bReleases.status).toBe(200);
  expect(bReleases.body.releases).toEqual([]);
});
