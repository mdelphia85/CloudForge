import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call, closeDatabases, itemBody, loadHandlers, movementKey, resetDatabase, runMigrations, seedActors, STRONG_PASSWORD, testPool,
  type Actors, type Handlers,
} from "./harness";

let h: Handlers;
let actors: Actors;

beforeAll(async () => {
  await resetDatabase();
  h = await loadHandlers();
  actors = await seedActors(h);
  const item = await call(h.inventory.POST, { method: "POST", cookie: actors.operator.cookie, body: itemBody({ sku: "AUD-1", onHand: "10" }) });
  expect(item.status).toBe(201);
  const moves: Array<Record<string, unknown>> = [
    { type: "receipt", sku: "AUD-1", quantity: "2", location: "Main warehouse", bin: "A-01" },
    { type: "issue", sku: "AUD-1", quantity: "1", sourceLocation: "Main warehouse", sourceBin: "A-01" },
    { type: "transfer", sku: "AUD-1", quantity: "1", sourceLocation: "Main warehouse", sourceBin: "A-01", destinationLocation: "Annex", destinationBin: "B-1" },
    { type: "count", sku: "AUD-1", quantity: "5", location: "Main warehouse", bin: "A-01" },
  ];
  for (const body of moves) {
    expect((await call(h.movements.POST, { method: "POST", cookie: actors.operator.cookie, body: { idempotencyKey: movementKey(), ...body } })).status).toBe(200);
  }
});
afterAll(closeDatabases);

