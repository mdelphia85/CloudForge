import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InvalidOpcUaReadingError, OpcUaReader, validateOpcUaConfig } from "../src/opcua.mjs";
import { createSimulator } from "./simulator.mjs";

test("secure read-only polling connects to a local OPC UA simulator and rejects untrusted servers", { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cloudforge-opcua-test-"));
  let simulator;
  let server;
  let reader;
  try {
    simulator = await createSimulator(dir, "11111111-1111-4111-8111-111111111111");
    server = simulator.server;
    const { config } = simulator;
    validateOpcUaConfig(config);
    reader = new OpcUaReader(config);
    await assert.rejects(reader.read());
    await reader.close();
    reader = undefined;
    await simulator.trust();
    reader = new OpcUaReader({ ...config, serverCertificateSha256: "0".repeat(64) });
    await assert.rejects(reader.read(), /fingerprint/);
    await reader.close();
    reader = new OpcUaReader(config);
    const readings = await reader.read();
    assert.equal(readings.get(config.mappings[0].assetId)[0].value, 42);
    assert.equal(readings.get(config.mappings[0].assetId)[0].quality, "good");
    assert.ok(readings.get(config.mappings[0].assetId)[0].observedAt);
    await reader.disconnect();
    assert.equal((await reader.read()).get(config.mappings[0].assetId)[0].value, 42);
    reader.config = { ...config, mappings: [{ ...config.mappings[0], dataType: "string" }] };
    await assert.rejects(reader.read(), InvalidOpcUaReadingError);
    assert.ok(reader.session);
    reader.config = config;
    assert.equal((await reader.read()).get(config.mappings[0].assetId)[0].value, 42);
    const serverKeys = { certificateFile: server.certificateFile, privateKeyFile: server.privateKeyFile };
    await server.shutdown(0);
    server = undefined;
    await assert.rejects(reader.read());
    server = await simulator.start(serverKeys);
    assert.equal((await reader.read()).get(config.mappings[0].assetId)[0].value, 42);
    assert.throws(() => validateOpcUaConfig({ ...config, mappings: [] }), /explicitly allowed/);
  } finally {
    if (reader) await reader.close();
    if (server) await server.shutdown(0);
    if (simulator) await simulator.serverManager.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
