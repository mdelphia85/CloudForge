import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  call, closeDatabases, hashToken, itemBody, loadHandlers, movementKey, resetDatabase, seedActors, STRONG_PASSWORD, testPool,
  type Actors, type Handlers,
} from "./harness";

let h: Handlers;
let actors: Actors;

beforeAll(async () => {
  await resetDatabase();
  h = await loadHandlers();
  actors = await seedActors(h);
  const seeded = await call(h.inventory.POST, { method: "POST", cookie: actors.admin.cookie, body: itemBody({ sku: "ROLE-1" }) });
  expect(seeded.status).toBe(201);
});
afterAll(closeDatabases);

describe("unauthenticated access", () => {
  it("returns 401 for every protected route", async () => {
    const checks = [
      call(h.inventory.GET),
      call(h.inventory.POST, { method: "POST", body: itemBody({ sku: "NOPE-1" }) }),
      call(h.movements.GET, { path: "/api/inventory/movements?sku=ROLE-1" }),
      call(h.movements.POST, { method: "POST", body: { type: "receipt", sku: "ROLE-1", quantity: "1", location: "L", bin: "B", idempotencyKey: movementKey() } }),
      call(h.users.POST, { method: "POST", body: { email: "x@example.test", displayName: "Xx", role: "viewer", password: STRONG_PASSWORD } }),
    ];
    for (const res of await Promise.all(checks)) {
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHENTICATED");
    }
  });

  it("returns 401 for malformed and unknown session cookies", async () => {
    for (const cookie of ["cloudforge_session=abc", `cloudforge_session=${"A".repeat(43)}`, "other=1", `cloudforge_session=${"a".repeat(200)}`]) {
      expect((await call(h.inventory.GET, { cookie })).status, cookie).toBe(401);
    }
  });

  it("does not leak any data in the 401 body", async () => {
    const res = await call(h.inventory.GET);
    expect(res.body).not.toHaveProperty("items");
  });
});

describe("session lifecycle", () => {
  it("rejects a session after its expiry time", async () => {
    const login = await call(h.login.POST, { method: "POST", body: { email: actors.viewer.email, password: STRONG_PASSWORD } });
    expect((await call(h.inventory.GET, { cookie: login.sessionCookie })).status).toBe(200);
    const token = login.sessionCookie!.split("=")[1];
    await testPool().query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE token_hash = $1", [hashToken(token)]);
    expect((await call(h.inventory.GET, { cookie: login.sessionCookie })).status).toBe(401);
  });

  it("rejects an active session once the account is deactivated", async () => {
    const created = await call(h.users.POST, {
      method: "POST", cookie: actors.admin.cookie,
      body: { email: "temp@example.test", displayName: "Temp User", role: "operator", password: STRONG_PASSWORD },
    });
    expect(created.status).toBe(201);
    const login = await call(h.login.POST, { method: "POST", body: { email: "temp@example.test", password: STRONG_PASSWORD } });
    expect((await call(h.inventory.GET, { cookie: login.sessionCookie })).status).toBe(200);
    await testPool().query("UPDATE users SET is_active = false WHERE email = 'temp@example.test'");
    expect((await call(h.inventory.GET, { cookie: login.sessionCookie })).status).toBe(401);
  });

  it("issues a distinct session token on every login", async () => {
    const a = await call(h.login.POST, { method: "POST", body: { email: actors.viewer.email, password: STRONG_PASSWORD } });
    const b = await call(h.login.POST, { method: "POST", body: { email: actors.viewer.email, password: STRONG_PASSWORD } });
    expect(a.sessionCookie).not.toBe(b.sessionCookie);
  });

  it("marks the session cookie Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const { sessionCookieOptions } = await import("@/server/auth");
      expect(sessionCookieOptions()).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict", path: "/" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("viewer role", () => {
  it("can read inventory and movement history", async () => {
    expect((await call(h.inventory.GET, { cookie: actors.viewer.cookie })).status).toBe(200);
    const history = await call(h.movements.GET, { cookie: actors.viewer.cookie, path: "/api/inventory/movements?sku=ROLE-1" });
    expect(history.status).toBe(200);
  });

  it("is forbidden from every write", async () => {
    const writes = [
      call(h.inventory.POST, { method: "POST", cookie: actors.viewer.cookie, body: itemBody({ sku: "VIEW-1" }) }),
      call(h.movements.POST, { method: "POST", cookie: actors.viewer.cookie, body: { type: "receipt", sku: "ROLE-1", quantity: "1", location: "L", bin: "B", idempotencyKey: movementKey() } }),
      call(h.users.POST, { method: "POST", cookie: actors.viewer.cookie, body: { email: "v@example.test", displayName: "Vv", role: "viewer", password: STRONG_PASSWORD } }),
    ];
    for (const res of await Promise.all(writes)) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
    }
    const created = await testPool().query("SELECT 1 FROM inventory_items WHERE sku = 'VIEW-1'");
    expect(created.rowCount).toBe(0);
  });
});

