import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse } from "@/server/errors";
import { listProductionResources } from "@/server/phase3/production";

async function handleGET(request: Request) {
  try {
    await requireUser(request);
    return NextResponse.json(await listProductionResources(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = withOrganizationRoute(handleGET);
