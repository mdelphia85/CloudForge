import { spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createSimulator } from "./simulator.mjs";

const [assetId, gatewayId, keyPath, baseUrl, dir] = process.argv.slice(2);
const simulator = await createSimulator(dir, assetId);
let child;
let exit;
try {
  await simulator.trust();
  const config = {
    enabled: true, gatewayId, cloudforgeUrl: baseUrl, signingKeyFile: keyPath,
    queueFile: join(dir, "buffer.sqlite"), queueMaxItems: 10, queueMaxBytes: 10000,
    pollIntervalMs: 1000, deliveryTimeoutMs: 2000,
    allowInsecureLoopback: true,
    opcua: simulator.config,
  };
  const configPath = join(dir, "gateway.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  child = spawn(process.execPath, [join(process.cwd(), "gateway", "src", "main.mjs"), configPath], { stdio: "inherit" });
  let exited = false;
  exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => { exited = true; resolve(code); });
  });
  let delivered = false;
  for (let attempt = 0; attempt < 300 && !exited; attempt++) {
    try {
      await access(join(dir, "delivered"));
      delivered = true;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await sleep(100);
  }
  if (!delivered) throw new Error("Gateway did not deliver the queued OPC UA reading.");
  child.kill("SIGTERM");
  if (await exit !== 0) throw new Error("Gateway did not stop cleanly.");
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await exit;
  }
  await simulator.server.shutdown(0);
  await simulator.serverManager.dispose();
}
