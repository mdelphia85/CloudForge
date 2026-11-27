import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  call, closeDatabases, hashToken, loadHandlers, resetDatabase, STRONG_PASSWORD, TEST_BOOTSTRAP_TOKEN, testPool,
  type Handlers,
} from "./harness";

let h: Handlers;

beforeAll(async () => {
  await resetDatabase();
  h = await loadHandlers();
});
afterAll(closeDatabases);

const bootstrapBody = (overrides: Record<string, unknown> = {}) => ({
  bootstrapToken: TEST_BOOTSTRAP_TOKEN,
  email: "Owner@Example.test",
  displayName: "Plant Owner",
  password: STRONG_PASSWORD,
  ...overrides,
});

describe("first-admin bootstrap", () => {
  it("reports that setup is required and enabled on an empty database", async () => {
    const res = await call(h.status.GET);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ setupRequired: true, setupEnabled: true, user: null });
  });

  it("reports the database as ready once migrations are applied", async () => {
    const res = await call(h.ready.GET);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
  });

  it("rejects requests without a same-origin Origin header", async () => {
    expect((await call(h.bootstrap.POST, { method: "POST", origin: null, body: bootstrapBody() })).status).toBe(403);
    const foreign = await call(h.bootstrap.POST, { method: "POST", origin: "https://evil.example", body: bootstrapBody() });
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("INVALID_ORIGIN");
  });

  it("rejects a wrong or missing bootstrap token", async () => {
    const wrong = await call(h.bootstrap.POST, { method: "POST", body: bootstrapBody({ bootstrapToken: "x".repeat(40) }) });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe("INVALID_BOOTSTRAP_TOKEN");
    const missing = await call(h.bootstrap.POST, { method: "POST", body: bootstrapBody({ bootstrapToken: undefined }) });
    expect(missing.status).toBe(403);
  });

  it("is disabled when the configured token is shorter than 32 characters", async () => {
    vi.stubEnv("BOOTSTRAP_ADMIN_TOKEN", "too-short");
    try {
      const res = await call(h.bootstrap.POST, { method: "POST", body: bootstrapBody({ bootstrapToken: "too-short" }) });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("BOOTSTRAP_DISABLED");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects weak passwords, bad emails and short names without creating a user", async () => {
    for (const overrides of [
      { password: "short" },
      { password: "alllowercase-password1!" },
      { password: "NoDigitsOrSymbolsHere" },
      { email: "not-an-email" },
      { displayName: "x" },
    ]) {
      const res = await call(h.bootstrap.POST, { method: "POST", body: bootstrapBody(overrides) });
      expect(res.status, JSON.stringify(overrides)).toBe(400);
    }
    const users = await testPool().query("SELECT count(*)::int AS n FROM users");
    expect(users.rows[0].n).toBe(0);
  });

  it("rejects non-JSON and oversized bodies", async () => {
    expect((await call(h.bootstrap.POST, { method: "POST", rawBody: "not json" })).status).toBe(400);
    expect((await call(h.bootstrap.POST, { method: "POST", rawBody: "[]" })).status).toBe(400);
    const big = await call(h.bootstrap.POST, { method: "POST", rawBody: JSON.stringify({ filler: "a".repeat(70_000) }) });
    expect(big.status).toBe(413);
  });

  it("creates the first admin with a hardened session cookie and stores only hashes", async () => {
    const res = await call(h.bootstrap.POST, { method: "POST", body: bootstrapBody() });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: "owner@example.test", displayName: "Plant Owner", role: "admin" });
    expect(res.body.user).not.toHaveProperty("password_hash");

    const cookie = res.setCookie ?? "";
    expect(cookie).toMatch(/cloudforge_session=[A-Za-z0-9_-]{43}/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=strict/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).toMatch(/Max-Age=43200/i);

    const user = await testPool().query("SELECT password_hash, role, is_active FROM users");
    expect(user.rows).toHaveLength(1);
    expect(user.rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(user.rows[0].password_hash).not.toContain(STRONG_PASSWORD);
    expect(user.rows[0]).toMatchObject({ role: "admin", is_active: true });

    const token = res.sessionCookie!.split("=")[1];
    const session = await testPool().query("SELECT token_hash, expires_at > now() AS live FROM sessions");
    expect(session.rows).toHaveLength(1);
    expect(session.rows[0].token_hash).toBe(hashToken(token));
    expect(session.rows[0].token_hash).not.toBe(token);
    expect(session.rows[0].live).toBe(true);
  });

  it("refuses a second bootstrap once an admin exists", async () => {
    const res = await call(h.bootstrap.POST, { method: "POST", body: bootstrapBody({ email: "second@example.test" }) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SETUP_COMPLETE");
    const status = await call(h.status.GET);
    expect(status.body.setupRequired).toBe(false);
  });

  it("lets only one of two simultaneous bootstrap requests succeed", async () => {
    await resetDatabase();
    const attempt = (email: string) => call(h.bootstrap.POST, { method: "POST", body: bootstrapBody({ email }) });
    const results = await Promise.all([attempt("a@example.test"), attempt("b@example.test")]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const users = await testPool().query("SELECT count(*)::int AS n FROM users");
    expect(users.rows[0].n).toBe(1);
  });
});

describe("login and logout", () => {
  beforeAll(async () => {
    await resetDatabase();
    await call(h.bootstrap.POST, { method: "POST", body: bootstrapBody() });
  });

  const login = (body: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    call(h.login.POST, { method: "POST", body, ...extra });

  it("signs in with correct credentials, ignoring email case and whitespace", async () => {
    const res = await login({ email: "  OWNER@example.TEST ", password: STRONG_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("admin");
    expect(res.sessionCookie).toBeTruthy();
  });

  it("returns the same generic 401 for a wrong password and an unknown account", async () => {
    const wrongPassword = await login({ email: "owner@example.test", password: "Wrong-Password-123!" });
    const unknownUser = await login({ email: "nobody@example.test", password: STRONG_PASSWORD });
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownUser.body);
    expect(wrongPassword.sessionCookie).toBeNull();
  });

  it("rejects missing fields, oversized fields and a bad origin", async () => {
    expect((await login({ email: "owner@example.test" })).status).toBe(400);
    expect((await login({ email: "", password: "x" })).status).toBe(400);
    expect((await login({ email: "owner@example.test", password: "x".repeat(257) })).status).toBe(400);
    expect((await login({ email: "owner@example.test", password: STRONG_PASSWORD }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await login({ email: "owner@example.test", password: STRONG_PASSWORD }, { origin: null })).status).toBe(403);
  });

  it("blocks deactivated accounts and their existing sessions", async () => {
    const signedIn = await login({ email: "owner@example.test", password: STRONG_PASSWORD });
    await testPool().query("UPDATE users SET is_active = false WHERE email = 'owner@example.test'");
    try {
      expect((await login({ email: "owner@example.test", password: STRONG_PASSWORD })).status).toBe(401);
      const status = await call(h.status.GET, { cookie: signedIn.sessionCookie });
      expect(status.body.user).toBeNull();
    } finally {
      await testPool().query("UPDATE users SET is_active = true WHERE email = 'owner@example.test'");
    }
  });

  it("logs out by deleting the server-side session and expiring the cookie", async () => {
    const signedIn = await login({ email: "owner@example.test", password: STRONG_PASSWORD });
    const before = await call(h.status.GET, { cookie: signedIn.sessionCookie });
    expect(before.body.user?.email).toBe("owner@example.test");

    const out = await call(h.logout.POST, { method: "POST", cookie: signedIn.sessionCookie });
    expect(out.status).toBe(200);
    expect(out.setCookie).toMatch(/Max-Age=0/i);

    const after = await call(h.status.GET, { cookie: signedIn.sessionCookie });
    expect(after.body.user).toBeNull();
    const token = signedIn.sessionCookie!.split("=")[1];
    const rows = await testPool().query("SELECT 1 FROM sessions WHERE token_hash = $1", [hashToken(token)]);
    expect(rows.rowCount).toBe(0);
  });

  it("requires a same-origin Origin header to log out", async () => {
    const res = await call(h.logout.POST, { method: "POST", origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("writes audit events for bootstrap, login and logout", async () => {
    const actions = await testPool().query("SELECT DISTINCT action FROM audit_events ORDER BY action");
    expect(actions.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["auth.bootstrap", "auth.login", "auth.logout", "user.bootstrap"]));
  });

  it("throttles repeated failed sign-in attempts and releases the lock after expiry", async () => {
    await testPool().query("DELETE FROM auth_login_attempts");

    for (let i = 0; i < 7; i++) {
      const result = await login({ email: "owner@example.test", password: "Wrong-Password-123!" });
      expect(result.status).toBe(401);
    }

    const eighth = await login({ email: "owner@example.test", password: "Wrong-Password-123!" });
    expect(eighth.status).toBe(429);
    expect(eighth.body.code).toBe("TOO_MANY_ATTEMPTS");

    const correctBlocked = await login({ email: "owner@example.test", password: STRONG_PASSWORD });
    expect(correctBlocked.status).toBe(429);
    expect(correctBlocked.sessionCookie).toBeNull();

    await testPool().query(
      "UPDATE auth_login_attempts SET blocked_until = now() - interval '1 minute', " +
      "window_started_at = now() - interval '11 minutes'",
    );

    const success = await login({ email: "owner@example.test", password: STRONG_PASSWORD });
    expect(success.status).toBe(200);
    const count = await testPool().query("SELECT count(*)::int AS n FROM auth_login_attempts");
    expect(count.rows[0].n).toBe(0);
  });

  it("applies the same throttling to unknown accounts without revealing whether an account exists", async () => {
    const email = "unknown-throttled@example.test";
    for (let i = 0; i < 7; i++) {
      const response = await login({ email, password: "Wrong-Password-123!" });
      expect(response.status).toBe(401);
    }
    const response = await login({ email, password: "Wrong-Password-123!" });
    expect(response.status).toBe(429);
    expect(response.body.code).toBe("TOO_MANY_ATTEMPTS");
  });

  it.todo("records failed login attempts in the audit log (not implemented - see Phase 1 report)");
});

describe("administrator account controls", () => {
  it("restricts account administration, revokes sessions, and prevents restoration of disabled sessions", async () => {
    await resetDatabase();
    const accountRoute = await import("@/app/api/users/[id]/route");
    const admin = await call(h.bootstrap.POST, { method: "POST", body: bootstrapBody() });
    const created = await call(h.users.POST, {
      method: "POST", cookie: admin.sessionCookie,
      body: { email: "worker@example.test", displayName: "Worker", role: "operator", password: STRONG_PASSWORD },
    });
    expect(created.status).toBe(201);
    const workerId = String(created.body.user.id);
    const signIn = () => call(h.login.POST, {
      method: "POST", body: { email: "worker@example.test", password: STRONG_PASSWORD },
    });
    const action = (id: string, cookie: string | null, value: string) => accountRoute.PATCH(
      new Request(`http://localhost:3000/api/users/${id}`, {
        method: "PATCH",
        headers: { origin: "http://localhost:3000", cookie: cookie ?? "", "content-type": "application/json" },
        body: JSON.stringify({ action: value }),
      }),
      { params: Promise.resolve({ id }) },
    );
    const worker = await signIn();
    expect(worker.status).toBe(200);
    const epoch = (await testPool().query("SELECT session_epoch FROM users WHERE id = $1", [workerId])).rows[0].session_epoch as number;
    expect((await call(h.users.GET, { cookie: worker.sessionCookie })).status).toBe(403);
    expect((await action(workerId, worker.sessionCookie, "disable")).status).toBe(403);
    expect((await action(String(admin.body.user.id), admin.sessionCookie, "disable")).status).toBe(409);

    const revoked = await action(workerId, admin.sessionCookie, "revoke_sessions");
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).revokedSessions).toBe(1);
    const { createSession, newSessionToken } = await import("@/server/auth");
    await expect(createSession(workerId, newSessionToken(), "auth.login", epoch)).rejects.toMatchObject({
      status: 401, code: "INVALID_CREDENTIALS",
    });
    expect((await call(h.status.GET, { cookie: worker.sessionCookie })).body.user).toBeNull();
    const nextSession = await signIn();
    expect(nextSession.status).toBe(200);
    expect((await action(workerId, admin.sessionCookie, "disable")).status).toBe(200);
    expect((await signIn()).status).toBe(401);
    expect((await action(workerId, admin.sessionCookie, "enable")).status).toBe(200);
    expect((await call(h.status.GET, { cookie: nextSession.sessionCookie })).body.user).toBeNull();
    expect((await signIn()).status).toBe(200);
    const audit = await testPool().query("SELECT action FROM audit_events WHERE entity_type='user' AND entity_id=$1", [workerId]);
    expect(audit.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      "user.revoke_sessions", "user.disable", "user.enable",
    ]));
  });
});
