import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse } from "@/server/errors";
import { listOverview } from "@/server/operations";
import { inTransaction } from "@/server/db";
import { requireValidatedOrganizationLicense } from "@/server/license-entitlements";

async function handleGET(request:Request) {
  try {
    const user=await requireUser(request);
    const commercial=process.env.CLOUDFORGE_MULTI_ORGANIZATION_ENABLED==="true" ||
      process.env.CLOUDFORGE_LICENSE_ENFORCEMENT_REQUIRED==="true";
    const allowed=commercial
      ? new Set((await inTransaction(client=>requireValidatedOrganizationLicense(client,user.organizationId))).claims.modules)
      : undefined;
    return NextResponse.json(await listOverview(user,allowed), {headers:{"Cache-Control":"no-store"}});
  } catch(error) { return errorResponse(error); }
}

export const GET = withOrganizationRoute(handleGET);
