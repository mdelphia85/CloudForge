import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import nextEnv from "@next/env";
import pg from "pg";

nextEnv.loadEnvConfig(process.cwd());
const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL must be set before running migrations.");
}

const pool = new Pool({ connectionString });
const lockClient = await pool.connect();
try {
  await lockClient.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await lockClient.query("SELECT pg_advisory_lock(208451190)");

  const directory = join(process.cwd(), "migrations");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) {
    const alreadyApplied = await lockClient.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
    if (alreadyApplied.rowCount) continue;

    const sql = await readFile(join(directory, name), "utf8");
    try {
      await lockClient.query("BEGIN");
      await lockClient.query(sql);
      await lockClient.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await lockClient.query("COMMIT");
      console.log(`Applied ${name}`);
    } catch (error) {
      try {
        await lockClient.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Migration rollback failed.", rollbackError);
      }
      throw error;
    }
  }
} finally {
  try {
    await lockClient.query("SELECT pg_advisory_unlock(208451190)");
  } finally {
    lockClient.release();
    await pool.end();
  }
}
