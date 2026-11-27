import "server-only";
import type { PoolClient } from "pg";
import type { AuthenticatedUser } from "@/server/auth";
import { requireRole } from "@/server/auth";
import { HttpError } from "@/server/errors";
import { audit, positive, requireUuid, shortText } from "@/server/phase3/shared";

export { audit, positive, requireUuid, shortText };

export function requireOperationsRole(user: AuthenticatedUser): void {
  requireRole(user, "admin", "operator");
}

export function optionalText(value: unknown, name: string, maximum: number): string {
  if (value === undefined || value === null || value === "") return "";
  return shortText(value, name, maximum);
}

export function requiredText(value: unknown, name: string, maximum: number): string {
  return shortText(value, name, maximum);
}

export function parseDate(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, "INVALID_DATE", `${name} must be a valid YYYY-MM-DD date.`);
  }
  return value;
}

export function parseTimestamp(value: unknown, name: string): Date {
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_TIMESTAMP", `${name} must be an ISO 8601 timestamp.`);
  }
  const timestamp = value.match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i);
  if (!timestamp || value.length > 40 || Number.isNaN(Date.parse(value)) ||
      new Date(`${timestamp[1]}T00:00:00.000Z`).toISOString().slice(0,10) !== timestamp[1]) {
    throw new HttpError(400, "INVALID_TIMESTAMP", `${name} must be an ISO 8601 timestamp.`);
  }
  const parsed = new Date(value);
  return parsed;
}

export function parsePriority(value: unknown): "low" | "normal" | "high" | "critical" {
  if (value === undefined || value === null || value === "") return "normal";
  if (value === "low" || value === "normal" || value === "high" || value === "critical") return value;
  throw new HttpError(400, "INVALID_PRIORITY", "Choose low, normal, high, or critical.");
}

export async function requireAssetAccess(
  client: PoolClient,
  assetId: string,
  user: AuthenticatedUser,
  lock = false,
) {
  const result = await client.query<{
    id: string;
    project_id: string | null;
    status: string;
    customer_site: string;
    created_at: Date;
  }>(
    `SELECT id,project_id,status,customer_site,created_at FROM engineering_assets WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    [assetId],
  );
  if (!result.rowCount) throw new HttpError(404, "EQUIPMENT_NOT_FOUND", "Equipment not found.");
  const asset = result.rows[0];
  if (user.role !== "viewer") return asset;

  const access = await client.query(
    "SELECT (EXISTS(SELECT 1 FROM projects p WHERE p.id=$1 AND p.created_by=$2) " +
      "OR EXISTS(SELECT 1 FROM project_resources r WHERE r.project_id=$1 AND r.user_id=$2) " +
      "OR EXISTS(SELECT 1 FROM field_service_jobs s WHERE s.asset_id=$3 AND s.assigned_to=$2) " +
      "OR EXISTS(SELECT 1 FROM maintenance_work_orders m WHERE m.asset_id=$3 AND m.assigned_to=$2)) AS exists",
    [asset.project_id, user.id, assetId],
  );
  if (!access.rows[0].exists) {
    throw new HttpError(403, "FORBIDDEN", "You are not assigned to this equipment or its project.");
  }
  return asset;
}

export function idempotencyKey(value: unknown): string {
  const key = shortText(value, "idempotencyKey", 128);
  if (key.length < 8) throw new HttpError(400, "INVALID_KEY", "An idempotency key of at least 8 characters is required.");
  return key;
}
