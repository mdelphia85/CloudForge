import { X509Certificate } from "node:crypto";
import { OPCUACertificateManager } from "node-opcua-certificate-manager";
import {
  AttributeIds, MessageSecurityMode, OPCUAClient, SecurityPolicy, UserTokenType, coerceNodeId,
} from "node-opcua-client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidOpcUaReadingError extends Error {}

export function validateOpcUaConfig(config) {
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "opc.tcp:" || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw new Error("OPC UA endpoint must be an opc.tcp URL without credentials, query, or fragment.");
  }
  if (!config.trustStore || !config.certificateFile || !config.privateKeyFile || !config.applicationUri) {
    throw new Error("OPC UA trust store, client certificate, private key, and application URI are required.");
  }
  if (typeof config.serverCertificateSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(config.serverCertificateSha256)) {
    throw new Error("An explicit SHA-256 server certificate fingerprint is required.");
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 120000) {
    throw new Error("OPC UA timeoutMs must be between 1000 and 120000.");
  }
  if (!Array.isArray(config.mappings) || config.mappings.length < 1 || config.mappings.length > 100) {
    throw new Error("Configure between 1 and 100 explicitly allowed OPC UA nodes.");
  }
  const tags = new Set();
  for (const mapping of config.mappings) {
    if (!UUID.test(mapping.assetId) || typeof mapping.tagName !== "string" ||
        !/^[a-zA-Z0-9_.-]{1,120}$/.test(mapping.tagName) ||
        typeof mapping.nodeId !== "string" || mapping.nodeId.length > 256 ||
        !["number", "boolean", "string"].includes(mapping.dataType)) {
      throw new Error("An OPC UA mapping has invalid assetId, tagName, nodeId, or dataType.");
    }
    coerceNodeId(mapping.nodeId);
    const key = `${mapping.assetId.toLowerCase()}:${mapping.tagName}`;
    if (tags.has(key)) throw new Error("An equipment tag may only be mapped once.");
    tags.add(key);
  }
}

export class OpcUaReader {
  constructor(config, identity = null) {
    validateOpcUaConfig(config);
    this.config = config;
    this.identity = identity;
    this.manager = new OPCUACertificateManager({
      rootFolder: config.trustStore,
      automaticallyAcceptUnknownCertificate: false,
    });
    this.client = null;
    this.session = null;
  }

  async connect() {
    if (this.session) return;
    await this.manager.initialize();
    this.client = OPCUAClient.create({
      applicationName: "CloudForge Gateway",
      applicationUri: this.config.applicationUri,
      clientCertificateManager: this.manager,
      certificateFile: this.config.certificateFile,
      privateKeyFile: this.config.privateKeyFile,
      securityMode: MessageSecurityMode.SignAndEncrypt,
      securityPolicy: SecurityPolicy.Basic256Sha256,
      endpointMustExist: true,
      requireTrustedServerForUserName: true,
      connectionStrategy: { maxRetry: 0, initialDelay: 1000, maxDelay: 1000 },
      transportTimeout: this.config.timeoutMs,
      defaultTransactionTimeout: this.config.timeoutMs,
      requestedSessionTimeout: Math.max(this.config.timeoutMs * 2, 60000),
    });
    try {
      await this.client.connect(this.config.endpoint);
      const certificate = Array.isArray(this.client.serverCertificate)
        ? this.client.serverCertificate[0] : this.client.serverCertificate;
      if (!certificate || new X509Certificate(certificate).fingerprint256.replaceAll(":", "").toLowerCase() !==
          this.config.serverCertificateSha256.toLowerCase()) {
        throw new Error("OPC UA server certificate fingerprint does not match the configured endpoint.");
      }
      this.session = this.identity
        ? await this.client.createSession({ type: UserTokenType.UserName, ...this.identity })
        : await this.client.createSession();
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async read() {
    await this.connect();
    try {
      const nodes = this.config.mappings.map((mapping) => ({
        nodeId: mapping.nodeId,
        attributeId: AttributeIds.Value,
      }));
      const values = await this.session.read(nodes, 0);
      const byAsset = new Map();
      for (let index = 0; index < nodes.length; index++) {
        const mapping = this.config.mappings[index];
        const data = values[index];
        const value = data.value?.value;
        if (!data.sourceTimestamp || Number.isNaN(data.sourceTimestamp.getTime()) ||
            typeof value !== mapping.dataType ||
            (typeof value === "number" && !Number.isFinite(value)) ||
            (typeof value === "string" && value.length > 1000)) {
          throw new InvalidOpcUaReadingError(`OPC UA node mapped to ${mapping.tagName} returned an invalid value or timestamp.`);
        }
        const quality = data.statusCode.isBad() ? "bad" : data.statusCode.value >= 0x40000000 ? "uncertain" : "good";
        const readings = byAsset.get(mapping.assetId) ?? [];
        readings.push({ tagName: mapping.tagName, value, quality, observedAt: data.sourceTimestamp.toISOString() });
        byAsset.set(mapping.assetId, readings);
      }
      return byAsset;
    } catch (error) {
      if (!(error instanceof InvalidOpcUaReadingError)) await this.disconnect();
      throw error;
    }
  }

  async disconnect() {
    const session = this.session;
    const client = this.client;
    this.session = null;
    this.client = null;
    try {
      if (session) await session.close();
    } finally {
      if (client) await client.disconnect();
    }
  }

  async close() {
    try {
      await this.disconnect();
    } finally {
      await this.manager.dispose();
    }
  }
}
