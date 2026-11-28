import "server-only";
import type { PoolClient } from "pg";
import { HttpError } from "@/server/errors";
import {
  InvalidLicenseError, LicenseConfigurationError, licenseTimeStatus,
  verifyLicense, type LicenseModule, type LicenseClaims,
} from "@/server/licensing";

// The policy is server-side only. Calling routes must enforce the organization
// context from the authenticated session, never from request payload alone.
export async function requireValidatedOrganizationLicense(
  client: PoolClient,
  organizationId: string,
  now = new Date(),
): Promise<{ claims: LicenseClaims; status: "active" | "grace"; seats: number }> {
  const organization = await client.query<{ status: string }>(
    "SELECT status FROM organizations WHERE id=$1 FOR SHARE",
    [organizationId],
  );
  if (!organization.rowCount || organization.rows[0].status !== "active") {
    throw new HttpError(403, "ORGANIZATION_SUSPENDED", "This organization is not active.");
  }

  const result = await client.query<{ signed_payload: string; signature: string }>(
    `SELECT signed_payload,signature FROM organization_licenses
      WHERE organization_id=$1 ORDER BY issued_at DESC, installed_at DESC LIMIT 1`,
    [organizationId],
  );
  if (!result.rows[0]) {
    throw new HttpError(402, "LICENSE_REQUIRED", "This organization requires an active license.");
  }

  let claims: LicenseClaims;
  try {
    if (!process.env.LICENSE_PUBLIC_KEY) throw new LicenseConfigurationError();
    claims = verifyLicense({
      payload: result.rows[0].signed_payload, signature: result.rows[0].signature,
    }, process.env.LICENSE_PUBLIC_KEY, organizationId);
  } catch (error) {
    if (error instanceof LicenseConfigurationError) {
      throw new HttpError(503, "LICENSE_CONFIGURATION", error.message);
    }
    if (error instanceof InvalidLicenseError) {
      throw new HttpError(403, "INVALID_LICENSE", "The installed license failed verification.");
    }
    throw error;
  }
  const status = licenseTimeStatus(claims, now);
  if (status === "not_active" || status === "expired") {
    throw new HttpError(402, "LICENSE_NOT_ACTIVE",
      "The organization's license is not active. Contact the license administrator.");
  }
  const usedSeats = await client.query<{ seats: number }>(
    `SELECT COUNT(*)::int AS seats FROM organization_memberships m
       JOIN users u ON u.id=m.user_id
      WHERE m.organization_id=$1 AND u.is_active`,
    [organizationId],
  );
  if ((usedSeats.rows[0]?.seats ?? 0) > claims.seatLimit) {
    throw new HttpError(403, "SEAT_LIMIT_EXCEEDED", "The organization exceeds its licensed active-user limit.");
  }

  return { claims, status, seats: usedSeats.rows[0]?.seats ?? 0 };
}

export async function requireLicensedModule(
  client: PoolClient,
  organizationId: string,
  module: LicenseModule,
  now = new Date(),
): Promise<{ claims: LicenseClaims; status: "active" | "grace" }> {
  const { claims,status } = await requireValidatedOrganizationLicense(client, organizationId, now);
  if (!claims.modules.includes(module)) {
    throw new HttpError(403, "MODULE_NOT_LICENSED",
      "This organization is not licensed for the requested module.");
  }
  return { claims,status };
}

export async function requireAvailableSeat(client: PoolClient, organizationId: string): Promise<void> {
  // Lock the organization row first in the caller transaction to serialize
  // concurrent invitation acceptances and prevent seat-limit races.
  const organization = await client.query(
    "SELECT id FROM organizations WHERE id=$1 AND status='active' FOR UPDATE",
    [organizationId],
  );
  if (!organization.rowCount) throw new HttpError(403,"ORGANIZATION_SUSPENDED",
    "This organization is not active.");
  const {claims,status,seats} = await requireValidatedOrganizationLicense(client,organizationId);
  if (status !== "active") {
    throw new HttpError(402,"RENEW_LICENSE",
      "Renew the organization's license before inviting or enrolling new users.");
  }
  if (seats >= claims.seatLimit) {
    throw new HttpError(409,"NO_LICENSED_SEATS",
      "No licensed seats are available for this organization.");
  }
}
