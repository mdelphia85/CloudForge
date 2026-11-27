import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { call, closeDatabases, loadHandlers, resetDatabase, seedActors, testPool, type Actors } from "./harness";
import * as equipment from "@/app/api/operations/equipment/route";
import * as telemetry from "@/app/api/operations/equipment/[id]/telemetry/route";
import * as history from "@/app/api/operations/equipment/[id]/telemetry/history/route";
import * as alarms from "@/app/api/operations/equipment/[id]/alarms/route";
import * as simulate from "@/app/api/operations/telemetry/simulate/route";
import * as gateways from "@/app/api/gateways/route";
import * as gateway from "@/app/api/gateways/[id]/route";
import * as ingest from "@/app/api/gateways/ingest/route";

let actors: Actors;

beforeAll(async () => {
  await resetDatabase();
  actors = await seedActors(await loadHandlers());
});
afterAll(closeDatabases);

function publicPem(key: KeyObject) {
  return key.export({ type: "spki", format: "pem" }).toString();
}

function signedHeaders(gatewayId: string, key: KeyObject, raw: string, timestamp = new Date().toISOString()) {
  const hash = createHash("sha256").update(raw).digest("hex");
  return {
    "x-cloudforge-gateway": gatewayId,
    "x-cloudforge-timestamp": timestamp,
    "x-cloudforge-signature": sign(null, Buffer.from(`cloudforge-gateway-v1\n${gatewayId}\n${timestamp}\n${hash}`), key).toString("base64url"),
  };
}

