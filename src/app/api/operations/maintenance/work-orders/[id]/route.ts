import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { getMaintenanceWorkOrder, updateMaintenanceWorkOrder } from "@/server/phase4/maintenance";
import { requireUuid } from "@/server/phase4/shared";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    return NextResponse.json(await getMaintenanceWorkOrder(requireUuid(id, "workOrderId"), user), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    return NextResponse.json(await updateMaintenanceWorkOrder(requireUuid(id, "workOrderId"), await readJson(request), user));
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}
