import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["__tests__/**/*.test.ts"],
    // api-auth.test.ts imports every route module cold; CI runners need >5s.
    testTimeout: 30_000,
  },
});
