import "server-only";
import {
  createCipheriv, createDecipheriv, createHash, createHmac,
  randomBytes, timingSafeEqual,
} from "node:crypto";
import { inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import { verifyPassword } from "@/server/password";

const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const OTP_STEP=30;
const OTP_DIGITS=6;
const PENDING_MINUTES=10;
const BACKUP_COUNT=10;

function secretKey():Buffer {
  const configured=process.env.CLOUDFORGE_MFA_ENCRYPTION_KEY ?? "";
  if(!/^[0-9a-fA-F]{64}$/.test(configured)) {
    throw new HttpError(503,"MFA_CONFIGURATION",
      "A 32-byte MFA encryption key must be configured before authenticator setup or verification.");
  }
  return Buffer.from(configured,"hex");
}

function encrypt(raw:string):string {
  const nonce=randomBytes(12);
  const cipher=createCipheriv("aes-256-gcm",secretKey(),nonce);
  const encrypted=Buffer.concat([cipher.update(raw,"utf8"),cipher.final()]);
  return [nonce,cipher.getAuthTag(),encrypted].map(b=>b.toString("base64url")).join(".");
}
function decrypt(encoded:string):string {
  try {
    const parts=encoded.split(".");
    if(parts.length!==3) throw new Error("invalid");
    const nonce=Buffer.from(parts[0],"base64url");
    const tag=Buffer.from(parts[1],"base64url");
    if(nonce.length!==12 || tag.length!==16)throw new Error("invalid");
    const decipher=createDecipheriv("aes-256-gcm",secretKey(),nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(parts[2],"base64url")),decipher.final(),
    ]).toString("utf8");
  }catch(error) {
    if(error instanceof HttpError)throw error;
    throw new HttpError(503,"MFA_DECRYPTION_FAILED",
      "Authenticator data could not be decrypted. Contact the installation administrator.");
  }
}

function base32(data:Buffer):string {
  let bits=0,acc=0,result="";
  for(const value of data) {
    acc=(acc<<8)|value;
    bits+=8;
    while(bits>=5) {
      bits-=5;
      result+=alphabet[(acc>>>bits)&31];
    }
    acc&=(1<<bits)-1;
  }
  if(bits>0)result+=alphabet[(acc<<(5-bits))&31];
  return result;
}
function unbase32(input:string):Buffer {
  let bits=0,acc=0;
  const output:number[]=[];
  for(const letter of input.toUpperCase()) {
    const digit=alphabet.indexOf(letter);
    if(digit<0)throw new Error("Invalid TOTP secret");
    acc=(acc<<5)|digit;
    bits+=5;
    if(bits>=8) {
      bits-=8;
      output.push((acc>>>bits)&255);
      acc&=(1<<bits)-1;
    }
  }
  return Buffer.from(output);
}
export function generateTotpSecret():string {
  return base32(randomBytes(20));
}
export function totpAt(secret:string,counter:number):string {
  const message=Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest=createHmac("sha1",unbase32(secret)).update(message).digest();
  const offset=digest[digest.length-1]&0xf;
  const number=(digest.readUInt32BE(offset)&0x7fffffff)%10**OTP_DIGITS;
  return String(number).padStart(OTP_DIGITS,"0");
}
export function matchedTotpCounter(
  secret:string,code:string,afterCounter=-1,now=Date.now(),
):number|null {
  if(!/^\d{6}$/.test(code))return null;
  const current=Math.floor(now/1000/OTP_STEP);
  for(const counter of [current-1,current,current+1]) {
    if(counter<=afterCounter || counter<0)continue;
    const expected=Buffer.from(totpAt(secret,counter));
    const provided=Buffer.from(code);
    if(timingSafeEqual(expected,provided))return counter;
  }
  return null;
}
const recoveryHash=(value:string)=>createHash("sha256").update(value).digest("hex");
function backupCodes():string[] {
  return Array.from({length:BACKUP_COUNT},()=>randomBytes(18).toString("base64url"));
}

