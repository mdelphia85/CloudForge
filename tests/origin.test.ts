import { afterEach, describe, expect, it, vi } from "vitest";
import { requireSameOrigin } from "@/server/errors";

afterEach(() => vi.unstubAllEnvs());

function request(origin: string | null, headers: Record<string, string> = {}) {
  return new Request("http://internal.example:3000/api/test", {
    method: "POST",
    headers: { ...headers, ...(origin === null ? {} : { origin }) },
  });
}

describe("same-origin validation", () => {
  it("accepts only the configured public origin behind a reverse proxy", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", "https://cloudforge.live");
    expect(() => requireSameOrigin(request("https://cloudforge.live", {
      "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http",
    }))).not.toThrow();
    for (const origin of [
      null, "null", "https://attacker.example", "http://cloudforge.live",
      "https://cloudforge.live:444", "https://cloudforge.live.attacker.example",
      "https://cloudforge.live/", "https://cloudforge.live, https://attacker.example",
      "http://internal.example:3000",
    ]) {
      expect(() => requireSameOrigin(request(origin, {
        "x-forwarded-host": "cloudforge.live", "x-forwarded-proto": "https",
      })), String(origin)).toThrow(expect.objectContaining({ status: 403, code: "INVALID_ORIGIN" }));
    }
  });

  it("fails closed for missing or malformed production configuration", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const value of [undefined, "", "not-an-origin", "https://cloudforge.live/",
      "https://user@cloudforge.live", "https://cloudforge.live/path", "https://cloudforge.live?x=1",
      "ftp://cloudforge.live"]) {
      vi.stubEnv("APP_ORIGIN", value);
      expect(() => requireSameOrigin(request("https://cloudforge.live")), String(value))
        .toThrow(expect.objectContaining({ status: 503, code: "INVALID_ORIGIN_CONFIGURATION" }));
    }
  });

  it("retains direct-origin behavior for local development without configuration", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_ORIGIN", undefined);
    const local = (origin: string) => new Request("http://localhost:3000/api/test", {
      method: "POST", headers: { origin, "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" },
    });
    expect(() => requireSameOrigin(local("http://localhost:3000"))).not.toThrow();
    expect(() => requireSameOrigin(local("http://localhost:3001")))
      .toThrow(expect.objectContaining({ status: 403, code: "INVALID_ORIGIN" }));
  });
});
