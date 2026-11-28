import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { createMaintenanceWorkOrder, listMaintenanceWorkOrders } from "@/server/phase4/maintenance";

async function handleGET(request: Request) {
  try {
    const user = await requireUser(request);
    return NextResponse.json(await listMaintenanceWorkOrders(user), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handlePOST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    return NextResponse.json(await createMaintenanceWorkOrder(await readJson(request), user), { status: 201 });
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}

export const GET = withOrganizationRoute(handleGET);
export const POST = withOrganizationRoute(handlePOST);
