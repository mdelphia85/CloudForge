import { readFile } from "node:fs/promises";
import { OpcUaReader } from "./opcua.mjs";

async function opcua(config) {
  let identity = null;
  if (config?.identityFile) {
    try {
      const credential = JSON.parse(await readFile(config.identityFile, "utf8"));
      if (typeof credential.userName !== "string" || !credential.userName ||
          typeof credential.password !== "string" || !credential.password) throw new Error("Invalid identity");
      identity = { userName: credential.userName, password: credential.password };
    } catch {
      throw new Error("Unable to load OPC UA identity file; verify permissions and format.");
    }
  }
  return new OpcUaReader(config, identity);
}

const factories = { opcua };

export async function createConfiguredProvider(config) {
  if (config.provider !== undefined && config.opcua !== undefined) {
    throw new Error("Configure either provider or the legacy opcua setting, not both.");
  }
  const specification = config.provider ?? { type: "opcua", options: config.opcua };
  if (!specification || typeof specification !== "object" || typeof specification.type !== "string" ||
      !Object.hasOwn(factories, specification.type) || !specification.options ||
      typeof specification.options !== "object" || Array.isArray(specification.options)) {
    throw new Error("Configure a supported industrial provider and its options.");
  }
  return factories[specification.type](specification.options);
}
