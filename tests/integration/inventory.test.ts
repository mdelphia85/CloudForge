import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call, closeDatabases, itemBody, loadHandlers, resetDatabase, seedActors, testPool, type Actors, type Handlers,
} from "./harness";

let h: Handlers;
let actors: Actors;

beforeAll(async () => {
  await resetDatabase();
  h = await loadHandlers();
  actors = await seedActors(h);
});
afterAll(closeDatabases);

const createItem = (overrides = {}, cookie = actors.admin.cookie) =>
  call(h.inventory.POST, { method: "POST", cookie, body: itemBody(overrides) });
const list = async () => (await call(h.inventory.GET, { cookie: actors.viewer.cookie })).body.items as Array<Record<string, string>>;

describe("item creation and retrieval", () => {
  it("creates an item and returns it through the list endpoint", async () => {
    const res = await createItem({ sku: "bolt-m8", name: "Hex bolt M8", onHand: "25", reorder: "10" });
    expect(res.status).toBe(201);
    const items = await list();
    const row = items.find((i) => i.sku === "BOLT-M8");
    expect(row).toMatchObject({
      sku: "BOLT-M8", name: "Hex bolt M8", category: "Fasteners", location: "Main warehouse", bin: "A-01",
      onHand: "25.000", reorder: "10.000", unit: "ea", state: "Healthy",
    });
    expect(Number(row!.updated)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("normalizes the SKU to upper case and trims text", async () => {
    await createItem({ sku: " trim-1 ", name: "  Washer  " });
    const row = (await list()).find((i) => i.sku === "TRIM-1");
    expect(row?.name).toBe("Washer");
  });

  it("derives stock state from on-hand quantity and reorder point", async () => {
    await createItem({ sku: "STATE-OUT", onHand: "0", reorder: "5" });
    await createItem({ sku: "STATE-LOW", onHand: "5", reorder: "5" });
    await createItem({ sku: "STATE-OK", onHand: "5.001", reorder: "5" });
    const byRef = Object.fromEntries((await list()).map((i) => [i.sku, i.state]));
    expect(byRef).toMatchObject({ "STATE-OUT": "Out of stock", "STATE-LOW": "Low stock", "STATE-OK": "Healthy" });
  });

  it("records an opening movement and an audit event, but no movement for a zero balance", async () => {
    const history = await call(h.movements.GET, { cookie: actors.viewer.cookie, path: "/api/inventory/movements?sku=BOLT-M8" });
    expect(history.status).toBe(200);
    expect(history.body.movements).toHaveLength(1);
    expect(history.body.movements[0]).toMatchObject({ type: "opening", quantityDelta: "25.000", toLocation: "Main warehouse", toBin: "A-01" });

    const empty = await call(h.movements.GET, { cookie: actors.viewer.cookie, path: "/api/inventory/movements?sku=STATE-OUT" });
    expect(empty.body.movements).toHaveLength(0);

    const audit = await testPool().query("SELECT actor_user_id, details FROM audit_events WHERE action = 'inventory.item.created' AND details->>'sku' = 'BOLT-M8'");
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_user_id).toBe(actors.admin.id);
  });

  it("returns 409 for a duplicate SKU and leaves the original untouched", async () => {
    const res = await createItem({ sku: "BOLT-M8", name: "Imposter", onHand: "999" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SKU_EXISTS");
    const rows = (await list()).filter((i) => i.sku === "BOLT-M8");
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Hex bolt M8");
  });

  it("rolls back completely when the item cannot be created", async () => {
    const before = await testPool().query("SELECT (SELECT count(*) FROM inventory_stock)::int AS stock, (SELECT count(*) FROM inventory_movements)::int AS moves");
    await createItem({ sku: "BOLT-M8" });
    const after = await testPool().query("SELECT (SELECT count(*) FROM inventory_stock)::int AS stock, (SELECT count(*) FROM inventory_movements)::int AS moves");
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("validates every field", async () => {
    const invalid: Array<Record<string, unknown>> = [
      { sku: "" }, { sku: "has space" }, { sku: "-leading-dash" }, { sku: "A".repeat(65) },
      { name: "" }, { category: "" }, { location: "" }, { bin: "" }, { unit: "" },
      { onHand: "-1" }, { onHand: "abc" }, { onHand: "1.0001" }, { reorder: "-0.5" }, { reorder: undefined },
    ];
    for (const overrides of invalid) {
      const res = await createItem({ sku: "VALID-1", ...overrides });
      expect(res.status, JSON.stringify(overrides)).toBe(400);
      expect(res.body.code).toBe("INVALID_ITEM");
    }
    expect((await list()).some((i) => i.sku === "VALID-1")).toBe(false);
  });

  it("accepts numeric (non-string) quantities", async () => {
    const res = await createItem({ sku: "NUM-1", onHand: 12, reorder: 3.5 });
    expect(res.status).toBe(201);
    expect((await list()).find((i) => i.sku === "NUM-1")).toMatchObject({ onHand: "12.000", reorder: "3.500" });
  });

  it("rejects non-object JSON bodies", async () => {
    const res = await call(h.inventory.POST, { method: "POST", cookie: actors.admin.cookie, rawBody: "\"string\"" });
    expect(res.status).toBe(400);
  });
});

describe("movement history lookup", () => {
  it("requires a valid SKU", async () => {
    for (const path of ["/api/inventory/movements", "/api/inventory/movements?sku=", "/api/inventory/movements?sku=bad%20sku"]) {
      const res = await call(h.movements.GET, { cookie: actors.viewer.cookie, path });
      expect(res.status, path).toBe(400);
      expect(res.body.code).toBe("INVALID_SKU");
    }
  });

  it("returns an empty list for an unknown SKU", async () => {
    const res = await call(h.movements.GET, { cookie: actors.viewer.cookie, path: "/api/inventory/movements?sku=NO-SUCH-SKU" });
    expect(res.status).toBe(200);
    expect(res.body.movements).toEqual([]);
  });

  it("matches the SKU case-insensitively", async () => {
    const res = await call(h.movements.GET, { cookie: actors.viewer.cookie, path: "/api/inventory/movements?sku=bolt-m8" });
    expect(res.body.movements).toHaveLength(1);
  });
});
