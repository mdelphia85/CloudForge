import { withOrganizationRoute } from "@/server/tenant-context";
import { NextResponse } from "next/server";
import { requireRole, requireUser } from "@/server/auth";
import { inTransaction } from "@/server/db";
import { errorResponse, HttpError, readJson, requireSameOrigin } from "@/server/errors";
import { requireUuid } from "@/server/operations";

type Context = { params: Promise<{ id: string }> };

async function handlePATCH(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const actor = await requireUser(request);
    requireRole(actor, "admin");
    const userId = requireUuid((await params).id, "user ID");
    const body = await readJson(request);
    // Disabling a shared identity globally could lock them out of another
    // customer. Block this legacy endpoint until scoped membership actions exist.
    if (process.env.CLOUDFORGE_MULTI_ORGANIZATION_ENABLED === "true") {
      throw new HttpError(409, "ORGANIZATION_ACCOUNT_ACTION_REQUIRED",
        "Use organization-scoped membership administration for shared SaaS accounts.");
    }
    const action = body.action;
    if (action !== "disable" && action !== "enable" && action !== "revoke_sessions") {
      throw new HttpError(400, "INVALID_ACTION", "Choose disable, enable, or revoke_sessions.");
    }
    const result = await inTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(208451192)");
      const currentActor = await client.query<{ role: string; is_active: boolean }>(
        "SELECT m.role,u.is_active FROM users u JOIN organization_memberships m ON m.user_id=u.id " +
          "WHERE u.id=$1 AND m.organization_id=$2 FOR UPDATE OF u,m",
        [actor.id,actor.organizationId],
      );
      if (!currentActor.rows[0]?.is_active || currentActor.rows[0].role !== "admin") {
        throw new HttpError(403, "FORBIDDEN", "Administrator access is required.");
      }
      const target = await client.query<{ role: string; is_active: boolean }>(
        "SELECT m.role,u.is_active FROM users u JOIN organization_memberships m ON m.user_id=u.id " +
          "WHERE u.id=$1 AND m.organization_id=$2 FOR UPDATE OF u,m",
        [userId,actor.organizationId],
      );
      if (!target.rowCount) throw new HttpError(404, "USER_NOT_FOUND", "User not found.");
      const current = target.rows[0];
      if (action === "disable" && current.is_active && current.role === "admin") {
        const admins = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM users u JOIN organization_memberships m ON m.user_id=u.id " +
            "WHERE m.organization_id=$1 AND m.role='admin' AND u.is_active",
          [actor.organizationId],
        );
        if (admins.rows[0].count <= 1) {
          throw new HttpError(409, "LAST_ADMIN", "The last active administrator cannot be disabled.");
        }
      }
      if (action === "disable" || action === "enable") {
        await client.query("UPDATE users SET is_active = $2 WHERE id = $1", [userId, action === "enable"]);
      }
      if (action !== "enable") {
        await client.query("UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1", [userId]);
      }
      const sessions = action === "enable" ? null : await client.query(
        "DELETE FROM sessions WHERE user_id = $1 AND organization_id=$2",
        [userId,actor.organizationId],
      );
      const revokedSessions = sessions?.rowCount ?? 0;
      await client.query(
        `INSERT INTO audit_events (actor_user_id,organization_id,action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, 'user', $4, $5)`,
        [actor.id,actor.organizationId, `user.${action}`, userId, JSON.stringify({ revokedSessions })],
      );
      return { id: userId, isActive: action === "enable" || (action === "revoke_sessions" && current.is_active), revokedSessions };
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

export const PATCH = withOrganizationRoute(handlePATCH);
