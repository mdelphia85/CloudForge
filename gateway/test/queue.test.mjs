import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { deliverOldest, deliveryUrl } from "../src/delivery.mjs";
import { PersistentQueue } from "../src/queue.mjs";

const dir = await mkdtemp(join(tmpdir(), "cloudforge-gateway-test-"));
after(async () => rm(dir, { recursive: true, force: true }));
const options = { maxItems: 2, maxBytes: 4096 };

test("queue survives restart, rejects overflow and only acknowledges its oldest entry", () => {
  const path = join(dir, "queue.sqlite");
  let queue = new PersistentQueue(path, options);
  assert.equal(queue.enqueue("asset", [{ value: 1 }], true), 1);
  assert.equal(queue.enqueue("asset", [{ value: 2 }], true), 2);
  assert.throws(() => queue.enqueue("asset", [], true), /queue is full/);
  queue.close();
  queue = new PersistentQueue(path, options);
  assert.equal(queue.peek().sequence, 1);
  assert.throws(() => queue.acknowledge({ sequence: 2, digest: "wrong" }), /oldest/);
  queue.acknowledge(queue.peek());
  assert.equal(queue.enqueue("asset", [], false), 3);
  queue.close();
});

test("corrupt entries stop replay instead of being discarded", () => {
  const queue = new PersistentQueue(join(dir, "corrupt.sqlite"), options);
  queue.enqueue("asset", [], true);
  queue.db.prepare("UPDATE queue SET payload='corrupt'").run();
  assert.throws(() => queue.peek(), /corrupt/);
  assert.equal(queue.db.prepare("SELECT count(*) AS count FROM queue").get().count, 1);
  queue.close();
});

test("delivery retains data through failure and requires a matching acknowledgement", async () => {
  const queue = new PersistentQueue(join(dir, "delivery.sqlite"), options);
  queue.enqueue("asset", [{ value: 3 }], true);
  let status = 503;
  let acknowledgement = 1;
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ headers: request.headers, body });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ sequence: acknowledgement }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const config = {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    gatewayId: "11111111-1111-4111-8111-111111111111",
    privateKey, timeoutMs: 2000, allowInsecureLoopback: true,
  };
  try {
    await assert.rejects(deliverOldest(queue, config), /503/);
    assert.equal(queue.peek().sequence, 1);
    status = 200;
    acknowledgement = 2;
    await assert.rejects(deliverOldest(queue, config), /invalid acknowledgement/);
    assert.equal(queue.peek().sequence, 1);
    acknowledgement = 1;
    assert.equal(await deliverOldest(queue, config), true);
    assert.equal(queue.peek(), null);
    assert.equal(requests[0].body, requests[2].body);
    const sent = requests[2];
    const hash = createHash("sha256").update(sent.body).digest("hex");
    const canonical = `cloudforge-gateway-v1\n${config.gatewayId}\n${sent.headers["x-cloudforge-timestamp"]}\n${hash}`;
    assert.equal(verify(null, Buffer.from(canonical), publicKey, Buffer.from(sent.headers["x-cloudforge-signature"], "base64url")), true);
    assert.throws(() => deliveryUrl("http://example.test", true), /HTTPS/);
  } finally {
    queue.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
