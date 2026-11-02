import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { hashPassword, isValidPassword } from "@/server/password";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const actor = await requireUser(request);
    requireRole(actor, "admin");
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
