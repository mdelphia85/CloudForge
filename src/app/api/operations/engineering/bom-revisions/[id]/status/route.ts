import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError, requireUuid } from "@/server/operations";
import { transitionBomRevision } from "@/server/phase3/engineering";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    requireRole(user, "admin", "operator");
    const { id } = await params;
    return NextResponse.json(await transitionBomRevision(requireUuid(id), (await readJson(request)).action, user));
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}
