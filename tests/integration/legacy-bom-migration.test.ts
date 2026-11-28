import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  call, closeDatabases, hashToken, runMigrations, testPool,
} from "./harness";
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

    const users = await testPool().query<{ id: string; role: string }>(
      "INSERT INTO users(email,display_name,password_hash,role) VALUES " +
      "('migration-admin@example.test','Migration admin','unused','admin')," +
      "('migration-operator@example.test','Migration operator','unused','operator') RETURNING id,role",
    );
    const adminId = users.rows.find((row) => row.role === "admin")!.id;
    const operatorId = users.rows.find((row) => row.role === "operator")!.id;
    const adminToken = "a".repeat(43);
    const operatorToken = "b".repeat(43);
    const actors = {
      admin: { id: adminId, cookie: `cloudforge_session=${adminToken}` },
      operator: { cookie: `cloudforge_session=${operatorToken}` },
    };
    await testPool().query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES " +
      "($1,$2,now()+interval '1 hour'),($3,$4,now()+interval '1 hour')",
      [hashToken(adminToken), adminId, hashToken(operatorToken), operatorId],
    );
    const project = await testPool().query<{ id: string }>(
      "INSERT INTO projects(code,name,customer,created_by) VALUES($1,$2,$3,$4) RETURNING id",
      ["MIG-BOM-001", "Migration BOM project", "Example Works", adminId],
    );
    const item = await testPool().query<{ id: string }>(
      "INSERT INTO inventory_items(sku,name,category,unit,reorder_point,created_by) VALUES($1,$2,$3,$4,0,$5) RETURNING id",
      ["MIG-BOM-ITEM", "Legacy control module", "Controls", "ea", adminId],
    );
    const projectId = project.rows[0].id;
    await testPool().query(
      "INSERT INTO engineering_bom_lines(project_id,item_id,required_qty,revision,added_by,created_at) " +
        "VALUES($1,$2,2,'A',$3,now()-interval '2 days'),($1,$2,3,'B',$3,now()-interval '1 day')",
      [projectId, item.rows[0].id, operatorId],
    );

    await applyMigrationsThrough("004_phase3_manufacturing_change_control.sql");
    const imported = await testPool().query(
      "SELECT id,revision_code,status,approved_by,approved_at,change_notes " +
        "FROM engineering_bom_revisions WHERE project_id=$1 ORDER BY revision_code",
      [projectId],
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
      [legacyId, operatorId],
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
      path: `/api/operations/material-shortages?projectId=${projectId}`,
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
      path: `/api/operations/material-shortages?projectId=${projectId}`,
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

  it("preserves historical records and memberships while preventing a second organization", async () => {
    await applyMigrationsThrough("011_phase5_alarm_source_state.sql", true);
    const user = await testPool().query<{ id: string }>(
      "INSERT INTO users(email,display_name,password_hash,role) VALUES('legacy@example.test','Legacy admin','unused','admin') RETURNING id",
    );
    const userId = user.rows[0].id;
    await testPool().query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", ["c".repeat(64), userId]);
    const item = await testPool().query<{ id: string }>(
      "INSERT INTO inventory_items(sku,name,category,unit,reorder_point,created_by) VALUES('LEGACY-1','Controller','Controls','ea',0,$1) RETURNING id",
      [userId],
    );
    const project = await testPool().query<{ id: string }>(
      "INSERT INTO projects(code,name,customer,created_by) VALUES('LEGACY','Legacy project','Example',$1) RETURNING id",
      [userId],
    );
    const asset = await testPool().query<{ id: string }>(
      "INSERT INTO engineering_assets(project_id,asset_tag,name,customer_site,created_by) VALUES($1,'LEGACY-ASSET','Legacy machine','Site',$2) RETURNING id",
      [project.rows[0].id, userId],
    );
    const document = await testPool().query<{ id: string }>(
      "INSERT INTO engineering_documents(project_id,asset_id,title,kind,created_by) VALUES($1,$2,'Legacy PLC','plc',$3) RETURNING id",
      [project.rows[0].id, asset.rows[0].id, userId],
    );
    const revision = await testPool().query<{ id: string }>(
      "INSERT INTO engineering_revisions(document_id,revision,file_name,content_type,byte_size,sha256,file_data,status,uploaded_by,approved_by,approved_at) " +
      "VALUES($1,1,'legacy.bin','application/octet-stream',3,$2,$3,'approved',$4,$4,now()) RETURNING id",
      [document.rows[0].id, "d".repeat(64), Buffer.from("plc"), userId],
    );
    const service = await testPool().query<{ id: string }>(
      "INSERT INTO field_service_jobs(project_id,asset_id,title,assigned_to,created_by) VALUES($1,$2,'Legacy service',$3,$3) RETURNING id",
      [project.rows[0].id, asset.rows[0].id, userId],
    );
    await testPool().query(
      "INSERT INTO field_program_installs(service_job_id,revision_id,result,performed_by) VALUES($1,$2,'installed',$3)",
      [service.rows[0].id, revision.rows[0].id, userId],
    );
    await testPool().query(
      "INSERT INTO inventory_movements(item_id,movement_type,quantity_delta,actor_user_id,idempotency_key) VALUES($1,'opening',2,$2,'legacy-movement')",
      [item.rows[0].id, userId],
    );
    await testPool().query(
      "INSERT INTO audit_events(actor_user_id,action,entity_type,entity_id) VALUES($1,'legacy.event','user',$1)",
      [userId],
    );
    const tables = ["sessions", "inventory_items", "inventory_movements", "audit_events", "projects",
      "engineering_assets", "engineering_documents", "engineering_revisions", "field_service_jobs", "field_program_installs"];
    const snapshots = await Promise.all(tables.map(async (table) =>
      (await testPool().query(`SELECT to_jsonb(t) AS data FROM ${table} t ORDER BY 1`)).rows,
    ));

    const migrated = runMigrations();
    expect(migrated.status, migrated.output).toBe(0);
    const organization = (await testPool().query("SELECT id FROM organizations WHERE identifier='existing-installation'")).rows[0].id;
    for (const [index, table] of tables.entries()) {
      // New inventory columns are intentionally additive; compare all original
      // business fields and separately assert the safe default-off policy.
      const newInventoryColumns = table === "inventory_items"
        ? " - 'auto_reorder_enabled' - 'auto_reorder_quantity'"
        : table === "sessions" ? " - 'mfa_verified'" : "";
      const rows = await testPool().query(
        `SELECT to_jsonb(t) - 'organization_id'${newInventoryColumns} AS data, organization_id FROM ${table} t ORDER BY 1`,
      );
      expect(rows.rows.map((row) => ({ data: row.data }))).toEqual(snapshots[index]);
      expect(rows.rows.every((row) => row.organization_id === organization)).toBe(true);
    }
    const policy = await testPool().query(
      "SELECT auto_reorder_enabled, auto_reorder_quantity::text FROM inventory_items WHERE sku='LEGACY-1'",
    );
    expect(policy.rows).toMatchObject([
      {auto_reorder_enabled:false,auto_reorder_quantity:"0.000"},
    ]);
    expect((await testPool().query("SELECT user_id,role FROM organization_memberships")).rows).toEqual([{ user_id: userId, role: "admin" }]);
    await expect(testPool().query("INSERT INTO organizations(identifier,name) VALUES('another','Another organization')"))
      .rejects.toMatchObject({ code: "23505" });
    const newUser = await testPool().query<{ id: string }>(
      "INSERT INTO users(email,display_name,password_hash,role) VALUES('new@example.test','New user','unused','viewer') RETURNING id",
    );
    // Commercial invitations must explicitly grant membership. Raw account creation
    // must never automatically add a user to another customer's organization.
    expect((await testPool().query(
      "SELECT 1 FROM organization_memberships WHERE user_id=$1", [newUser.rows[0].id],
    )).rows).toEqual([]);
  });
});
