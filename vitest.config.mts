import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/server-only.stub.ts", import.meta.url)),
    },
    conditions: ["react-server"],
  },
  test: {
    environment: "node",
  },
});