export async function startMfaEnrollment(
  userId:string,organizationId:string,password:string,
  recoveryAuthenticated=false,
):Promise<{secret:string;otpauthUrl:string;expiresInSeconds:number}> {
  const key=secretKey();
  if(key.length!==32)throw new HttpError(503,"MFA_CONFIGURATION","Encryption key invalid.");
  const row=await inTransaction(async client=>{
    const result=await client.query<{
      email:string;password_hash:string;mfa_enabled:boolean;
    }>("SELECT email,password_hash,mfa_enabled FROM users WHERE id=$1 AND is_active FOR UPDATE",[userId]);
    if(!result.rows[0])throw new HttpError(401,"UNAUTHENTICATED","Sign in to continue.");
    if(result.rows[0].mfa_enabled && !recoveryAuthenticated)
      throw new HttpError(409,"MFA_ALREADY_ENABLED",
        "Sign in using an unused recovery code to replace a lost authenticator.");
    if(!await verifyPassword(password,result.rows[0].password_hash)) {
      throw new HttpError(401,"INVALID_CREDENTIALS","Password is incorrect.");
    }
    const secret=generateTotpSecret();
    await client.query(
      `UPDATE users SET mfa_pending_secret_encrypted=$2,
       mfa_pending_expires_at=now()+interval '10 minutes' WHERE id=$1`,
      [userId,encrypt(secret)],
    );
    await client.query(
      `INSERT INTO audit_events(actor_user_id,organization_id,action,entity_type,entity_id)
       VALUES($1,$2,$3,'user',$1)`,
      [userId,organizationId,result.rows[0].mfa_enabled
        ? "auth.mfa_replacement_started":"auth.mfa_setup_started"],
    );
    return {secret,email:result.rows[0].email};
  });
  const issuer="CloudForge";
  const label=encodeURIComponent(issuer+":"+row.email);
  const otpauthUrl=`otpauth://totp/${label}?secret=${row.secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return {secret:row.secret,otpauthUrl,expiresInSeconds:PENDING_MINUTES*60};
}

export async function completeMfaEnrollment(
  userId:string,organizationId:string,code:string,recoveryAuthenticated=false,
):Promise<{recoveryCodes:string[]}> {
  return inTransaction(async client=>{
    const result=await client.query<{
      mfa_enabled:boolean;mfa_pending_secret_encrypted:string|null;
      mfa_pending_expires_at:Date|null;
    }>(`SELECT mfa_enabled,mfa_pending_secret_encrypted,mfa_pending_expires_at
       FROM users WHERE id=$1 AND is_active FOR UPDATE`,[userId]);
    const row=result.rows[0];
    if(!row||!row.mfa_pending_secret_encrypted||
       !row.mfa_pending_expires_at||
       row.mfa_pending_expires_at.getTime()<=Date.now()) {
      throw new HttpError(400,"MFA_SETUP_EXPIRED","Start authenticator setup again.");
    }
    if(row.mfa_enabled && !recoveryAuthenticated) {
      throw new HttpError(403,"MFA_RECOVERY_REQUIRED","A recovery-authenticated session is required to replace an authenticator.");
    }
    const secret=decrypt(row.mfa_pending_secret_encrypted);
    const matched=matchedTotpCounter(secret,code);
    if(matched===null)throw new HttpError(401,"INVALID_MFA_CODE","Authenticator code is incorrect.");
    const codes=backupCodes();
    // Replacement invalidates every old emergency code; none survive
    // an authenticator change.
    await client.query("DELETE FROM user_mfa_recovery_codes WHERE user_id=$1",[userId]);
    await client.query(
      `UPDATE users SET mfa_secret_encrypted=mfa_pending_secret_encrypted,
        mfa_enabled=true,mfa_pending_secret_encrypted=NULL,
        mfa_pending_expires_at=NULL,mfa_last_counter=-1,session_epoch=session_epoch+1
       WHERE id=$1`,
      [userId],
    );
    for(const recoveryCode of codes) {
      await client.query(
        "INSERT INTO user_mfa_recovery_codes(user_id,code_hash) VALUES($1,$2)",
        [userId,recoveryHash(recoveryCode)],
      );
    }
    await client.query("DELETE FROM sessions WHERE user_id=$1",[userId]);
    await client.query(
      `INSERT INTO audit_events(actor_user_id,organization_id,action,entity_type,entity_id)
        VALUES($1,$2,$3,'user',$1)`,
      [userId,organizationId,row.mfa_enabled ? "auth.mfa_replaced" : "auth.mfa_enabled"],
    );
    return {recoveryCodes:codes};
  });
}

export async function verifyLoginMfa(userId:string,code:unknown):Promise<"totp"|"recovery"|false> {
  const supplied=typeof code==="string"?code.trim():"";
  if(!supplied || supplied.length>128)return false;
  return inTransaction(async client=>{
    const row=await client.query<{
      mfa_enabled:boolean;mfa_secret_encrypted:string|null;mfa_last_counter:string;
    }>(`SELECT mfa_enabled,mfa_secret_encrypted,mfa_last_counter::text
       FROM users WHERE id=$1 AND is_active FOR UPDATE`,[userId]);
    const item=row.rows[0];
    if(!item?.mfa_enabled||!item.mfa_secret_encrypted)return false;
    if(/^\d{6}$/.test(supplied)) {
      const matched=matchedTotpCounter(
        decrypt(item.mfa_secret_encrypted),supplied,Number(item.mfa_last_counter),
      );
      if(matched===null)return false;
      await client.query("UPDATE users SET mfa_last_counter=$2 WHERE id=$1",[userId,matched]);
      return "totp";
    }
    if(!/^[A-Za-z0-9_-]{24}$/.test(supplied))return false;
    const recovered=await client.query(
      `UPDATE user_mfa_recovery_codes SET consumed_at=now()
        WHERE user_id=$1 AND code_hash=$2 AND consumed_at IS NULL RETURNING code_hash`,
      [userId,recoveryHash(supplied)],
    );
    if(!recovered.rowCount)return false;
    await client.query(
      `INSERT INTO audit_events(actor_user_id,action,entity_type,entity_id,details)
        VALUES($1,'auth.mfa_recovery_used','user',$1,$2::jsonb)`,
      [userId,JSON.stringify({remainingRecoveryCodes:"Check account security settings"})],
    );
    return "recovery";
  });
}
