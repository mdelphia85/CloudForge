import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { recordMaintenancePart } from "@/server/phase4/maintenance";
import { requireUuid } from "@/server/phase4/shared";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    const result = await recordMaintenancePart(requireUuid(id, "workOrderId"), await readJson(request), user);
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}
