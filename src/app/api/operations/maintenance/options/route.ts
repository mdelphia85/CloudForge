import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse } from "@/server/errors";
import { maintenanceOptions } from "@/server/phase4/maintenance";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return NextResponse.json(await maintenanceOptions(user), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
