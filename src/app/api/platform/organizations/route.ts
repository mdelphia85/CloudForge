import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { withOrganizationRoute } from "@/server/tenant-context";
import { requirePlatformOwner } from "@/server/platform-owner";

async function handleGET(request: Request) {
  try {
    const actor = await requireUser(request);
    const organizations = await inTransaction(async (client) => {
      await requirePlatformOwner(client, actor.id);
      const result = await client.query(
        `SELECT id, identifier, name, status, deployment_type AS "deploymentType"
         FROM organizations ORDER BY name, id`,
      );
      return result.rows;
    });
    return NextResponse.json({ organizations }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = withOrganizationRoute(handleGET);

async function handlePOST(request: Request) {
  try {
    requireSameOrigin(request);
    const actor=await requireUser(request);
    if (process.env.CLOUDFORGE_MULTI_ORGANIZATION_ENABLED !== "true") {
      throw new HttpError(409,"MULTI_ORGANIZATION_NOT_ACTIVATED",
        "Organization onboarding is blocked until commercial tenant isolation is activated.");
    }
    const body=await readJson(request);
    const identifier=typeof body.identifier==="string"?body.identifier.trim().toLowerCase():"";
    const name=typeof body.name==="string"?body.name.trim():"";
    const deploymentType=body.deploymentType;
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(identifier) ||
        name.length<2 || name.length>160 ||
        !["saas","dedicated","on_premises","air_gapped"].includes(String(deploymentType))) {
      throw new HttpError(400,"INVALID_ORGANIZATION",
        "Provide a unique identifier, business name, and supported deployment type.");
    }
    const created=await inTransaction(async client=>{
      await requirePlatformOwner(client,actor.id);
      const result=await client.query<{
        id:string;identifier:string;name:string;status:string;deployment_type:string;
      }>(
        `INSERT INTO organizations(identifier,name,status,deployment_type)
         VALUES($1,$2,'active',$3)
         RETURNING id,identifier,name,status,deployment_type`,
        [identifier,name,deploymentType],
      );
      const organization=result.rows[0];
      await client.query(
        `INSERT INTO audit_events(actor_user_id,organization_id,action,entity_type,entity_id,details)
          VALUES($1,$2,'platform.organization_created','organization',$2,$3::jsonb)`,
        [actor.id,organization.id,JSON.stringify({identifier,name,deploymentType})],
      );
      return organization;
    });
    return NextResponse.json({organization:created},{status:201,headers:{"Cache-Control":"no-store"}});
  }catch(error){
    if (typeof error==="object" && error!==null && "code" in error &&
        error.code==="23505") {
      return errorResponse(new HttpError(409,"ORGANIZATION_EXISTS",
        "That organization identifier is already in use."));
    }
    return errorResponse(error);
  }
}

export const GET=withOrganizationRoute(handleGET);
export const POST=withOrganizationRoute(handlePOST);
