import "server-only";
import { createPublicKey, verify } from "node:crypto";

const MODULES = [
  "inventory", "projects", "engineering", "production", "purchasing", "field_service", "equipment", "telemetry",
] as const;
export type LicenseModule = typeof MODULES[number];
export type LicenseClaims = {
  version: 1;
  licenseId: string;
  organizationId: string;
  licenseType: "saas" | "dedicated" | "on_premises" | "air_gapped";
  tier: string;
  seatLimit: number;
  modules: LicenseModule[];
  issuedAt: string;
  activatedAt: string;
  expiresAt: string;
};
export type LicenseEnvelope = { payload: string; signature: string };
export type LicenseTimeStatus = "not_active" | "active" | "grace" | "expired";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GRACE_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

export class InvalidLicenseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLicenseError";
  }
}

export class LicenseConfigurationError extends Error {
  constructor() {
    super("License verification key must be configured as an Ed25519 public key.");
    this.name = "LicenseConfigurationError";
  }
}

function isModule(value: unknown): value is LicenseModule {
  return typeof value === "string" && MODULES.some((module) => module === value);
}

function isLicenseType(value: unknown): value is LicenseClaims["licenseType"] {
  return value === "saas" || value === "dedicated" || value === "on_premises" || value === "air_gapped";
}

function decodeBase64Url(value: unknown, maximum: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new InvalidLicenseError("Invalid license encoding.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new InvalidLicenseError("Invalid license encoding.");
  return decoded;
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") throw new InvalidLicenseError("Invalid license timestamp.");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new InvalidLicenseError("License timestamps must be canonical UTC timestamps.");
  }
  return date.getTime();
}

export function verifyLicense(envelope: LicenseEnvelope, publicKey: string, organizationId: string): LicenseClaims {
  const payload = decodeBase64Url(envelope.payload, 16_384);
  const signature = decodeBase64Url(envelope.signature, 128);
  if (signature.length !== 64) throw new InvalidLicenseError("Invalid license signature.");
  if (!publicKey.trim().startsWith("-----BEGIN PUBLIC KEY-----")) throw new LicenseConfigurationError();
  let key;
  try {
    key = createPublicKey(publicKey);
  } catch {
    throw new LicenseConfigurationError();
  }
  if (key.asymmetricKeyType !== "ed25519") throw new LicenseConfigurationError();
  if (!verify(null, payload, key, signature)) throw new InvalidLicenseError("Invalid license signature.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new InvalidLicenseError("Invalid license payload.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InvalidLicenseError("Invalid license payload.");
  const claims = parsed as Record<string, unknown>;
  if (claims.version !== 1 || typeof claims.licenseId !== "string" || !UUID.test(claims.licenseId)
    || typeof claims.organizationId !== "string" || !UUID.test(claims.organizationId)
    || claims.organizationId !== organizationId
    || !isLicenseType(claims.licenseType)
    || typeof claims.tier !== "string" || claims.tier.length < 1 || claims.tier.length > 64
    || typeof claims.seatLimit !== "number" || !Number.isSafeInteger(claims.seatLimit)
    || claims.seatLimit < 1 || claims.seatLimit > 100_000
    || !Array.isArray(claims.modules) || claims.modules.length === 0
    || !claims.modules.every(isModule) || new Set(claims.modules).size !== claims.modules.length
    || typeof claims.issuedAt !== "string" || typeof claims.activatedAt !== "string"
    || typeof claims.expiresAt !== "string") {
    throw new InvalidLicenseError("Invalid license claims or organization.");
  }
  const issued = timestamp(claims.issuedAt);
  const activated = timestamp(claims.activatedAt);
  const expires = timestamp(claims.expiresAt);
  if (issued > activated || activated >= expires) throw new InvalidLicenseError("Invalid license validity period.");
  return {
    version: 1, licenseId: claims.licenseId, organizationId: claims.organizationId,
    licenseType: claims.licenseType, tier: claims.tier, seatLimit: claims.seatLimit,
    modules: claims.modules, issuedAt: claims.issuedAt, activatedAt: claims.activatedAt, expiresAt: claims.expiresAt,
  };
}

export function licenseTimeStatus(claims: LicenseClaims, now: Date): LicenseTimeStatus {
  const instant = now.getTime();
  if (!Number.isFinite(instant)) throw new InvalidLicenseError("Invalid current time.");
  if (instant < timestamp(claims.activatedAt)) return "not_active";
  const expiration = timestamp(claims.expiresAt);
  if (instant < expiration) return "active";
  if (instant < expiration + GRACE_MILLISECONDS) return "grace";
  return "expired";
}
