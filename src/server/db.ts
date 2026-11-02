import "server-only";
import { Pool, type PoolClient } from "pg";

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

  globalThis.cloudForgePool ??= new Pool({
    connectionString,
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return globalThis.cloudForgePool;
}

export async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
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
