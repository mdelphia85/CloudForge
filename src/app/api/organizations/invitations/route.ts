import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { errorResponse, readJson, requireSameOrigin } from "@/server/errors";
import { issueOrganizationInvitation } from "@/server/organization-invitations";
import { withOrganizationRoute } from "@/server/tenant-context";

async function handleGET(request: Request) {
  try {
    const user = await requireUser(request);
    requireRole(user,"admin");
    const invites=await inTransaction(async client=>{
      const result=await client.query(
        `SELECT id,email,role,expires_at AS "expiresAt",created_at AS "createdAt",
          accepted_at AS "acceptedAt",revoked_at AS "revokedAt"
          FROM organization_invitations WHERE organization_id=$1
          ORDER BY created_at DESC LIMIT 150`,
        [user.organizationId],
      );
      return result.rows;
    });
    return NextResponse.json({invitations:invites},{headers:{"Cache-Control":"no-store"}});
  } catch(error) { return errorResponse(error); }
}

async function handlePOST(request: Request) {
  try {
    requireSameOrigin(request);
    const user=await requireUser(request);
    requireRole(user,"admin");
    const body=await readJson(request);
    const invited=await inTransaction(client=>issueOrganizationInvitation(
      client,user.organizationId,body.email,body.role,user.id,
    ));
    // URL fragment keeps bearer token out of server logs, HTTP referrers and
    // intermediary caches. Do not store or log the raw token.
    const origin=process.env.APP_ORIGIN ?? new URL(request.url).origin;
    const inviteLink=origin+"/join#token="+encodeURIComponent(invited.token);
    return NextResponse.json({
      invitationId:invited.invitationId,email:invited.email,role:invited.role,
      expiresAt:invited.expiresAt,inviteLink,
    },{status:201,headers:{"Cache-Control":"no-store"}});
  } catch(error) { return errorResponse(error); }
}

export const GET=withOrganizationRoute(handleGET);
export const POST=withOrganizationRoute(handlePOST);
