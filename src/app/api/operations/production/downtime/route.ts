import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { recordDowntime } from "@/server/phase3/production";

async function handlePOST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const result = await recordDowntime(await readJson(request), user);
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}

export const POST = withOrganizationRoute(handlePOST);
