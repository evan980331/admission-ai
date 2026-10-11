import { defineConfig } from "vitest/config";

// H-C runner config (P4.4b-7). Runs ONLY *.hc.test.ts and only after
// scripts/test-hc-preflight.ts passes its fail-closed preflight
// (TEST_DATABASE_URL required, never DATABASE_URL). There is no isolated
// database yet, so this config must not be executed in this phase.
export default defineConfig({
  test: {
    include: ["tests/**/*.hc.test.ts"],
    environment: "node",
  },
});
