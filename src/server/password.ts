import "server-only";
import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export function isValidPassword(password: unknown): password is string {
  return typeof password === "string"
    && password.length >= 14
    && password.length <= 256
    && /[a-z]/.test(password)
    && /[A-Z]/.test(password)
    && /\d/.test(password)
    && /[^A-Za-z0-9]/.test(password);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await deriveKey(password, salt);
  return `scrypt$32768$8$1$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || parts[1] !== "32768" || parts[2] !== "8" || parts[3] !== "1") {
    return false;
  }
  if (!/^[\da-f]{32}$/i.test(parts[4]) || !/^[\da-f]{128}$/i.test(parts[5])) {
    return false;
  }

  const expected = Buffer.from(parts[5], "hex");
  const actual = await deriveKey(password, Buffer.from(parts[4], "hex"));
  return timingSafeEqual(actual, expected);
}
