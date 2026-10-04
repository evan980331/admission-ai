import fs from "node:fs";
import path from "node:path";
import { runLocalImport } from "../src/data/importers/official/application115/local/index";

/**
 * Local import CLI. Offline only: scans a directory of manually downloaded
 * CAC detail HTML files. Never fetches, never writes the DB, never mutates raws.
 *
 *   npm run data:import-official-local -- --input <dir> --output <dir> --year 115
 *   npm run data:import-official-local -- --dry-run   (no writes at all)
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const inputDir = arg("--input") ?? path.join(process.cwd(), "data", "raw", "official", "115", "application");
  const outputDir = arg("--output") ?? path.join(process.cwd(), "data", "processed", "official", "115", "local-import");
  const year = Number(arg("--year") ?? "115");
  if (!Number.isInteger(year) || year < 100 || year > 130) {
    console.error(`--year must be an academic year, got ${JSON.stringify(arg("--year"))}`);
    process.exit(2);
  }
  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    console.error(`input dir not found: ${inputDir} (download official HTML manually first; nothing is fetched automatically)`);
    process.exit(2);
  }
  const dryRun = flag("--dry-run");
  const { report, records, errors } = runLocalImport({
    inputDir,
    outputDir: dryRun ? null : outputDir,
    academicYear: year,
    dryRun,
    dataVersion: arg("--data-version") ?? "local-import",
  });

  console.log(`discovered: ${report.discovered} supported: ${report.supported} imported: ${report.imported} skipped: ${report.skipped}`);
  console.log(`unidentified: ${report.unidentified} source_unverified: ${report.sourceUnverified} duplicates: ${report.duplicates}`);
  console.log(`parserErrors: ${report.parserErrors} normalizationErrors: ${report.normalizationErrors}`);
  for (const f of report.files.filter((x) => x.status !== "imported")) {
    console.log(`- ${f.status}: ${f.path}${f.reasons.length > 0 ? ` (${f.reasons[0]})` : ""}`);
  }

  if (!dryRun) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "import-report.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(outputDir, "records.json"), JSON.stringify(records, null, 2));
    fs.writeFileSync(path.join(outputDir, "errors.json"), JSON.stringify(errors, null, 2));
    const coverage = {
      generatedAt: report.generatedAt,
      academicYear: year,
      total: records.length,
      byStatus: Object.fromEntries(
        (["imported", "already_imported", "invalid_html", "unidentified", "source_unverified", "parser_error", "normalization_error"] as const).map(
          (s) => [s, records.filter((r) => r.status === s).length],
        ),
      ),
    };
    fs.writeFileSync(path.join(outputDir, "coverage.json"), JSON.stringify(coverage, null, 2));
    console.log(`out: ${outputDir}`);
  } else {
    console.log("dry-run: no writes performed");
  }
  if (report.parserErrors + report.normalizationErrors + report.unidentified > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
