import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  call, closeDatabases, itemBody, loadHandlers, runMigrations,
  seedActors, testPool,
} from "./harness";
import * as resources from "@/app/api/operations/[resource]/route";
import * as materialShortages from "@/app/api/operations/material-shortages/route";
import * as bomStatus from "@/app/api/operations/engineering/bom-revisions/[id]/status/route";

async function applyMigrationsThrough(lastMigration: string, reset = false) {
  const pool = testPool();
  const client = await pool.connect();
  try {
    if (reset) {
      await client.query("DROP SCHEMA public CASCADE");
      await client.query("CREATE SCHEMA public");
      await client.query(
        "CREATE TABLE public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
    }
    await client.query("SET search_path TO public");
    const directory = join(process.cwd(), "migrations");
    const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    for (const name of files) {
      if (name > lastMigration) break;
      const applied = await client.query("SELECT 1 FROM public.schema_migrations WHERE name=$1", [name]);
      if (applied.rowCount) continue;
      const sql = await readFile(join(directory, name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

type RouteHandler<P extends Record<string, string>> =
  (request: Request, context: { params: Promise<P> }) => Promise<Response>;
const dynamicCall = <P extends Record<string, string>>(
  handler: RouteHandler<P>,
  params: P,
  options: Parameters<typeof call>[1] = {},
) => call((request) => handler(request, { params: Promise.resolve(params) }), options);

describe("Phase 2 BOM migration provenance", () => {
  afterAll(closeDatabases);

  it("keeps operator-authored legacy BOMs provisional until an explicit engineering approval", async () => {
    await applyMigrationsThrough("003_phase2_operations.sql", true);

    const handlers = await loadHandlers();
    const actors = await seedActors(handlers);
    const project = await call((request) => resources.POST(request, {
      params: Promise.resolve({ resource: "projects" }),
    }), {
      method: "POST",
      cookie: actors.admin.cookie,
      body: { code: "MIG-BOM-001", name: "Migration BOM project", customer: "Example Works" },
    });
    expect(project.status).toBe(201);
    const item = await call(handlers.inventory.POST, {
      method: "POST",
      cookie: actors.admin.cookie,
      body: itemBody({ sku: "MIG-BOM-ITEM", name: "Legacy control module" }),
    });
    expect(item.status).toBe(201);
    const [itemRow, operator] = await Promise.all([
      testPool().query("SELECT id FROM inventory_items WHERE sku=$1", ["MIG-BOM-ITEM"]),
      testPool().query("SELECT id FROM users WHERE email=$1", [actors.operator.email]),
    ]);
    await testPool().query(
      "INSERT INTO engineering_bom_lines(project_id,item_id,required_qty,revision,added_by,created_at) " +
        "VALUES($1,$2,2,'A',$3,now()-interval '2 days'),($1,$2,3,'B',$3,now()-interval '1 day')",
      [project.body.id, itemRow.rows[0].id, operator.rows[0].id],
    );

    await applyMigrationsThrough("004_phase3_manufacturing_change_control.sql");
    const imported = await testPool().query(
      "SELECT id,revision_code,status,approved_by,approved_at,change_notes " +
        "FROM engineering_bom_revisions WHERE project_id=$1 ORDER BY revision_code",
      [project.body.id],
    );
    expect(imported.rows).toHaveLength(2);
    expect(imported.rows[0]).toMatchObject({
      revision_code: "A", status: "superseded", approved_by: null, approved_at: null,
    });
    expect(imported.rows[1]).toMatchObject({
      revision_code: "B", status: "legacy", approved_by: null, approved_at: null,
    });

    const legacyId = imported.rows[1].id as string;
    await testPool().query(
      "UPDATE engineering_bom_revisions SET status='approved',approved_by=$2,approved_at=created_at WHERE id=$1",
      [legacyId, operator.rows[0].id],
    );
    const correctionMigration = runMigrations();
    expect(correctionMigration.status, correctionMigration.output).toBe(0);
    const corrected = await testPool().query(
      "SELECT status,approved_by,approved_at FROM engineering_bom_revisions WHERE id=$1",
      [legacyId],
    );
    expect(corrected.rows[0]).toEqual({ status: "legacy", approved_by: null, approved_at: null });

    const provisional = await call(materialShortages.GET, {
      cookie: actors.admin.cookie,
      path: `/api/operations/material-shortages?projectId=${project.body.id}`,
    });
    expect(provisional.status).toBe(200);
    expect(provisional.body.shortages).toEqual([
      expect.objectContaining({
        bomStatus: "legacy", demandStatus: "provisional", bomRevisionCode: "B", requiredQty: "3.000",
      }),
    ]);

    expect((await dynamicCall(bomStatus.POST, { id: legacyId }, {
      method: "POST", cookie: actors.operator.cookie, body: { action: "submit" },
    })).status).toBe(200);
    expect((await dynamicCall(bomStatus.POST, { id: legacyId }, {
      method: "POST", cookie: actors.admin.cookie, body: { action: "approve" },
    })).status).toBe(200);
    const approved = await call(materialShortages.GET, {
      cookie: actors.admin.cookie,
      path: `/api/operations/material-shortages?projectId=${project.body.id}`,
    });
    expect(approved.body.shortages[0]).toMatchObject({ bomStatus: "approved", demandStatus: "approved" });
    const approvalHistory = await testPool().query(
      "SELECT action,actor_user_id FROM audit_events WHERE entity_type='engineering_bom_revision' AND entity_id=$1",
      [legacyId],
    );
    expect(approvalHistory.rows).toHaveLength(2);
    expect(approvalHistory.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "engineering.bom_revision.submitted" }),
      expect.objectContaining({
        action: "engineering.bom_revision.approved", actor_user_id: actors.admin.id,
      }),
    ]));
  });
});
