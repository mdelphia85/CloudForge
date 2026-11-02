import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertSafeTestDatabaseUrl } from "./database-guard";
import { TEST_BOOTSTRAP_TOKEN } from "./env";

export const ORIGIN = "http://localhost:3000";
export const STRONG_PASSWORD = "Correct-Horse-Battery-9!";
export { TEST_BOOTSTRAP_TOKEN };

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

let adminPool: pg.Pool | undefined;

// env.ts already compared TEST_DATABASE_URL with the shell's original DATABASE_URL
// before overwriting it, so later re-validation skips that one comparison.
function vettedTestUrl(): string {
  return assertSafeTestDatabaseUrl({ ...process.env, DATABASE_URL: undefined });
}

/** A direct connection for assertions; always re-validated through the guard. */
export function testPool(): pg.Pool {
  adminPool ??= new pg.Pool({ connectionString: vettedTestUrl(), max: 3 });
  return adminPool;
}

export function runMigrations(): { status: number | null; output: string } {
  const url = vettedTestUrl();
  const result = spawnSync(process.execPath, ["scripts/migrate.mjs"], {
    cwd: repoRoot,
    // NODE_ENV=test stops @next/env from loading .env.local in the child process.
    env: { ...process.env, DATABASE_URL: url, NODE_ENV: "test" },
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Wipes the guarded test database and re-applies every migration. */
export async function resetDatabase(): Promise<void> {
  const pool = testPool();
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
  const migrated = runMigrations();
  if (migrated.status !== 0) throw new Error(`Migrations failed:\n${migrated.output}`);
}

export async function closeDatabases(): Promise<void> {
  await globalThis.cloudForgePool?.end();
  globalThis.cloudForgePool = undefined;
  await adminPool?.end();
  adminPool = undefined;
}

type Handler = (request: Request) => Promise<Response>;

export type CallOptions = {
  method?: string;
  path?: string;
  body?: unknown;
  rawBody?: string;
  cookie?: string | null;
  origin?: string | null;
  headers?: Record<string, string>;
};

export type CallResult = {
  status: number;
  // Route responses are arbitrary JSON; tests assert on their shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: Record<string, any>;
  setCookie: string | null;
  sessionCookie: string | null;
};

export async function call(handler: Handler, options: CallOptions = {}): Promise<CallResult> {
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers);
  const origin = options.origin === undefined ? (method === "GET" ? null : ORIGIN) : options.origin;
  if (origin) headers.set("origin", origin);
  if (options.cookie) headers.set("cookie", options.cookie);

  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined) headers.set("content-type", "application/json");

  const response = await handler(new Request(`${ORIGIN}${options.path ?? "/api/test"}`, { method, headers, body }));
  const setCookie = response.headers.get("set-cookie");
  const match = setCookie?.match(/cloudforge_session=([^;]*)/);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : {},
    setCookie,
    sessionCookie: match && match[1] ? `cloudforge_session=${match[1]}` : null,
  };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

let sequence = 0;
export const uniqueSuffix = () => `${Date.now().toString(36)}${(sequence++).toString(36)}`.toUpperCase();

export type Handlers = Awaited<ReturnType<typeof loadHandlers>>;

export async function loadHandlers() {
  const [bootstrap, login, logout, status, users, inventory, movements, ready] = await Promise.all([
    import("@/app/api/auth/bootstrap/route"),
    import("@/app/api/auth/login/route"),
    import("@/app/api/auth/logout/route"),
    import("@/app/api/auth/status/route"),
    import("@/app/api/users/route"),
    import("@/app/api/inventory/route"),
    import("@/app/api/inventory/movements/route"),
    import("@/app/api/health/ready/route"),
  ]);
  return { bootstrap, login, logout, status, users, inventory, movements, ready };
}

export type Actors = {
  admin: { cookie: string; email: string; id: string };
  operator: { cookie: string; email: string };
  viewer: { cookie: string; email: string };
};

/** Bootstraps the first admin, then creates an operator and a viewer through the API. */
export async function seedActors(h: Handlers): Promise<Actors> {
  const adminEmail = "admin@example.test";
  const boot = await call(h.bootstrap.POST, {
    method: "POST",
    body: { bootstrapToken: TEST_BOOTSTRAP_TOKEN, email: adminEmail, displayName: "Admin User", password: STRONG_PASSWORD },
  });
  if (boot.status !== 201 || !boot.sessionCookie) throw new Error(`Bootstrap failed: ${JSON.stringify(boot.body)}`);

  const make = async (role: "operator" | "viewer") => {
    const email = `${role}@example.test`;
    const created = await call(h.users.POST, {
      method: "POST",
      cookie: boot.sessionCookie,
      body: { email, displayName: `${role} user`, role, password: STRONG_PASSWORD },
    });
    if (created.status !== 201) throw new Error(`Creating ${role} failed: ${JSON.stringify(created.body)}`);
    const signedIn = await call(h.login.POST, { method: "POST", body: { email, password: STRONG_PASSWORD } });
    if (signedIn.status !== 200 || !signedIn.sessionCookie) throw new Error(`Login for ${role} failed`);
    return { cookie: signedIn.sessionCookie, email };
  };

  return {
    admin: { cookie: boot.sessionCookie, email: adminEmail, id: boot.body.user.id },
    operator: await make("operator"),
    viewer: await make("viewer"),
  };
}

export type ItemSeed = Partial<{
  sku: string; name: string; category: string; location: string; bin: string; onHand: string | number; reorder: string | number; unit: string;
}>;

export const itemBody = (overrides: ItemSeed = {}) => ({
  sku: "SKU-1", name: "Hex bolt M8", category: "Fasteners", location: "Main warehouse", bin: "A-01",
  onHand: "10", reorder: "4", unit: "ea", ...overrides,
});

let movementCounter = 0;
export const movementKey = () => `idem-${Date.now().toString(36)}-${movementCounter++}`;
