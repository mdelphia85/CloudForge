import { describe, expect, it } from "vitest";
import { assertSafeTestDatabaseUrl, UnsafeTestDatabaseError } from "./integration/database-guard";

const safe = "postgresql://cloudforge_test:pw@localhost:5432/cloudforge_test";
const check = (env: Record<string, string | undefined>) => () => assertSafeTestDatabaseUrl(env);

describe("integration test database guard", () => {
  it("accepts a local database and role dedicated to testing", () => {
    expect(assertSafeTestDatabaseUrl({ TEST_DATABASE_URL: safe })).toBe(safe);
    expect(check({ TEST_DATABASE_URL: "postgres://ci_test:pw@127.0.0.1:5433/app_test" })).not.toThrow();
    expect(check({ TEST_DATABASE_URL: "postgres://cloudforge_test:pw@[::1]:5432/cloudforge_test" })).not.toThrow();
  });

  it("requires TEST_DATABASE_URL and never falls back to DATABASE_URL", () => {
    expect(check({})).toThrow(UnsafeTestDatabaseError);
    expect(check({ TEST_DATABASE_URL: "" })).toThrow(/must be set explicitly/);
    expect(check({ DATABASE_URL: safe })).toThrow(/must be set explicitly/);
  });

  it("rejects malformed and non-postgres URLs", () => {
    expect(check({ TEST_DATABASE_URL: "not a url" })).toThrow(UnsafeTestDatabaseError);
    expect(check({ TEST_DATABASE_URL: "mysql://cloudforge_test:pw@localhost/cloudforge_test" })).toThrow(/postgres/);
  });

  it("rejects known hosted providers and Railway hosts", () => {
    for (const host of ["roundhouse.proxy.rlwy.net", "postgres.railway.internal", "db.abc.supabase.co", "x.neon.tech", "db.us-east-1.rds.amazonaws.com"]) {
      expect(check({ TEST_DATABASE_URL: `postgresql://cloudforge_test:pw@${host}:5432/cloudforge_test` }), host).toThrow(/hosted database provider/);
    }
  });

  it("rejects any non-local host, even with a test-looking name", () => {
    for (const host of ["db.internal.example.com", "10.0.0.5", "postgres", "localhost.evil.com"]) {
      expect(check({ TEST_DATABASE_URL: `postgresql://cloudforge_test:pw@${host}:5432/cloudforge_test` }), host).toThrow(/not local/);
    }
  });

  it("rejects production-looking and non-test database names", () => {
    for (const db of ["railway", "postgres", "cloudforge", "cloudforge_production", "prod_test"]) {
      expect(check({ TEST_DATABASE_URL: `postgresql://cloudforge_test:pw@localhost:5432/${db}` }), db).toThrow(/production|test/);
    }
    expect(check({ TEST_DATABASE_URL: "postgresql://cloudforge_test:pw@localhost:5432/orders" })).toThrow(/"test" segment/);
    expect(check({ TEST_DATABASE_URL: "postgresql://cloudforge_test:pw@localhost:5432/" })).toThrow(/name a database/);
  });

  it("requires a dedicated test role", () => {
    expect(check({ TEST_DATABASE_URL: "postgresql://postgres:pw@localhost:5432/cloudforge_test" })).toThrow(/test role/);
    expect(check({ TEST_DATABASE_URL: "postgresql://railway:pw@localhost:5432/cloudforge_test" })).toThrow(/test role/);
  });

  it("refuses a URL that matches DATABASE_URL", () => {
    expect(check({ TEST_DATABASE_URL: safe, DATABASE_URL: "postgresql://other:secret@localhost:5432/cloudforge_test" })).toThrow(/same database/);
    expect(check({ TEST_DATABASE_URL: safe, DATABASE_URL: "postgresql://x:y@roundhouse.proxy.rlwy.net:21166/railway" })).not.toThrow();
  });

  it("does not echo credentials in error messages", () => {
    try {
      assertSafeTestDatabaseUrl({ TEST_DATABASE_URL: "postgresql://cloudforge_test:SuperSecret123@db.abc.supabase.co:5432/cloudforge_test" });
    } catch (error) {
      expect(String(error)).not.toContain("SuperSecret123");
    }
  });
});
