import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse } from "@/server/errors";
import { listApprovedDocumentRevisions } from "@/server/phase3/engineering";

export async function GET(request: Request) {
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
