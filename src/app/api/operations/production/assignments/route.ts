import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { assignProductionJob } from "@/server/phase3/production";

async function handlePOST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    requireRole(user, "admin", "operator");
    return NextResponse.json(await assignProductionJob(await readJson(request), user), { status: 201 });
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}

export const POST = withOrganizationRoute(handlePOST);
