import fs from "node:fs";
import path from "node:path";
import { runDatasetBuild } from "../src/data/dataset/official/application115/index";

/**
 * Dataset build CLI. Offline: scans manually downloaded official HTML,
 * merges into a cumulative local dataset. No fetch, no DB writes.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}
function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function main() {
  const inputDir = arg("--input") ?? path.join(process.cwd(), "data", "raw", "official", "115", "application");
  const outputDir = arg("--output") ?? path.join(process.cwd(), "data", "processed", "official", "115", "application");
  const year = Number(arg("--year") ?? "115");
  if (!Number.isInteger(year) || year < 100 || year > 130) {
    console.error(`--year must be an academic year, got ${JSON.stringify(arg("--year"))}`);
    process.exit(2);
  }
  if (!existsDir(inputDir)) {
    console.error(`input dir not found: ${inputDir} (download official HTML manually first; nothing is fetched automatically)`);
    process.exit(2);
  }
  const dryRun = flag("--dry-run");
  const { coverage, buildReport } = runDatasetBuild({
    inputDir,
    outputDir: dryRun ? null : outputDir,
    academicYear: year,
    dryRun,
    universePath: arg("--universe"),
    dataVersion: arg("--data-version") ?? "dataset-build",
  });

  console.log(`total=${coverage.totalDepartments} captured=${coverage.captured} unchanged=${coverage.unchanged} changed=${coverage.contentChanged} carried=${coverage.carried}`);
  console.log(`parseSuccess=${coverage.parseSuccess} parseError=${coverage.parseError} validationError=${coverage.validationError}`);
  console.log(`normalized=${coverage.normalized} normalizationError=${coverage.normalizationError} missing=${coverage.missing}`);
  console.log(`newEntries=${buildReport.newEntries} errors=${buildReport.errors}`);
  if (dryRun) console.log("dry-run: no writes performed");
  else console.log(`out: ${outputDir} (dataset.json coverage.json errors.json build-report.json)`);
  if (buildReport.errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
