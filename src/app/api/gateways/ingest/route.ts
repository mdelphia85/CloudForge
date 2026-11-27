import { NextResponse } from "next/server";
import { errorResponse } from "@/server/errors";
import { ingestGateway } from "@/server/phase5/gateways";

export async function POST(request: Request) {
  try {
    return NextResponse.json(await ingestGateway(request), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
