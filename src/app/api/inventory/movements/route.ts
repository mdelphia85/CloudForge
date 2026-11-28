import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { createMovement, listMovements, parseMovementInput } from "@/server/inventory";

async function handleGET(request: Request) {
  try {
    const user=await requireUser(request);
    const sku = new URL(request.url).searchParams.get("sku")?.trim().toUpperCase();
    if (!sku || !/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(sku)) {
      throw new HttpError(400, "INVALID_SKU", "Provide a valid SKU.");
    }
    return NextResponse.json({ movements: await listMovements(sku,user) });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handlePOST(request: Request) {
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

export const GET = withOrganizationRoute(handleGET);
export const POST = withOrganizationRoute(handlePOST);
