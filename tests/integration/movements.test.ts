import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call, closeDatabases, itemBody, loadHandlers, movementKey, resetDatabase, seedActors, testPool, type Actors, type Handlers,
} from "./harness";

let h: Handlers;
let actors: Actors;

beforeAll(async () => {
  await resetDatabase();
  h = await loadHandlers();
  actors = await seedActors(h);
});
afterAll(closeDatabases);

const WH = "Main warehouse";
let skuCounter = 0;

async function newItem(onHand = "10", overrides = {}) {
  const sku = `MV-${++skuCounter}`;
  const res = await call(h.inventory.POST, { method: "POST", cookie: actors.operator.cookie, body: itemBody({ sku, onHand, location: WH, bin: "A-01", ...overrides }) });
  expect(res.status).toBe(201);
  return sku;
}

const move = (body: Record<string, unknown>, headers?: Record<string, string>) =>
  call(h.movements.POST, { method: "POST", cookie: actors.operator.cookie, body: { idempotencyKey: movementKey(), ...body }, headers });

async function balances(sku: string): Promise<Record<string, string>> {
  const rows = await testPool().query(
    `SELECT s.location || '/' || s.bin AS key, s.on_hand::text AS qty
       FROM inventory_stock s JOIN inventory_items i ON i.id = s.item_id WHERE i.sku = $1`, [sku]);
  return Object.fromEntries(rows.rows.map((r) => [r.key, r.qty]));
}
const movementCount = async (sku: string) =>
  (await testPool().query("SELECT count(*)::int AS n FROM inventory_movements m JOIN inventory_items i ON i.id = m.item_id WHERE i.sku = $1", [sku])).rows[0].n as number;

describe("receipts", () => {
  it("adds to an existing bin and creates a new bin", async () => {
    const sku = await newItem("10");
    expect((await move({ type: "receipt", sku, quantity: "5.5", location: WH, bin: "A-01", reference: "PO-1" })).status).toBe(200);
    expect((await move({ type: "receipt", sku, quantity: "3", location: "Annex", bin: "B-07" })).status).toBe(200);
    expect(await balances(sku)).toEqual({ [`${WH}/A-01`]: "15.500", "Annex/B-07": "3.000" });
    const history = await call(h.movements.GET, { cookie: actors.viewer.cookie, path: `/api/inventory/movements?sku=${sku}` });
    expect(history.body.movements.map((m: { type: string }) => m.type).sort()).toEqual(["opening", "receipt", "receipt"]);
    expect(history.body.movements.find((m: { reference: string | null }) => m.reference === "PO-1")).toMatchObject({ quantityDelta: "5.500", toLocation: WH, toBin: "A-01" });
  });

  it("keeps decimal arithmetic exact", async () => {
    const sku = await newItem("0.1");
    await move({ type: "receipt", sku, quantity: "0.2", location: WH, bin: "A-01" });
    expect((await balances(sku))[`${WH}/A-01`]).toBe("0.300");
  });
});

