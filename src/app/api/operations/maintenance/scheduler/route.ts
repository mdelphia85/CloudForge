import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, requireSameOrigin } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { generateDueMaintenanceWorkOrders } from "@/server/phase4/maintenance";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    return NextResponse.json(await generateDueMaintenanceWorkOrders(user));
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}
