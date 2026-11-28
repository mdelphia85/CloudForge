import { afterAll, beforeAll, expect, it } from "vitest";
import {
  call, closeDatabases, loadHandlers, ORIGIN, resetDatabase, seedActors, testPool,
  type Actors, type Handlers,
} from "./harness";
import * as context from "@/app/api/auth/organization/route";
import { getAuthenticatedUser, switchSessionOrganization } from "@/server/auth";

let h: Handlers;
let actors: Actors;
let organizationId: string;

beforeAll(async () => {
  await resetDatabase();
  h = await loadHandlers();
  actors = await seedActors(h);
  const existing = await testPool().query<{ id: string }>(
    "SELECT id FROM organizations WHERE identifier='existing-installation'",
  );
  expect(existing.rows).toHaveLength(1);
  organizationId = existing.rows[0].id;
});
afterAll(closeDatabases);

it("binds created sessions to the existing organization's active membership", async () => {
  const authenticated = await getAuthenticatedUser(new Request(ORIGIN, {
    headers: { cookie: actors.operator.cookie },
  }));
  expect(authenticated).toMatchObject({
    organizationId, role: "operator",
  });
  const joined = await testPool().query(
    `SELECT m.role, s.organization_id FROM sessions s
       JOIN organization_memberships m ON m.organization_id=s.organization_id AND m.user_id=s.user_id
       JOIN users u ON u.id=s.user_id WHERE u.email=$1`,
    [actors.operator.email],
  );
  expect(joined.rows.some((row) => row.organization_id === organizationId && row.role === "operator")).toBe(true);
});

it("lists only organizations accessible to this user, and supports an authorized no-op switch", async () => {
  const list = await call(context.GET, { cookie: actors.viewer.cookie });
  expect(list.status).toBe(200);
  expect(list.body.selectedOrganizationId).toBe(organizationId);
  expect(list.body.organizations).toHaveLength(1);
  expect(list.body.organizations[0]).toMatchObject({ id: organizationId, role: "viewer" });

  const switched = await call(context.POST, {
    method: "POST", cookie: actors.viewer.cookie, body: { organizationId },
  });
  expect(switched.status).toBe(200);
  expect(switched.body.user).toMatchObject({ organizationId, role: "viewer" });
});

it("blocks unauthorized switches and does not change the session association", async () => {
  const forbiddenId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const result = await call(context.POST, {
    method: "POST", cookie: actors.operator.cookie, body: { organizationId: forbiddenId },
  });
  expect(result.status).toBe(403);
  expect(result.body.code).toBe("ORGANIZATION_ACCESS_DENIED");
  const current = await getAuthenticatedUser(new Request(ORIGIN, { headers: { cookie: actors.operator.cookie } }));
  expect(current?.organizationId).toBe(organizationId);
  expect((await call(context.POST, {
    method: "POST", cookie: actors.operator.cookie, origin: "https://evil.example",
    body: { organizationId },
  })).status).toBe(403);
});

it("fails closed when an organization membership is removed", async () => {
  const user = (await testPool().query<{ id: string }>("SELECT id FROM users WHERE email=$1", [
    actors.viewer.email,
  ])).rows[0];
  await testPool().query("DELETE FROM organization_memberships WHERE user_id=$1 AND organization_id=$2", [
    user.id, organizationId,
  ]);
  expect(await getAuthenticatedUser(new Request(ORIGIN, { headers: { cookie: actors.viewer.cookie } }))).toBeNull();
  const list = await call(context.GET, { cookie: actors.viewer.cookie });
  expect(list.status).toBe(401);
});

it("rejects unverified MFA sessions before organization switching", async () => {
  await testPool().query("UPDATE users SET mfa_enabled=true WHERE email=$1",[actors.operator.email]);
  try {
    const request=new Request(ORIGIN,{headers:{cookie:actors.operator.cookie}});
    await expect(switchSessionOrganization(request,organizationId)).rejects.toMatchObject({
      status:401,code:"UNAUTHENTICATED",
    });
    const result=await call(context.POST,{method:"POST",cookie:actors.operator.cookie,body:{organizationId}});
    expect(result.status).toBe(401);
  } finally {
    await testPool().query("UPDATE users SET mfa_enabled=false WHERE email=$1",[actors.operator.email]);
  }
});
