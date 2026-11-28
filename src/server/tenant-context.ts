import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { requireUser } from "@/server/auth";
import { errorResponse, HttpError } from "@/server/errors";
import { inTransaction } from "@/server/db";
import { requireLicensedModule } from "@/server/license-entitlements";
import type { LicenseModule } from "@/server/licensing";

export type OrganizationContext = {
  organizationId: string;
  userId: string;
};
const context = new AsyncLocalStorage<OrganizationContext>();

export function activeOrganizationContext(): OrganizationContext | undefined {
  return context.getStore();
}

/**
 * Each API request receives its own async context. Never use enterWith(),
 * module globals or connection-scoped SET for tenant identity: concurrent
 * customer requests may otherwise inherit one another's organization.
 *
 * Authentication reads the globally scoped session record; the organization
 * is derived from its verified active membership. Request bodies and headers
 * are never accepted as authorization evidence.
 */
function moduleForPath(path: string): LicenseModule | null {
  // The platform-owner control plane must remain accessible to install/renew
  // a license. Never expose customer operations through these routes.
  if (path.startsWith("/api/platform/") || path.startsWith("/api/users/") || path === "/api/users") {
    return null;
  }
  if (path.startsWith("/api/inventory")) return "inventory";
  if (path.startsWith("/api/engineering")) return "engineering";
  if (path.startsWith("/api/gateways")) return "telemetry";
  if (path.startsWith("/api/operations/engineering")) return "engineering";
  if (path.startsWith("/api/operations/equipment") ||
      path.startsWith("/api/operations/maintenance") ||
      path.startsWith("/api/operations/analytics")) return "equipment";
  if (path.startsWith("/api/operations/telemetry")) return "telemetry";
  if (path.startsWith("/api/operations/production")) return "production";
  if (path.startsWith("/api/operations/projects")) return "projects";
  if (path.startsWith("/api/operations/service")) return "field_service";
  if (path.startsWith("/api/operations/purchasing") ||
      path.startsWith("/api/operations/suppliers") ||
      path.startsWith("/api/operations/purchase-orders")) return "purchasing";
  if (path.startsWith("/api/operations/reservations") ||
      path.startsWith("/api/operations/material-shortages")) return "inventory";
  const resource = path.match(/^\/api\/operations\/([a-z_-]+)(?:\/|$)/)?.[1];
  const directResources: Record<string,LicenseModule> = {
    projects: "projects", tasks: "projects", assets: "equipment",
    bom: "engineering", documents: "engineering",
    production: "production", purchasing: "purchasing", service: "field_service",
  };
  return resource ? directResources[resource] ?? null : null;
}

export async function enforceRouteLicense(organizationId: string, requestUrl: string): Promise<void> {
  const path = new URL(requestUrl).pathname;
  // These aggregate endpoints expose multiple licensed modules. Until they
  // return entitlement-filtered payloads, fail closed in shared SaaS mode.
  if (path === "/api/operations/overview" || path.startsWith("/api/operations/phase3")) {
    throw new HttpError(403, "UNSCOPED_AGGREGATE",
      "This aggregate requires tenant-safe entitlement filtering before shared SaaS use.");
  }
  const licensedModule = moduleForPath(path);
  if (!licensedModule) {
    if (path.startsWith("/api/platform/") || path.startsWith("/api/users")) return;
    throw new HttpError(403, "UNCLASSIFIED_OPERATION",
      "The requested operation has not been approved for multi-organization licensing.");
  }
  await inTransaction(client => requireLicensedModule(client, organizationId, licensedModule));
}

export function withOrganizationRoute<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Promise<Response>,
): (request: Request, ...args: Args) => Promise<Response> {
  return async (request: Request, ...args: Args): Promise<Response> => {
    try {
      const user = await requireUser(request);
      if (process.env.CLOUDFORGE_MULTI_ORGANIZATION_ENABLED === "true" ||
          process.env.CLOUDFORGE_LICENSE_ENFORCEMENT_REQUIRED === "true") {
        await enforceRouteLicense(user.organizationId, request.url);
      }
      return await context.run(
        { organizationId: user.organizationId, userId: user.id },
        () => handler(request, ...args),
      );
    } catch (error) {
      return errorResponse(error);
    }
  };
}
