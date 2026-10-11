import { spawnSync } from "node:child_process";
import { hcExecutionPlan, preflightHcCommand } from "../src/data/testing/testGuard";

/**
 * H-C entry point. Preflight FIRST: without TEST_DATABASE_URL (or on any
 * guard failure) it exits non-zero BEFORE any connection or test file
 * runs. Then it prints the explicit execution plan (LIVE vs BLOCKED with
 * the NOT RUN list) so skip counts can never be misread as passes. Only
 * host/dbname (non-secret) are ever printed.
 */
function main(): void {
  let target: { host: string; dbName: string };
  try {
    target = preflightHcCommand(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error("H-C status: BLOCKED (preflight failed; NOT RUN: all live cases)");
    process.exit(2);
  }
  console.log(`H-C target: host=${target.host} db=${target.dbName} (sentinel check still required inside tests)`);
  const plan = hcExecutionPlan(process.env);
  console.log(`H-C status: ${plan.mode}${plan.reason ? ` — ${plan.reason}` : ""}`);
  if (plan.notRun.length > 0) console.log(`H-C NOT RUN: ${plan.notRun.join(", ")}`);
  const r = spawnSync("npx", ["vitest", "run", "--config", "vitest.hc.config.ts"], { stdio: "inherit", shell: true });
  process.exit(r.status ?? 1);
}

main();
