import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { errorResponse, HttpError, requireSameOrigin } from "@/server/errors";
import { requireUuid } from "@/server/operations";
import { withOrganizationRoute } from "@/server/tenant-context";

type Context={params:Promise<{id:string}>};

async function handlePATCH(request:Request,{params}:Context) {
  try {
    requireSameOrigin(request);
    const actor=await requireUser(request);
    requireRole(actor,"admin");
    const id=requireUuid((await params).id,"invitation ID");
    const revoked=await inTransaction(async client=>{
      const result=await client.query<{id:string}>(
        `UPDATE organization_invitations SET revoked_at=now()
          WHERE id=$1 AND organization_id=$2 AND accepted_at IS NULL
            AND revoked_at IS NULL RETURNING id`,
        [id,actor.organizationId],
      );
      if(!result.rowCount) {
        throw new HttpError(404,"INVITATION_NOT_FOUND",
          "Pending invitation was not found for this organization.");
      }
      await client.query(
        `INSERT INTO audit_events(actor_user_id,organization_id,action,entity_type,entity_id)
          VALUES($1,$2,'organization.invitation_revoked','organization_invitation',$3)`,
        [actor.id,actor.organizationId,id],
      );
      return {id:result.rows[0].id,revoked:true};
    });
    return NextResponse.json(revoked,{headers:{"Cache-Control":"no-store"}});
  }catch(error){return errorResponse(error);}
}

export const PATCH=withOrganizationRoute(handlePATCH);
