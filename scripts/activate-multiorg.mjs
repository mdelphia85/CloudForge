import nextEnv from "@next/env";
import pg from "pg";

nextEnv.loadEnvConfig(process.cwd());
const mode=process.argv[2] ?? "--audit";
if (process.argv.length>3 || !["--audit","--apply"].includes(mode)) {
  throw new Error("Usage: node scripts/activate-multiorg.mjs [--audit|--apply]");
}
const connectionString=process.env.DATABASE_URL;
if (!connectionString) throw new Error("An authorized schema-owner DATABASE_URL is required.");
const applicationRole=process.env.CLOUDFORGE_APP_DATABASE_ROLE ?? "cloudforge_app";
if (!/^[a-z_][a-z0-9_]{1,62}$/.test(applicationRole)) {
  throw new Error("Invalid application database role.");
}
if (mode==="--apply") {
  if (process.env.CLOUDFORGE_ACTIVATION_APPROVAL !== "AUTHORIZE_MULTI_ORGANIZATION_ISOLATION") {
    throw new Error("Explicit commercial activation approval is required.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    process.env.CLOUDFORGE_ACTIVATION_APPROVER_ID ?? "",
  )) {
    throw new Error("An explicitly provisioned platform-owner UUID must approve activation.");
  }
}

const exclusions=new Set([
  "sessions","audit_events","organization_memberships",
  "organization_licenses","organization_license_events",
  "organization_invitations",
  "industrial_gateways","gateway_allowed_tags","gateway_telemetry_batches",
]);
const expectedMigrations=[
  "012_organization_foundation.sql","013_engineering_direct_uploads.sql",
  "014_session_organization_binding.sql","015_cross_organization_references.sql",
  "016_tenant_row_security.sql","017_organization_business_keys.sql",
  "018_explicit_memberships_and_invitations.sql",
  "019_inventory_auto_reorder.sql",
];
const pool=new pg.Pool({connectionString,max:1});
const client=await pool.connect();
let inTransaction=false;

async function preflight() {
  const applied=await client.query(
    "SELECT name FROM schema_migrations WHERE name=ANY($1::text[])",
    [expectedMigrations],
  );
  const names=new Set(applied.rows.map(row=>row.name));
  for(const name of expectedMigrations) {
    if(!names.has(name))throw new Error("Required schema migration missing: "+name);
  }
  const role=await client.query(
    "SELECT rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=$1",
    [applicationRole],
  );
  if(!role.rows[0] || role.rows[0].rolsuper || role.rows[0].rolbypassrls ||
      !role.rows[0].rolcanlogin) {
    throw new Error("Application database role must be LOGIN NOSUPERUSER NOBYPASSRLS.");
  }
  const originals=await client.query(
    "SELECT id::text AS id FROM organizations ORDER BY id LIMIT 2",
  );
  if(originals.rows.length!==1)throw new Error("Activation requires exactly one existing organization.");
  const originalOrg=originals.rows[0].id;
  const index=await client.query(
    "SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='organizations_single_installation_only'",
  );
  if(!index.rowCount)throw new Error("Singleton guard is already removed; activation state must be reconciled manually.");

  const rows=await client.query(
    `SELECT c.oid::regclass::text AS relation, c.relname AS table_name,
            c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
            EXISTS(SELECT 1 FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname
                     AND p.policyname='cloudforge_tenant_scope') AS policy
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r'
        AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid
                   AND a.attname='organization_id' AND NOT a.attisdropped)
      ORDER BY c.relname`,
  );
  const scoped=rows.rows.filter(row=>!exclusions.has(row.table_name));
  if(scoped.length<35)throw new Error("The tenant-protected table count is unexpectedly small.");
  for(const row of scoped) {
    if(!row.rls || !row.force || !row.policy) {
      throw new Error("Missing FORCE RLS tenant policy: "+row.relation);
    }
  }
  // The public schema is controlled by migration scripts. Existing rows must
  // belong to the one original organization; do not reassign data here.
  for(const row of rows.rows) {
    // pg_catalog::regclass provides an identifier-safe table reference.
    const result=await client.query(
      `SELECT EXISTS(SELECT 1 FROM ${row.relation} WHERE organization_id IS DISTINCT FROM $1::uuid) AS mismatched`,
      [originalOrg],
    );
    if(result.rows[0].mismatched) {
      throw new Error("Historical organization mismatch in "+row.relation);
    }
  }
  if(mode==="--apply") {
    const owner=await client.query(
      "SELECT 1 FROM platform_owners p JOIN users u ON u.id=p.user_id " +
        "WHERE p.user_id=$1 AND u.is_active",
      [process.env.CLOUDFORGE_ACTIVATION_APPROVER_ID],
    );
    if(!owner.rowCount)throw new Error("Approving platform owner is not active.");
  }
  return {originalOrg,scoped,all:rows.rows};
}

