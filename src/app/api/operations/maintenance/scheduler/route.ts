import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, requireSameOrigin } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { generateDueMaintenanceWorkOrders } from "@/server/phase4/maintenance";

async function handlePOST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    return NextResponse.json(await generateDueMaintenanceWorkOrders(user));
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}

export const POST = withOrganizationRoute(handlePOST);
