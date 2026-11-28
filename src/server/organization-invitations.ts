import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import { hashPassword, isValidPassword, verifyPassword } from "@/server/password";
import { requireAvailableSeat, requireValidatedOrganizationLicense } from "@/server/license-entitlements";
import { clearLoginFailures, isLoginBlocked, recordFailedLogin } from "@/server/login-rate-limit";

export type InviteRole = "admin" | "operator" | "viewer";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const INVITATION_LIFETIME_DAYS = 7;

function normalizedEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 254) {
    throw new HttpError(400,"INVALID_EMAIL","Provide a valid email address.");
  }
  return email;
}
function invitationRole(value: unknown): InviteRole {
  if (value !== "admin" && value !== "operator" && value !== "viewer") {
    throw new HttpError(400,"INVALID_ROLE","Choose admin, operator, or viewer.");
  }
  return value;
}
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueOrganizationInvitation(
  client: PoolClient,
  organizationId: string,
  emailValue: unknown,
  roleValue: unknown,
  actorId: string,
): Promise<{ invitationId: string; token: string; email: string; role: InviteRole; expiresAt: string }> {
  const email = normalizedEmail(emailValue);
  const role = invitationRole(roleValue);

  // Lock + verify active org and active signed license BEFORE issuing an invite.
  await requireAvailableSeat(client, organizationId);
  const {claims,seats} = await requireValidatedOrganizationLicense(client,organizationId);
  const existing = await client.query(
    "SELECT 1 FROM organization_memberships m JOIN users u ON u.id=m.user_id " +
      "WHERE m.organization_id=$1 AND u.email=$2",
    [organizationId,email],
  );
  if (existing.rowCount) throw new HttpError(409,"ALREADY_MEMBER","This account already belongs to the organization.");

  // Revoke expired pending invitations so a new legitimate invitation is possible.
  await client.query(
    "UPDATE organization_invitations SET revoked_at=now() " +
      "WHERE organization_id=$1 AND email=$2 AND accepted_at IS NULL " +
      "AND revoked_at IS NULL AND expires_at<=now()",
    [organizationId,email],
  );
  const pending = await client.query<{ count:number }>(
    "SELECT count(*)::int AS count FROM organization_invitations " +
      "WHERE organization_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()",
    [organizationId],
  );
  if (seats + pending.rows[0].count >= claims.seatLimit) {
    throw new HttpError(409,"SEAT_CAPACITY_RESERVED",
      "No additional seats are available after accounting for pending invitations.");
  }

  const token = randomBytes(32).toString("base64url");
  const result = await client.query<{ id: string; expires_at: Date }>(
    `INSERT INTO organization_invitations
       (organization_id,email,role,token_hash,expires_at,created_by)
       VALUES($1,$2,$3,$4,now()+($5::int*interval '1 day'),$6)
       RETURNING id,expires_at`,
    [organizationId,email,role,tokenHash(token),INVITATION_LIFETIME_DAYS,actorId],
  );
  await client.query(
    `INSERT INTO audit_events(actor_user_id,organization_id,action,entity_type,entity_id,details)
     VALUES($1,$2,'organization.invitation_issued','organization_invitation',$3,$4::jsonb)`,
    [actorId,organizationId,result.rows[0].id,JSON.stringify({email,role})],
  );
  return { invitationId:result.rows[0].id,token,email,role,
    expiresAt:result.rows[0].expires_at.toISOString() };
}

