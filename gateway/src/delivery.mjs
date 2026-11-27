import { createHash, sign } from "node:crypto";

export function deliveryUrl(baseUrl, allowInsecureLoopback = false) {
  const url = new URL("/api/gateways/ingest", baseUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" &&
      !(allowInsecureLoopback && url.protocol === "http:" && loopback))) {
    throw new Error("Gateway delivery requires HTTPS (or explicitly enabled loopback HTTP for tests).");
  }
  return url;
}

export async function deliverOldest(queue, { baseUrl, gatewayId, privateKey, timeoutMs, allowInsecureLoopback = false }) {
  const entry = queue.peek();
  if (!entry) return false;
  const url = deliveryUrl(baseUrl, allowInsecureLoopback);
  const timestamp = new Date().toISOString();
  const payloadHash = createHash("sha256").update(entry.payload).digest("hex");
  const canonical = `cloudforge-gateway-v1\n${gatewayId}\n${timestamp}\n${payloadHash}`;
  const signature = sign(null, Buffer.from(canonical), privateKey).toString("base64url");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cloudforge-gateway": gatewayId,
      "x-cloudforge-timestamp": timestamp,
      "x-cloudforge-signature": signature,
    },
    body: entry.payload,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Telemetry delivery failed with HTTP ${response.status}; entry retained.`);
  const acknowledgement = await response.json();
  if (acknowledgement.sequence !== entry.sequence) {
    throw new Error("Telemetry delivery returned an invalid acknowledgement; entry retained.");
  }
  queue.acknowledge(entry);
  return true;
}
