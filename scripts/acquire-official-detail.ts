import fs from "node:fs";
import path from "node:path";
import { MAX_BATCH, pocBatch, runAcquisition } from "../src/data/acquisition/official/application115/index";
import { MAX_RETRIES, REQUEST_DELAY_MS, REQUEST_TIMEOUT_MS } from "../src/data/acquisition/official/application115/client";

/**
 * PoC acquisition CLI. Manifest-only URLs, serial requests, fail-closed robots.
 *   --dry-run            list batch URLs, send zero HTTP requests
 *   --limit <n>          PoC cap (<=10)
 *   --code <6digits>     single department from the PoC batch only
 *   --refresh            re-fetch even on cache hit
 * Exit: 0 ok · 1 failures · 2 usage/cap · 3 ROBOTS_BLOCKED (policy, not a bug)
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const batch = pocBatch();
  const code = arg("--code");
  let entries = batch;
  if (code) {
    if (!/^\d{6}$/.test(code)) {
      console.error(`--code must be 6 digits, got ${JSON.stringify(code)}`);
      process.exit(2);
    }
    entries = batch.filter((e) => e.departmentCode === code);
    if (entries.length === 0) {
      console.error(`code ${code} is not in the PoC batch (${batch.map((e) => e.departmentCode).join(",")}); arbitrary URLs are refused`);
      process.exit(2);
    }
  }
  const limitRaw = arg("--limit");
  const limit = limitRaw === undefined ? Math.min(4, entries.length) : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) {
    console.error(`--limit must be a positive integer, got ${JSON.stringify(limitRaw)}`);
    process.exit(2);
  }
  if (limit > MAX_BATCH) {
    console.error(`--limit ${limit} exceeds PoC cap ${MAX_BATCH}`);
    process.exit(2);
  }

  const dryRun = flag("--dry-run");
  const { report } = await runAcquisition({
    academicYear: 115,
    entries,
    limit,
    refresh: flag("--refresh"),
    dryRun,
    offline: false,
    delayMs: REQUEST_DELAY_MS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });

  if (dryRun) {
    for (const p of report.pages) console.log(`would fetch: ${p.departmentCode} ${p.url}`);
    console.log(`urls: ${report.requested} (dry-run, zero HTTP requests)`);
    return;
  }
  for (const p of report.pages) {
    console.log(`${p.status}: ${p.departmentCode} http=${p.httpStatus ?? "-"} bytes=${p.bytes} cached=${p.cacheHit} parser=${p.parserStatus}`);
    for (const e of p.errors) console.log(`  error: ${e}`);
  }
  console.log(`requested=${report.requested} success=${report.success} cached=${report.cached} failed=${report.failed} invalid=${report.invalid} parseFailed=${report.parseFailed} robotsBlocked=${report.robotsBlocked}`);
  console.log(`robotsAllowed=${report.robotsAllowed} note=${report.robotsNote}`);

  const outDir = path.join(process.cwd(), "data", "processed", "official", "115", "application");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "acquisition-report.json"), JSON.stringify(report, null, 2));
  console.log("report: data/processed/official/115/application/acquisition-report.json");

  if (report.robotsBlocked > 0) {
    console.error("ROBOTS_BLOCKED");
    process.exit(3);
  }
  if (report.failed + report.invalid + report.parseFailed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
