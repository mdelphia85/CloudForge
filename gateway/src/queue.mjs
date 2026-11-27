import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export class PersistentQueue {
  constructor(path, { maxItems, maxBytes }) {
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1024) {
      throw new Error("Queue limits must be positive integers, with at least 1024 bytes.");
    }
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS queue_state (id INTEGER PRIMARY KEY CHECK(id=1), next_sequence INTEGER NOT NULL);
      INSERT OR IGNORE INTO queue_state(id,next_sequence) VALUES(1,1);
      CREATE TABLE IF NOT EXISTS queue (
        sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL, digest TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes > 0)
      );
    `);
  }

  enqueue(assetId, readings, connected, capturedAt = new Date().toISOString(), diagnostic) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { next_sequence: sequence } = this.db.prepare("SELECT next_sequence FROM queue_state WHERE id=1").get();
      if (!Number.isSafeInteger(sequence) || sequence >= Number.MAX_SAFE_INTEGER) {
        throw new Error("Gateway sequence exhausted.");
      }
      const payload = JSON.stringify({ sequence, assetId, connected, capturedAt, readings, diagnostic });
      const bytes = Buffer.byteLength(payload);
      if (bytes > 60_000) throw new Error("Telemetry entry exceeds the delivery limit.");
      const size = this.db.prepare("SELECT count(*) AS count, COALESCE(sum(bytes),0) AS bytes FROM queue").get();
      if (size.count >= this.maxItems || size.bytes + bytes > this.maxBytes) {
        throw new Error("Telemetry queue is full; samples have not been accepted.");
      }
      this.db.prepare("INSERT INTO queue(sequence,payload,digest,bytes) VALUES(?,?,?,?)")
        .run(sequence, payload, digest(payload), bytes);
      this.db.prepare("UPDATE queue_state SET next_sequence=next_sequence+1 WHERE id=1").run();
      this.db.exec("COMMIT");
      return sequence;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  peek() {
    const row = this.db.prepare("SELECT sequence,payload,digest,bytes FROM queue ORDER BY sequence LIMIT 1").get();
    if (!row) return null;
    if (digest(row.payload) !== row.digest || Buffer.byteLength(row.payload) !== row.bytes) {
      throw new Error(`Telemetry queue entry ${row.sequence} is corrupt; delivery stopped.`);
    }
    let value;
    try {
      value = JSON.parse(row.payload);
    } catch {
      throw new Error(`Telemetry queue entry ${row.sequence} is corrupt; delivery stopped.`);
    }
    if (value.sequence !== row.sequence) {
      throw new Error(`Telemetry queue entry ${row.sequence} has an invalid sequence; delivery stopped.`);
    }
    return { sequence: row.sequence, payload: row.payload, digest: row.digest };
  }

  acknowledge(entry) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const first = this.peek();
      if (!first || first.sequence !== entry.sequence || first.digest !== entry.digest) {
        throw new Error("Queue acknowledgement does not match the oldest entry.");
      }
      this.db.prepare("DELETE FROM queue WHERE sequence=? AND digest=?").run(entry.sequence, entry.digest);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}
