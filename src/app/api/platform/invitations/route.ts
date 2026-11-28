import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { requireUuid } from "@/server/operations";
import { requirePlatformOwner } from "@/server/platform-owner";
import { issueOrganizationInvitation } from "@/server/organization-invitations";
import { withOrganizationRoute } from "@/server/tenant-context";

async function handlePOST(request: Request) {
  try {
    requireSameOrigin(request);
    const actor=await requireUser(request);
    const body=await readJson(request);
    const organizationId=requireUuid(body.organizationId,"organization ID");
    const invited=await inTransaction(async client=>{
      await requirePlatformOwner(client,actor.id);
      return issueOrganizationInvitation(
        client,organizationId,body.email,body.role,actor.id,
      );
    });
    const origin=process.env.APP_ORIGIN ?? new URL(request.url).origin;
    return NextResponse.json({
      invitationId:invited.invitationId,email:invited.email,role:invited.role,
      expiresAt:invited.expiresAt,
      inviteLink:origin+"/join#token="+encodeURIComponent(invited.token),
    },{status:201,headers:{"Cache-Control":"no-store"}});
  } catch(error) { return errorResponse(error); }
}

export const POST=withOrganizationRoute(handlePOST);
