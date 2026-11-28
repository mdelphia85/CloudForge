import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError, requireUuid } from "@/server/operations";
import { createChangeOrder, listChangeOrders } from "@/server/phase3/engineering";

async function handleGET(request: Request) {
  try {
    await requireUser(request);
    const projectId = new URL(request.url).searchParams.get("projectId");
    return NextResponse.json(
      { changeOrders: await listChangeOrders(projectId ? requireUuid(projectId, "projectId") : undefined) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

async function handlePOST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    requireRole(user, "admin", "operator");
    return NextResponse.json(await createChangeOrder(await readJson(request), user), { status: 201 });
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}

export const GET = withOrganizationRoute(handleGET);
export const POST = withOrganizationRoute(handlePOST);
