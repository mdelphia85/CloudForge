import nextEnv from "@next/env";
import pg from "pg";

nextEnv.loadEnvConfig(process.cwd());
const userId = process.argv[2];
if (process.argv.length !== 3 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(userId ?? "")) {
  throw new Error("Provide exactly one existing user UUID.");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be configured.");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const user = await client.query("SELECT id FROM users WHERE id = $1 AND is_active FOR UPDATE", [userId]);
  if (!user.rowCount) throw new Error("The selected active user does not exist.");
  await client.query("INSERT INTO platform_owners (user_id) VALUES ($1)", [userId]);
  await client.query(
    "INSERT INTO platform_owner_events (user_id, database_role, action) VALUES ($1, current_user, 'granted')",
    [userId],
  );
  await client.query("COMMIT");
  console.log("Platform owner granted to the selected account.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
