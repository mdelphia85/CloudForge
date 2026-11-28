import { afterAll, beforeAll, expect, it } from "vitest";
import {
  call, closeDatabases, loadHandlers, ORIGIN, resetDatabase, seedActors, testPool,
  type Actors, type Handlers,
} from "./harness";
import * as resources from "@/app/api/operations/[resource]/route";
import * as upload from "@/app/api/engineering/uploads/route";
import * as revisions from "@/app/api/engineering/documents/[id]/revisions/route";
import * as revision from "@/app/api/engineering/revisions/[id]/route";

let h: Handlers;
let actors: Actors;
let projectId: string;
let assetId: string;
let serviceId: string;
const bytes = new Uint8Array([0, 255, 1, 20, 10, 0, 42, 99]);

const resource = (name: string, body: Record<string, unknown>, cookie: string) =>
  call((request) => resources.POST(request, { params: Promise.resolve({ resource: name }) }), {
    method: "POST", cookie, body,
  });

async function directUpload(
  kind: string, cookie: string,
  options: { projectId?: string | null; assetId?: string | null; fileName?: string; fileBytes?: Uint8Array } = {},
) {
  const form = new FormData();
  form.set("kind", kind);
  form.set("title", "Sanding Robot " + kind + " engineering file");
  form.set("notes", "Initial engineering draft");
  if (options.projectId !== null) form.set("projectId", options.projectId ?? projectId);
  if (options.assetId !== null) form.set("assetId", options.assetId ?? assetId);
  form.set("file", new File([options.fileBytes ?? bytes], options.fileName ?? "native-project.bin"));
  return upload.POST(new Request(ORIGIN + "/api/engineering/uploads", {
    method: "POST", headers: { origin: ORIGIN, cookie }, body: form,
  }));
}

beforeAll(async () => {
  await resetDatabase();
  h = await loadHandlers();
  actors = await seedActors(h);
  const project = await resource("projects", {
    code: "SAND-ROBOT", name: "Sanding Robot", customer: "Example manufacturer",
  }, actors.admin.cookie);
  expect(project.status).toBe(201);
  projectId = String(project.body.id);

  const equipment = await resource("assets", {
    project_id: projectId, asset_tag: "TEST-SAND-001", name: "Sanding Robot",
    customer_site: "Example manufacturer site", plc_make: "Test Vendor",
  }, actors.operator.cookie);
  expect(equipment.status).toBe(201);
  assetId = String(equipment.body.id);

  const viewerId = (await testPool().query<{ id: string }>("SELECT id FROM users WHERE email=$1", [
    actors.viewer.email,
  ])).rows[0].id;
  const service = await resource("service", {
    project_id: projectId, asset_id: assetId, title: "Commission robot", assigned_to: viewerId,
  }, actors.admin.cookie);
  expect(service.status).toBe(201);
  serviceId = String(service.body.id);
});
afterAll(closeDatabases);

