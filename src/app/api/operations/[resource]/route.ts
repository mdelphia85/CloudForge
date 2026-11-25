import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { isResource, listResource, createResource, operationsError } from "@/server/operations";

type Context = { params: Promise<{resource:string}> };
export async function GET(request:Request, {params}:Context) {
  try {
    const {resource}=await params;
    if (!isResource(resource)) throw new HttpError(404,"NOT_FOUND","Unknown module.");
    await requireUser(request);
    return NextResponse.json({records:await listResource(resource)}, {headers:{"Cache-Control":"no-store"}});
  } catch (error) { return errorResponse(error); }
}
export async function POST(request:Request, {params}:Context) {
  try {
    requireSameOrigin(request);
    const user=await requireUser(request);
    requireRole(user,"admin","operator");
    const {resource}=await params;
    if (!isResource(resource)) throw new HttpError(404,"NOT_FOUND","Unknown module.");
    return NextResponse.json(await createResource(resource,await readJson(request),user),{status:201});
  } catch (error) { return errorResponse(operationsError(error)); }
}
