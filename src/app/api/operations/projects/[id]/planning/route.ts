import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError, requireUuid } from "@/server/operations";
import { getProjectPlanning, updateProjectPlanning } from "@/server/phase3/project-planning";
import { requireProjectOwner } from "@/server/phase3/shared";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const projectId = requireUuid(id, "projectId");
    await inTransaction((client) => requireProjectOwner(client, user, projectId));
    return NextResponse.json(await getProjectPlanning(projectId, user), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    requireRole(user, "admin", "operator");
    const { id } = await params;
    const body = await readJson(request);
    const result = await updateProjectPlanning(requireUuid(id, "projectId"), body, user);
    const status = ["milestone", "task", "resource", "cost", "dependency"].includes(String(body.action)) ? 201 : 200;
    return NextResponse.json(
      result,
      { status },
    );
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}
