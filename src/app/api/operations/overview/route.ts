import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse } from "@/server/errors";
import { listOverview } from "@/server/operations";

export async function GET(request:Request) {
  try {
    await requireUser(request);
    return NextResponse.json(await listOverview(), {headers:{"Cache-Control":"no-store"}});
  } catch(error) { return errorResponse(error); }
}
