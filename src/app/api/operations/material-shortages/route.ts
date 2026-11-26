import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse } from "@/server/errors";
import { requireUuid } from "@/server/operations";
import { getMaterialShortages } from "@/server/phase3/materials";

export async function GET(request: Request) {
  try {
    await requireUser(request);
    const project = new URL(request.url).searchParams.get("projectId");
    return NextResponse.json(
      { shortages: await getMaterialShortages(project ? requireUuid(project, "projectId") : undefined) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
