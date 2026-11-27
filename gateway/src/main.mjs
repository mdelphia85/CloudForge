import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createPrivateKey } from "node:crypto";
import { PersistentQueue } from "./queue.mjs";
import { deliverOldest, deliveryUrl } from "./delivery.mjs";
import { OpcUaReader } from "./opcua.mjs";

function interval(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum} milliseconds.`);
  }
  return value;
}

async function wait(ms, signal) {
  try {
    await sleep(ms, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

async function run(config, signal) {
  if (config.enabled !== true) {
    console.log("Gateway is disabled; no network connections were opened.");
    return;
  }
  const pollMs = interval(config.pollIntervalMs, "pollIntervalMs", 1000, 3600000);
  const timeoutMs = interval(config.deliveryTimeoutMs, "deliveryTimeoutMs", 1000, 120000);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.gatewayId)) {
    throw new Error("gatewayId must be a UUID.");
  }
  deliveryUrl(config.cloudforgeUrl, config.allowInsecureLoopback === true);
  const privateKey = createPrivateKey(await readFile(config.signingKeyFile));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Gateway signing key must be Ed25519.");
  let identity = null;
  if (config.opcua.identityFile) {
    try {
      const credential = JSON.parse(await readFile(config.opcua.identityFile, "utf8"));
      if (typeof credential.userName !== "string" || !credential.userName ||
          typeof credential.password !== "string" || !credential.password) throw new Error("Invalid identity");
      identity = { userName: credential.userName, password: credential.password };
    } catch {
      throw new Error("Unable to load OPC UA identity file; verify permissions and format.");
    }
  }
  const reader = new OpcUaReader(config.opcua, identity);
  const queue = new PersistentQueue(config.queueFile, {
    maxItems: config.queueMaxItems,
    maxBytes: config.queueMaxBytes,
  });
  const assetIds = [...new Set(config.opcua.mappings.map((mapping) => mapping.assetId))];

  async function poll() {
    let connected = false;
    while (!signal.aborted) {
      let readings;
      try {
        readings = await reader.read();
        connected = true;
      } catch (error) {
        console.error(`OPC UA polling failed: ${error.message}`);
        if (connected) {
          for (const assetId of assetIds) {
            try {
              queue.enqueue(assetId, [], false);
            } catch (queueError) {
              console.error(`Cannot queue disconnection: ${queueError.message}`);
            }
          }
          connected = false;
        }
      }
      if (readings) {
        const capturedAt = new Date().toISOString();
        for (const [assetId, values] of readings) {
          try {
            queue.enqueue(assetId, values, true, capturedAt);
          } catch (error) {
            console.error(`Cannot queue telemetry: ${error.message}`);
            break;
          }
        }
      }
      await wait(pollMs, signal);
    }
  }

  async function deliver() {
    let delay = 1000;
    while (!signal.aborted) {
      try {
        const sent = await deliverOldest(queue, {
          baseUrl: config.cloudforgeUrl,
          gatewayId: config.gatewayId,
          privateKey,
          timeoutMs,
          allowInsecureLoopback: config.allowInsecureLoopback === true,
        });
        delay = 1000;
        if (!sent) await wait(1000, signal);
      } catch (error) {
        console.error(`Gateway delivery failed: ${error.message}`);
        await wait(delay, signal);
        delay = Math.min(delay * 2, 60000);
      }
    }
  }

  try {
    await Promise.all([poll(), deliver()]);
  } finally {
    try {
      await reader.close();
    } finally {
      queue.close();
    }
  }
}

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  if (process.argv.length !== 3) throw new Error("Usage: node src/main.mjs <configuration.json>");
  const config = JSON.parse(await readFile(process.argv[2], "utf8"));
  await run(config, controller.signal);
} catch (error) {
  console.error(`Gateway stopped: ${error.message}`);
  process.exitCode = 1;
}
