import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { simulateTelemetry } from "@/server/phase4/telemetry";
import { requireUuid } from "@/server/phase4/shared";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const body = await readJson(request);
    const result = await simulateTelemetry(requireUuid(body.assetId, "assetId"), body.mode, user);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}
