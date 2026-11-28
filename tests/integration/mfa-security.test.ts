import {afterAll,beforeAll,expect,it} from "vitest";
import {
  call,closeDatabases,loadHandlers,resetDatabase,seedActors,
  STRONG_PASSWORD,testPool,type Actors,type Handlers,
} from "./harness";
import {totpAt,matchedTotpCounter} from "@/server/mfa";
import * as mfaSetup from "@/app/api/auth/mfa/setup/route";
import * as mfaVerify from "@/app/api/auth/mfa/verify/route";
import * as inventory from "@/app/api/inventory/route";

const pathSetup="/api/auth/mfa/setup";
const pathVerify="/api/auth/mfa/verify";
const pathLogin="/api/auth/login";
const originalKey=process.env.CLOUDFORGE_MFA_ENCRYPTION_KEY;
const originalRequired=process.env.CLOUDFORGE_MFA_REQUIRED;
let h:Handlers;
let actors:Actors;
let secret="";
let codes:string[]=[];
const login=(mfaCode?:string,password=STRONG_PASSWORD)=>call(h.login.POST,{
  method:"POST",path:pathLogin,body:{
    email:actors.admin.email,password,...(mfaCode?{mfaCode}:{}),
  },
});
const start=(password:string)=>call(mfaSetup.POST,{
  method:"POST",path:pathSetup,cookie:actors.admin.cookie,body:{password},
});
const confirm=(code:string)=>call(mfaVerify.POST,{
  method:"POST",path:pathVerify,cookie:actors.admin.cookie,body:{code},
});

beforeAll(async()=>{
  await resetDatabase();
  h=await loadHandlers();
  actors=await seedActors(h);
  process.env.CLOUDFORGE_MFA_ENCRYPTION_KEY="ab".repeat(32);
});
afterAll(async()=>{
  if(originalKey===undefined)delete process.env.CLOUDFORGE_MFA_ENCRYPTION_KEY;
  else process.env.CLOUDFORGE_MFA_ENCRYPTION_KEY=originalKey;
  if(originalRequired===undefined)delete process.env.CLOUDFORGE_MFA_REQUIRED;
  else process.env.CLOUDFORGE_MFA_REQUIRED=originalRequired;
  await closeDatabases();
});

it("rejects MFA enrollment from an unauthenticated or cross-origin request",async()=>{
  const noUser=await call(mfaSetup.POST,{
    method:"POST",path:pathSetup,body:{password:STRONG_PASSWORD},
  });
  expect(noUser.status).toBe(401);
  const wrongOrigin=await call(mfaSetup.POST,{
    method:"POST",path:pathSetup,cookie:actors.admin.cookie,
    origin:"https://untrusted.example.test",body:{password:STRONG_PASSWORD},
  });
  expect(wrongOrigin.status).toBe(403);
  const badPassword=await start("wrong-password");
  expect(badPassword.status).toBe(401);
});

it("enforces setup for commercial operations while letting existing users enroll",async()=>{
  process.env.CLOUDFORGE_MFA_REQUIRED="true";
  const blocked=await call(inventory.GET,{
    path:"/api/inventory",cookie:actors.admin.cookie,
  });
  expect(blocked.status).toBe(403);
  expect(blocked.body.code).toBe("MFA_SETUP_REQUIRED");
  const setup=await start(STRONG_PASSWORD);
  expect(setup.status).toBe(200);
  secret=String(setup.body.secret);
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  expect(setup.body.otpauthUrl).toContain("otpauth://totp/");
  const stored=await testPool().query<{mfa_pending_secret_encrypted:string}>(
    "SELECT mfa_pending_secret_encrypted FROM users WHERE id=$1",[actors.admin.id],
  );
  expect(stored.rows[0].mfa_pending_secret_encrypted).not.toContain(secret);
  const incorrect=await confirm("000000"===totpAt(secret,Math.floor(Date.now()/30000))?"111111":"000000");
  expect(incorrect.status).toBe(401);
  const good=await confirm(totpAt(secret,Math.floor(Date.now()/30000)));
  expect(good.status).toBe(200);
  codes=good.body.recoveryCodes as string[];
  expect(codes).toHaveLength(10);
  expect(new Set(codes).size).toBe(10);
  expect(codes.every(code=>/^[A-Za-z0-9_-]{24}$/.test(code))).toBe(true);
  const storedCodes=await testPool().query<{code_hash:string}>(
    "SELECT code_hash FROM user_mfa_recovery_codes WHERE user_id=$1",
    [actors.admin.id],
  );
  expect(storedCodes.rows).toHaveLength(10);
  expect(storedCodes.rows.some(row=>codes.includes(row.code_hash))).toBe(false);
  const revoked=await call(inventory.GET,{
    path:"/api/inventory",cookie:actors.admin.cookie,
  });
  expect(revoked.status).toBe(401);
});

