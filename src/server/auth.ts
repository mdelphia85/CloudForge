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
  organizationId: string;
  mfaEnabled: boolean;
  mfaRecoveryAuthenticated: boolean;
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

export async function createSession(userId: string, token: string, action = "auth.login", expectedEpoch?: number, mfaVerified = false, mfaRecoveryAuthenticated=false): Promise<{organizationId:string;role:UserRole}> {
  return inTransaction(async (client) => {
    const user = await client.query<{ is_active: boolean; session_epoch: number; mfa_enabled:boolean }>(
      "SELECT is_active, session_epoch, mfa_enabled FROM users WHERE id = $1 FOR UPDATE",
      [userId],
    );
    if (!user.rows[0]?.is_active || (expectedEpoch !== undefined && user.rows[0].session_epoch !== expectedEpoch)) {
      throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    }

    if(user.rows[0].mfa_enabled && !mfaVerified) {
      throw new HttpError(401,"MFA_REQUIRED","Verify your authenticator or recovery code.");
    }
    const membership = await client.query<{ organization_id: string; role: UserRole }>(
      `SELECT m.organization_id,m.role FROM organization_memberships m
         JOIN organizations o ON o.id=m.organization_id
        WHERE m.user_id=$1 AND o.status='active'
        ORDER BY m.created_at, m.organization_id
        LIMIT 1 FOR SHARE OF m, o`,
      [userId],
    );
    if (!membership.rowCount) {
      throw new HttpError(403, "NO_ACTIVE_ORGANIZATION", "No active organization membership is available.");
    }
    await client.query(
      `INSERT INTO sessions (token_hash, user_id, organization_id, expires_at,mfa_verified,mfa_recovery_authenticated)
       VALUES ($1, $2, $3, now() + ($4 * interval '1 second'),$5,$6)`,
      [hashToken(token), userId, membership.rows[0].organization_id, SESSION_TTL_SECONDS,
        mfaVerified,mfaRecoveryAuthenticated],
    );
    await client.query(
      `INSERT INTO audit_events (actor_user_id, organization_id, action, entity_type, entity_id)
       VALUES ($1, $3, $2, 'user', $1)`,
      [userId, action, membership.rows[0].organization_id],
    );
    return {organizationId:membership.rows[0].organization_id,role:membership.rows[0].role};
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
          `INSERT INTO audit_events (actor_user_id, organization_id, action, entity_type, entity_id)
           VALUES ($1, $2, 'auth.logout', 'user', $1)`,
          [user.id, user.organizationId],
        );
      }
    });
  }
}

export async function getAuthenticatedUser(request: Request): Promise<AuthenticatedUser | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || token.length > 128) return null;

  const result = await getPool().query<AuthenticatedUser>(
    `SELECT u.id, u.email, u.display_name AS "displayName",
            m.role, m.organization_id AS "organizationId",u.mfa_enabled AS "mfaEnabled",
            s.mfa_recovery_authenticated AS "mfaRecoveryAuthenticated"
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN organization_memberships m ON m.user_id = u.id AND m.organization_id = s.organization_id
       JOIN organizations o ON o.id = s.organization_id
      WHERE s.token_hash = $1 AND s.expires_at > now()
        AND u.is_active = true AND o.status = 'active'
        AND (NOT u.mfa_enabled OR s.mfa_verified)`,
    [hashToken(token)],
  );
  return result.rows[0] ?? null;
}

export async function requireUser(request: Request): Promise<AuthenticatedUser> {
  const user = await getAuthenticatedUser(request);
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  return user;
}


export async function listAccessibleOrganizations(userId: string): Promise<{
  id: string; name: string; identifier: string; role: UserRole;
}[]> {
  const result = await getPool().query<{
    id: string; name: string; identifier: string; role: UserRole;
  }>(
    `SELECT o.id, o.name, o.identifier, m.role
       FROM organization_memberships m
       JOIN organizations o ON o.id=m.organization_id
       JOIN users u ON u.id=m.user_id
      WHERE m.user_id=$1 AND u.is_active AND o.status='active'
      ORDER BY o.name, o.id`,
    [userId],
  );
  return result.rows;
}

export async function switchSessionOrganization(request: Request, organizationId: string): Promise<AuthenticatedUser> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  const tokenHash = hashToken(token);
  await inTransaction(async (client) => {
    const session = await client.query<{ user_id: string; organization_id: string }>(
      `SELECT s.user_id, s.organization_id FROM sessions s
         JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.expires_at>now() AND u.is_active
        FOR UPDATE OF s`,
      [tokenHash],
    );
    if (!session.rowCount) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
    const userId = session.rows[0].user_id;
    const membership = await client.query(
      `SELECT 1 FROM organization_memberships m
         JOIN organizations o ON o.id=m.organization_id
        WHERE m.user_id=$1 AND m.organization_id=$2 AND o.status='active'
        FOR SHARE OF m, o`,
      [userId, organizationId],
    );
    if (!membership.rowCount) {
      throw new HttpError(403, "ORGANIZATION_ACCESS_DENIED", "You are not an active member of this organization.");
    }
    if (session.rows[0].organization_id !== organizationId) {
      await client.query("UPDATE sessions SET organization_id=$2 WHERE token_hash=$1", [tokenHash, organizationId]);
      await client.query(
        `INSERT INTO audit_events (actor_user_id,organization_id, action, entity_type, entity_id, details)
         VALUES ($1,$2,'auth.organization_switched', 'organization', $2, $3)`,
        [userId, organizationId, JSON.stringify({ from: session.rows[0].organization_id, to: organizationId })],
      );
    }
  });
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
