import "server-only";
import type { PoolClient } from "pg";
import type { AuthenticatedUser } from "@/server/auth";
import { HttpError } from "@/server/errors";
import { audit, positive, requireUuid, shortText } from "@/server/operations";

export { audit, positive, requireUuid, shortText };

export function optionalText(value: unknown, name: string, max: number): string {
  if (value === undefined || value === null || value === "") return "";
  return shortText(value, name, max);
}

export function nonNegativeMoney(value: unknown, name: string): string {
  const raw = typeof value === "number" || typeof value === "string" ? String(value) : "";
  if (!/^\d{1,11}(?:\.\d{1,4})?$/.test(raw)) {
    throw new HttpError(400, "INVALID_AMOUNT", `${name} must be a non-negative amount with up to four decimal places.`);
  }
  return raw;
}

export function optionalDate(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, "INVALID_DATE", `${name} must be a valid YYYY-MM-DD date.`);
  }
  return value;
}

export async function requireProject(client: PoolClient, projectId: string): Promise<void> {
  const result = await client.query("SELECT id FROM projects WHERE id=$1", [projectId]);
  if (!result.rowCount) throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found.");
}

export async function requireProjectOwner(
  client: PoolClient,
  user: AuthenticatedUser,
  projectId: string,
): Promise<void> {
  const result = await client.query<{ created_by: string }>(
    "SELECT created_by FROM projects WHERE id=$1",
    [projectId],
  );
  if (!result.rowCount) throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found.");
  if (user.role === "viewer") {
    const membership = await client.query(
      "SELECT 1 FROM project_resources WHERE project_id=$1 AND user_id=$2",
      [projectId, user.id],
    );
    if (!membership.rowCount && result.rows[0].created_by !== user.id) {
      throw new HttpError(403, "FORBIDDEN", "You are not assigned to this project.");
    }
  }
}
