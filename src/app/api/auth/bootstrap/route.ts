import { NextResponse } from "next/server";
import { createSession, newSessionToken, safeSecretEquals, sessionCookieOptions } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { hashPassword, isValidPassword } from "@/server/password";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = await readJson(request);
    const expectedToken = process.env.BOOTSTRAP_ADMIN_TOKEN;
    const token = typeof body.bootstrapToken === "string" ? body.bootstrapToken : "";
    if (!expectedToken || Buffer.byteLength(expectedToken) < 32) {
      throw new HttpError(503, "BOOTSTRAP_DISABLED", "Initial administrator setup is not enabled. Configure a random bootstrap token of at least 32 characters.");
    }
    if (!safeSecretEquals(token, expectedToken)) {
      throw new HttpError(403, "INVALID_BOOTSTRAP_TOKEN", "Bootstrap token was rejected.");
    }

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const password = body.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
      || displayName.length < 2 || displayName.length > 120 || !isValidPassword(password)) {
      throw new HttpError(400, "INVALID_ADMIN", "Provide a valid email, a display name (2-120 characters), and a password with at least 14 characters including upper/lowercase letters, a number, and a symbol.");
    }

    const passwordHash = await hashPassword(password);
    const user = await inTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(208451191)");
      const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM users");
      if (count.rows[0].count !== "0") {
        throw new HttpError(409, "SETUP_COMPLETE", "Initial administrator setup has already been completed.");
      }
      const result = await client.query<{ id: string; email: string; display_name: string; role: "admin" }>(
        `INSERT INTO users (email, display_name, password_hash, role)
         VALUES ($1, $2, $3, 'admin')
         RETURNING id, email, display_name, role`,
        [email, displayName, passwordHash],
      );
      const originalOrganization=await client.query<{id:string}>(
        "SELECT id FROM organizations WHERE identifier='existing-installation' FOR SHARE",
      );
      if (!originalOrganization.rowCount) {
        throw new HttpError(503,"ORGANIZATION_CONFIGURATION",
          "The existing installation organization must be provisioned before administrator setup.");
      }
      await client.query(
        "INSERT INTO organization_memberships(organization_id,user_id,role) VALUES($1,$2,'admin')",
        [originalOrganization.rows[0].id,result.rows[0].id],
      );
      await client.query(
        `INSERT INTO audit_events (actor_user_id,organization_id,action, entity_type, entity_id, details)
         VALUES ($1,$3,'user.bootstrap', 'user', $1, $2)`,
        [result.rows[0].id, JSON.stringify({ email, role: "admin" }),originalOrganization.rows[0].id],
      );
      return result.rows[0];
    });

    const sessionToken = newSessionToken();
    const membership=await createSession(user.id, sessionToken, "auth.bootstrap");
    const response = NextResponse.json({
      user: { id: user.id, email: user.email, displayName: user.display_name,
        role: membership.role, organizationId: membership.organizationId },
    }, { status: 201 });
    response.cookies.set("cloudforge_session", sessionToken, sessionCookieOptions());
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
