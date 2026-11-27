import "server-only";
import type { PoolClient } from "pg";

const TAGS = [
  ["machine_state", "Machine state", "string", "state", "", null, null],
  ["runtime_seconds", "Runtime", "number", "runtime_counter", "s", 0, null],
  ["cycle_count", "Cycle count", "number", "cycle_counter", "cycles", 0, null],
  ["temperature_c", "Temperature", "number", "metric", "degC", -50, 250],
  ["alarm_code", "Alarm code", "string", "alarm", "", null, null],
  ["production_count", "Production count", "number", "metric", "cycles", 0, null],
] as const;

export async function initializeSimulatedTelemetry(client: PoolClient, assetId: string, actorId: string): Promise<void> {
  await client.query(
    "INSERT INTO asset_telemetry_sources(asset_id,provider,connection_state,updated_by) " +
      "VALUES($1,'simulated','disconnected',$2)",
    [assetId,actorId],
  );
  for (const tag of TAGS) {
    await client.query(
      "INSERT INTO asset_telemetry_tags(asset_id,tag_name,label,data_type,semantic_type,unit,minimum,maximum) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [assetId,...tag],
    );
  }
}
