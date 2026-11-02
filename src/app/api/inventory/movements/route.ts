import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { createMovement, listMovements, parseMovementInput } from "@/server/inventory";

export async function GET(request: Request) {
  try {
    await requireUser(request);
    const sku = new URL(request.url).searchParams.get("sku")?.trim().toUpperCase();
    if (!sku || !/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(sku)) {
      throw new HttpError(400, "INVALID_SKU", "Provide a valid SKU.");
    }
    return NextResponse.json({ movements: await listMovements(sku) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    requireRole(user, "admin", "operator");
    const movement = parseMovementInput(
      await readJson(request),
      request.headers.get("idempotency-key"),
    );
    await createMovement(movement, user);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return NextResponse.json({ error: "This movement was already processed.", code: "DUPLICATE_MOVEMENT" }, { status: 409 });
    }
    return errorResponse(error);
  }
}
