import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError, requireUuid } from "@/server/operations";
import { updatePurchaseOrderStatus } from "@/server/phase3/purchasing";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    requireRole(user, "admin", "operator");
    const { id } = await params;
    return NextResponse.json(await updatePurchaseOrderStatus(requireUuid(id), (await readJson(request)).status, user));
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}
