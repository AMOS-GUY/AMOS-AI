import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    // Child processes, not worker threads: the permission tests change process.umask(), which
    // worker threads do not allow.
    pool: "forks",
    // Tests pass explicit temporary directories (AMOS_CONFIG_DIR etc.) to the code under test and
    // never read the developer's real config, secrets or data directories.
    restoreMocks: true,
  },
});
