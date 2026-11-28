import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { getPool, inTransaction } from "@/server/db";
import { requireValidatedOrganizationLicense } from "@/server/license-entitlements";
import { errorResponse } from "@/server/errors";

async function handleGET(request: Request) {
  try {
    const user=await requireUser(request);
    const commercial=process.env.CLOUDFORGE_MULTI_ORGANIZATION_ENABLED==="true" ||
      process.env.CLOUDFORGE_LICENSE_ENFORCEMENT_REQUIRED==="true";
    const allowed=commercial
      ? new Set((await inTransaction(client=>requireValidatedOrganizationLicense(client,user.organizationId))).claims.modules)
      : undefined;
    const [users,items] = await Promise.all([
      getPool().query(
        `SELECT u.id,u.display_name AS "displayName",m.role
           FROM users u JOIN organization_memberships m ON m.user_id=u.id
          WHERE u.is_active AND m.organization_id=$1 ORDER BY u.display_name`,
        [user.organizationId],
      ),
      !allowed || allowed.has("inventory")
        ? getPool().query(
            "SELECT id,sku,name,unit FROM inventory_items WHERE is_active=true AND organization_id=$1 ORDER BY sku",
            [user.organizationId],
          )
        : Promise.resolve({rows:[] as Record<string,unknown>[]}),
    ]);
    return NextResponse.json({ users: users.rows, items: items.rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = withOrganizationRoute(handleGET);
