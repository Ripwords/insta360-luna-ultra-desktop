import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Composable tests need a Nuxt runtime; they run under vitest.nuxt.config.ts
    exclude: ["tests/nuxt/**"],
    environment: "node",
  },
});
