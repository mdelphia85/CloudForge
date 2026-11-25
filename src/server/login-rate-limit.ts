import "server-only";
import { createHash } from "node:crypto";
import { getPool } from "@/server/db";

// 8 bad attempts in 10 minutes produce a temporary login lock.
// Hash identifiers so account emails are not stored in this table.
const MAX_FAILURES = 8;
const WINDOW_MINUTES = 10;

function identifierHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export async function isLoginBlocked(email: string): Promise<boolean> {
  const result = await getPool().query<{ blocked: boolean }>(
    "SELECT COALESCE(blocked_until > now(), false) AS blocked " +
    "FROM auth_login_attempts WHERE identifier_hash = $1",
    [identifierHash(email)],
  );
  return result.rows[0]?.blocked === true;
}

export async function recordFailedLogin(email: string): Promise<boolean> {
  const restart = "auth_login_attempts.window_started_at < now() - ($2 * interval '1 minute') " +
    "OR (auth_login_attempts.blocked_until IS NOT NULL AND auth_login_attempts.blocked_until <= now())";
  const sql = "INSERT INTO auth_login_attempts " +
    "(identifier_hash, attempts, window_started_at, blocked_until, updated_at) " +
    "VALUES ($1, 1, now(), null, now()) " +
    "ON CONFLICT (identifier_hash) DO UPDATE SET " +
    "attempts = CASE WHEN " + restart +
    " THEN 1 ELSE LEAST(auth_login_attempts.attempts + 1, $3) END, " +
    "window_started_at = CASE WHEN " + restart +
    " THEN now() ELSE auth_login_attempts.window_started_at END, " +
    "blocked_until = CASE WHEN " + restart +
    " THEN null WHEN auth_login_attempts.attempts + 1 >= $3 " +
    "THEN now() + ($2 * interval '1 minute') " +
    "ELSE auth_login_attempts.blocked_until END, " +
    "updated_at = now() " +
    "RETURNING COALESCE(blocked_until > now(), false) AS blocked";
  const result = await getPool().query<{ blocked: boolean }>(
    sql,
    [identifierHash(email), WINDOW_MINUTES, MAX_FAILURES],
  );
  return result.rows[0]?.blocked === true;
}

export async function clearLoginFailures(email: string): Promise<void> {
  await getPool().query(
    "DELETE FROM auth_login_attempts WHERE identifier_hash = $1",
    [identifierHash(email)],
  );
}
