import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { createInventoryItem, listInventory, parseItemInput } from "@/server/inventory";

export async function GET(request: Request) {
  try {
    await requireUser(request);
    return NextResponse.json({ items: await listInventory() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    requireRole(user, "admin", "operator");
    const input = parseItemInput(await readJson(request));
    await createInventoryItem(input, user);
    return NextResponse.json({ item: input }, { status: 201 });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return NextResponse.json({ error: "That SKU already exists.", code: "SKU_EXISTS" }, { status: 409 });
    }
    return errorResponse(error);
  }
}
