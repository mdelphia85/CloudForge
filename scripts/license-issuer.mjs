import { createPrivateKey, randomUUID, sign } from "node:crypto";

const MODULES = new Set([
  "inventory", "projects", "engineering", "production", "purchasing",
  "field_service", "equipment", "telemetry",
]);
const LICENSE_TYPES = new Set(["saas", "dedicated", "on_premises", "air_gapped"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function canonicalDate(value, field) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    throw new Error(field + " must be a canonical UTC ISO 8601 timestamp.");
  }
  return Date.parse(value);
}

// Owner-side issuing only; customer installations receive the public verification key,
// NEVER this module's private key.
export function issueSignedLicense(request, privateKeyPem, now = new Date()) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("License request must be a JSON object.");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Invalid issuance clock.");
  }
  const organizationId = request.organizationId;
  if (typeof organizationId !== "string" || !UUID.test(organizationId)) {
    throw new Error("A canonical organization UUID is required.");
  }
  if (!LICENSE_TYPES.has(request.licenseType)) {
    throw new Error("License type must be saas, dedicated, on_premises, or air_gapped.");
  }
  if (typeof request.tier !== "string" || !request.tier.trim() ||
      request.tier.length > 64) {
    throw new Error("A tier of 1–64 characters is required.");
  }
  if (!Number.isSafeInteger(request.seatLimit) || request.seatLimit < 1 ||
      request.seatLimit > 100000) {
    throw new Error("Seat limit must be between 1 and 100000.");
  }
  if (!Array.isArray(request.modules) || request.modules.length < 1 ||
      !request.modules.every((name) => MODULES.has(name)) ||
      new Set(request.modules).size !== request.modules.length) {
    throw new Error("Modules must be a nonempty, unique list of supported entitlements.");
  }

  const issuedAt = now.toISOString();
  const activatedAt = request.activatedAt ?? issuedAt;
  const expiration = request.expiresAt;
  const activated = canonicalDate(activatedAt, "activatedAt");
  const expires = canonicalDate(expiration, "expiresAt");
  if (now.getTime() > activated || activated >= expires) {
    throw new Error("License validity must begin at or after issuance and end after activation.");
  }

  const licenseId = randomUUID();
  const claims = {
    version: 1, licenseId, organizationId,
    licenseType: request.licenseType, tier: request.tier.trim(),
    seatLimit: request.seatLimit, modules: request.modules,
    issuedAt, activatedAt, expiresAt: expiration,
  };

  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    throw new Error("A valid Ed25519 private signing key is required.");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("License signing key must be Ed25519.");
  }

  const payload = Buffer.from(JSON.stringify(claims), "utf8");
  const signature = sign(null, payload, privateKey);
  return {
    envelope: { payload: payload.toString("base64url"), signature: signature.toString("base64url") },
    claims,
  };
}
