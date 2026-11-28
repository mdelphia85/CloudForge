import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError, requireUuid } from "@/server/operations";
import { recordServiceUpdate } from "@/server/phase3/field-service";

type Context = { params: Promise<{ id: string }> };

async function handlePOST(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    return NextResponse.json(await recordServiceUpdate(requireUuid(id, "serviceJobId"), await readJson(request), user), { status: 201 });
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}

export const POST = withOrganizationRoute(handlePOST);
