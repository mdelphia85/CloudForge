import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { requireUuid } from "@/server/phase4/shared";
import { editAlarmRule, setAlarmRuleEnabled } from "@/server/phase5/alarms";

type Context = { params: Promise<{ id: string; ruleId: string }> };

async function handlePUT(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id, ruleId } = await params;
    return NextResponse.json(await editAlarmRule(
      requireUuid(id, "equipmentId"), requireUuid(ruleId, "ruleId"), await readJson(request), user,
    ));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handlePATCH(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id, ruleId } = await params;
    const body = await readJson(request);
    return NextResponse.json(await setAlarmRuleEnabled(
      requireUuid(id, "equipmentId"), requireUuid(ruleId, "ruleId"), body.enabled, user,
    ));
  } catch (error) {
    return errorResponse(error);
  }
}

export const PUT = withOrganizationRoute(handlePUT);
export const PATCH = withOrganizationRoute(handlePATCH);
