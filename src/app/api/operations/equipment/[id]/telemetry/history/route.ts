import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { getTelemetryHistory } from "@/server/phase4/telemetry";
import { requireUuid } from "@/server/phase4/shared";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const url = new URL(request.url);
    return NextResponse.json(await getTelemetryHistory(
      requireUuid(id, "equipmentId"),
      url.searchParams.get("tagId"),
      url.searchParams.get("days"),
      user,
      url.searchParams.get("provider"),
    ), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}
