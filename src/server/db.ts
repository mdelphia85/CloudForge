import "server-only";
import { Pool, type PoolClient } from "pg";
import { activeOrganizationContext } from "@/server/tenant-context";

declare global {
  var cloudForgePool: Pool | undefined;
}

export function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured.");
  }

  const maxConnections = Number(process.env.DATABASE_POOL_SIZE ?? 10);
  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 50) {
    throw new Error("DATABASE_POOL_SIZE must be an integer between 1 and 50.");
  }

  if (!globalThis.cloudForgePool) {
    const pool = new Pool({
      connectionString,
      max: maxConnections,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    // Scoped one-off queries must use SET LOCAL inside their OWN transaction.
    // Never use a session-level SET on a pooled connection: tenant identifiers
    // could leak into the next unrelated request.
    globalThis.cloudForgePool = new Proxy(pool, {
      get(target, property) {
        if (property === "query") {
          return (...args: unknown[]) => {
            const org = activeOrganizationContext();
            if (!org) return Reflect.apply(target.query, target, args);
            return (async () => {
              const client = await target.connect();
              try {
                await client.query("BEGIN");
                await client.query(
                  "SELECT set_config('cloudforge.organization_id',$1,true)",
                  [org.organizationId],
                );
                const result = await Reflect.apply(client.query, client, args);
                await client.query("COMMIT");
                return result;
              } catch (error) {
                try { await client.query("ROLLBACK"); } catch { /* retain original error */ }
                throw error;
              } finally {
                client.release();
              }
            })();
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  return globalThis.cloudForgePool;
}

export async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const org = activeOrganizationContext();
    if (org) {
      await client.query(
        "SELECT set_config('cloudforge.organization_id',$1,true)",
        [org.organizationId],
      );
    }
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Database rollback failed.", rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}
