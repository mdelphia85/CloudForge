import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueSignedLicense } from "../scripts/license-issuer.mjs";
import { verifyLicense } from "@/server/licensing";

const keys = generateKeyPairSync("ed25519");
const privatePem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const publicPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const orgId = "12345678-1234-4234-8234-123456789abc";
const request = {
  organizationId: orgId, licenseType: "air_gapped", tier: "professional",
  seatLimit: 25, modules: ["inventory", "engineering", "equipment"],
  expiresAt: "2028-01-01T00:00:00.000Z",
};
const now = new Date("2027-01-01T00:00:00.000Z");

describe("platform-owner offline license issuance", () => {
  it("issues a signed per-organization license that the server verifies offline", () => {
    const { envelope, claims } = issueSignedLicense(request, privatePem, now);
    expect(verifyLicense(envelope, publicPem, orgId)).toEqual(claims);
    expect(claims).toMatchObject({
      organizationId: orgId, licenseType: "air_gapped", seatLimit: 25,
      tier: "professional", modules: request.modules,
      issuedAt: now.toISOString(), activatedAt: now.toISOString(),
    });
    expect(JSON.stringify(envelope)).not.toContain("PRIVATE KEY");
    expect(() => verifyLicense(envelope, publicPem, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toThrow();
  });

  it("rejects invalid seats, unsupported modules, duplicate modules and invalid dates", () => {
    expect(() => issueSignedLicense({ ...request, seatLimit: 0 }, privatePem, now)).toThrow();
    expect(() => issueSignedLicense({ ...request, modules: ["unknown"] }, privatePem, now)).toThrow();
    expect(() => issueSignedLicense({ ...request, modules: ["inventory", "inventory"] }, privatePem, now)).toThrow();
    expect(() => issueSignedLicense({ ...request, expiresAt: now.toISOString() }, privatePem, now)).toThrow();
    expect(() => issueSignedLicense({ ...request, activatedAt: "2026-01-01T00:00:00.000Z" }, privatePem, now)).toThrow();
    expect(() => issueSignedLicense({ ...request, organizationId: "not-uuid" }, privatePem, now)).toThrow();
  });

  it("rejects a non-Ed25519 private key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPem = rsa.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => issueSignedLicense(request, rsaPem, now)).toThrow("Ed25519");
  });
});
