import { generateKeyPairSync } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";

try {
  if (process.argv.length !== 3) throw new Error("Usage: node src/keygen.mjs <new-key-path-prefix>");
  const prefix = process.argv[2];
  const privatePath = `${prefix}.private.pem`;
  const publicPath = `${prefix}.public.pem`;
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await writeFile(privatePath, pair.privateKey, { flag: "wx", mode: 0o600 });
  try {
    await writeFile(publicPath, pair.publicKey, { flag: "wx", mode: 0o644 });
  } catch (error) {
    await unlink(privatePath);
    throw error;
  }
  console.log(`Created private key at ${privatePath} and public key at ${publicPath}.`);
} catch (error) {
  console.error(`Key generation failed: ${error.message}`);
  process.exitCode = 1;
}