const rejects = async (sql: string, params: unknown[] = []) => {
  try {
    await testPool().query(sql, params);
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error(`Expected statement to fail: ${sql}`);
};

describe("audit trail coverage", () => {
  it("records an event for every sensitive action with the right actor", async () => {
    const rows = await testPool().query("SELECT action, actor_user_id, entity_type, details FROM audit_events");
    const actions = new Set(rows.rows.map((r) => r.action));
    for (const expected of [
      "auth.bootstrap", "user.bootstrap", "auth.login", "user.created",
      "inventory.item.created", "inventory.receipt", "inventory.issue", "inventory.transfer", "inventory.count",
    ]) {
      expect(actions, expected).toContain(expected);
    }
    const inventoryEvents = rows.rows.filter((r) => String(r.action).startsWith("inventory."));
    expect(inventoryEvents.every((r) => r.actor_user_id !== actors.admin.id)).toBe(true);
  });

  it("stores movement details (quantity and locations) in the audit payload", async () => {
    const transfer = await testPool().query("SELECT details FROM audit_events WHERE action = 'inventory.transfer'");
    expect(transfer.rows[0].details).toMatchObject({ sku: "AUD-1", quantityDelta: "-1", toLocation: "Annex", toBin: "B-1" });
  });

  it("writes exactly one audit event per movement and does not audit rejected attempts", async () => {
    const before = (await testPool().query("SELECT count(*)::int AS n FROM audit_events")).rows[0].n;
    const refused = await call(h.movements.POST, {
      method: "POST", cookie: actors.operator.cookie,
      body: { idempotencyKey: movementKey(), type: "issue", sku: "AUD-1", quantity: "9999", sourceLocation: "Main warehouse", sourceBin: "A-01" },
    });
    expect(refused.status).toBe(409);
    expect((await testPool().query("SELECT count(*)::int AS n FROM audit_events")).rows[0].n).toBe(before);
  });

  it("links every audit event and movement to a real user", async () => {
    const orphans = await testPool().query(
      `SELECT (SELECT count(*) FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id WHERE u.id IS NULL)::int AS audit,
              (SELECT count(*) FROM inventory_movements m LEFT JOIN users u ON u.id = m.actor_user_id WHERE u.id IS NULL)::int AS moves`);
    expect(orphans.rows[0]).toEqual({ audit: 0, moves: 0 });
  });
});

describe("append-only protection", () => {
  it.each(["inventory_movements", "audit_events"])("blocks UPDATE, DELETE and TRUNCATE on %s", async (table) => {
    for (const sql of [`UPDATE ${table} SET id = id`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
      const error = await rejects(sql);
      expect(error.message, sql).toMatch(/append-only/);
    }
    const count = await testPool().query(`SELECT count(*)::int AS n FROM ${table}`);
    expect(count.rows[0].n).toBeGreaterThan(0);
  });

  it("blocks cascading truncation from a parent table", async () => {
    const error = await rejects("TRUNCATE users CASCADE");
    expect(error.message).toMatch(/append-only/);
  });
});

describe("check constraints", () => {
  const user = () => testPool().query("SELECT id FROM users WHERE role = 'admin'").then((r) => r.rows[0].id as string);

  it("rejects negative stock and negative reorder points", async () => {
    const id = await user();
    const item = await testPool().query("SELECT id FROM inventory_items WHERE sku = 'AUD-1'");
    expect((await rejects("UPDATE inventory_stock SET on_hand = -1")).code).toBe("23514");
    expect((await rejects("UPDATE inventory_items SET reorder_point = -1")).code).toBe("23514");
    expect((await rejects(
      "INSERT INTO inventory_stock (item_id, location, bin, on_hand, updated_by) VALUES ($1, 'X', 'Y', -5, $2)", [item.rows[0].id, id])).code).toBe("23514");
  });

  it("rejects unknown roles and movement types", async () => {
    const id = await user();
    const item = await testPool().query("SELECT id FROM inventory_items WHERE sku = 'AUD-1'");
    expect((await rejects("UPDATE users SET role = 'root' WHERE id = $1", [id])).code).toBe("23514");
    expect((await rejects(
      `INSERT INTO inventory_movements (item_id, movement_type, quantity_delta, actor_user_id, idempotency_key)
       VALUES ($1, 'teleport', 1, $2, 'bad-type-key')`, [item.rows[0].id, id])).code).toBe("23514");
  });
});

describe("uniqueness and referential integrity", () => {
  it("enforces unique SKUs, emails, idempotency keys and per-bin balances", async () => {
    const id = (await testPool().query("SELECT id FROM users WHERE role = 'admin'")).rows[0].id;
    const item = (await testPool().query("SELECT id FROM inventory_items WHERE sku = 'AUD-1'")).rows[0].id;
    expect((await rejects(
      "INSERT INTO inventory_items (sku, name, category, unit, reorder_point, created_by) VALUES ('AUD-1','n','c','u',0,$1)", [id])).code).toBe("23505");
    expect((await rejects(
      "INSERT INTO users (email, display_name, password_hash, role) VALUES ('admin@example.test','d','h','viewer')")).code).toBe("23505");
    expect((await rejects(
      "INSERT INTO inventory_stock (item_id, location, bin, on_hand, updated_by) VALUES ($1,'Main warehouse','A-01',1,$2)", [item, id])).code).toBe("23505");
    const key = (await testPool().query("SELECT idempotency_key FROM inventory_movements LIMIT 1")).rows[0].idempotency_key;
    expect((await rejects(
      "INSERT INTO inventory_movements (item_id, movement_type, quantity_delta, actor_user_id, idempotency_key) VALUES ($1,'receipt',1,$2,$3)", [item, id, key])).code).toBe("23505");
  });

  it("restricts deleting users and items that history depends on", async () => {
    // ON DELETE RESTRICT surfaces as restrict_violation (23001), not foreign_key_violation (23503).
    expect((await rejects("DELETE FROM users WHERE role = 'operator'")).code).toBe("23001");
    expect((await rejects("DELETE FROM inventory_items WHERE sku = 'AUD-1'")).code).toBe("23001");
  });

  it("rejects rows that reference missing parents", async () => {
    const id = (await testPool().query("SELECT id FROM users WHERE role = 'admin'")).rows[0].id;
    const ghost = "00000000-0000-0000-0000-000000000000";
    expect((await rejects("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now())", ["a".repeat(64), ghost])).code).toBe("23503");
    expect((await rejects("INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id) VALUES ($1,'x','y',$2)", [ghost, id])).code).toBe("23503");
  });

  it("cascades session deletion with a user, but protects users that have audit history", async () => {
    const created = await call(h.users.POST, {
      method: "POST", cookie: actors.admin.cookie,
      body: { email: "gone@example.test", displayName: "Gone User", role: "viewer", password: STRONG_PASSWORD },
    });
    await call(h.login.POST, { method: "POST", body: { email: "gone@example.test", password: STRONG_PASSWORD } });
    const audited = created.body.user.id;
    expect((await testPool().query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1", [audited])).rows[0].n).toBe(1);
    expect((await rejects("DELETE FROM users WHERE id = $1", [audited])).code).toBe("23001");

    const bare = await testPool().query(
      "INSERT INTO users (email, display_name, password_hash, role) VALUES ('bare@example.test','Bare','hash','viewer') RETURNING id");
    await testPool().query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", ["b".repeat(64), bare.rows[0].id]);
    await testPool().query("DELETE FROM users WHERE id = $1", [bare.rows[0].id]);
    expect((await testPool().query("SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1", ["b".repeat(64)])).rows[0].n).toBe(0);
  });
});

describe("migrations", () => {
  it("records the foundation migration and reapplying is a no-op", async () => {
    const applied = await testPool().query("SELECT name FROM schema_migrations ORDER BY name");
    expect(applied.rows.map((r) => r.name)).toEqual(["001_inventory_foundation.sql"]);
    const again = runMigrations();
    expect(again.status).toBe(0);
    expect(again.output).not.toMatch(/Applied/);
  });

  it("creates the expected tables and indexes", async () => {
    const tables = await testPool().query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      "audit_events", "inventory_items", "inventory_movements", "inventory_stock", "schema_migrations", "sessions", "users",
    ]);
    const indexes = await testPool().query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'");
    const names = indexes.rows.map((r) => r.indexname);
    for (const expected of ["sessions_expiration_idx", "inventory_stock_location_idx", "inventory_movements_item_idx", "audit_events_entity_idx", "audit_events_occurred_idx"]) {
      expect(names).toContain(expected);
    }
  });
});
