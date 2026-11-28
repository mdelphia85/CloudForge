import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { startMfaEnrollment } from "@/server/mfa";

export async function POST(request:Request) {
  try {
    requireSameOrigin(request);
    const user=await requireUser(request);
    const body=await readJson(request);
    if(typeof body.password!=="string"||body.password.length>256) {
      throw new HttpError(400,"INVALID_PASSWORD","Re-enter your account password.");
    }
    const result=await startMfaEnrollment(user.id,user.organizationId,body.password,user.mfaRecoveryAuthenticated);
    return NextResponse.json(result,{headers:{"Cache-Control":"no-store","Pragma":"no-cache"}});
  }catch(error){return errorResponse(error);}
}
