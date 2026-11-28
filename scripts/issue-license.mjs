#!/usr/bin/env node
// CloudForge platform-owner tool: run OFFLINE or on a secured owner workstation.
// Usage:
//   CLOUDFORGE_LICENSE_SIGNING_KEY_FILE=/secure/ed25519-private.pem \
//     node scripts/issue-license.mjs request.json signed-license.json
// NEVER copy the private key into the CloudForge web app, database, or customer server.

import { readFile, stat, writeFile } from "node:fs/promises";
import { issueSignedLicense } from "./license-issuer.mjs";

const [requestPath, outputPath, ...extra] = process.argv.slice(2);
const keyPath = process.env.CLOUDFORGE_LICENSE_SIGNING_KEY_FILE;

if (!requestPath || !outputPath || extra.length || !keyPath) {
  throw new Error("Usage: CLOUDFORGE_LICENSE_SIGNING_KEY_FILE=/secure/private.pem node scripts/issue-license.mjs request.json signed-license.json");
}
if (requestPath === outputPath || keyPath === outputPath) {
  throw new Error("Signed license output must not overwrite the request or private signing key.");
}
const metadata = await stat(keyPath);
if (!metadata.isFile()) throw new Error("Private signing key must be a regular file.");
if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
  throw new Error("Private key file must not be accessible by group or other users (chmod 600).");
}
// On Windows, separately verify the private key's NTFS ACLs before use.
const signingPem = await readFile(keyPath, "utf8");
const request = JSON.parse(await readFile(requestPath, "utf8"));
const { envelope, claims } = issueSignedLicense(request, signingPem);
await writeFile(outputPath, JSON.stringify(envelope, null, 2) + "\n", {
  flag: "wx", mode: 0o600,
});
console.log("Issued signed " + claims.licenseType + " license " + claims.licenseId +
  " for organization " + claims.organizationId + ". File: " + outputPath);
console.log("Copy ONLY the signed license JSON to the customer system, never the private key.");
