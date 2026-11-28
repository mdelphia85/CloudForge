import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { errorResponse } from "@/server/errors";
import { requirePlatformOwner } from "@/server/platform-owner";

export async function GET(request: Request) {
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
