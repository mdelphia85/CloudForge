import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  call, closeDatabases, itemBody, loadHandlers, resetDatabase, STRONG_PASSWORD, TEST_BOOTSTRAP_TOKEN, testPool,
  type Handlers,
} from "./harness";

let handlers: Handlers;
beforeAll(async () => {
  await resetDatabase();
  handlers = await loadHandlers();
});
afterAll(closeDatabases);

it("protects bootstrap, login, and authenticated writes behind a reverse proxy", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_ORIGIN", "https://cloudforge.live");
  const proxy = {
    method: "POST",
    url: "http://internal.example:3000/api/test",
    headers: { "x-forwarded-host": "cloudforge.live", "x-forwarded-proto": "https" },
  };
  const bootstrap = {
    bootstrapToken: TEST_BOOTSTRAP_TOKEN, email: "proxy@example.test",
    displayName: "Proxy Admin", password: STRONG_PASSWORD,
  };
  try {
    for (const origin of [null, "https://attacker.example", "https://cloudforge.live.attacker.example"]) {
      const rejected = await call(handlers.bootstrap.POST, { ...proxy, origin, body: bootstrap });
      expect(rejected.status).toBe(403);
    }
    const admin = await call(handlers.bootstrap.POST, { ...proxy, origin: "https://cloudforge.live", body: bootstrap });
    expect(admin.status).toBe(201);
    expect(admin.setCookie).toMatch(/Secure/i);
    const login = { email: bootstrap.email, password: STRONG_PASSWORD };
    expect((await call(handlers.login.POST, { ...proxy, origin: "https://attacker.example", body: login })).status).toBe(403);
    expect((await call(handlers.login.POST, { ...proxy, origin: null, body: login })).status).toBe(403);
    const signedIn = await call(handlers.login.POST, { ...proxy, origin: "https://cloudforge.live", body: login });
    expect(signedIn.status).toBe(200);
    expect(signedIn.sessionCookie).toBeTruthy();
    for (const origin of [null, "https://attacker.example", "http://internal.example:3000"]) {
      expect((await call(handlers.inventory.POST, {
        ...proxy, origin, cookie: signedIn.sessionCookie, body: itemBody({ sku: "PROXY-REJECT" }),
      })).status).toBe(403);
    }
    const created = await call(handlers.inventory.POST, {
      ...proxy, origin: "https://cloudforge.live", cookie: signedIn.sessionCookie, body: itemBody({ sku: "PROXY-OK" }),
    });
    expect(created.status).toBe(201);
    const items = await testPool().query("SELECT sku FROM inventory_items ORDER BY sku");
    expect(items.rows).toEqual([{ sku: "PROXY-OK" }]);
  } finally {
    vi.unstubAllEnvs();
  }
});
