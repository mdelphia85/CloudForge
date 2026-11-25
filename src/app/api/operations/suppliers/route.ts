import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { operationsError } from "@/server/operations";
import { createSupplier, listSuppliers } from "@/server/phase3/purchasing";

export async function GET(request: Request) {
  try {
    await requireUser(request);
    return NextResponse.json({ suppliers: await listSuppliers() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    requireRole(user, "admin", "operator");
    return NextResponse.json(await createSupplier(await readJson(request), user), { status: 201 });
  } catch (error) {
    return errorResponse(operationsError(error));
  }
}
