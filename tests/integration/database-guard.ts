export class UnsafeTestDatabaseError extends Error {
  constructor(reason: string) {
    super(`Refusing to run integration tests: ${reason}`);
    this.name = "UnsafeTestDatabaseError";
  }
}

// Integration tests may only ever talk to a database on the local machine
// (a developer instance or the GitHub Actions service container).
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const KNOWN_HOSTED_SUFFIXES = [
  ".rlwy.net",
  ".railway.app",
  ".railway.internal",
  ".railway.com",
  ".supabase.co",
  ".neon.tech",
  ".amazonaws.com",
  ".azure.com",
  ".render.com",
  ".vercel-storage.com",
];

const PRODUCTION_DATABASE_NAMES = new Set(["railway", "postgres", "cloudforge", "cloudforge_prod", "cloudforge_production"]);

function endpoint(raw: string): { host: string; port: string; database: string } | null {
  try {
    const url = new URL(raw);
    return {
      host: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
      port: url.port || "5432",
      database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    };
  } catch {
    return null;
  }
}

/**
 * Validates TEST_DATABASE_URL and returns it. It deliberately never reads
 * DATABASE_URL (other than to refuse a match) and never loads .env files.
 */
export function assertSafeTestDatabaseUrl(env: Record<string, string | undefined>): string {
  const raw = env.TEST_DATABASE_URL?.trim();
  if (!raw) {
    throw new UnsafeTestDatabaseError("TEST_DATABASE_URL must be set explicitly. It is never inferred from DATABASE_URL or .env files.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeTestDatabaseError("TEST_DATABASE_URL is not a valid URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new UnsafeTestDatabaseError("TEST_DATABASE_URL must be a postgres:// URL.");
  }

  const target = endpoint(raw);
  if (!target) throw new UnsafeTestDatabaseError("TEST_DATABASE_URL could not be parsed.");

  if (KNOWN_HOSTED_SUFFIXES.some((suffix) => target.host.endsWith(suffix))) {
    throw new UnsafeTestDatabaseError(`host "${target.host}" belongs to a hosted database provider.`);
  }
  if (!ALLOWED_HOSTS.has(target.host)) {
    throw new UnsafeTestDatabaseError(`host "${target.host}" is not local. Only localhost, 127.0.0.1 and ::1 are permitted.`);
  }

  if (!target.database) {
    throw new UnsafeTestDatabaseError("TEST_DATABASE_URL must name a database.");
  }
  if (PRODUCTION_DATABASE_NAMES.has(target.database.toLowerCase()) || /prod/i.test(target.database)) {
    throw new UnsafeTestDatabaseError(`database name "${target.database}" looks like a production database.`);
  }
  if (!/(^|[_-])test($|[_-])/i.test(target.database)) {
    throw new UnsafeTestDatabaseError(`database name "${target.database}" must contain a "test" segment (for example cloudforge_test).`);
  }

  const role = decodeURIComponent(url.username);
  if (!/(^|[_-])test($|[_-])/i.test(role)) {
    throw new UnsafeTestDatabaseError("the database role must be a dedicated test role whose name contains a \"test\" segment (for example cloudforge_test).");
  }

  const production = env.DATABASE_URL ? endpoint(env.DATABASE_URL) : null;
  if (production && production.host === target.host && production.port === target.port && production.database === target.database) {
    throw new UnsafeTestDatabaseError("TEST_DATABASE_URL points at the same database as DATABASE_URL.");
  }

  return raw;
}
