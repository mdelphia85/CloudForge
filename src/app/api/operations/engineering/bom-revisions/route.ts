import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError, requireUuid } from "@/server/operations";
import { createBomRevision, listBomRevisions } from "@/server/phase3/engineering";

export async function GET(request: Request) {
  try {
    await requireUser(request);
    const projectId = new URL(request.url).searchParams.get("projectId");
    return NextResponse.json(
      { revisions: await listBomRevisions(projectId ? requireUuid(projectId, "projectId") : undefined) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    requireRole(user, "admin", "operator");
    return NextResponse.json(await createBomRevision(await readJson(request), user), { status: 201 });
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}
