import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // H-C isolation tests (*.hc.test.ts) NEVER run under default `npm test`.
    // They require a provisioned isolated database + TEST_DATABASE_URL and
    // run only via `npm run test:hc` after the preflight guard passes.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*",
      "**/*.hc.test.ts",
    ],
    environment: "node",
  },
});
