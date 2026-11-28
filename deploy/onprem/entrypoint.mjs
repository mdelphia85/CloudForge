import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

function readSecret(path, label) {
  if (!path) throw new Error(label + " file path is required.");
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(label + " file is empty.");
  return value;
}

const host = process.env.DB_HOST ?? "postgres";
const dbName = process.env.DB_NAME ?? "cloudforge";
const dbUser = process.env.DB_APP_USER ?? "cloudforge_app";
if (!/^[a-zA-Z0-9_-]{1,63}$/.test(host) ||
    !/^[a-zA-Z0-9_]{1,63}$/.test(dbName) ||
    !/^[a-zA-Z0-9_]{1,63}$/.test(dbUser)) {
  throw new Error("Invalid internal database address, name, or user.");
}
const password = readSecret(process.env.DB_APP_PASSWORD_FILE, "Application database password");
if (password.length < 24) throw new Error("Database password must be at least 24 characters.");
if (!process.env.APP_ORIGIN) throw new Error("APP_ORIGIN must be explicitly configured.");
const publicKey = readSecret(process.env.LICENSE_PUBLIC_KEY_FILE, "License public key");
if (!publicKey.includes("-----BEGIN PUBLIC KEY-----")) {
  throw new Error("Expected an Ed25519 PEM public key.");
}

const env = {
  ...process.env,
  DATABASE_URL: `postgresql://${encodeURIComponent(dbUser)}:${encodeURIComponent(password)}@${host}:5432/${dbName}`,
  LICENSE_PUBLIC_KEY: publicKey,
  NEXT_PUBLIC_APP_URL: process.env.APP_ORIGIN,
  NODE_ENV: "production",
};
if (process.env.CLOUDFORGE_MFA_ENCRYPTION_KEY_FILE) {
  const mfaKey=readSecret(process.env.CLOUDFORGE_MFA_ENCRYPTION_KEY_FILE,"MFA encryption key");
  if(!/^[0-9a-fA-F]{64}$/.test(mfaKey)) {
    throw new Error("MFA encryption key must be 32 random bytes encoded as 64 hex digits.");
  }
  env.CLOUDFORGE_MFA_ENCRYPTION_KEY=mfaKey;
}
if (process.env.BOOTSTRAP_ADMIN_TOKEN_FILE) {
  env.BOOTSTRAP_ADMIN_TOKEN = readSecret(process.env.BOOTSTRAP_ADMIN_TOKEN_FILE, "Bootstrap token");
}

// Database and licensing credentials are never printed or persisted by this entrypoint.
async function run(args) {
  const child = spawn(process.execPath, args, { env, stdio: "inherit" });
  const forward = (signal) => child.kill(signal);
  process.on("SIGTERM", forward);
  process.on("SIGINT", forward);
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (status, signal) => resolve(status ?? (signal ? 1 : 0)));
  });
  process.off("SIGTERM", forward);
  process.off("SIGINT", forward);
  return code;
}

// A separate one-shot migrator container performs privileged schema changes.
// This long-running app process only receives restricted database credentials.
process.exit(await run(["server.js"]));
