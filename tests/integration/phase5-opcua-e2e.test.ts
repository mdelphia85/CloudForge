import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { call, closeDatabases, loadHandlers, resetDatabase, seedActors, type Actors } from "./harness";
import * as equipment from "@/app/api/operations/equipment/route";
import * as telemetry from "@/app/api/operations/equipment/[id]/telemetry/route";
import * as alarms from "@/app/api/operations/equipment/[id]/alarms/route";
import * as gateways from "@/app/api/gateways/route";
import * as ingest from "@/app/api/gateways/ingest/route";

let actors: Actors;
beforeAll(async () => {
  await resetDatabase();
  actors = await seedActors(await loadHandlers());
});
afterAll(closeDatabases);

it("forwards a simulated OPC UA reading through the durable queue into equipment and alarms", async () => {
  const asset = await call(equipment.POST, {
    method: "POST", cookie: actors.admin.cookie,
    body: { assetTag: "E2E-OPCUA", name: "OPC UA simulated equipment", customerSite: "Test" },
  });
  expect(asset.status).toBe(201);
  const assetId = String(asset.body.id);
  const context = { params: Promise.resolve({ id: assetId }) };
  const initial = await call((request) => telemetry.GET(request, context), { cookie: actors.admin.cookie });
  const tag = (initial.body.tags as Array<{ id: string; tagName: string }>).find((row) => row.tagName === "temperature_c")!;
  expect((await call((request) => alarms.POST(request, context), {
    method: "POST", cookie: actors.admin.cookie,
    body: { name: "Simulator threshold", tagId: tag.id, condition: "above", threshold: "40", severity: "high" },
  })).status).toBe(201);
  const keys = generateKeyPairSync("ed25519");
  const registered = await call(gateways.POST, {
    method: "POST", cookie: actors.admin.cookie,
    body: {
      name: "OPC UA test", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), tagIds: [tag.id],
    },
  });
  expect(registered.status).toBe(201);
  const directory = await mkdtemp(join(tmpdir(), "cloudforge-e2e-"));
  const keyPath = join(directory, "signing.pem");
  await writeFile(keyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const requests: string[] = [];
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push(body);
      if (requests.length === 1) {
        outgoing.writeHead(503).end();
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name,value);
      }
      const request = new Request("http://127.0.0.1/api/gateways/ingest", {
        method: "POST", headers, body,
      });
      const response = await ingest.POST(request);
      outgoing.writeHead(response.status, { "content-type": "application/json" });
      outgoing.end(await response.text());
      if (response.ok) await writeFile(join(directory, "delivered"), "ok");
    })().catch((error: unknown) => {
      console.error("Test delivery server failed.", error);
      outgoing.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected loopback test server address.");
    const child = spawn(process.execPath, [
      join("gateway", "test", "ingestion-driver.mjs"), assetId, String(registered.body.id), keyPath,
      `http://127.0.0.1:${address.port}`, directory,
    ], { cwd: process.cwd(), timeout: 60_000 });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(exitCode, output).toBe(0);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[1]).toBe(requests[0]);
    const status = await call((request) => telemetry.GET(request, context), { cookie: actors.admin.cookie });
    expect(status.body.provider).toBe("gateway");
    expect(status.body.connection).toBe("connected");
    expect(status.body.tags.find((item: { id: string }) => item.id === tag.id)).toMatchObject({
      value: "42", quality: "good", freshness: "fresh", orderingState: "ordered",
    });
    const result = await call((request) => alarms.GET(request, context), { cookie: actors.admin.cookie });
    expect(result.body.alarms).toHaveLength(1);
    expect(result.body.alarms[0]).toMatchObject({ provider: "gateway", clearedAt: null });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
