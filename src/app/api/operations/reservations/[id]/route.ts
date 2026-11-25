import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { errorResponse, requireSameOrigin } from "@/server/errors";
import { operationsError, requireUuid } from "@/server/operations";
import { releaseReservation } from "@/server/phase3/materials";

type Context = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    requireRole(user, "admin", "operator");
    const { id } = await params;
    return NextResponse.json(await releaseReservation(requireUuid(id), user));
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}
