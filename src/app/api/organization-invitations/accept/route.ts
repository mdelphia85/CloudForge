import { NextResponse } from "next/server";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { acceptOrganizationInvitation } from "@/server/organization-invitations";

// Invitation tokens are bearer secrets transferred only in URL fragments.
// This endpoint accepts a one-time token and verifies the account password
// before binding the user to the licensed organization. No automatic login.
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body=await readJson(request);
    const membership=await acceptOrganizationInvitation({
      token:body.token,password:body.password,displayName:body.displayName,
    });
    return NextResponse.json({
      membership:{organizationId:membership.organizationId,role:membership.role},
      next:"Sign in to CloudForge and select your organization.",
    },{status:201,headers:{"Cache-Control":"no-store"}});
  } catch(error) { return errorResponse(error); }
}
