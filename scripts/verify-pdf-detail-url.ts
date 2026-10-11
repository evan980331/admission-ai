import fs from "node:fs";
import path from "node:path";
import { buildOfficialDetailUrl } from "../src/data/discovery/official/application115/universe";
import { PDF_001_ORDER } from "../src/data/discovery/official/application115/pdf-inventory";

function fail(msg: string): never {
  console.error(`ASSERT FAILED: ${msg}`);
  process.exit(1);
}

function main() {
  const root = process.cwd();
  // Guard the human-verified input before using it.
  if (PDF_001_ORDER.length !== 73) fail(`expected 73 PDF codes, got ${PDF_001_ORDER.length}`);
  if (new Set(PDF_001_ORDER).size !== 73) fail("duplicate codes in PDF order list");
  if (!PDF_001_ORDER.every((c) => /^001\d{3}$/.test(c))) fail("non-001 codes in PDF order list");

  const rawDir = path.join(root, "data", "raw", "official", "115", "application", "departments");
  const rawCodes = new Set(
    fs
      .readdirSync(rawDir)
      .map((f) => f.match(/^115_(\d{6})\.htm$/i)?.[1])
      .filter((c): c is string => !!c),
  );
  const readExpected = (code: string) =>
    JSON.parse(
      fs.readFileSync(
        path.join(root, "tests", "fixtures", "official", "application115", "detail", `115_${code}.expected.json`),
        "utf8",
      ),
    ) as { departmentName?: string; sourceUrl?: string };
  const readMeta = (code: string) =>
    JSON.parse(fs.readFileSync(path.join(rawDir, `115_${code}.htm.meta.json`), "utf8")) as { sourceUrl?: string };

  // A. Known success case: 001012.
  const knownCode = "001012";
  if (!PDF_001_ORDER.includes(knownCode)) fail("001012 missing from PDF order list");
  if (!rawCodes.has(knownCode)) fail("001012 has no raw detail (precondition broken)");
  const knownExpected = readExpected(knownCode);
  const knownMeta = readMeta(knownCode);
  const knownName = knownExpected.departmentName ?? "(unknown)";
  const existingUrl = knownMeta.sourceUrl ?? knownExpected.sourceUrl ?? "(unknown)";
  const generatedKnown = buildOfficialDetailUrl(115, knownCode);
  const knownPath = (u: string) => u.split("?")[0];
  const match = knownPath(generatedKnown) === knownPath(existingUrl);

  // B. Unknown sample: first PDF code with no raw detail.
  const unknownCode = PDF_001_ORDER.find((c) => !rawCodes.has(c));
  if (!unknownCode) fail("no PDF-backed code without raw (nothing to sample)");
  let unknownName = "(name from official PDF; fixture cross-check below)";
  try {
    unknownName = readExpected(unknownCode).departmentName ?? unknownName;
  } catch {
    /* no fixture for this code; name stays PDF-sourced */
  }
  const candidate = buildOfficialDetailUrl(115, unknownCode);

  console.log("PDF → DETAIL URL VERIFICATION");
  console.log("");
  console.log("Known:");
  console.log(knownCode);
  console.log(`PDF name: ${knownName}`);
  console.log("Existing URL:");
  console.log(existingUrl);
  console.log("");
  console.log("Generated URL:");
  console.log(generatedKnown);
  console.log("");
  console.log(`MATCH: ${match ? "YES (canonical pathname; live href may carry ?v=1.0)" : "NO"}`);
  console.log("");
  console.log("Unknown sample:");
  console.log(`departmentCode: ${unknownCode}`);
  console.log(`departmentName: ${unknownName}`);
  console.log("");
  console.log("Candidate URL:");
  console.log(candidate);
  console.log("");
  console.log("STATUS: CANDIDATE_ONLY");
  console.log("");
  console.log("No network request performed.");
  console.log("No database write performed.");
  console.log("No raw file written.");
  if (!match) process.exit(1);
}

main();
