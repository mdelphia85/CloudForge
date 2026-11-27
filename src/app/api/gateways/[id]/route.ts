import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { requireUuid } from "@/server/phase4/shared";
import { updateGateway } from "@/server/phase5/gateways";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    return NextResponse.json(await updateGateway(requireUuid(id, "gatewayId"), await readJson(request), user));
  } catch (error) {
    return errorResponse(error);
  }
}
