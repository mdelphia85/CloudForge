import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { listGateways, registerGateway } from "@/server/phase5/gateways";

export async function GET(request: Request) {
  try {
    return NextResponse.json(await listGateways(await requireUser(request)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    return NextResponse.json(await registerGateway(await readJson(request), user), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
