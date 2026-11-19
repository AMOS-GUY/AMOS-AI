import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    // Tests must never reach the network or the real user config.
    env: { AMOS_TEST: "1" },
    restoreMocks: true,
  },
});
