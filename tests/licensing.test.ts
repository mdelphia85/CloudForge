import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InvalidLicenseError, LicenseConfigurationError, licenseTimeStatus, verifyLicense } from "@/server/licensing";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const organizationId = "12345678-1234-4234-8234-123456789abc";
const claims = {
  version: 1, licenseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", organizationId,
  licenseType: "air_gapped", tier: "standard", seatLimit: 5, modules: ["inventory", "engineering"],
  issuedAt: "2026-01-01T00:00:00.000Z", activatedAt: "2026-01-02T00:00:00.000Z",
  expiresAt: "2026-02-01T00:00:00.000Z",
};
function envelope(value: unknown) {
  const payload = Buffer.from(JSON.stringify(value));
  return { payload: payload.toString("base64url"), signature: sign(null, payload, keys.privateKey).toString("base64url") };
}

describe("offline signed licenses", () => {
  it("verifies an organization-bound Ed25519 license without network access", () => {
    expect(verifyLicense(envelope(claims), publicKey, organizationId)).toEqual(claims);
    expect(() => verifyLicense(envelope(claims), publicKey, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toThrow(InvalidLicenseError);
  });

  it("rejects tampered, noncanonical, incorrectly signed, and invalid claims", () => {
    const signed = envelope(claims);
    expect(() => verifyLicense({ ...signed, payload: envelope({ ...claims, seatLimit: 50 }).payload }, publicKey, organizationId)).toThrow(InvalidLicenseError);
    expect(() => verifyLicense({ ...signed, signature: signed.signature + "=" }, publicKey, organizationId)).toThrow(InvalidLicenseError);
    expect(() => verifyLicense(envelope({ ...claims, modules: ["inventory", "unknown"] }), publicKey, organizationId)).toThrow(InvalidLicenseError);
    expect(() => verifyLicense(envelope({ ...claims, seatLimit: 0 }), publicKey, organizationId)).toThrow(InvalidLicenseError);
    expect(() => verifyLicense(envelope({ ...claims, expiresAt: claims.activatedAt }), publicKey, organizationId)).toThrow(InvalidLicenseError);
    expect(() => verifyLicense(signed, "invalid key", organizationId)).toThrow(LicenseConfigurationError);
    expect(() => verifyLicense(signed, keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), organizationId)).toThrow(LicenseConfigurationError);
  });

  it("applies the selected 30-day expiration grace period at exact boundaries", () => {
    const verified = verifyLicense(envelope(claims), publicKey, organizationId);
    expect(licenseTimeStatus(verified, new Date("2026-01-01T23:59:59.999Z"))).toBe("not_active");
    expect(licenseTimeStatus(verified, new Date("2026-01-02T00:00:00.000Z"))).toBe("active");
    expect(licenseTimeStatus(verified, new Date("2026-02-01T00:00:00.000Z"))).toBe("grace");
    expect(licenseTimeStatus(verified, new Date("2026-03-03T00:00:00.000Z"))).toBe("expired");
  });
});
