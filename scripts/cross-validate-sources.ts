import fs from "node:fs";
import path from "node:path";
import { compareWithProvenance } from "../src/data/validation/source-cross-validation/index";
import type { OfficialRow, ThirdPartyRow } from "../src/data/validation/source-cross-validation/types";

/**
 * Source cross-validation CLI (P3.6). Offline: reads two intermediate JSON files,
 * writes a diff report. No fetching, no DB writes.
 *
 *   npm run data:cross-validate -- --year 115 \
 *     --official <official-rows.json> --third-party <utw-rows.json> \
 *     --out data/processed/source-cross-validation/115
 *
 * Input shapes: JSON array (or {records:[...]}) of OfficialRow / ThirdPartyRow.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readRows<T>(p: string): T[] {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return (Array.isArray(raw) ? raw : raw.records) as T[];
}

async function main() {
  const year = Number(arg("--year"));
  const officialPath = arg("--official");
  const thirdPartyPath = arg("--third-party");
  const outDir = arg("--out") ?? path.join(process.cwd(), "data", "processed", "source-cross-validation", String(year));
  if (!Number.isInteger(year)) {
    console.error(`--year required, got ${JSON.stringify(arg("--year"))}`);
    process.exit(2);
  }
  if (!officialPath || !thirdPartyPath) {
    console.error("--official <json> and --third-party <json> are required (local intermediate files only)");
    process.exit(2);
  }
  const official = readRows<OfficialRow>(officialPath);
  const thirdParty = readRows<ThirdPartyRow>(thirdPartyPath);
  const report = compareWithProvenance(year, `official-pdf:${path.basename(officialPath)}`, `utw:${path.basename(thirdPartyPath)}`, official, thirdParty);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "diff-report.json"), JSON.stringify(report, null, 2));

  console.log(`official rows: ${official.length}`);
  console.log(`third-party rows: ${thirdParty.length}`);
  for (const [k, v] of Object.entries(report.totals)) console.log(`${k}: ${v}`);
  console.log(`report: ${path.join(outDir, "diff-report.json")}`);
  const mism = report.rows.filter((r) => r.verdict === "missing_in_university_tw");
  if (mism.length > 0) {
    console.log(`missing codes: ${mism.map((r) => r.departmentCode).join(",")}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
