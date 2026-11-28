import { NextResponse } from "next/server";
import {
  listAccessibleOrganizations, requireUser, switchSessionOrganization,
} from "@/server/auth";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { requireUuid } from "@/server/operations";

// Return only organizations of which this authenticated user is an active member.
export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const organizations = await listAccessibleOrganizations(user.id);
    return NextResponse.json({ selectedOrganizationId: user.organizationId, organizations }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

// An organization's identifier alone never grants access. We verify an active
// membership and current session on the server before switching roles/context.
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireUser(request);
    const body = await readJson(request);
    if (typeof body.organizationId !== "string") {
      throw new HttpError(400, "INVALID_ORGANIZATION", "An organization ID is required.");
    }
    const user = await switchSessionOrganization(request, requireUuid(body.organizationId, "organization ID"));
    return NextResponse.json({ user }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
