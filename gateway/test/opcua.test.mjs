import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OPCUACertificateManager } from "node-opcua-certificate-manager";
import { DataType, MessageSecurityMode, OPCUAServer, SecurityPolicy, Variant } from "node-opcua";
import { OpcUaReader, validateOpcUaConfig } from "../src/opcua.mjs";

test("secure read-only polling connects to a local OPC UA simulator and rejects untrusted servers", { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cloudforge-opcua-test-"));
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const serverManager = new OPCUACertificateManager({
    rootFolder: join(dir, "server"), automaticallyAcceptUnknownCertificate: true,
  });
  const clientManager = new OPCUACertificateManager({
    rootFolder: join(dir, "client"), automaticallyAcceptUnknownCertificate: false,
  });
  let server;
  let reader;
  try {
    const options = {
      port, host: "127.0.0.1", hostname: "127.0.0.1",
      serverCertificateManager: serverManager,
      securityModes: [MessageSecurityMode.SignAndEncrypt],
      securityPolicies: [SecurityPolicy.Basic256Sha256],
    };
    const startServer = async (extra = {}) => {
      const instance = new OPCUAServer({ ...options, ...extra });
      await instance.initialize();
      const namespace = instance.engine.addressSpace.getOwnNamespace();
      namespace.addVariable({
        organizedBy: instance.engine.addressSpace.rootFolder.objects,
        nodeId: "ns=1;s=Temperature",
        browseName: "Temperature",
        dataType: "Double",
        minimumSamplingInterval: 1000,
        value: { get: () => new Variant({ dataType: DataType.Double, value: 42 }) },
      });
      await instance.start();
      return instance;
    };
    server = await startServer();
    await clientManager.initialize();
    const certificateFile = join(dir, "client-certificate.pem");
    const applicationUri = "urn:cloudforge:test:gateway";
    await clientManager.createSelfSignedCertificate({
      outputFile: certificateFile, applicationUri, dns: ["localhost"],
      subject: "/CN=CloudForge Test Gateway", startDate: new Date(Date.now() - 60000), validity: 30,
    });
    const config = {
      endpoint: server.getEndpointUrl(),
      trustStore: join(dir, "client"),
      certificateFile,
      privateKeyFile: clientManager.privateKey,
      applicationUri,
      serverCertificateSha256: new X509Certificate(server.getCertificate()).fingerprint256.replaceAll(":", "").toLowerCase(),
      timeoutMs: 5000,
      mappings: [{
        assetId: "11111111-1111-4111-8111-111111111111",
        tagName: "temperature_c", nodeId: "ns=1;s=Temperature", dataType: "number",
      }],
    };
    validateOpcUaConfig(config);
    await clientManager.dispose();
    reader = new OpcUaReader(config);
    await assert.rejects(reader.read());
    await reader.close();
    reader = undefined;
    const trustManager = new OPCUACertificateManager({ rootFolder: config.trustStore });
    await trustManager.initialize();
    await trustManager.trustCertificate(server.getCertificate());
    await trustManager.dispose();
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
    const serverKeys = { certificateFile: server.certificateFile, privateKeyFile: server.privateKeyFile };
    await server.shutdown(0);
    server = undefined;
    await assert.rejects(reader.read());
    server = await startServer(serverKeys);
    assert.equal((await reader.read()).get(config.mappings[0].assetId)[0].value, 42);
    assert.throws(() => validateOpcUaConfig({ ...config, mappings: [] }), /explicitly allowed/);
  } finally {
    if (reader) await reader.close();
    if (server) await server.shutdown(0);
    await serverManager.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
