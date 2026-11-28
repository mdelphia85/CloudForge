import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { getPool } from "@/server/db";
import { errorResponse } from "@/server/errors";

async function handleGET(request: Request) {
  try {
    await requireUser(request);
    const [users, items] = await Promise.all([
      getPool().query("SELECT id,display_name AS \"displayName\",role FROM users WHERE is_active=true ORDER BY display_name"),
      getPool().query("SELECT id,sku,name,unit FROM inventory_items WHERE is_active=true ORDER BY sku"),
    ]);
    return NextResponse.json({ users: users.rows, items: items.rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = withOrganizationRoute(handleGET);
