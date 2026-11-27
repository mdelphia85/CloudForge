import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { updateMaintenanceChecklist } from "@/server/phase4/maintenance";
import { requireUuid } from "@/server/phase4/shared";

type Context = { params: Promise<{ id: string; checklistId: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id, checklistId } = await params;
    return NextResponse.json(await updateMaintenanceChecklist(
      requireUuid(id, "workOrderId"),
      requireUuid(checklistId, "checklistId"),
      await readJson(request),
      user,
    ));
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}
