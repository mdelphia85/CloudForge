import { NextResponse } from "next/server";
import { createSession, newSessionToken, sessionCookieOptions } from "@/server/auth";
import { getPool } from "@/server/db";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { verifyPassword } from "@/server/password";
import { clearLoginFailures, isLoginBlocked, recordFailedLogin } from "@/server/login-rate-limit";

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

    if (await isLoginBlocked(email)) {
      throw new HttpError(429, "TOO_MANY_ATTEMPTS", "Too many sign-in attempts. Try again later.");
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
      const blocked = await recordFailedLogin(email);
      if (blocked) {
        throw new HttpError(429, "TOO_MANY_ATTEMPTS", "Too many sign-in attempts. Try again later.");
      }
      throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    }
    await clearLoginFailures(email);

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