it("enrolls a gateway, preserves source provenance and processes authenticated readings and alarms", async () => {
  const created = await call(equipment.POST, {
    method: "POST", cookie: actors.admin.cookie,
    body: { assetTag: "GW-TEST", name: "Gateway test equipment", customerSite: "Test plant" },
  });
  expect(created.status).toBe(201);
  const assetId = String(created.body.id);
  const context = { params: Promise.resolve({ id: assetId }) };
  const status = (provider?: string) => call((request) => telemetry.GET(request, context), {
    cookie: actors.admin.cookie, path: provider ? `/api/test?provider=${provider}` : "/api/test",
  });
  const initial = await status();
  const tags = initial.body.tags as Array<{ id: string; tagName: string }>;
  const temp = tags.find((tag) => tag.tagName === "temperature_c")!;
  const state = tags.find((tag) => tag.tagName === "machine_state")!;
  expect((await call(simulate.POST, {
    method: "POST", cookie: actors.operator.cookie, body: { assetId, mode: "normal" },
  })).status).toBe(200);
  expect((await call((request) => alarms.POST(request, context), {
    method: "POST", cookie: actors.admin.cookie,
    body: { name: "Gateway temperature", tagId: temp.id, condition: "above", threshold: "50", severity: "high" },
  })).status).toBe(201);
  const keys = generateKeyPairSync("ed25519");
  const registration = {
    name: "Test gateway", publicKey: publicPem(keys.publicKey),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), tagIds: [temp.id],
  };
  expect((await call(gateways.POST, { method: "POST", cookie: actors.operator.cookie, body: registration })).status).toBe(403);
  const registered = await call(gateways.POST, { method: "POST", cookie: actors.admin.cookie, body: registration });
  expect(registered.status).toBe(201);
  const gatewayId = String(registered.body.id);
  const listed = await call(gateways.GET, { cookie: actors.admin.cookie });
  expect(listed.body.gateways[0]).not.toHaveProperty("public_key");
  expect((await call(gateways.GET, { cookie: actors.viewer.cookie })).status).toBe(403);

  const capturedAt = new Date().toISOString();
  const observed = new Date(Date.now() - 10_000).toISOString();
  const body = (sequence: number, value: unknown, extra: Record<string, unknown> = {}) => ({
    sequence, assetId, connected: true, capturedAt,
    readings: [{ tagName: "temperature_c", value, quality: "good", observedAt: observed }],
    ...extra,
  });
  const deliver = (payload: Record<string, unknown>, key = keys.privateKey, timestamp?: string) => {
    const raw = JSON.stringify(payload);
    return call(ingest.POST, { method: "POST", rawBody: raw, headers: signedHeaders(gatewayId,key,raw,timestamp) });
  };
  const first = await deliver(body(1,60));
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ sequence: 1, accepted: 1, replayed: false });
  expect((await deliver(body(1,60))).body.replayed).toBe(true);
  expect((await deliver(body(1,61))).status).toBe(409);
  expect((await deliver(body(2,60))).body.accepted).toBe(0);
  expect((await deliver(body(3,60,{ readings: [{ tagName: "machine_state", value: "fault", quality: "good", observedAt: observed }] }))).status).toBe(403);
  expect((await deliver(body(3,"not a number"))).status).toBe(400);
  expect((await deliver(body(3,60,{ capturedAt: new Date(Date.now() + 120_000).toISOString() }))).status).toBe(400);
  const signedBody = JSON.stringify(body(3,60));
  expect((await call(ingest.POST, {
    method: "POST", rawBody: JSON.stringify(body(3,61)), headers: signedHeaders(gatewayId,keys.privateKey,signedBody),
  })).status).toBe(401);
  expect((await deliver(body(3,60), keys.privateKey, new Date(Date.now() - 300_000).toISOString())).status).toBe(401);
  expect((await deliver(body(3,60), generateKeyPairSync("ed25519").privateKey)).status).toBe(401);

  const gatewayStatus = await status();
  expect(gatewayStatus.body.provider).toBe("gateway");
  expect(gatewayStatus.body.connection).toBe("connected");
  expect(gatewayStatus.body.tags.find((tag: { id: string }) => tag.id === temp.id).value).toBe("60");
  expect(gatewayStatus.body.tags.find((tag: { id: string }) => tag.id === state.id).value).toBeNull();
  expect((await status("simulated")).body.tags.find((tag: { id: string }) => tag.id === temp.id).value).not.toBe("60");
  const alarmList = await call((request) => alarms.GET(request, context), { cookie: actors.admin.cookie });
  expect(alarmList.body.alarms).toHaveLength(1);
  expect(alarmList.body.alarms[0]).toMatchObject({ provider: "gateway", clearedAt: null });
  expect(alarmList.body.alarms[0].events[0].actor).toBe("Gateway: Test gateway");

  const later = new Date(Date.now() - 5_000).toISOString();
  expect((await deliver(body(4,70, { readings: [{ tagName: "temperature_c", value: 70, quality: "bad", observedAt: later }] }))).status).toBe(200);
  const outOfOrder = await deliver(body(3,30, { readings: [{ tagName: "temperature_c", value: 30, quality: "good", observedAt: new Date(Date.now() - 1000).toISOString() }] }));
  expect(outOfOrder.body.outOfOrder).toBe(1);
  expect((await call((request) => alarms.GET(request, context), { cookie: actors.admin.cookie })).body.alarms[0].clearedAt).toBeNull();
  const disconnected = await deliver({ sequence: 5, assetId, connected: false, capturedAt: new Date().toISOString(), readings: [] });
  expect(disconnected.status).toBe(200);
  expect((await status()).body.connection).toBe("disconnected");
  const hist = await call((request) => history.GET(request, context), {
    cookie: actors.admin.cookie, path: `/api/test?tagId=${temp.id}&provider=gateway`,
  });
  expect(hist.body.points).toHaveLength(3);
  expect(hist.body.points.some((point: { orderingState: string }) => point.orderingState === "out_of_order")).toBe(true);
  const machineAudit = await testPool().query(
    "SELECT actor_user_id,gateway_actor_id FROM audit_events WHERE action='equipment_alarm.triggered' AND gateway_actor_id=$1",
    [gatewayId],
  );
  expect(machineAudit.rows).toEqual([{ actor_user_id: null, gateway_actor_id: gatewayId }]);
  expect((await testPool().query("SELECT count(*)::int AS n FROM asset_downtime_events WHERE asset_id=$1", [assetId])).rows[0].n).toBe(0);

  const change = (action: string, extra: Record<string, unknown> = {}, cookie = actors.admin.cookie) =>
    call((request) => gateway.PATCH(request, { params: Promise.resolve({ id: gatewayId }) }), {
      method: "PATCH", cookie, body: { action, ...extra },
    });
  expect((await change("disable", {}, actors.operator.cookie)).status).toBe(403);
  expect((await change("disable")).status).toBe(200);
  expect((await deliver(body(6,60))).status).toBe(401);
  expect((await change("enable")).status).toBe(200);
  const nextKeys = generateKeyPairSync("ed25519");
  expect((await change("rotate", { publicKey: publicPem(nextKeys.publicKey), expiresAt: registration.expiresAt })).status).toBe(200);
  expect((await deliver(body(6,60))).status).toBe(401);
  const reconnectedAt = new Date().toISOString();
  expect((await deliver(body(6,30, {
    capturedAt: reconnectedAt,
    readings: [{ tagName: "temperature_c", value: 30, quality: "good", observedAt: reconnectedAt }],
  }), nextKeys.privateKey)).status).toBe(200);
  expect((await status()).body.connection).toBe("connected");
  expect((await call((request) => alarms.GET(request, context), { cookie: actors.admin.cookie })).body.alarms[0].clearedAt).toBeTruthy();
  expect((await deliver({
    sequence: 7, assetId, connected: false, capturedAt: new Date().toISOString(),
    readings: [], diagnostic: "invalid_reading",
  }, nextKeys.privateKey)).status).toBe(200);
  const invalid = await status();
  expect(invalid.body.connection).toBe("faulted");
  expect(invalid.body.lastError).toContain("invalid value or timestamp");
  expect(invalid.body.tags.find((tag: { id: string }) => tag.id === temp.id).value).toBe("30");
  await testPool().query("UPDATE industrial_gateways SET expires_at=now()-interval '1 second' WHERE id=$1", [gatewayId]);
  expect((await deliver(body(8,60), nextKeys.privateKey)).status).toBe(401);
  expect((await status()).body.connection).toBe("disconnected");
  expect((await change("revoke")).status).toBe(200);
  expect((await change("enable")).status).toBe(409);
  expect((await deliver(body(8,60), nextKeys.privateKey)).status).toBe(401);
  const replacement = await call(gateways.POST, { method: "POST", cookie: actors.admin.cookie, body: registration });
  expect(replacement.status).toBe(201);
  expect((await testPool().query("SELECT gateway_id FROM asset_telemetry_sources WHERE asset_id=$1 AND provider='gateway'", [assetId])).rows[0].gateway_id).toBe(replacement.body.id);
});

