import { afterAll, beforeAll, expect, it } from "vitest";
import { call, closeDatabases, loadHandlers, resetDatabase, seedActors, testPool, type Actors } from "./harness";
import * as equipment from "@/app/api/operations/equipment/route";
import * as telemetry from "@/app/api/operations/equipment/[id]/telemetry/route";
import * as alarms from "@/app/api/operations/equipment/[id]/alarms/route";
import * as alarm from "@/app/api/operations/equipment/[id]/alarms/[alarmId]/route";
import * as rule from "@/app/api/operations/equipment/[id]/alarms/rules/[ruleId]/route";
import * as simulate from "@/app/api/operations/telemetry/simulate/route";

let actors: Actors;

beforeAll(async () => {
  await resetDatabase();
  actors = await seedActors(await loadHandlers());
});
afterAll(closeDatabases);

it("evaluates fresh good readings once, retains alarm history, and restricts actions", async () => {
  const asset = await call(equipment.POST, {
    method: "POST", cookie: actors.admin.cookie,
    body: { assetTag: "P5-ALARM", name: "Alarm test machine", customerSite: "Test plant" },
  });
  expect(asset.status).toBe(201);
  const id = String(asset.body.id);
  const withAsset = (handler: typeof alarms.GET | typeof alarms.POST, options: Parameters<typeof call>[1] = {}) =>
    call((request) => handler(request, { params: Promise.resolve({ id }) }), options);
  const data = await call((request) => telemetry.GET(request, { params: Promise.resolve({ id }) }), { cookie: actors.admin.cookie });
  const tags = data.body.tags as Array<{ id: string; tagName: string }>;
  const stateTag = tags.find((tag) => tag.tagName === "machine_state")!.id;
  const tempTag = tags.find((tag) => tag.tagName === "temperature_c")!.id;
  const stateRule = { name: "Fault state", tagId: stateTag, condition: "equals", threshold: "fault", severity: "high" };
  expect((await withAsset(alarms.GET, { cookie: actors.viewer.cookie })).status).toBe(403);
  expect((await withAsset(alarms.POST, { method: "POST", cookie: actors.viewer.cookie, body: stateRule })).status).toBe(403);
  const createdRule = await withAsset(alarms.POST, { method: "POST", cookie: actors.admin.cookie, body: stateRule });
  expect(createdRule.status).toBe(201);
  const ruleId = String(createdRule.body.id);
  const pause = (cookie: string, enabled: boolean) => call((request) =>
    rule.PATCH(request, { params: Promise.resolve({ id, ruleId }) }), { method: "PATCH", cookie, body: { enabled } });
  expect((await pause(actors.viewer.cookie, false)).status).toBe(403);
  expect((await withAsset(alarms.POST, {
    method: "POST", cookie: actors.admin.cookie,
    body: { name: "High temperature", tagId: tempTag, condition: "above", threshold: "41", severity: "critical", debounceSamples: 2 },
  })).status).toBe(201);
  const sample = (mode: string) => call(simulate.POST, { method: "POST", cookie: actors.operator.cookie, body: { assetId: id, mode } });
  for (const mode of ["invalid", "stale", "out_of_order", "normal", "normal"]) {
    expect((await sample(mode)).status).toBe(200);
  }
  expect((await withAsset(alarms.GET, { cookie: actors.admin.cookie })).body.alarms).toHaveLength(0);
  expect((await sample("fault")).status).toBe(200);
  expect((await sample("fault")).status).toBe(200);
  const active = await withAsset(alarms.GET, { cookie: actors.admin.cookie });
  expect(active.body.alarms).toHaveLength(2);
  expect((await pause(actors.admin.cookie, false)).status).toBe(409);
  const stateAlarm = (active.body.alarms as Array<{ id: string; name: string }>).find((row) => row.name === "Fault state")!;
  const acknowledge = (cookie: string) => call((request) =>
    alarm.POST(request, { params: Promise.resolve({ id, alarmId: stateAlarm.id }) }), { method: "POST", cookie });
  expect((await acknowledge(actors.viewer.cookie)).status).toBe(403);
  expect((await acknowledge(actors.operator.cookie)).body.alreadyAcknowledged).toBe(false);
  expect((await acknowledge(actors.operator.cookie)).body.alreadyAcknowledged).toBe(true);
  expect((await sample("stopped")).status).toBe(200);
  const history = await withAsset(alarms.GET, { cookie: actors.admin.cookie });
  const state = (history.body.alarms as Array<{ id: string; clearedAt: string | null; events: Array<{ action: string }> }>)
    .find((row) => row.id === stateAlarm.id)!;
  expect(state.clearedAt).toBeTruthy();
  expect(state.events.map((event) => event.action)).toEqual(["triggered", "acknowledged", "cleared"]);
  expect((await pause(actors.admin.cookie, false)).status).toBe(200);
  expect((await pause(actors.admin.cookie, true)).status).toBe(200);
  const events = await testPool().query("SELECT id FROM equipment_alarm_events WHERE alarm_id=$1", [stateAlarm.id]);
  expect(events.rowCount).toBe(3);
  await expect(testPool().query("DELETE FROM equipment_alarm_events WHERE alarm_id=$1", [stateAlarm.id])).rejects.toThrow(/append-only/);
});
