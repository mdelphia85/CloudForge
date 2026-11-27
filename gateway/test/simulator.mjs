import { X509Certificate } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { OPCUACertificateManager } from "node-opcua-certificate-manager";
import { DataType, MessageSecurityMode, OPCUAServer, SecurityPolicy, Variant } from "node-opcua";

export async function createSimulator(dir, assetId) {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const serverManager = new OPCUACertificateManager({
    rootFolder: join(dir, "server"), automaticallyAcceptUnknownCertificate: true, disableFileWatchers: true,
  });
  const options = {
    port, host: "127.0.0.1", hostname: "127.0.0.1",
    serverCertificateManager: serverManager,
    securityModes: [MessageSecurityMode.SignAndEncrypt],
    securityPolicies: [SecurityPolicy.Basic256Sha256],
  };
  const start = async (extra = {}) => {
    const server = new OPCUAServer({ ...options, ...extra });
    await server.initialize();
    const namespace = server.engine.addressSpace.getOwnNamespace();
    namespace.addVariable({
      organizedBy: server.engine.addressSpace.rootFolder.objects,
      nodeId: "ns=1;s=Temperature",
      browseName: "Temperature",
      dataType: "Double",
      minimumSamplingInterval: 1000,
      value: { get: () => new Variant({ dataType: DataType.Double, value: 42 }) },
    });
    await server.start();
    return server;
  };
  const server = await start();
  const manager = new OPCUACertificateManager({ rootFolder: join(dir, "client"), disableFileWatchers: true });
  await manager.initialize();
  const certificateFile = join(dir, "client-certificate.pem");
  const applicationUri = "urn:cloudforge:test:gateway";
  await manager.createSelfSignedCertificate({
    outputFile: certificateFile, applicationUri, dns: ["localhost"],
    subject: "/CN=CloudForge Test Gateway", startDate: new Date(Date.now() - 60000), validity: 30,
  });
  const config = {
    endpoint: server.getEndpointUrl(),
    trustStore: join(dir, "client"),
    certificateFile,
    privateKeyFile: manager.privateKey,
    applicationUri,
    serverCertificateSha256: new X509Certificate(server.getCertificate()).fingerprint256.replaceAll(":", "").toLowerCase(),
    timeoutMs: 5000,
    mappings: [{ assetId, tagName: "temperature_c", nodeId: "ns=1;s=Temperature", dataType: "number" }],
  };
  await manager.dispose();
  const trust = async () => {
    const trustManager = new OPCUACertificateManager({ rootFolder: config.trustStore, disableFileWatchers: true });
    await trustManager.initialize();
    try {
      await trustManager.trustCertificate(server.getCertificate());
    } finally {
      await trustManager.dispose();
    }
  };
  return { server, serverManager, config, start, trust };
}
