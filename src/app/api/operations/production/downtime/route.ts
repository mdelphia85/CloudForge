import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { recordDowntime } from "@/server/phase3/production";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    return NextResponse.json(await recordDowntime(await readJson(request), user), { status: 201 });
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}