export async function acceptOrganizationInvitation(input: {
  token: unknown; password: unknown; displayName?: unknown;
}): Promise<{ organizationId: string; userId: string; role: InviteRole }> {
  const token = typeof input.token === "string" ? input.token : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!TOKEN.test(token) || password.length < 1 || password.length > 256) {
    throw new HttpError(400,"INVALID_INVITATION","Invitation is invalid or expired.");
  }

  const hash = tokenHash(token);
  const preliminary = await getPool().query<{ email:string;organization_id:string }>(
    `SELECT email,organization_id FROM organization_invitations
      WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()`,
    [hash],
  );
  if (!preliminary.rows[0]) throw new HttpError(400,"INVALID_INVITATION","Invitation is invalid or expired.");
  const { email,organization_id:organizationId } = preliminary.rows[0];
  const existing = await getPool().query<{ id:string;password_hash:string;is_active:boolean }>(
    "SELECT id,password_hash,is_active FROM users WHERE email=$1",
    [email],
  );
  let newPasswordHash: string | null = null;
  let displayName: string | null = null;
  if (existing.rows[0]) {
    if (!existing.rows[0].is_active || await isLoginBlocked(email)) {
      throw new HttpError(429,"INVITATION_AUTH_BLOCKED","Account verification is unavailable.");
    }
    const okay = await verifyPassword(password,existing.rows[0].password_hash);
    if (!okay) {
      await recordFailedLogin(email);
      throw new HttpError(401,"INVALID_CREDENTIALS","The account password is incorrect.");
    }
    await clearLoginFailures(email);
  } else {
    displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
    if (displayName.length < 2 || displayName.length > 120 || !isValidPassword(password)) {
      throw new HttpError(400,"INVALID_ACCOUNT",
        "Provide a display name and a strong password of at least 14 characters.");
    }
    newPasswordHash = await hashPassword(password);
  }

  return inTransaction(async client => {
    // Lock the organization row first, serializing seat acceptance, then lock
    // the invite. Revalidate token/identity after the earlier password checks.
    await requireAvailableSeat(client,organizationId);
    const locked = await client.query<{
      id:string;email:string;role:InviteRole;accepted_at:Date|null;
      revoked_at:Date|null;expires_at:Date;
    }>(
      "SELECT id,email,role,accepted_at,revoked_at,expires_at " +
        "FROM organization_invitations WHERE token_hash=$1 AND organization_id=$2 FOR UPDATE",
      [hash,organizationId],
    );
    const invitation = locked.rows[0];
    if (!invitation || invitation.accepted_at || invitation.revoked_at ||
        invitation.expires_at.getTime() <= Date.now() || invitation.email !== email) {
      throw new HttpError(400,"INVALID_INVITATION","Invitation is invalid or expired.");
    }

    let userId: string;
    if (existing.rows[0]) {
      const current = await client.query<{ id:string;password_hash:string;is_active:boolean }>(
        "SELECT id,password_hash,is_active FROM users WHERE email=$1 FOR UPDATE",
        [email],
      );
      if (!current.rowCount || !current.rows[0].is_active ||
          current.rows[0].password_hash !== existing.rows[0].password_hash) {
        throw new HttpError(409,"ACCOUNT_CHANGED","Account credentials changed; retry invitation acceptance.");
      }
      userId = current.rows[0].id;
    } else {
      const created = await client.query<{id:string}>(
        `INSERT INTO users(email,display_name,password_hash,role)
          VALUES($1,$2,$3,'viewer') RETURNING id`,
        [email,displayName,newPasswordHash],
      );
      userId = created.rows[0].id;
    }
    const membership = await client.query(
      `INSERT INTO organization_memberships(organization_id,user_id,role)
         VALUES($1,$2,$3) ON CONFLICT(organization_id,user_id) DO NOTHING RETURNING user_id`,
      [organizationId,userId,invitation.role],
    );
    if (!membership.rowCount) throw new HttpError(409,"ALREADY_MEMBER",
      "The account already belongs to the organization.");
    await client.query(
      "UPDATE organization_invitations SET accepted_at=now(),accepted_by=$2 WHERE id=$1",
      [invitation.id,userId],
    );
    await client.query(
      `INSERT INTO audit_events(actor_user_id,organization_id,action,entity_type,entity_id,details)
         VALUES($1,$2,'organization.invitation_accepted','organization_invitation',$3,$4::jsonb)`,
      [userId,organizationId,invitation.id,JSON.stringify({email,role:invitation.role})],
    );
    return {organizationId,userId,role:invitation.role};
  });
}
