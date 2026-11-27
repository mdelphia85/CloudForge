import { readFile } from "node:fs/promises";
import { createPrivateKey } from "node:crypto";
import { PersistentQueue } from "./queue.mjs";
import { deliveryUrl } from "./delivery.mjs";
import { createConfiguredProvider } from "./providers.mjs";
import { validateProvider } from "./provider.mjs";
import { runPipeline } from "./pipeline.mjs";

function interval(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum} milliseconds.`);
  }
  return value;
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
  const provider = await createConfiguredProvider(config);
  let queue;
  try {
    validateProvider(provider);
    queue = new PersistentQueue(config.queueFile, {
      maxItems: config.queueMaxItems,
      maxBytes: config.queueMaxBytes,
    });
  } catch (error) {
    await provider.close();
    throw error;
  }
  await runPipeline({
    provider, queue, pollMs, signal,
    delivery: {
      baseUrl: config.cloudforgeUrl, gatewayId: config.gatewayId, privateKey,
      timeoutMs, allowInsecureLoopback: config.allowInsecureLoopback === true,
    },
  });
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