it.each([
  ["plc", "controller.acd"],
  ["hmi", "operator-interface.mer"],
  ["electrical_schematic", "control-panel.dwg"],
  ["mechanical_schematic", "assembly.sldasm"],
])("uploads original %s file as atomic document and revision", async (kind, fileName) => {
  const response = await directUpload(kind, actors.operator.cookie, { fileName });
  expect(response.status).toBe(201);
  const data = await response.json();
  expect(data).toMatchObject({ kind, revision: 1, status: "draft" });

  const persisted = await testPool().query<{
    kind: string; status: string; revision: number; file_data: Buffer; file_name: string;
    project_id: string; asset_id: string;
  }>(
    "SELECT d.kind,d.project_id,d.asset_id,r.status,r.revision,r.file_data,r.file_name " +
      "FROM engineering_documents d JOIN engineering_revisions r ON r.document_id=d.id WHERE d.id=$1",
    [data.documentId],
  );
  expect(persisted.rows).toHaveLength(1);
  expect(persisted.rows[0]).toMatchObject({
    kind, project_id: projectId, asset_id: assetId, revision: 1, status: "draft", file_name: fileName,
  });
  expect(Array.from(persisted.rows[0].file_data)).toEqual(Array.from(bytes));

  const list = await revisions.GET(new Request(ORIGIN, { headers: { cookie: actors.admin.cookie } }), {
    params: Promise.resolve({ id: data.documentId }),
  });
  expect(list.status).toBe(200);
  const shown = await list.json();
  expect(shown.revisions).toHaveLength(1);

  const approve = await revision.PATCH(new Request(ORIGIN, {
    method: "PATCH", headers: { origin: ORIGIN, cookie: actors.admin.cookie },
  }), { params: Promise.resolve({ id: data.revisionId }) });
  expect(approve.status).toBe(200);

  const downloaded = await revision.GET(new Request(ORIGIN, {
    headers: { cookie: actors.viewer.cookie },
  }), { params: Promise.resolve({ id: data.revisionId }) });
  expect(downloaded.status).toBe(200);
  expect(Array.from(new Uint8Array(await downloaded.arrayBuffer()))).toEqual(Array.from(bytes));

  const actions = await testPool().query<{ action: string }>(
    "SELECT action FROM audit_events WHERE entity_id=$1", [data.documentId],
  );
  expect(actions.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
    "engineering.document_created", "engineering.revision_uploaded", "engineering.revision_approved",
    "engineering.revision_download",
  ]));
});

it("allows project-only schematic uploads without an equipment record", async () => {
  const response = await directUpload("electrical_schematic", actors.operator.cookie, { assetId: null });
  expect(response.status).toBe(201);
  const body = await response.json();
  const row = await testPool().query("SELECT asset_id, project_id FROM engineering_documents WHERE id=$1", [body.documentId]);
  expect(row.rows[0]).toMatchObject({ asset_id: null, project_id: projectId });
});

it("prevents viewer uploads and invalid file types without creating orphan records", async () => {
  const before = await testPool().query<{ count: number }>("SELECT COUNT(*)::int AS count FROM engineering_documents");
  expect((await directUpload("plc", actors.viewer.cookie)).status).toBe(403);
  expect((await directUpload("plc", actors.operator.cookie, { fileName: "installer.exe" })).status).toBe(415);
  expect((await directUpload("not_a_type", actors.operator.cookie)).status).toBe(400);
  expect((await directUpload("plc", actors.operator.cookie, { projectId: null, assetId: null })).status).toBe(400);
  const after = await testPool().query<{ count: number }>("SELECT COUNT(*)::int AS count FROM engineering_documents");
  expect(after.rows[0].count).toBe(before.rows[0].count);
});

it("rejects mismatched equipment and project references without partial document creation", async () => {
  const another = await resource("projects", {
    code: "OTHER-PROJECT", name: "Other Project", customer: "Other manufacturer",
  }, actors.admin.cookie);
  expect(another.status).toBe(201);
  const before = await testPool().query<{ count: number }>("SELECT COUNT(*)::int AS count FROM engineering_documents");
  const response = await directUpload("mechanical_schematic", actors.operator.cookie, {
    projectId: String(another.body.id), assetId,
  });
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.code).toBe("PROJECT_EQUIPMENT_MISMATCH");
  const after = await testPool().query<{ count: number }>("SELECT COUNT(*)::int AS count FROM engineering_documents");
  expect(after.rows[0].count).toBe(before.rows[0].count);
});

it("keeps technician release access tied to assigned open service work", async () => {
  expect(serviceId).toMatch(/^[a-f0-9-]{36}$/i);
  const created = await directUpload("hmi", actors.admin.cookie);
  expect(created.status).toBe(201);
  const data = await created.json();
  const unapproved = await revision.GET(new Request(ORIGIN, { headers: { cookie: actors.viewer.cookie } }), {
    params: Promise.resolve({ id: data.revisionId }),
  });
  expect(unapproved.status).toBe(403);
});
