import "server-only";
import type { PoolClient } from "pg";
import { HttpError } from "@/server/errors";

export async function requirePlatformOwner(client: PoolClient, userId: string): Promise<void> {
  const owner = await client.query(
    "SELECT 1 FROM platform_owners p JOIN users u ON u.id = p.user_id WHERE p.user_id = $1 AND u.is_active FOR SHARE OF p, u",
    [userId],
  );
  if (!owner.rowCount) throw new HttpError(403, "FORBIDDEN", "Platform owner access is required.");
}
