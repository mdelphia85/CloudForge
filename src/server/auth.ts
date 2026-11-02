import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getPool, inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";

export type UserRole = "admin" | "operator" | "viewer";
export type AuthenticatedUser = {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
};

const SESSION_COOKIE = "cloudforge_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

export async function createSession(userId: string, token: string, action = "auth.login"): Promise<void> {
  await inTransaction(async (client) => {
    await client.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, now() + ($3 * interval '1 second'))`,
      [hashToken(token), userId, SESSION_TTL_SECONDS],
    );
    await client.query(
      `INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id)
       VALUES ($1, $2, 'user', $1)`,
      [userId, action],
    );
  });
}

export async function deleteSession(request: Request): Promise<void> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    const user = await getAuthenticatedUser(request);
    await inTransaction(async (client) => {
      await client.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
      if (user) {
        await client.query(
          `INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id)
           VALUES ($1, 'auth.logout', 'user', $1)`,
          [user.id],
        );
      }
    });
  }
}

export async function getAuthenticatedUser(request: Request): Promise<AuthenticatedUser | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || token.length > 128) return null;

  const result = await getPool().query<AuthenticatedUser>(
    `SELECT u.id, u.email, u.display_name AS "displayName", u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active = true`,
    [hashToken(token)],
  );
  return result.rows[0] ?? null;
}

export async function requireUser(request: Request): Promise<AuthenticatedUser> {
  const user = await getAuthenticatedUser(request);
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  return user;
}

export function requireRole(user: AuthenticatedUser, ...roles: UserRole[]): void {
  if (!roles.includes(user.role)) {
    throw new HttpError(403, "FORBIDDEN", "You do not have permission to perform this action.");
  }
}

export function safeSecretEquals(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function bootstrapTokenConfigured(): boolean {
  return Boolean(process.env.BOOTSTRAP_ADMIN_TOKEN);
}
