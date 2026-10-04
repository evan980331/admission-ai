import dotenv from "dotenv";
import { defaultOptions, runCrawl } from "../src/data/crawlers/official/application115/index";
import {
  ACADEMIC_YEAR_115,
  SOURCE_APPLICATION115,
} from "../src/data/crawlers/official/application115/types";

dotenv.config({ path: ".env.local" });
dotenv.config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}
function intArg(name: string, fallback: number): number {
  const v = arg(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`invalid ${name}: ${JSON.stringify(v)}`);
    process.exit(2);
  }
  return n;
}

async function main() {
  const source = arg("--source");
  const year = Number(arg("--year"));
  if (source !== SOURCE_APPLICATION115) {
    console.error(`unsupported --source ${JSON.stringify(source)} (expected "application115")`);
    process.exit(2);
  }
  if (year !== ACADEMIC_YEAR_115) {
    console.error(`P2.5 only supports --year 115, got ${JSON.stringify(arg("--year"))}`);
    process.exit(2);
  }

  const dryRun = flag("--dry-run");
  const base = defaultOptions();
  const { report, blocked } = await runCrawl({
    year,
    dryRun,
    limitSchools: intArg("--limit", base.limitSchools),
    force: flag("--force"),
    includeDepartments: !flag("--skip-departments"),
    offline: flag("--offline"),
    inputTotalHtml: arg("--input"),
    delayMs: intArg("--delay-ms", base.delayMs),
    timeoutMs: intArg("--timeout-ms", base.timeoutMs),
    maxRetries: intArg("--retries", base.maxRetries),
  });

  console.log(`robots_allowed: ${report.robots_allowed}`);
  console.log(`schools_found: ${report.schools_found}`);
  console.log(`schools_processed: ${report.schools_processed}`);
  console.log(`departments_found: ${report.departments_found}`);
  console.log(`files_downloaded: ${report.files_downloaded}`);
  console.log(`files_cached: ${report.files_cached}`);
  console.log(`errors: ${report.errors}`);
  console.log(`warnings: ${report.warnings}`);
  console.log(`report: data/processed/official/115/application/crawl-report.json`);
  for (const n of report.notes) console.log(`note: ${n}`);

  if (blocked) {
    console.error("REFUSED: robots.txt disallows batch fetch. Use manual-download mode instead.");
    process.exit(3);
  }
  if (report.errors > 0 && !dryRun) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
