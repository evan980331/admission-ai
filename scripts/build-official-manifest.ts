import fs from "node:fs";
import path from "node:path";
import { totalHtmlToManifestInput } from "../src/data/discovery/official/application115/index";
import type { OfficialDepartmentManifest } from "../src/data/discovery/official/application115/types";
import { MANIFEST_VERSION } from "../src/data/discovery/official/application115/types";

/**
 * Offline manifest builder (P3.8). Local official index files in, manifest out.
 * No fetching, no scanning, no DB.
 *
 *   npm run data:build-official-manifest -- \
 *     --total <TotalGsdShow.html> --school-dir <dir of <code>.html> \
 *     --out data/processed/official/115/application
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const totalPath = arg("--total");
  const schoolDir = arg("--school-dir");
  const outDir = arg("--out") ?? path.join(process.cwd(), "data", "processed", "official", "115", "application");
  if (!totalPath || !schoolDir) {
    console.error("usage: npm run data:build-official-manifest -- --total <TotalGsdShow.html> --school-dir <dir>");
    console.error("offline only: missing local input is an error, never fetched automatically");
    process.exit(2);
  }
  if (!fs.existsSync(totalPath)) {
    console.error(`total index not found: ${totalPath}`);
    process.exit(2);
  }
  if (!fs.existsSync(schoolDir) || !fs.statSync(schoolDir).isDirectory()) {
    console.error(`school dir not found: ${schoolDir}`);
    process.exit(2);
  }
  const totalHtml = fs.readFileSync(totalPath, "utf8");
  const schoolPages = new Map<string, { html: string; url: string }>();
  for (const f of fs.readdirSync(schoolDir).sort()) {
    const m = f.match(/^(\d{3})\.html?$/i);
    if (!m) continue;
    schoolPages.set(m[1]!, {
      html: fs.readFileSync(path.join(schoolDir, f), "utf8"),
      url: `https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/ShowSchGsd.php?colno=${m[1]}`,
    });
  }
  const totalUrl = "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/TotalGsdShow.htm";
  const { schools, entries, report } = totalHtmlToManifestInput(totalHtml, schoolPages, {
    academicYear: 115,
    totalUrl,
  });

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "school-index.json"),
    JSON.stringify({ year: 115, source: "official", sourceUrl: totalUrl, schools }, null, 2),
  );
  const manifest: OfficialDepartmentManifest = {
    academicYear: 115,
    source: "official",
    sourceUrl: totalUrl,
    manifestVersion: MANIFEST_VERSION,
    generatedAt: report.generatedAt,
    count: entries.length,
    departments: entries,
    schools,
  };
  fs.writeFileSync(path.join(outDir, "department-manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "manifest-report.json"), JSON.stringify(report, null, 2));

  console.log(`schools: ${report.schoolsFound} departments: ${report.departmentsFound}`);
  console.log(`errors: ${report.errors} warnings: ${report.warnings}`);
  for (const i of report.issues.filter((x) => x.level === "error").slice(0, 10)) {
    console.log(`ERROR ${i.check}: ${i.detail}`);
  }
  console.log(`out: ${outDir}`);
  if (report.errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