try {
  await client.query("BEGIN");
  inTransaction=true;
  await client.query("SELECT pg_advisory_xact_lock(208451190)");
  await client.query("LOCK TABLE organizations IN ACCESS EXCLUSIVE MODE");
  const state=await preflight();

  if(mode==="--audit") {
    console.log("Multi-organization activation preflight passed.");
    console.log("Tenant-protected tables:",state.scoped.length);
    console.log("Existing organization records preserved; singleton guard remains ACTIVE.");
    await client.query("ROLLBACK");
    inTransaction=false;
  } else {
    // This is a privileged, explicit release operation. Automatic migrations
    // and routine deployment MUST NEVER remove the singleton index.
    await client.query(`
      CREATE OR REPLACE FUNCTION cloudforge_current_org() RETURNS uuid
      LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
        SELECT NULLIF(current_setting('cloudforge.organization_id',true),'')::uuid
      $$`);

    for(const row of state.scoped) {
      // Regclass-qualified names originated from pg_catalog, not user input.
      await client.query(
        "ALTER TABLE "+row.relation+
        " ALTER COLUMN organization_id SET DEFAULT cloudforge_current_org()",
      );
    }
    for(const name of ["industrial_gateways","gateway_allowed_tags","gateway_telemetry_batches"]) {
      await client.query(
        "ALTER TABLE "+name+
        " ALTER COLUMN organization_id SET DEFAULT cloudforge_current_org()",
      );
    }
    // Anonymous platform-auth events have no tenant; user-originated audit
    // records use request-scoped GUC or an explicit organization_id.
    await client.query("ALTER TABLE audit_events ALTER COLUMN organization_id DROP NOT NULL");
    await client.query(
      "ALTER TABLE audit_events ALTER COLUMN organization_id SET DEFAULT cloudforge_current_org()",
    );
    await client.query("ALTER TABLE sessions ALTER COLUMN organization_id DROP DEFAULT");
    await client.query(`
      CREATE TABLE platform_commercial_activations(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        activated_at timestamptz NOT NULL DEFAULT now(),
        approved_by uuid NOT NULL REFERENCES platform_owners(user_id) ON DELETE RESTRICT,
        original_organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        protected_tables integer NOT NULL CHECK (protected_tables >= 35)
      )`);
    await client.query(`
      CREATE TRIGGER commercial_activation_append_only BEFORE UPDATE OR DELETE
      ON platform_commercial_activations FOR EACH ROW EXECUTE FUNCTION reject_event_mutation()`);
    await client.query(`
      CREATE TRIGGER commercial_activation_no_truncate BEFORE TRUNCATE
      ON platform_commercial_activations FOR EACH STATEMENT EXECUTE FUNCTION reject_event_mutation()`);
    await client.query(
      "INSERT INTO platform_commercial_activations(approved_by,original_organization_id,protected_tables) " +
        "VALUES($1,$2,$3)",
      [process.env.CLOUDFORGE_ACTIVATION_APPROVER_ID,state.originalOrg,state.scoped.length],
    );
    // Only now permit multiple organizations.
    await client.query("DROP INDEX organizations_single_installation_only");
    await client.query("COMMIT");
    inTransaction=false;
    console.log("Multi-organization database activation recorded.");
    console.log("Deploy with MULTI_ORGANIZATION and LICENSE_ENFORCEMENT gates enabled.");
  }
} catch(error) {
  if(inTransaction) {
    try{await client.query("ROLLBACK");}catch{ /* original error retained */ }
  }
  throw error;
} finally {
  client.release();
  await pool.end();
}
