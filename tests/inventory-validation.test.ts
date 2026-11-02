import { describe, expect, it } from "vitest";
import { parseItemInput, parseMovementInput } from "../src/server/inventory";
import { isValidPassword, hashPassword, verifyPassword } from "../src/server/password";
import { readJson } from "../src/server/errors";

describe("inventory request validation", () => {
  it("normalizes a valid SKU and accepts decimal quantities", () => {
    expect(parseItemInput({
      sku: "cf-1001",
      name: "Pump bearing",
      category: "Hardware",
      location: "North Yard",
      bin: "A-01",
      unit: "ea",
      onHand: "12.5",
      reorder: "3",
    })).toMatchObject({ sku: "CF-1001", onHand: "12.5", reorder: "3" });
  });

  it("rejects malformed or negative stock quantities", () => {
    expect(() => parseItemInput({
      sku: "CF-1001",
      name: "Bearing",
      category: "Hardware",
      location: "North Yard",
      bin: "A-01",
      unit: "ea",
      onHand: "-1",
      reorder: "0",
    })).toThrow();
  });

  it("requires complete source and destination for transfers", () => {
    expect(() => parseMovementInput({
      type: "transfer", sku: "CF-1001", quantity: "2",
    }, "request-123456")).toThrow(/source and destination/i);
  });

  it("validates and preserves a count of zero", () => {
    expect(parseMovementInput({
      type: "count", sku: "CF-1001", quantity: "0", location: "North Yard", bin: "A-01",
    }, "request-123456").quantity).toBe("0");
  });

  it("rejects request bodies over the API limit", async () => {
    const body = JSON.stringify({ value: "x".repeat(65_537) });
    await expect(readJson(new Request("http://localhost/api/inventory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }))).rejects.toMatchObject({ status: 413 });
  });

  it("rejects non-object JSON payloads", async () => {
    await expect(readJson(new Request("http://localhost/api/inventory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["not", "an", "object"]),
    }))).rejects.toMatchObject({ status: 400 });
  });
});

describe("local password handling", () => {
  it("requires the documented password strength", () => {
    expect(isValidPassword("ChangeMe!123456")).toBe(true);
    expect(isValidPassword("short")).toBe(false);
    expect(isValidPassword("alllowercasepassword")).toBe(false);
  });

  it("stores a salted hash and verifies only the matching password", async () => {
    const password = "LocalOnly!StrongPass123";
    const encoded = await hashPassword(password);
    expect(encoded).not.toContain(password);
    expect(await verifyPassword(password, encoded)).toBe(true);
    expect(await verifyPassword("Different!Password123", encoded)).toBe(false);
  });
});
