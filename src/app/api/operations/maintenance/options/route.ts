import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse } from "@/server/errors";
import { maintenanceOptions } from "@/server/phase4/maintenance";

async function handleGET(request: Request) {
  try {
    const user = await requireUser(request);
    return NextResponse.json(await maintenanceOptions(user), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = withOrganizationRoute(handleGET);
