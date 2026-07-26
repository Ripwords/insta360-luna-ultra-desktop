import { defineVitestConfig } from "@nuxt/test-utils/config";

export default defineVitestConfig({
  test: {
    include: ["tests/nuxt/**/*.test.ts"],
    environment: "nuxt",
  },
});
