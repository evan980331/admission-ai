import fs from "node:fs";
import path from "node:path";
import { buildMatrix } from "../src/data/audit/official/application115/coverage";
import { scanLocal } from "../src/data/audit/official/application115/index";
import { summarize, sourceSummary } from "../src/data/audit/official/application115/report";

/**
 * Offline coverage audit CLI. Reads local artifacts only.
 * No fetch, no DB writes, no raw modification. Missing inputs are reported.
 */
async function main() {
  const { warnings, inputs, pdfFiles, utwMatch, utwMissing, utwExtra } = scanLocal();
  const matrix = buildMatrix(inputs);
  const report = summarize(matrix, inputs.academicYear);
  const summary = sourceSummary();

  const outDir = path.join(process.cwd(), "data", "processed", "official", "115", "application", "coverage");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "coverage-matrix.json"), JSON.stringify(matrix, null, 2));
  fs.writeFileSync(path.join(outDir, "coverage-report.json"), JSON.stringify({ ...report, pdfFiles, utwCrossValidation: { match: utwMatch, missing: utwMissing, extra: utwExtra } }, null, 2));
  fs.writeFileSync(path.join(outDir, "source-summary.json"), JSON.stringify(summary, null, 2));

  console.log(`totalDepartments: ${report.totalDepartments}`);
  console.log(`officialHtml: ${report.sourceCounts.officialHtml} officialPdf(dept-level): ${report.sourceCounts.officialPdf} thirdParty: ${report.sourceCounts.thirdParty} parsed: ${report.sourceCounts.parsed} normalized: ${report.sourceCounts.normalized}`);
  console.log(`pdfFiles: ${pdfFiles.length} (${pdfFiles.join(", ")})`);
  console.log(`utw cross-check (P3.6 real run): match=${utwMatch} missing=${utwMissing} extra=${utwExtra}`);
  for (const [f, c] of Object.entries(report.fieldCoverage)) {
    console.log(`field ${f}: ${c.available}/${c.applicable} ${c.rate === null ? "n/a" : `${(c.rate * 100).toFixed(0)}%`}`);
  }
  console.log(`gaps: ${JSON.stringify(report.gapCounts)}`);
  for (const w of warnings) console.log(`warn: ${w}`);
  console.log(`out: ${outDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
