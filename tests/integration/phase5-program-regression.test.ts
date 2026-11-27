import { afterAll, beforeAll, expect, it } from "vitest";
import {
  call, closeDatabases, loadHandlers, ORIGIN, resetDatabase, seedActors, STRONG_PASSWORD, testPool,
  type Actors, type Handlers,
} from "./harness";
import * as resources from "@/app/api/operations/[resource]/route";
import * as equipment from "@/app/api/operations/equipment/route";
import * as upload from "@/app/api/engineering/documents/[id]/revisions/route";
import * as revision from "@/app/api/engineering/revisions/[id]/route";
import * as installs from "@/app/api/operations/service/[id]/installs/route";

let h: Handlers;
let actors: Actors;
let assetId: string;
let jobId: string;
let viewerId: string;
let unassignedCookie: string;

const resource = (name: string, body: Record<string, unknown>, cookie: string) =>
  call((request) => resources.POST(request, { params: Promise.resolve({ resource: name }) }), {
    method: "POST", cookie, body,
  });
const byId = (handler: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>,
  id: string, options: Parameters<typeof call>[1] = {}) =>
  call((request) => handler(request, { params: Promise.resolve({ id }) }), options);

beforeAll(async () => {
  await resetDatabase();
  h = await loadHandlers();
  actors = await seedActors(h);
  viewerId = String((await testPool().query("SELECT id FROM users WHERE email=$1", [actors.viewer.email])).rows[0].id);
  const asset = await call(equipment.POST, {
    method: "POST", cookie: actors.admin.cookie,
    body: { assetTag: "P5-PROGRAM", name: "Program test controller", customerSite: "Test plant" },
  });
  expect(asset.status).toBe(201);
  assetId = String(asset.body.id);
  const job = await resource("service", {
    asset_id: assetId, title: "Assigned commissioning visit", assigned_to: viewerId,
  }, actors.admin.cookie);
  expect(job.status).toBe(201);
  jobId = String(job.body.id);
  const created = await call(h.users.POST, {
    method: "POST", cookie: actors.admin.cookie,
    body: { email: "unassigned@example.test", displayName: "Unassigned tech", role: "viewer", password: STRONG_PASSWORD },
  });
  expect(created.status).toBe(201);
  const login = await call(h.login.POST, {
    method: "POST", body: { email: "unassigned@example.test", password: STRONG_PASSWORD },
  });
  expect(login.status).toBe(200);
  unassignedCookie = login.sessionCookie!;
});
afterAll(closeDatabases);

it.each(["plc", "hmi"])("preserves %s uploads, approval, assigned download, and onsite installation history", async (kind) => {
  const document = await resource("documents", {
    asset_id: assetId, title: `Phase 5 ${kind} program`, kind,
  }, actors.operator.cookie);
  expect(document.status).toBe(201);
  const docId = String(document.body.id);
  const uploadFile = (cookie: string) => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3, 4])], `program.${kind}`, { type: "application/octet-stream" }));
    form.set("notes", "Approved for onsite installation");
    return upload.POST(new Request(`${ORIGIN}/api/engineering/documents/${docId}/revisions`, {
      method: "POST", headers: { origin: ORIGIN, cookie }, body: form,
    }), { params: Promise.resolve({ id: docId }) });
  };
  expect((await uploadFile(actors.viewer.cookie)).status).toBe(403);
  const uploaded = await uploadFile(actors.operator.cookie);
  expect(uploaded.status).toBe(201);
  const revisionId = String((await uploaded.json()).id);
  expect((await byId(revision.PATCH, revisionId, { method: "PATCH", cookie: actors.operator.cookie })).status).toBe(403);
  expect((await byId(revision.GET, revisionId, { cookie: actors.viewer.cookie })).status).toBe(403);
  expect((await byId(revision.PATCH, revisionId, { method: "PATCH", cookie: actors.admin.cookie })).status).toBe(200);
  expect((await byId(revision.GET, revisionId, { cookie: unassignedCookie })).status).toBe(403);
  const download = await revision.GET(
    new Request(`${ORIGIN}/api/engineering/revisions/${revisionId}`, { headers: { cookie: actors.viewer.cookie } }),
    { params: Promise.resolve({ id: revisionId }) },
  );
  expect(download.status).toBe(200);
  expect(Array.from(new Uint8Array(await download.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  const body = { revisionId, result: "installed", notes: "Installed onsite with vendor software", idempotencyKey: `p5-${kind}-install` };
  expect((await byId(installs.POST, jobId, { method: "POST", cookie: unassignedCookie, body })).status).toBe(403);
  expect((await byId(installs.POST, jobId, { method: "POST", cookie: actors.viewer.cookie, body })).status).toBe(201);
  const history = await byId(installs.GET, jobId, { cookie: actors.viewer.cookie });
  expect(history.body.installs).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind, result: "installed", technician: "viewer user", revision: 1, performed_at: expect.any(String) }),
  ]));
  const persisted = await testPool().query(
    `SELECT j.asset_id,i.revision_id,i.performed_by,i.result,i.performed_at
       FROM field_program_installs i JOIN field_service_jobs j ON j.id=i.service_job_id
      WHERE i.service_job_id=$1 AND i.revision_id=$2`,
    [jobId, revisionId],
  );
  expect(persisted.rows[0]).toMatchObject({ asset_id: assetId, revision_id: revisionId, performed_by: viewerId, result: "installed" });
  expect(persisted.rows[0].performed_at).toBeInstanceOf(Date);
  const audit = await testPool().query<{ action: string }>(
    `SELECT action FROM audit_events WHERE details->>'revisionId'=$1
      AND action IN ('engineering.revision_approved','engineering.revision_download','field_service.program_install_recorded')`,
    [revisionId],
  );
  expect(audit.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
    "engineering.revision_approved", "engineering.revision_download", "field_service.program_install_recorded",
  ]));
});
