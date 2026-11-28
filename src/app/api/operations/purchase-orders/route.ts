import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { createPurchaseOrder, listPurchaseOrders } from "@/server/phase3/purchasing";

async function handleGET(request: Request) {
  try {
    await requireUser(request);
    return NextResponse.json({ purchaseOrders: await listPurchaseOrders() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handlePOST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    requireRole(user, "admin", "operator");
    return NextResponse.json(await createPurchaseOrder(await readJson(request), user), { status: 201 });
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}

export const GET = withOrganizationRoute(handleGET);
export const POST = withOrganizationRoute(handlePOST);
