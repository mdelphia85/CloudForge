import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertSafeTestDatabaseUrl } from "./database-guard";
import { closeDatabases, loadHandlers, resetDatabase, seedActors, testPool } from "./harness";

const root=fileURLToPath(new URL("../../",import.meta.url));
let approver="";
const run=(args:string[],env:Record<string,string>={})=>{
  // This guard rules out hosted, production or non-test database names.
  const safe=assertSafeTestDatabaseUrl({...process.env,DATABASE_URL:undefined});
  const out=spawnSync(process.execPath,["scripts/activate-multiorg.mjs",...args],{
    cwd:root,encoding:"utf8",timeout:30_000,
    env:{
      ...process.env,NODE_ENV:"test",DATABASE_URL:safe,
      CLOUDFORGE_APP_DATABASE_ROLE:"cloudforge_app",
      CLOUDFORGE_ACTIVATION_APPROVAL:"",
      CLOUDFORGE_ACTIVATION_APPROVER_ID:"",
      ...env,
    },
  });
  return {code:out.status,logs:`${out.stdout??""}\n${out.stderr??""}`};
};

beforeAll(async()=>{
  await resetDatabase();
  const actors=await seedActors(await loadHandlers());
  approver=actors.admin.id;
  await testPool().query("INSERT INTO platform_owners(user_id) VALUES($1)",[approver]);
  await testPool().query(`DO $$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cloudforge_app') THEN
        CREATE ROLE cloudforge_app LOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$`);
  await testPool().query("ALTER ROLE cloudforge_app LOGIN NOSUPERUSER NOBYPASSRLS");
});
afterAll(closeDatabases);

it("audit-only preflight preserves singleton and all existing customer data",async()=>{
  const original=await testPool().query("SELECT id FROM organizations WHERE identifier='existing-installation'");
  const result=run(["--audit"]);
  expect(result.code,result.logs).toBe(0);
  expect(result.logs).toContain("preflight passed");
  expect((await testPool().query("SELECT id FROM organizations")).rows).toEqual(original.rows);
  const guard=await testPool().query(
    "SELECT 1 FROM pg_indexes WHERE indexname='organizations_single_installation_only'",
  );
  expect(guard.rowCount).toBe(1);
});

it("explicit apply is denied without approved platform-owner identity",async()=>{
  const denied=run(["--apply"]);
  expect(denied.code).not.toBe(0);
  expect(denied.logs).toMatch(/approval/i);
  expect((await testPool().query(
    "SELECT 1 FROM pg_indexes WHERE indexname='organizations_single_installation_only'",
  )).rowCount).toBe(1);
});

it("transactionally applies activation, dynamic tenant defaults and an immutable audit record only on disposable database",async()=>{
  const result=run(["--apply"],{
    CLOUDFORGE_ACTIVATION_APPROVAL:"AUTHORIZE_MULTI_ORGANIZATION_ISOLATION",
    CLOUDFORGE_ACTIVATION_APPROVER_ID:approver,
  });
  expect(result.code,result.logs).toBe(0);
  const table=await testPool().query<{count:number}>(
    "SELECT COUNT(*)::int AS count FROM platform_commercial_activations",
  );
  expect(table.rows[0].count).toBe(1);
  expect((await testPool().query(
    "SELECT 1 FROM pg_indexes WHERE indexname='organizations_single_installation_only'",
  )).rowCount).toBe(0);
  const def=await testPool().query<{expression:string}>(
    `SELECT pg_get_expr(d.adbin,d.adrelid) AS expression
       FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
      WHERE d.adrelid='public.inventory_items'::regclass AND a.attname='organization_id'`,
  );
  expect(def.rows[0].expression).toContain("cloudforge_current_org()");
  const second=await testPool().query<{id:string}>(
    "INSERT INTO organizations(identifier,name,status,deployment_type) " +
      "VALUES('onboard-test-only','Onboard Test Only','active','saas') RETURNING id",
  );
  expect(second.rows).toHaveLength(1);
  await expect(testPool().query("DELETE FROM platform_commercial_activations")).rejects.toThrow();
  // The activation script intentionally cannot be run twice.
  const duplicate=run(["--apply"],{
    CLOUDFORGE_ACTIVATION_APPROVAL:"AUTHORIZE_MULTI_ORGANIZATION_ISOLATION",
    CLOUDFORGE_ACTIVATION_APPROVER_ID:approver,
  });
  expect(duplicate.code).not.toBe(0);
});
