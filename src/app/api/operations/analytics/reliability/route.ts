import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse } from "@/server/errors";
import { getReliabilityAnalytics } from "@/server/phase4/analytics";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const url = new URL(request.url);
    return NextResponse.json(await getReliabilityAnalytics(
      user,
      url.searchParams.get("days"),
      url.searchParams.get("assetId"),
    ), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
