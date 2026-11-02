import { NextResponse } from "next/server";
import { deleteSession } from "@/server/auth";
import { errorResponse, requireSameOrigin } from "@/server/errors";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await deleteSession(request);
    const response = NextResponse.json({ ok: true });
    response.cookies.set("cloudforge_session", "", { ...{
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict" as const,
      path: "/",
    }, maxAge: 0 });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
