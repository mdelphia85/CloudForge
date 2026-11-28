import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { call, closeDatabases, loadHandlers, resetDatabase, STRONG_PASSWORD, TEST_BOOTSTRAP_TOKEN, testPool, type Handlers } from "./harness";
import * as licenses from "@/app/api/platform/licenses/route";
import * as organizations from "@/app/api/platform/organizations/route";

let handlers: Handlers;
beforeAll(async () => { await resetDatabase(); handlers = await loadHandlers(); });
afterAll(closeDatabases);

it("restricts offline license installation to explicitly provisioned platform owners", async () => {
  const admin = await call(handlers.bootstrap.POST, {
    method: "POST",
    body: { bootstrapToken: TEST_BOOTSTRAP_TOKEN, email: "owner@example.test", displayName: "Owner", password: STRONG_PASSWORD },
  });
  expect(admin.status).toBe(201);
  const organizationId = (await testPool().query("SELECT id FROM organizations")).rows[0].id as string;
  const keys = generateKeyPairSync("ed25519");
  vi.stubEnv("LICENSE_PUBLIC_KEY", keys.publicKey.export({ type: "spki", format: "pem" }).toString());
  const claims = {
    version: 1, licenseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", organizationId,
    licenseType: "air_gapped", tier: "standard", seatLimit: 10, modules: ["inventory", "engineering"],
    issuedAt: "2026-01-01T00:00:00.000Z", activatedAt: "2026-01-02T00:00:00.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  const signed = (value: object) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return { payload: bytes.toString("base64url"), signature: sign(null, bytes, keys.privateKey).toString("base64url") };
  };
  const install = (value: object, cookie = admin.sessionCookie) => call(licenses.POST, {
    method: "POST", cookie, body: { organizationId, ...signed(value) },
  });
  try {
    expect((await install(claims)).status).toBe(403);
    expect((await call(organizations.GET, { cookie: admin.sessionCookie })).status).toBe(403);
    expect((await call(organizations.GET)).status).toBe(401);
    const provision = spawnSync(process.execPath, ["scripts/grant-platform-owner.mjs", admin.body.user.id], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "test" }, encoding: "utf8",
    });
    expect(provision.status, provision.stderr).toBe(0);
    expect((await call(organizations.GET, { cookie: admin.sessionCookie })).body.organizations)
      .toEqual([expect.objectContaining({ id: organizationId, identifier: "existing-installation" })]);
    const mismatch = await install({ ...claims, organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    expect(mismatch.status).toBe(400);
    const forged = signed(claims);
    expect((await call(licenses.POST, {
      method: "POST", cookie: admin.sessionCookie,
      body: { organizationId, payload: forged.payload, signature: Buffer.alloc(64).toString("base64url") },
    })).status).toBe(400);
    expect((await install(claims)).status).toBe(201);
    expect((await install(claims)).status).toBe(200);
    expect((await install({ ...claims, licenseId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })).status).toBe(409);
    const read = await call(licenses.GET, { cookie: admin.sessionCookie, path: `/api/platform/licenses?organizationId=${organizationId}` });
    expect(read.status).toBe(200);
    expect(read.body.license).toMatchObject({ claims, timeStatus: "active" });
    expect((await testPool().query("SELECT action,actor_user_id FROM organization_license_events")).rows)
      .toEqual([{ action: "installed", actor_user_id: admin.body.user.id }]);
    expect((await testPool().query("SELECT action FROM platform_owner_events")).rows).toEqual([{ action: "granted" }]);
  } finally {
    vi.unstubAllEnvs();
  }
});
