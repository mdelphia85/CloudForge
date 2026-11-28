import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse } from "@/server/errors";
import { listApprovedDocumentRevisions } from "@/server/phase3/engineering";

async function handleGET(request: Request) {
  try {
    await requireUser(request);
    return NextResponse.json(
      { revisions: await listApprovedDocumentRevisions() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = withOrganizationRoute(handleGET);
