import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  call, closeDatabases, loadHandlers, ORIGIN, resetDatabase, seedActors,
  STRONG_PASSWORD, testPool, type Actors, type Handlers,
} from "./harness";
import { getAuthenticatedUser } from "@/server/auth";
import * as platformInvites from "@/app/api/platform/invitations/route";
import * as orgInvites from "@/app/api/organizations/invitations/route";
import * as inviteAcceptance from "@/app/api/organization-invitations/accept/route";
import * as switchOrganization from "@/app/api/auth/organization/route";

let h: Handlers;
let actors: Actors;
let orgA="";
let orgB="";
let firstLink="";
const keys=generateKeyPairSync("ed25519");
const publicKey=keys.publicKey.export({type:"spki",format:"pem"}).toString();
const originalKey=process.env.LICENSE_PUBLIC_KEY;

async function license(org:string,seats=3) {
  const start=new Date(Date.now()-24*3600*1000).toISOString();
  const end=new Date(Date.now()+30*24*3600*1000).toISOString();
  const claims={
    version:1,licenseId:randomUUID(),organizationId:org,licenseType:"saas",
    tier:"professional",seatLimit:seats,modules:["inventory","engineering","projects"],
    issuedAt:start,activatedAt:start,expiresAt:end,
  };
  const bytes=Buffer.from(JSON.stringify(claims));
  await testPool().query(
    `INSERT INTO organization_licenses
      (license_id,organization_id,signed_payload,signature,issued_at,activated_at,expires_at,installed_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [claims.licenseId,org,bytes.toString("base64url"),
      sign(null,bytes,keys.privateKey).toString("base64url"),
      start,start,end,actors.admin.id],
  );
}

beforeAll(async()=>{
  await resetDatabase();
  h=await loadHandlers();
  actors=await seedActors(h);
  orgA=(await testPool().query<{id:string}>(
    "SELECT id FROM organizations WHERE identifier='existing-installation'",
  )).rows[0].id;
  process.env.LICENSE_PUBLIC_KEY=publicKey;
  // Test only; in production the singleton guard stays until all CI and
  // operational security release gates are verified.
  await testPool().query("DROP INDEX organizations_single_installation_only");
  orgB=(await testPool().query<{id:string}>(
    "INSERT INTO organizations(identifier,name,deployment_type) " +
      "VALUES('second-manufacturer','Second Manufacturer','saas') RETURNING id",
  )).rows[0].id;
  await testPool().query("INSERT INTO platform_owners(user_id) VALUES($1)",[actors.admin.id]);
  await license(orgB,3);
});
afterAll(async()=>{
  if(originalKey===undefined)delete process.env.LICENSE_PUBLIC_KEY;
  else process.env.LICENSE_PUBLIC_KEY=originalKey;
  await closeDatabases();
});

it("issues a signed-license-capped invitation for a second organization without owner membership",async()=>{
  const response=await call(platformInvites.POST,{
    method:"POST",cookie:actors.admin.cookie,
    body:{organizationId:orgB,email:"new-engineer@example.test",role:"admin"},
  });
  expect(response.status).toBe(201);
  expect(response.body).toMatchObject({email:"new-engineer@example.test",role:"admin"});
  firstLink=String(response.body.inviteLink);
  expect(firstLink).toContain("/join#token=");
  const token=new URL(firstLink.replace("#token=","?token=")).searchParams.get("token");
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const raw=await testPool().query<{token_hash:string}>(
    "SELECT token_hash FROM organization_invitations WHERE organization_id=$1",
    [orgB],
  );
  expect(raw.rows).toHaveLength(1);
  expect(raw.rows[0].token_hash).not.toBe(token);
  const ownerMembership=await testPool().query(
    "SELECT 1 FROM organization_memberships WHERE organization_id=$1 AND user_id=$2",
    [orgB,actors.admin.id],
  );
  expect(ownerMembership.rowCount).toBe(0);
});

it("accepts a new user once and NEVER auto-enrolls them in original organization",async()=>{
  const token=firstLink.split("#token=")[1];
  const accepted=await call(inviteAcceptance.POST,{
    method:"POST",body:{
      token,displayName:"New Engineering Administrator",password:STRONG_PASSWORD,
    },
  });
  expect(accepted.status).toBe(201);
  expect(accepted.body.membership).toMatchObject({organizationId:orgB,role:"admin"});
  const created=await testPool().query<{id:string;role:string}>(
    "SELECT id,role FROM users WHERE email='new-engineer@example.test'",
  );
  expect(created.rows).toHaveLength(1);
  expect(created.rows[0].role).toBe("viewer");
  const memberships=await testPool().query<{organization_id:string;role:string}>(
    "SELECT organization_id,role FROM organization_memberships WHERE user_id=$1",
    [created.rows[0].id],
  );
  expect(memberships.rows).toEqual([{organization_id:orgB,role:"admin"}]);
  const replay=await call(inviteAcceptance.POST,{
    method:"POST",body:{token,password:STRONG_PASSWORD},
  });
  expect(replay.status).toBe(400);
  const login=await call(h.login.POST,{
    method:"POST",body:{email:"new-engineer@example.test",password:STRONG_PASSWORD},
  });
  expect(login.status).toBe(200);
  expect(login.sessionCookie).toBeTruthy();
  const current=await getAuthenticatedUser(new Request(ORIGIN,{
    headers:{cookie:login.sessionCookie!},
  }));
  expect(current).toMatchObject({organizationId:orgB,role:"admin"});
});

it("existing users may accept an invitation to another licensed organization and then switch",async()=>{
  const issued=await call(platformInvites.POST,{
    method:"POST",cookie:actors.admin.cookie,
    body:{organizationId:orgB,email:actors.operator.email,role:"operator"},
  });
  expect(issued.status).toBe(201);
  const token=String(issued.body.inviteLink).split("#token=")[1];
  const bad=await call(inviteAcceptance.POST,{
    method:"POST",body:{token,password:"INCORRECT-PASSWORD!"},
  });
  expect(bad.status).toBe(401);
  const accepted=await call(inviteAcceptance.POST,{
    method:"POST",body:{token,password:STRONG_PASSWORD},
  });
  expect(accepted.status).toBe(201);
  const memberships=await testPool().query<{organization_id:string;role:string}>(
    "SELECT organization_id,role FROM organization_memberships WHERE user_id=(SELECT id FROM users WHERE email=$1) ORDER BY organization_id",
    [actors.operator.email],
  );
  expect(new Set(memberships.rows.map(x=>x.organization_id))).toEqual(new Set([orgA,orgB]));
  const switched=await call(switchOrganization.POST,{
    method:"POST",cookie:actors.operator.cookie,body:{organizationId:orgB},
  });
  expect(switched.status).toBe(200);
  expect(switched.body.user).toMatchObject({organizationId:orgB,role:"operator"});
});

it("prevents other customer administrators from reading another organization's invitations",async()=>{
  const listA=await call(orgInvites.GET,{cookie:actors.admin.cookie});
  expect(listA.status).toBe(200);
  expect(listA.body.invitations).toEqual([]);
  const outsider=await call(platformInvites.POST,{
    method:"POST",cookie:actors.operator.cookie,
    body:{organizationId:orgB,email:"outsider@example.test",role:"viewer"},
  });
  expect(outsider.status).toBe(403);
});

it("seat accounting reserves invitations and blocks excess membership invitations",async()=>{
  const first=await call(platformInvites.POST,{
    method:"POST",cookie:actors.admin.cookie,
    body:{organizationId:orgB,email:"third-user@example.test",role:"viewer"},
  });
  expect(first.status).toBe(201);
  const over=await call(platformInvites.POST,{
    method:"POST",cookie:actors.admin.cookie,
    body:{organizationId:orgB,email:"fourth-user@example.test",role:"viewer"},
  });
  expect(over.status).toBe(409);
  expect(over.body.code).toBe("SEAT_CAPACITY_RESERVED");
});

it("rejects invalid/unknown invitation tokens without creating users",async()=>{
  const result=await call(inviteAcceptance.POST,{
    method:"POST",body:{token:"x".repeat(43),password:STRONG_PASSWORD,displayName:"Some User"},
  });
  expect(result.status).toBe(400);
  const user=await testPool().query("SELECT 1 FROM users WHERE email='some-user@example.test'");
  expect(user.rowCount).toBe(0);
});