it("keeps simulator and gateway alarm debounce and clearing independent", async () => {
  const created = await call(equipment.POST, {
    method: "POST", cookie: actors.admin.cookie,
    body: { assetTag: "GW-ALARMS", name: "Separate alarm sources", customerSite: "Test plant" },
  });
  const assetId = String(created.body.id);
  const context = { params: Promise.resolve({ id: assetId }) };
  const initial = await call((request) => telemetry.GET(request, context), { cookie: actors.admin.cookie });
  const tags = initial.body.tags as Array<{ id: string; tagName: string }>;
  const temperature = tags.find((tag) => tag.tagName === "temperature_c")!;
  const machineState = tags.find((tag) => tag.tagName === "machine_state")!;
  for (const body of [
    { name: "Source fault", tagId: machineState.id, condition: "equals", threshold: "fault", severity: "high" },
    { name: "Source temperature", tagId: temperature.id, condition: "above", threshold: "40", severity: "high", debounceSamples: 2 },
  ]) {
    expect((await call((request) => alarms.POST(request, context), { method: "POST", cookie: actors.admin.cookie, body })).status).toBe(201);
  }
  const simulateMode = (mode: string) => call(simulate.POST, {
    method: "POST", cookie: actors.operator.cookie, body: { assetId, mode },
  });
  expect((await simulateMode("fault")).status).toBe(200);
  const keys = generateKeyPairSync("ed25519");
  const registered = await call(gateways.POST, {
    method: "POST", cookie: actors.admin.cookie,
    body: {
      name: "Independent source gateway", publicKey: publicPem(keys.publicKey),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), tagIds: [temperature.id],
    },
  });
  expect(registered.status).toBe(201);
  const gatewayId = String(registered.body.id);
  const send = async (sequence: number, offset: number) => {
    const raw = JSON.stringify({
      sequence, assetId, connected: true, capturedAt: new Date().toISOString(),
      readings: [{ tagName: "temperature_c", value: 60, quality: "good", observedAt: new Date(Date.now() - offset).toISOString() }],
    });
    return call(ingest.POST, { method: "POST", rawBody: raw, headers: signedHeaders(gatewayId, keys.privateKey, raw) });
  };
  expect((await send(1, 2000)).status).toBe(200);
  let list = await call((request) => alarms.GET(request, context), { cookie: actors.admin.cookie });
  expect(list.body.alarms).toHaveLength(1);
  expect(list.body.alarms[0]).toMatchObject({ name: "Source fault", provider: "simulated", clearedAt: null });
  expect((await simulateMode("stopped")).status).toBe(200);
  list = await call((request) => alarms.GET(request, context), { cookie: actors.admin.cookie });
  expect(list.body.alarms.find((item: { name: string }) => item.name === "Source fault").clearedAt).toBeTruthy();
  expect(list.body.alarms.find((item: { name: string }) => item.name === "Source temperature")).toMatchObject({
    provider: "simulated", clearedAt: null,
  });
  expect((await send(2, 1000)).status).toBe(200);
  list = await call((request) => alarms.GET(request, context), { cookie: actors.admin.cookie });
  expect(list.body.alarms.filter((item: { name: string }) => item.name === "Source temperature")
    .map((item: { provider: string }) => item.provider).sort()).toEqual(["gateway", "simulated"]);
});
