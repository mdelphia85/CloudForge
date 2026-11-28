import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { completeMfaEnrollment } from "@/server/mfa";

export async function POST(request:Request) {
  try {
    requireSameOrigin(request);
    const user=await requireUser(request);
    const body=await readJson(request);
    if(typeof body.code!=="string"||!/^\d{6}$/.test(body.code)) {
      throw new HttpError(400,"INVALID_MFA_CODE","Enter a six-digit code from your authenticator.");
    }
    const result=await completeMfaEnrollment(user.id,user.organizationId,body.code,user.mfaRecoveryAuthenticated);
    return NextResponse.json({...result,next:"Save your recovery codes and sign in again with MFA."},{
      headers:{"Cache-Control":"no-store","Pragma":"no-cache"},
    });
  }catch(error){return errorResponse(error);}
}
