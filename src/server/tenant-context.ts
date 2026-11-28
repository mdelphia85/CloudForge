import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { requireUser } from "@/server/auth";
import { errorResponse } from "@/server/errors";

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
export function withOrganizationRoute<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Promise<Response>,
): (request: Request, ...args: Args) => Promise<Response> {
  return async (request: Request, ...args: Args): Promise<Response> => {
    try {
      const user = await requireUser(request);
      return await context.run(
        { organizationId: user.organizationId, userId: user.id },
        () => handler(request, ...args),
      );
    } catch (error) {
      return errorResponse(error);
    }
  };
}
