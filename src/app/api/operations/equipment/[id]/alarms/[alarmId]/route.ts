import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, requireSameOrigin } from "@/server/errors";
import { requireUuid } from "@/server/phase4/shared";
import { acknowledgeAlarm } from "@/server/phase5/alarms";

type Context = { params: Promise<{ id: string; alarmId: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id, alarmId } = await params;
    return NextResponse.json(await acknowledgeAlarm(requireUuid(id, "equipmentId"), requireUuid(alarmId, "alarmId"), user));
  } catch (error) {
    return errorResponse(error);
  }
}
