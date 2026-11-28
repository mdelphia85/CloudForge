import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { requireUuid } from "@/server/operations";
import { withOrganizationRoute } from "@/server/tenant-context";

type Context={params:Promise<{id:string}>};
type Role="admin"|"operator"|"viewer";

async function mutateMembership(request:Request,{params}:Context,remove:boolean) {
  try {
    requireSameOrigin(request);
    const actor=await requireUser(request);
    requireRole(actor,"admin");
    const userId=requireUuid((await params).id,"member user ID");
    let nextRole:Role|null=null;
    if(!remove) {
      const body=await readJson(request);
      if(body.role!=="admin" && body.role!=="operator" && body.role!=="viewer") {
        throw new HttpError(400,"INVALID_ROLE","Choose an organization admin, operator, or viewer.");
      }
      nextRole=body.role;
    }

    const result=await inTransaction(async client=>{
      // Synchronize last-admin checks with parallel membership updates.
      await client.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE",[actor.organizationId]);
      const current=await client.query<{role:Role;is_active:boolean}>(
        `SELECT m.role,u.is_active FROM organization_memberships m
         JOIN users u ON u.id=m.user_id
         WHERE m.organization_id=$1 AND m.user_id=$2 FOR UPDATE OF m,u`,
        [actor.organizationId,userId],
      );
      if(!current.rowCount) throw new HttpError(404,"MEMBER_NOT_FOUND",
        "No such member belongs to this organization.");

      if(current.rows[0].role==="admin" && current.rows[0].is_active &&
         (remove || nextRole!=="admin")) {
        const activeAdmins=await client.query<{count:number}>(
          `SELECT count(*)::int AS count FROM organization_memberships m
          JOIN users u ON u.id=m.user_id
          WHERE m.organization_id=$1 AND m.role='admin' AND u.is_active`,
          [actor.organizationId],
        );
        if(activeAdmins.rows[0].count<=1) {
          throw new HttpError(409,"LAST_ORGANIZATION_ADMIN",
            "The last active organization administrator cannot be removed or demoted.");
        }
      }
      if(remove) {
        await client.query(
          "DELETE FROM organization_memberships WHERE organization_id=$1 AND user_id=$2",
          [actor.organizationId,userId],
        );
      } else {
        await client.query(
          "UPDATE organization_memberships SET role=$3 WHERE organization_id=$1 AND user_id=$2",
          [actor.organizationId,userId,nextRole],
        );
      }
      // Only revoke sessions in THIS organization; preserve sessions the same
      // identity has with unrelated companies.
      const revoked=await client.query(
        "DELETE FROM sessions WHERE organization_id=$1 AND user_id=$2",
        [actor.organizationId,userId],
      );
      await client.query(
        `INSERT INTO audit_events(actor_user_id,organization_id,action,entity_type,entity_id,details)
          VALUES($1,$2,$3,'organization_membership',$4,$5::jsonb)`,
        [actor.id,actor.organizationId,remove?"organization.member_removed":"organization.member_role_changed",
          userId,JSON.stringify({from:current.rows[0].role,to:nextRole,revokedSessions:revoked.rowCount})],
      );
      return {userId,removed:remove,role:nextRole,revokedSessions:revoked.rowCount??0};
    });
    return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
  }catch(error){return errorResponse(error);}
}

async function handlePATCH(request:Request,context:Context) {
  return mutateMembership(request,context,false);
}
async function handleDELETE(request:Request,context:Context) {
  return mutateMembership(request,context,true);
}
export const PATCH=withOrganizationRoute(handlePATCH);
export const DELETE=withOrganizationRoute(handleDELETE);
