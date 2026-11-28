import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { InvalidLicenseError, LicenseConfigurationError, licenseTimeStatus, verifyLicense } from "@/server/licensing";
import { requireUuid } from "@/server/operations";
import { requirePlatformOwner } from "@/server/platform-owner";

function publicKey(): string {
  if (!process.env.LICENSE_PUBLIC_KEY) throw new LicenseConfigurationError();
  return process.env.LICENSE_PUBLIC_KEY;
}

function licenseError(error: unknown): Response {
  if (error instanceof InvalidLicenseError) return errorResponse(new HttpError(400, "INVALID_LICENSE", error.message));
  if (error instanceof LicenseConfigurationError) return errorResponse(new HttpError(503, "LICENSE_CONFIGURATION", error.message));
  return errorResponse(error);
}

export async function GET(request: Request) {
  try {
    const actor = await requireUser(request);
    const organizationId = requireUuid(new URL(request.url).searchParams.get("organizationId"), "organization ID");
    const license = await inTransaction(async (client) => {
      await requirePlatformOwner(client, actor.id);
      const result = await client.query<{ signed_payload: string; signature: string }>(
        "SELECT signed_payload, signature FROM organization_licenses WHERE organization_id = $1 ORDER BY issued_at DESC LIMIT 1",
        [organizationId],
      );
      if (!result.rows[0]) return null;
      const claims = verifyLicense({ payload: result.rows[0].signed_payload, signature: result.rows[0].signature }, publicKey(), organizationId);
      return { claims, timeStatus: licenseTimeStatus(claims, new Date()) };
    });
    return NextResponse.json({ license }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return licenseError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const actor = await requireUser(request);
    const body = await readJson(request);
    const organizationId = requireUuid(body.organizationId, "organization ID");
    if (typeof body.payload !== "string" || typeof body.signature !== "string") {
      throw new HttpError(400, "INVALID_LICENSE", "A signed license payload and signature are required.");
    }
    const payload = body.payload;
    const signature = body.signature;
    const result = await inTransaction(async (client) => {
      await requirePlatformOwner(client, actor.id);
      const organization = await client.query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", [organizationId]);
      if (!organization.rowCount) throw new HttpError(404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
      const claims = verifyLicense({ payload, signature }, publicKey(), organizationId);
      const previous = await client.query<{ license_id: string; signed_payload: string; signature: string; issued_at: Date }>(
        "SELECT license_id, signed_payload, signature, issued_at FROM organization_licenses WHERE organization_id = $1 ORDER BY issued_at DESC LIMIT 1",
        [organizationId],
      );
      const prior = previous.rows[0];
      if (prior?.license_id === claims.licenseId && prior.signed_payload === payload && prior.signature === signature) {
        return { claims, timeStatus: licenseTimeStatus(claims, new Date()), installed: false };
      }
      if (prior && new Date(claims.issuedAt).getTime() <= prior.issued_at.getTime()) {
        throw new HttpError(409, "LICENSE_NOT_NEWER", "The license must be newer than the installed license.");
      }
      await client.query(
        `INSERT INTO organization_licenses
           (license_id, organization_id, signed_payload, signature, issued_at, activated_at, expires_at, installed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [claims.licenseId, organizationId, payload, signature, claims.issuedAt, claims.activatedAt, claims.expiresAt, actor.id],
      );
      await client.query(
        "INSERT INTO organization_license_events (organization_id, license_id, actor_user_id, action) VALUES ($1, $2, $3, 'installed')",
        [organizationId, claims.licenseId, actor.id],
      );
      return { claims, timeStatus: licenseTimeStatus(claims, new Date()), installed: true };
    });
    return NextResponse.json({ license: result }, { status: result.installed ? 201 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return licenseError(error);
  }
}