describe("issues", () => {
  it("reduces stock and records a negative delta", async () => {
    const sku = await newItem("10");
    expect((await move({ type: "issue", sku, quantity: "4", sourceLocation: WH, sourceBin: "A-01", reference: "WO-9" })).status).toBe(200);
    expect((await balances(sku))[`${WH}/A-01`]).toBe("6.000");
    const history = await call(h.movements.GET, { cookie: actors.viewer.cookie, path: `/api/inventory/movements?sku=${sku}` });
    expect(history.body.movements[0]).toMatchObject({ type: "issue", quantityDelta: "-4.000", fromLocation: WH, fromBin: "A-01", toLocation: null });
  });

  it("can issue the exact on-hand quantity down to zero", async () => {
    const sku = await newItem("4");
    expect((await move({ type: "issue", sku, quantity: "4", sourceLocation: WH, sourceBin: "A-01" })).status).toBe(200);
    expect((await balances(sku))[`${WH}/A-01`]).toBe("0.000");
  });

  it("refuses to issue more than is on hand and changes nothing", async () => {
    const sku = await newItem("3");
    const before = await movementCount(sku);
    const res = await move({ type: "issue", sku, quantity: "3.001", sourceLocation: WH, sourceBin: "A-01" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INSUFFICIENT_STOCK");
    expect((await balances(sku))[`${WH}/A-01`]).toBe("3.000");
    expect(await movementCount(sku)).toBe(before);
  });

  it("refuses to issue from a bin that has no stock", async () => {
    const sku = await newItem("3");
    const res = await move({ type: "issue", sku, quantity: "1", sourceLocation: WH, sourceBin: "NOPE" });
    expect(res.status).toBe(409);
  });

  it("never lets simultaneous issues drive stock negative", async () => {
    const sku = await newItem("10");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => move({ type: "issue", sku, quantity: "4", sourceLocation: WH, sourceBin: "A-01" })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect((await balances(sku))[`${WH}/A-01`]).toBe("2.000");
  });
});

describe("transfers", () => {
  it("moves stock between bins, preserving the total", async () => {
    const sku = await newItem("10");
    expect((await move({ type: "transfer", sku, quantity: "4", sourceLocation: WH, sourceBin: "A-01", destinationLocation: "Line 2", destinationBin: "W-1" })).status).toBe(200);
    expect(await balances(sku)).toEqual({ [`${WH}/A-01`]: "6.000", "Line 2/W-1": "4.000" });
    const history = await call(h.movements.GET, { cookie: actors.viewer.cookie, path: `/api/inventory/movements?sku=${sku}` });
    expect(history.body.movements[0]).toMatchObject({ type: "transfer", quantityDelta: "-4.000", fromLocation: WH, toLocation: "Line 2", toBin: "W-1" });
  });

  it("adds to an existing destination bin", async () => {
    const sku = await newItem("10");
    await move({ type: "receipt", sku, quantity: "2", location: "Line 2", bin: "W-1" });
    await move({ type: "transfer", sku, quantity: "3", sourceLocation: WH, sourceBin: "A-01", destinationLocation: "Line 2", destinationBin: "W-1" });
    expect(await balances(sku)).toEqual({ [`${WH}/A-01`]: "7.000", "Line 2/W-1": "5.000" });
  });

  it("is all-or-nothing when the source lacks stock", async () => {
    const sku = await newItem("2");
    const before = await balances(sku);
    const res = await move({ type: "transfer", sku, quantity: "5", sourceLocation: WH, sourceBin: "A-01", destinationLocation: "Line 2", destinationBin: "W-1" });
    expect(res.status).toBe(409);
    expect(await balances(sku)).toEqual(before);
  });

  it("requires distinct source and destination and all four location fields", async () => {
    const sku = await newItem("5");
    const same = await move({ type: "transfer", sku, quantity: "1", sourceLocation: WH, sourceBin: "A-01", destinationLocation: WH, destinationBin: "A-01" });
    expect(same.status).toBe(400);
    const partial = await move({ type: "transfer", sku, quantity: "1", sourceLocation: WH, sourceBin: "A-01" });
    expect(partial.status).toBe(400);
  });
});

describe("cycle counts", () => {
  it("sets the balance to the counted quantity and records the delta", async () => {
    const sku = await newItem("10");
    expect((await move({ type: "count", sku, quantity: "7", location: WH, bin: "A-01" })).status).toBe(200);
    expect((await move({ type: "count", sku, quantity: "9.25", location: WH, bin: "A-01" })).status).toBe(200);
    expect((await balances(sku))[`${WH}/A-01`]).toBe("9.250");
    const history = await call(h.movements.GET, { cookie: actors.viewer.cookie, path: `/api/inventory/movements?sku=${sku}` });
    const deltas = history.body.movements.filter((m: { type: string }) => m.type === "count").map((m: { quantityDelta: string }) => m.quantityDelta).sort();
    expect(deltas).toEqual(["-3.000", "2.250"]);
  });

  it("allows counting a bin down to zero", async () => {
    const sku = await newItem("10");
    expect((await move({ type: "count", sku, quantity: "0", location: WH, bin: "A-01" })).status).toBe(200);
    expect((await balances(sku))[`${WH}/A-01`]).toBe("0.000");
  });

  it("returns 404 when no balance exists at that bin", async () => {
    const sku = await newItem("10");
    const res = await move({ type: "count", sku, quantity: "1", location: WH, bin: "ZZ-99" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("STOCK_NOT_FOUND");
  });
});

describe("idempotency", () => {
  it("rejects a replayed key without applying the movement twice", async () => {
    const sku = await newItem("10");
    const key = movementKey();
    const body = { type: "issue", sku, quantity: "3", sourceLocation: WH, sourceBin: "A-01", idempotencyKey: key };
    expect((await move(body)).status).toBe(200);
    const replay = await move(body);
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("DUPLICATE_MOVEMENT");
    expect((await balances(sku))[`${WH}/A-01`]).toBe("7.000");
    expect(await movementCount(sku)).toBe(2);
  });

  it("accepts the key from the Idempotency-Key header", async () => {
    const sku = await newItem("10");
    const key = movementKey();
    const body = { type: "receipt", sku, quantity: "1", location: WH, bin: "A-01" };
    const res = await call(h.movements.POST, { method: "POST", cookie: actors.operator.cookie, body, headers: { "idempotency-key": key } });
    expect(res.status).toBe(200);
    const replay = await call(h.movements.POST, { method: "POST", cookie: actors.operator.cookie, body, headers: { "idempotency-key": key } });
    expect(replay.status).toBe(409);
    expect((await balances(sku))[`${WH}/A-01`]).toBe("11.000");
  });

  it("treats two simultaneous submissions of the same key as one", async () => {
    const sku = await newItem("10");
    const key = movementKey();
    const body = { type: "issue", sku, quantity: "2", sourceLocation: WH, sourceBin: "A-01", idempotencyKey: key };
    const results = await Promise.all([move(body), move(body)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await balances(sku))[`${WH}/A-01`]).toBe("8.000");
  });
});

describe("movement validation", () => {
  it("rejects an unknown SKU with 404 and a disabled item", async () => {
    expect((await move({ type: "receipt", sku: "NO-SUCH", quantity: "1", location: WH, bin: "A-01" })).status).toBe(404);
    const sku = await newItem("1");
    await testPool().query("UPDATE inventory_items SET is_active = false WHERE sku = $1", [sku]);
    expect((await move({ type: "receipt", sku, quantity: "1", location: WH, bin: "A-01" })).status).toBe(404);
  });

  it("rejects malformed movements", async () => {
    const sku = await newItem("5");
    const cases: Array<Record<string, unknown>> = [
      { type: "teleport", sku, quantity: "1", location: WH, bin: "A-01" },
      { type: "receipt", sku, quantity: "0", location: WH, bin: "A-01" },
      { type: "receipt", sku, quantity: "-1", location: WH, bin: "A-01" },
      { type: "receipt", sku, quantity: "1.0001", location: WH, bin: "A-01" },
      { type: "receipt", sku, quantity: "abc", location: WH, bin: "A-01" },
      { type: "receipt", sku, quantity: "1" },
      { type: "issue", sku, quantity: "1" },
      { type: "receipt", sku: "bad sku", quantity: "1", location: WH, bin: "A-01" },
      { type: "receipt", sku, quantity: "1", location: WH, bin: "A-01", idempotencyKey: "short" },
    ];
    for (const body of cases) {
      const res = await move(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe("INVALID_MOVEMENT");
    }
    expect((await balances(sku))[`${WH}/A-01`]).toBe("5.000");
  });

  it("keeps every item's stock equal to its movement ledger (transfers net to zero)", async () => {
    await move({ type: "receipt", sku: await newItem("3"), quantity: "2", location: WH, bin: "A-01" });
    const stock = await testPool().query(
      "SELECT i.sku, COALESCE(sum(s.on_hand), 0)::text AS total FROM inventory_items i LEFT JOIN inventory_stock s ON s.item_id = i.id GROUP BY i.sku");
    const ledger = await testPool().query(
      `SELECT i.sku, COALESCE(sum(m.quantity_delta) FILTER (WHERE m.movement_type <> 'transfer'), 0)::text AS total
         FROM inventory_items i LEFT JOIN inventory_movements m ON m.item_id = i.id GROUP BY i.sku`);
    const ledgerBySku = Object.fromEntries(ledger.rows.map((r) => [r.sku, Number(r.total)]));
    expect(stock.rows.length).toBeGreaterThan(5);
    for (const row of stock.rows) {
      expect(Number(row.total), row.sku).toBeCloseTo(ledgerBySku[row.sku], 3);
    }
  });
});
