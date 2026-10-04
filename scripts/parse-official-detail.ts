import fs from "node:fs";
import path from "node:path";
import { runDetailFile } from "../src/data/importers/official/application115/detail/index";

/**
 * PoC CLI: parse ONE explicitly given local CAC detail HTML file.
 * No fetching, no scanning, no DB. Output JSON under data/processed/.../detail/.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const input = arg("--input") ?? arg("--html");
  if (!input) {
    console.error("usage: npm run data:parse-official-detail -- --input <local-115_XXXXXX.htm>");
    process.exit(2);
  }
  const base = path.basename(input, path.extname(input));
  const m = base.match(/(\d{3})_(\d{6})/);
  const sourceUrl = m
    ? `https://www.cac.edu.tw/mobile_apply115/colqRy_Apply_8Rfsd57q/html/${m[1]}_${m[2]}.htm`
    : `local-file:${base}`;
  const { record, issues } = runDetailFile({
    inputPath: input,
    sourceUrl,
    dataVersion: arg("--data-version") ?? "fixture-manual",
  });
  if (!record) {
    for (const i of issues) console.log(`${i.level.toUpperCase()} ${i.check}: ${i.detail}`);
    process.exit(1);
  }
  const outDir = path.join(process.cwd(), "data", "processed", "official", "115", "application", "detail");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${base}.json`), JSON.stringify(record, null, 2));

  console.log(`department: ${record.schoolCode} ${record.departmentCode} ${record.departmentName}`);
  console.log(`quota: ${record.quota} expected: ${record.expectedInterviewCount}`);
  console.log(`subjects: ${record.subjectRequirements.length} stage2: ${record.secondStageItems.length}`);
  console.log(`errors: ${issues.filter((i) => i.level === "error").length} warnings: ${issues.filter((i) => i.level === "warning").length}`);
  for (const i of issues.filter((x) => x.level === "error")) console.log(`ERROR ${i.check}: ${i.detail}`);
  console.log(`output: data/processed/official/115/application/detail/${base}.json`);
  if (issues.some((i) => i.level === "error")) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
