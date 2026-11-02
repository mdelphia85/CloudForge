import { NextResponse } from "next/server";
import { createSession, newSessionToken, sessionCookieOptions } from "@/server/auth";
import { getPool } from "@/server/db";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { verifyPassword } from "@/server/password";

const DUMMY_HASH = `scrypt$32768$8$1$${"0".repeat(32)}$${"0".repeat(128)}`;

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = await readJson(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || email.length > 254 || !password || password.length > 256) {
      throw new HttpError(400, "INVALID_CREDENTIALS", "Enter your email and password.");
    }

    const result = await getPool().query<{
      id: string;
      email: string;
      display_name: string;
      role: "admin" | "operator" | "viewer";
      password_hash: string;
    }>(
      `SELECT id, email, display_name, role, password_hash
         FROM users WHERE email = $1 AND is_active = true`,
      [email],
    );
    const user = result.rows[0];
    const verified = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !verified) {
      throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    }

    const sessionToken = newSessionToken();
    await createSession(user.id, sessionToken);
    const response = NextResponse.json({
      user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
    });
    response.cookies.set("cloudforge_session", sessionToken, sessionCookieOptions());
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
