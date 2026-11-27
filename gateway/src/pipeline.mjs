import { setTimeout as sleep } from "node:timers/promises";
import { deliverOldest } from "./delivery.mjs";
import { ProviderError, validateProvider, validateProviderReadings } from "./provider.mjs";

async function wait(ms, signal) {
  try {
    await sleep(ms, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

/** @param {{provider: import("./provider.mjs").TelemetryProvider, queue: import("./queue.mjs").PersistentQueue,
 * delivery: object, pollMs: number, signal: AbortSignal}} options */
export async function runPipeline({ provider, queue, delivery, pollMs, signal }) {
  const allowed = validateProvider(provider);
  const assetIds = [...new Set(provider.mappings.map((mapping) => mapping.assetId))];

  async function poll() {
    let state = null;
    while (!signal.aborted) {
      let readings;
      try {
        readings = await provider.read();
        validateProviderReadings(readings, allowed);
        state = "connected";
      } catch (error) {
        readings = undefined;
        const nextState = error instanceof ProviderError && error.kind === "invalid_reading" ? "invalid_reading" : "disconnected";
        console.error(nextState === "invalid_reading"
          ? "Provider polling failed: invalid or unallowlisted reading."
          : "Provider polling failed: connection or read error; check provider configuration and trust.");
        if (state !== nextState || nextState === "invalid_reading") {
          let queued = true;
          for (const assetId of assetIds) {
            try {
              queue.enqueue(assetId, [], false, undefined, nextState === "invalid_reading" ? nextState : undefined);
            } catch (queueError) {
              queued = false;
              console.error(`Cannot queue provider status: ${queueError.message}`);
            }
          }
          if (queued) state = nextState;
        }
      }
      if (readings) {
        const capturedAt = new Date().toISOString();
        for (const [assetId, values] of readings) {
          try {
            queue.enqueue(assetId, values.map(({ tagName, value, quality, observedAt }) =>
              ({ tagName, value, quality, observedAt })), true, capturedAt);
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
        const sent = await deliverOldest(queue, delivery);
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
      await provider.close();
    } finally {
      queue.close();
    }
  }
}
