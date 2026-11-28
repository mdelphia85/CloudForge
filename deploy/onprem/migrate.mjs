import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import pg from "pg";

function secret(path, label) {
  if (!path) throw new Error(label + " file path is required.");
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(label + " file is empty.");
  return value;
}

const host = process.env.DB_HOST ?? "postgres";
const database = process.env.DB_NAME ?? "cloudforge";
const admin = process.env.DB_ADMIN_USER ?? "cloudforge_admin";
const appUser = process.env.DB_APP_USER ?? "cloudforge_app";
for (const [name, value] of [["database host",host],["database name",database],["administrator",admin],["application role",appUser]]) {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(value)) throw new Error("Invalid "+name);
}
const adminPassword = secret(process.env.DB_ADMIN_PASSWORD_FILE, "Database administrator password");
const appPassword = secret(process.env.DB_APP_PASSWORD_FILE, "Application password");
if (adminPassword.length < 24 || appPassword.length < 24 || adminPassword === appPassword) {
  throw new Error("Separate, strong database administrator and application credentials are required.");
}
const adminUrl = `postgresql://${encodeURIComponent(admin)}:${encodeURIComponent(adminPassword)}@${host}:5432/${database}`;
const env = { ...process.env, DATABASE_URL: adminUrl, NODE_ENV: "production" };
const migrated = spawnSync(process.execPath, ["scripts/migrate.mjs"], { env, stdio: "inherit" });
if (migrated.error) throw migrated.error;
if (migrated.status !== 0) throw new Error("Schema migrations failed; application startup remains blocked.");

const pool = new pg.Pool({ connectionString: adminUrl, max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT set_config('cloudforge.app_role_password',$1,true)", [appPassword]);
  await client.query(`DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cloudforge_app') THEN
        EXECUTE format('CREATE ROLE cloudforge_app LOGIN PASSWORD %L',
          current_setting('cloudforge.app_role_password'));
      ELSE
        EXECUTE format('ALTER ROLE cloudforge_app LOGIN PASSWORD %L',
          current_setting('cloudforge.app_role_password'));
      END IF;
    END $$`);
  await client.query("ALTER ROLE cloudforge_app NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION");
  await client.query("GRANT CONNECT ON DATABASE cloudforge TO cloudforge_app");
  await client.query("GRANT USAGE ON SCHEMA public TO cloudforge_app");
  await client.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO cloudforge_app");
  await client.query("GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO cloudforge_app");
  await client.query(
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO cloudforge_app",
  );
  await client.query(
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO cloudforge_app",
  );
  await client.query("COMMIT");
  console.log("Database migrations completed and restricted application role configured.");
} catch (error) {
  try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
  throw error;
} finally {
  client.release();
  await pool.end();
}
