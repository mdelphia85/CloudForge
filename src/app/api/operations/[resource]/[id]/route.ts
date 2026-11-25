import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { isResource, requireUuid, updateStatus, operationsError } from "@/server/operations";

type Context = {params:Promise<{resource:string;id:string}>};
export async function PATCH(request:Request,{params}:Context) {
  try {
    requireSameOrigin(request);
    const user=await requireUser(request);
    requireRole(user,"admin","operator");
    const {resource,id}=await params;
    if (!isResource(resource)) throw new HttpError(404,"NOT_FOUND","Unknown module.");
    const body=await readJson(request);
    return NextResponse.json(await updateStatus(resource,requireUuid(id),body.status,user));
  } catch (error) { return errorResponse(operationsError(error)); }
}
