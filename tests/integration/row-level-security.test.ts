import { afterAll, beforeAll, expect, it } from "vitest";
import { closeDatabases, loadHandlers, resetDatabase, seedActors, testPool } from "./harness";

let organizationA = "";
let organizationB = "";

beforeAll(async () => {
  await resetDatabase();
  const actors = await seedActors(await loadHandlers());
  organizationA = (await testPool().query<{ id: string }>(
    "SELECT id FROM organizations WHERE identifier='existing-installation'",
  )).rows[0].id;
  // Disposable test DB only; the production singleton remains intact.
  await testPool().query("DROP INDEX organizations_single_installation_only");
  organizationB = (await testPool().query<{ id: string }>(
    "INSERT INTO organizations(identifier,name) VALUES('rls-other-company','Other company') RETURNING id",
  )).rows[0].id;
  for (const [org, sku] of [[organizationA, "RLS-A"], [organizationB, "RLS-B"]]) {
    await testPool().query(
      `INSERT INTO inventory_items(organization_id,sku,name,category,unit,reorder_point,created_by)
       VALUES($1,$2,'RLS boundary test','Test','ea',0,$3)`,
      [org,sku,actors.admin.id],
    );
  }

  await testPool().query(`DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cloudforge_rls_test') THEN
      CREATE ROLE cloudforge_rls_test NOSUPERUSER NOBYPASSRLS NOLOGIN;
    END IF;
  END $$`);
  await testPool().query("GRANT USAGE ON SCHEMA public TO cloudforge_rls_test");
  await testPool().query("GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA public TO cloudforge_rls_test");
});
afterAll(closeDatabases);

it("enforces organization RLS through a real non-superuser role and never leaks across pooled transactions", async () => {
  const client = await testPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE cloudforge_rls_test");
    const noTenant = await client.query<{ sku: string }>("SELECT sku FROM inventory_items ORDER BY sku");
    expect(noTenant.rows).toEqual([]);

    await client.query("SELECT set_config('cloudforge.organization_id',$1,true)", [organizationA]);
    const first = await client.query<{ sku: string }>("SELECT sku FROM inventory_items ORDER BY sku");
    expect(first.rows.map(row => row.sku)).toEqual(["RLS-A"]);

    await client.query("SELECT set_config('cloudforge.organization_id',$1,true)", [organizationB]);
    const second = await client.query<{ sku: string }>("SELECT sku FROM inventory_items ORDER BY sku");
    expect(second.rows.map(row => row.sku)).toEqual(["RLS-B"]);

    await client.query("SAVEPOINT tenant_write");
    await expect(client.query(
      `INSERT INTO inventory_items(organization_id,sku,name,category,unit,reorder_point,created_by)
       VALUES($1,'RLS-INJECT','Cross-company row','Test','ea',0,
         (SELECT id FROM users WHERE email='admin@example.test'))`,
      [organizationA],
    )).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT tenant_write");
    await client.query("COMMIT");

    // A fresh transaction on the same database connection must have no tenant GUC.
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE cloudforge_rls_test");
    const reset = await client.query("SELECT sku FROM inventory_items ORDER BY sku");
    expect(reset.rows).toEqual([]);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});