describe("operator role", () => {
  it("can create items and record movements", async () => {
    const item = await call(h.inventory.POST, { method: "POST", cookie: actors.operator.cookie, body: itemBody({ sku: "OPER-1" }) });
    expect(item.status).toBe(201);
    const move = await call(h.movements.POST, {
      method: "POST", cookie: actors.operator.cookie,
      body: { type: "receipt", sku: "OPER-1", quantity: "5", location: "Main warehouse", bin: "A-01", idempotencyKey: movementKey() },
    });
    expect(move.status).toBe(200);
  });

  it("cannot create users", async () => {
    const res = await call(h.users.POST, {
      method: "POST", cookie: actors.operator.cookie,
      body: { email: "o2@example.test", displayName: "Oo", role: "viewer", password: STRONG_PASSWORD },
    });
    expect(res.status).toBe(403);
  });
});

describe("admin role and user creation", () => {
  const newUser = (overrides: Record<string, unknown> = {}) => ({
    email: "new.person@example.test", displayName: "New Person", role: "viewer", password: STRONG_PASSWORD, ...overrides,
  });

  it("creates users, normalizes the email and records an audit event", async () => {
    const res = await call(h.users.POST, { method: "POST", cookie: actors.admin.cookie, body: newUser({ email: " New.Person@Example.TEST " }) });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: "new.person@example.test", role: "viewer" });
    expect(JSON.stringify(res.body)).not.toMatch(/scrypt|password/i);

    const audit = await testPool().query(
      "SELECT actor_user_id, entity_id, details FROM audit_events WHERE action = 'user.created' AND entity_id = $1", [res.body.user.id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_user_id).toBe(actors.admin.id);
    expect(audit.rows[0].details).toMatchObject({ email: "new.person@example.test", role: "viewer" });
  });

  it("returns 409 for a duplicate email", async () => {
    const res = await call(h.users.POST, { method: "POST", cookie: actors.admin.cookie, body: newUser() });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EMAIL_EXISTS");
  });

  it("rejects invalid roles, weak passwords and invalid emails", async () => {
    for (const overrides of [{ role: "superuser" }, { role: undefined }, { password: "weakpass" }, { email: "bad", displayName: "Okay Name" }]) {
      const res = await call(h.users.POST, { method: "POST", cookie: actors.admin.cookie, body: newUser({ email: "z@example.test", ...overrides }) });
      expect(res.status, JSON.stringify(overrides)).toBe(400);
    }
  });

  it("lets a newly created user sign in with the assigned role", async () => {
    const login = await call(h.login.POST, { method: "POST", body: { email: "new.person@example.test", password: STRONG_PASSWORD } });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe("viewer");
  });
});

describe("cross-site request protection", () => {
  it("rejects authenticated writes without a matching Origin header", async () => {
    for (const origin of [null, "https://evil.example", "http://localhost:3001"]) {
      const res = await call(h.inventory.POST, { method: "POST", cookie: actors.admin.cookie, origin, body: itemBody({ sku: "CSRF-1" }) });
      expect(res.status, String(origin)).toBe(403);
      expect(res.body.code).toBe("INVALID_ORIGIN");
    }
    expect((await testPool().query("SELECT 1 FROM inventory_items WHERE sku = 'CSRF-1'")).rowCount).toBe(0);
  });
});
