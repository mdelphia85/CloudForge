import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { createEquipment, listEquipment } from "@/server/phase4/equipment";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return NextResponse.json(await listEquipment(user), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const result = await createEquipment(await readJson(request), user);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}
