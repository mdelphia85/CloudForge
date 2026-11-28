import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { createReservation, listReservations } from "@/server/phase3/materials";

async function handleGET(request: Request) {
  try {
    await requireUser(request);
    return NextResponse.json({ reservations: await listReservations() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handlePOST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    requireRole(user, "admin", "operator");
    const result = await createReservation(await readJson(request), user);
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}

export const GET = withOrganizationRoute(handleGET);
export const POST = withOrganizationRoute(handlePOST);
