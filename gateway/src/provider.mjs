/**
 * A read-only provider exposes its allowlisted mappings, read(), and close().
 * read() connects/reconnects as needed and returns a Map of asset IDs to
 * readings: { tagName, value, quality: "good"|"uncertain"|"bad", observedAt }.
 * Protocol-specific configuration, authentication and trust remain in the
 * provider. Throw ProviderError("invalid_reading", ...) for unusable data;
 * other failures indicate disconnection. close() releases all resources.
 * @typedef {{mappings: Array<{assetId: string, tagName: string, dataType: string}>,
 *   read: () => Promise<Map<string, Array<{tagName: string, value: unknown, quality: string, observedAt: string}>>>,
 *   close: () => Promise<void>}} TelemetryProvider
 */

export class ProviderError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export function validateProvider(provider) {
  if (!provider || typeof provider.read !== "function" || typeof provider.close !== "function" ||
      !Array.isArray(provider.mappings) || provider.mappings.length < 1 || provider.mappings.length > 100) {
    throw new Error("A provider must expose read, close, and 1 to 100 allowlisted mappings.");
  }
  const allowed = new Map();
  for (const mapping of provider.mappings) {
    if (typeof mapping.assetId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mapping.assetId) ||
        typeof mapping.tagName !== "string" || !/^[a-zA-Z0-9_.-]{1,120}$/.test(mapping.tagName) ||
        !["number", "boolean", "string"].includes(mapping.dataType)) {
      throw new Error("A provider mapping has an invalid asset ID, tag name, or data type.");
    }
    const key = `${mapping.assetId}:${mapping.tagName}`;
    if (allowed.has(key)) throw new Error("Provider mappings must not contain duplicate tags.");
    allowed.set(key, mapping.dataType);
  }
  return allowed;
}

export function validateProviderReadings(readings, allowed, now = Date.now()) {
  if (!(readings instanceof Map) || readings.size === 0) {
    throw new ProviderError("invalid_reading", "Provider returned no equipment readings.");
  }
  for (const [assetId, values] of readings) {
    if (!Array.isArray(values) || values.length === 0 || values.length > 100) {
      throw new ProviderError("invalid_reading", "Provider returned an invalid reading batch.");
    }
    const seen = new Set();
    for (const reading of values) {
      const type = allowed.get(`${assetId}:${reading?.tagName}`);
      const time = typeof reading?.observedAt === "string" ? Date.parse(reading.observedAt) : NaN;
      const datePart = typeof reading?.observedAt === "string" ? reading.observedAt.slice(0, 10) : "";
      const calendarDay = Date.parse(`${datePart}T00:00:00.000Z`);
      if (!type || seen.has(reading.tagName) || typeof reading.value !== type ||
          (type === "number" && !Number.isFinite(reading.value)) ||
          (type === "string" && reading.value.length > 1000) ||
          !["good", "uncertain", "bad"].includes(reading.quality) ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/i.test(reading.observedAt) ||
          !Number.isFinite(calendarDay) || new Date(calendarDay).toISOString().slice(0, 10) !== datePart ||
          !Number.isFinite(time) || time > now + 30_000 || time < now - 30 * 86_400_000) {
        throw new ProviderError("invalid_reading", "Provider returned an invalid, unallowlisted, or mistimed reading.");
      }
      seen.add(reading.tagName);
    }
  }
}
