import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { requireUuid } from "@/server/phase4/shared";
import { createAlarmRule, listAlarms } from "@/server/phase5/alarms";

type Context = { params: Promise<{ id: string }> };

async function handleGET(request: Request, { params }: Context) {
  try {
    const user = await requireUser(request);
    return NextResponse.json(await listAlarms(requireUuid((await params).id, "equipmentId"), user), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handlePOST(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const result = await createAlarmRule(requireUuid((await params).id, "equipmentId"), await readJson(request), user);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}

export const GET = withOrganizationRoute(handleGET);
export const POST = withOrganizationRoute(handlePOST);
