import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runPipeline } from "../src/pipeline.mjs";
import { validateProvider, validateProviderReadings } from "../src/provider.mjs";
import { createConfiguredProvider } from "../src/providers.mjs";
import { PersistentQueue } from "../src/queue.mjs";

const assetId = "11111111-1111-4111-8111-111111111111";

test("the generic provider contract rejects unallowlisted and invalid telemetry", async () => {
  const provider = {
    mappings: [{ assetId, tagName: "temperature_c", dataType: "number" }],
    async read() { return new Map(); },
    async close() {},
  };
  const allowed = validateProvider(provider);
  const sample = { tagName: "temperature_c", value: 42, quality: "good", observedAt: new Date().toISOString() };
  validateProviderReadings(new Map([[assetId, [sample]]]), allowed);
  for (const invalid of [
    { ...sample, tagName: "not_allowed" },
    { ...sample, value: NaN },
    { ...sample, quality: "unknown" },
    { ...sample, observedAt: new Date(Date.now() + 60_000).toISOString() },
    { ...sample, observedAt: new Date(Date.now() - 31 * 86_400_000).toISOString() },
  ]) {
    assert.throws(() => validateProviderReadings(new Map([[assetId, [invalid]]]), allowed), /invalid/);
  }
  await assert.rejects(createConfiguredProvider({ provider: { type: "unknown", options: {} } }), /supported/);
  await assert.rejects(createConfiguredProvider({ provider: { type: "opcua", options: {} }, opcua: {} }), /either/);
});

test("a non-OPC provider uses the same durable signed pipeline through disconnect and recovery", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cloudforge-provider-"));
  const queue = new PersistentQueue(join(dir, "buffer.sqlite"), { maxItems: 10, maxBytes: 10000 });
  const controller = new AbortController();
  const keys = generateKeyPairSync("ed25519");
  let calls = 0;
  let closed = false;
  const provider = {
    mappings: [{ assetId, tagName: "temperature_c", dataType: "number" }],
    async read() {
      if (++calls === 1) throw new Error("Test connection unavailable.");
      return new Map([[assetId, [{ tagName: "temperature_c", value: 42, quality: "good",
        observedAt: new Date().toISOString(), privateMetadata: "must-not-be-sent" }]]]);
    },
    async close() { closed = true; },
  };
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const hash = createHash("sha256").update(raw).digest("hex");
    const canonical = `cloudforge-gateway-v1\n${assetId}\n${request.headers["x-cloudforge-timestamp"]}\n${hash}`;
    requests.push({ body, signed: verify(null, Buffer.from(canonical), keys.publicKey,
      Buffer.from(request.headers["x-cloudforge-signature"], "base64url")) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ sequence: body.sequence }));
    if (body.connected) controller.abort();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await runPipeline({
      provider, queue, pollMs: 1000, signal: controller.signal,
      delivery: {
        baseUrl: `http://127.0.0.1:${server.address().port}`, gatewayId: assetId, privateKey: keys.privateKey,
        timeoutMs: 2000, allowInsecureLoopback: true,
      },
    });
    assert.equal(closed, true);
    assert.equal(requests[0].body.connected, false);
    assert.equal(requests[1].body.connected, true);
    assert.equal(requests[1].body.readings[0].value, 42);
    assert.equal(requests[1].body.readings[0].privateMetadata, undefined);
    assert.ok(requests.every((request) => request.signed));
  } finally {
    controller.abort();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
