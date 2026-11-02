import { NextResponse } from "next/server";
import { bootstrapTokenConfigured, getAuthenticatedUser } from "@/server/auth";
import { getPool } from "@/server/db";
import { errorResponse } from "@/server/errors";

export async function GET(request: Request) {
  try {
    const [users, user] = await Promise.all([
      getPool().query<{ count: string }>("SELECT count(*)::text AS count FROM users"),
      getAuthenticatedUser(request),
    ]);
    return NextResponse.json({
      setupRequired: users.rows[0].count === "0",
      setupEnabled: bootstrapTokenConfigured(),
      user,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
