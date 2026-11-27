import { describe, expect, it } from "vitest";
import { telemetryFreshness, validateTelemetryReading, type Tag } from "../src/server/phase4/telemetry";
import { parseTimestamp } from "../src/server/phase4/shared";

const now = new Date("2026-02-01T12:00:00.000Z");
const temperature: Tag = {
  id: "00000000-0000-4000-8000-000000000001",
  tag_name: "temperature_c",
  data_type: "number",
  semantic_type: "metric",
  minimum: "-50",
  maximum: "250",
};

function reading(value: unknown, observedAt = now) {
  return {
    tagName: temperature.tag_name,
    value,
    observedAt,
    quality: "good" as const,
    idempotencyKey: "simulated-reading-123",
  };
}

describe("read-only telemetry validation", () => {
  it("preserves out-of-range values as bad-quality samples rather than treating them as current numeric values", () => {
    expect(validateTelemetryReading(temperature,reading(999),now)).toMatchObject({
      value: "999",
      numericValue: null,
      quality: "bad",
    });
  });

  it("rejects malformed numbers and timestamps beyond the allowed clock-drift window", () => {
    expect(() => validateTelemetryReading(temperature,reading("not-a-number"),now)).toThrow(/finite number/i);
    expect(() => validateTelemetryReading(temperature,reading(25,new Date(now.getTime()+30_001)),now))
      .toThrow(/more than 30 seconds in the future/i);
    expect(() => validateTelemetryReading(temperature,reading(25,new Date(now.getTime()-31*86_400_000)),now))
      .toThrow(/raw-ingest retention window/i);
  });

  it("distinguishes fresh, stale, and missing observations at the configured threshold", () => {
    expect(telemetryFreshness(new Date(now.getTime()-90_000),now)).toBe("fresh");
    expect(telemetryFreshness(new Date(now.getTime()-90_001),now)).toBe("stale");
    expect(telemetryFreshness(null,now)).toBe("missing");
  });

  it("requires an explicit timezone and rejects normalized invalid calendar dates", () => {
    expect(parseTimestamp("2026-02-01T12:00:00-05:00","startedAt").toISOString())
      .toBe("2026-02-01T17:00:00.000Z");
    expect(() => parseTimestamp("2026-02-01T12:00:00","startedAt")).toThrow(/ISO 8601 timestamp/i);
    expect(() => parseTimestamp("2026-02-30T12:00:00Z","startedAt")).toThrow(/ISO 8601 timestamp/i);
  });
});
