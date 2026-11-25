import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError, requireUuid } from "@/server/operations";
import { receivePurchaseOrderLine } from "@/server/phase3/purchasing";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    requireRole(user, "admin", "operator");
    const { id } = await params;
    const result = await receivePurchaseOrderLine(requireUuid(id), await readJson(request), user);
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}