it("requires an MFA code before issuing a login cookie and rejects incorrect codes",async()=>{
  const without=await login();
  expect(without.status).toBe(401);
  expect(without.body.code).toBe("MFA_REQUIRED");
  expect(without.sessionCookie).toBeNull();
  const wrong=await login("123456"===totpAt(secret,Math.floor(Date.now()/30000))?"654321":"123456");
  expect(wrong.status).toBe(401);
  expect(wrong.sessionCookie).toBeNull();
  const withCode=await login(totpAt(secret,Math.floor(Date.now()/30000)));
  expect(withCode.status).toBe(200);
  expect(withCode.body.user.mfaEnabled).toBe(true);
  expect(withCode.sessionCookie).toBeTruthy();
  const authorized=await call(inventory.GET,{
    path:"/api/inventory",cookie:withCode.sessionCookie,
  });
  expect(authorized.status).toBe(200);
});

it("rejects reusing the same authenticator time-step code",async()=>{
  const replay=await login(totpAt(secret,Math.floor(Date.now()/30000)));
  expect(replay.status).toBe(401);
  expect(replay.sessionCookie).toBeNull();
});

it("consumes recovery codes exactly once without storing plaintext",async()=>{
  const first=await login(codes[0]);
  expect(first.status).toBe(200);
  expect(first.sessionCookie).toBeTruthy();
  const repeated=await login(codes[0]);
  expect(repeated.status).toBe(401);
  const second=await login(codes[1]);
  expect(second.status).toBe(200);
  const remaining=await testPool().query<{count:number}>(
    "SELECT count(*)::int AS count FROM user_mfa_recovery_codes WHERE user_id=$1 AND consumed_at IS NULL",
    [actors.admin.id],
  );
  expect(remaining.rows[0].count).toBe(8);
});

it("replaces a lost MFA device ONLY from a one-use-recovery-authenticated session",async()=>{
  expect(matchedTotpCounter(secret,totpAt(secret,100),100,100*30*1000)).toBeNull();
  expect(matchedTotpCounter(secret,totpAt(secret,100),-1,(100+6)*30*1000)).toBeNull();
  const normal=await login(totpAt(secret,Math.floor(Date.now()/30000)+1));
  expect(normal.status).toBe(200);
  expect(normal.body.user.mfaRecoveryAuthenticated).toBe(false);
  const forbidden=await call(mfaSetup.POST,{
    method:"POST",path:pathSetup,cookie:normal.sessionCookie,
    body:{password:STRONG_PASSWORD},
  });
  expect(forbidden.status).toBe(409);
  const recovered=await login(codes[2]);
  expect(recovered.status).toBe(200);
  expect(recovered.body.user.mfaRecoveryAuthenticated).toBe(true);
  const replacement=await call(mfaSetup.POST,{
    method:"POST",path:pathSetup,cookie:recovered.sessionCookie,
    body:{password:STRONG_PASSWORD},
  });
  expect(replacement.status).toBe(200);
  const replacementSecret=String(replacement.body.secret);
  expect(replacementSecret).toMatch(/^[A-Z2-7]{32}$/);
  expect(replacementSecret).not.toBe(secret);
  const unauthorizedCompletion=await call(mfaVerify.POST,{
    method:"POST",path:pathVerify,cookie:normal.sessionCookie,
    body:{code:totpAt(replacementSecret,Math.floor(Date.now()/30000))},
  });
  expect(unauthorizedCompletion.status).toBe(403);
  expect(unauthorizedCompletion.body.code).toBe("MFA_RECOVERY_REQUIRED");
  const completed=await call(mfaVerify.POST,{
    method:"POST",path:pathVerify,cookie:recovered.sessionCookie,
    body:{code:totpAt(replacementSecret,Math.floor(Date.now()/30000))},
  });
  expect(completed.status).toBe(200);
  const newCodes=completed.body.recoveryCodes as string[];
  expect(newCodes).toHaveLength(10);
  expect(new Set(newCodes).size).toBe(10);
  const oldSession=await call(inventory.GET,{
    path:"/api/inventory",cookie:recovered.sessionCookie,
  });
  expect(oldSession.status).toBe(401);
  const oldCode=await login(codes[3]);
  expect(oldCode.status).toBe(401);
  const newRecovery=await login(newCodes[0]);
  expect(newRecovery.status).toBe(200);
  expect(newRecovery.body.user.mfaRecoveryAuthenticated).toBe(true);
  const passwordOnly=await login();
  expect(passwordOnly.status).toBe(401);
});

it("MFA encryption must be configured; missing key fails closed",async()=>{
  process.env.CLOUDFORGE_MFA_ENCRYPTION_KEY="";
  const denied=await login("123456");
  expect(denied.status).toBe(503);
  expect(denied.sessionCookie).toBeNull();
  process.env.CLOUDFORGE_MFA_ENCRYPTION_KEY="ab".repeat(32);
});
