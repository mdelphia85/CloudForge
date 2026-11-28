import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  closeDatabases, loadHandlers, resetDatabase, seedActors, testPool,
} from "./harness";
import { inTransaction } from "@/server/db";
import { requireLicensedModule } from "@/server/license-entitlements";
import { HttpError } from "@/server/errors";

const key = generateKeyPairSync("ed25519");
const publicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString();
const originalKey = process.env.LICENSE_PUBLIC_KEY;
let organizationId = "";
let adminId = "";

type Fixture = {
  modules?: string[]; seatLimit?: number; issuedAt?: string; activatedAt?: string;
  expiresAt?: string; signature?: string;
};
async function installLicense({
  modules = ["inventory", "engineering"], seatLimit = 3,
  issuedAt = "2026-11-01T00:00:00.000Z",
  activatedAt = issuedAt,
  expiresAt = "2027-11-01T00:00:00.000Z",
  signature,
}: Fixture = {}) {
  const claims = {
    version: 1, licenseId: randomUUID(), organizationId, licenseType: "air_gapped",
    tier: "professional", seatLimit, modules, issuedAt, activatedAt, expiresAt,
  };
  const bytes = Buffer.from(JSON.stringify(claims));
  const payload = bytes.toString("base64url");
  const sig = signature ?? sign(null, bytes, key.privateKey).toString("base64url");
  await testPool().query(
    `INSERT INTO organization_licenses
       (license_id,organization_id,signed_payload,signature,issued_at,activated_at,expires_at,installed_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [claims.licenseId, organizationId, payload, sig, issuedAt, activatedAt, expiresAt, adminId],
  );
}

async function validate(module: "inventory" | "engineering" | "production", date = "2026-11-15T00:00:00.000Z") {
  return inTransaction(client => requireLicensedModule(client, organizationId, module, new Date(date)));
}

beforeAll(async () => {
  await resetDatabase();
  const actors = await seedActors(await loadHandlers());
  adminId = actors.admin.id;
  organizationId = (await testPool().query<{ id: string }>(
    "SELECT id FROM organizations WHERE identifier='existing-installation'",
  )).rows[0].id;
  process.env.LICENSE_PUBLIC_KEY = publicKey;
});
afterAll(async () => {
  if (originalKey === undefined) delete process.env.LICENSE_PUBLIC_KEY;
  else process.env.LICENSE_PUBLIC_KEY = originalKey;
  await closeDatabases();
});

it("requires an installed signed license and validates module, term, and seat count", async () => {
  await expect(validate("inventory")).rejects.toMatchObject({
    status: 402, code: "LICENSE_REQUIRED",
  } satisfies Partial<HttpError>);
  await installLicense();
  expect(await validate("engineering")).toMatchObject({
    status: "active", claims: { organizationId, seatLimit: 3 },
  });
  await expect(validate("production")).rejects.toMatchObject({
    status: 403, code: "MODULE_NOT_LICENSED",
  } satisfies Partial<HttpError>);
});

it("applies the grace period and rejects expired licenses", async () => {
  expect((await validate("inventory", "2027-11-01T00:00:00.000Z")).status).toBe("grace");
  await expect(validate("inventory", "2027-12-01T00:00:00.000Z")).rejects.toMatchObject({
    status: 402, code: "LICENSE_NOT_ACTIVE",
  } satisfies Partial<HttpError>);
});

it("rejects over-seat usage and invalid signed license replacements", async () => {
  await installLicense({ issuedAt: "2026-11-02T00:00:00.000Z", seatLimit: 2 });
  await expect(validate("inventory")).rejects.toMatchObject({
    status: 403, code: "SEAT_LIMIT_EXCEEDED",
  } satisfies Partial<HttpError>);
  await installLicense({ issuedAt: "2026-11-03T00:00:00.000Z", signature: "a".repeat(86) });
  await expect(validate("inventory")).rejects.toMatchObject({
    status: 403, code: "INVALID_LICENSE",
  } satisfies Partial<HttpError>);
});

it("rejects organization suspension irrespective of installed license", async () => {
  await testPool().query("UPDATE organizations SET status='suspended' WHERE id=$1", [organizationId]);
  await expect(validate("inventory")).rejects.toMatchObject({
    status: 403, code: "ORGANIZATION_SUSPENDED",
  } satisfies Partial<HttpError>);
});
