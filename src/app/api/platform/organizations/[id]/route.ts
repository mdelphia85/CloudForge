import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { requireUuid } from "@/server/operations";
import { requirePlatformOwner } from "@/server/platform-owner";
import { withOrganizationRoute } from "@/server/tenant-context";

type Context={params:Promise<{id:string}>};

async function handlePATCH(request:Request,{params}:Context) {
  try {
    requireSameOrigin(request);
    const actor=await requireUser(request);
    const organizationId=requireUuid((await params).id,"organization ID");
    const body=await readJson(request);
    if(body.action!=="suspend" && body.action!=="reactivate") {
      throw new HttpError(400,"INVALID_ORGANIZATION_ACTION",
        "Choose suspend or reactivate.");
    }
    const nextStatus=body.action==="suspend"?"suspended":"active";
    const result=await inTransaction(async client=>{
      await requirePlatformOwner(client,actor.id);
      const org=await client.query<{
        id:string;identifier:string;status:"active"|"suspended";
      }>(
        "SELECT id,identifier,status FROM organizations WHERE id=$1 FOR UPDATE",
        [organizationId],
      );
      if(!org.rowCount) {
        throw new HttpError(404,"ORGANIZATION_NOT_FOUND","Organization was not found.");
      }
      const previous=org.rows[0];
      // Never disable the original platform owner's only recovery/control-plane
      // organization. Customer orgs can be suspended independently.
      if(nextStatus==="suspended" && previous.identifier==="existing-installation") {
        throw new HttpError(409,"PLATFORM_RECOVERY_ORGANIZATION",
          "The original platform recovery organization cannot be suspended.");
      }
      if(previous.status===nextStatus) {
        return {id:organizationId,status:nextStatus,changed:false};
      }
      await client.query(
        "UPDATE organizations SET status=$2,updated_at=now() WHERE id=$1",
        [organizationId,nextStatus],
      );
      await client.query(
        `INSERT INTO audit_events(actor_user_id,organization_id,action,entity_type,entity_id,details)
         VALUES($1,$2,$3,'organization',$2,$4::jsonb)`,
        [actor.id,organizationId,
          nextStatus==="suspended"?"platform.organization_suspended":"platform.organization_reactivated",
          JSON.stringify({previousStatus:previous.status,nextStatus})],
      );
      // Sessions remain tied to their organization; authorization immediately
      // fails for suspended organizations. Reactivation requires license validation.
      return {id:organizationId,status:nextStatus,changed:true};
    });
    return NextResponse.json({organization:result},{headers:{"Cache-Control":"no-store"}});
  }catch(error){return errorResponse(error);}
}

export const PATCH=withOrganizationRoute(handlePATCH);
