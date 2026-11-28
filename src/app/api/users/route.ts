import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { hashPassword, isValidPassword } from "@/server/password";

async function handleGET(request: Request) {
  try {
    const actor = await requireUser(request);
    requireRole(actor, "admin");
    const users = await inTransaction(async (client) => {
      const result = await client.query(
        `SELECT u.id, u.email, u.display_name AS "displayName",
                m.role, u.is_active AS "isActive"
         FROM users u JOIN organization_memberships m ON m.user_id=u.id
         WHERE m.organization_id=$1 ORDER BY u.display_name,u.id`,
        [actor.organizationId],
      );
      return result.rows;
    });
    return NextResponse.json({ users }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handlePOST(request: Request) {
  try {
    requireSameOrigin(request);
    const actor = await requireUser(request);
    requireRole(actor, "admin");
    // Until invitations and per-organization account provisioning are complete,
    // never create globally scoped user accounts from a shared SaaS organization.
    if (process.env.CLOUDFORGE_MULTI_ORGANIZATION_ENABLED === "true") {
      throw new HttpError(409, "INVITATIONS_REQUIRED",
        "Organization-scoped invitations are required before adding users to shared SaaS.");
    }
    const body = await readJson(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const role = body.role;
    const password = body.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
      || displayName.length < 2 || displayName.length > 120
      || !["admin", "operator", "viewer"].includes(String(role))
      || !isValidPassword(password)) {
      throw new HttpError(400, "INVALID_USER", "Provide a valid email, display name, role, and a password with at least 14 characters including upper/lowercase letters, a number, and a symbol.");
    }

    const passwordHash = await hashPassword(password);
    const newUser = await inTransaction(async (client) => {
      const result = await client.query<{ id: string; email: string; display_name: string; role: string }>(
        `INSERT INTO users (email, display_name, password_hash, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, display_name, role`,
        [email, displayName, passwordHash, role],
      );
      await client.query(
        `INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, details)
         VALUES ($1, 'user.created', 'user', $2, $3)`,
        [actor.id, result.rows[0].id, JSON.stringify({ email, role })],
      );
      return result.rows[0];
    });
    return NextResponse.json({
      user: {
        id: newUser.id,
        email: newUser.email,
        displayName: newUser.display_name,
        role: newUser.role,
      },
    }, { status: 201 });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return NextResponse.json({ error: "That email already has an account.", code: "EMAIL_EXISTS" }, { status: 409 });
    }
    return errorResponse(error);
  }
}

export const GET = withOrganizationRoute(handleGET);
export const POST = withOrganizationRoute(handlePOST);
