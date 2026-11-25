import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse } from "@/server/errors";
import { requireUuid } from "@/server/operations";
import { listServiceWork } from "@/server/phase3/field-service";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    return NextResponse.json(await listServiceWork(requireUuid(id, "serviceJobId"), user), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
