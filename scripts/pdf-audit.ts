import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import dotenv from "dotenv";
import {
  buildMasterCandidate,
  crossValidate,
  extractDepartmentCandidates,
  findMissingCodes,
  groupDuplicates,
  scanPdfBuffer,
  type DepartmentCandidate,
  type PdfFileRecord,
} from "../src/data/audit/official/application115/pdf-audit";
import { buildInventory, PDF_FILES, PDF_NAMES } from "../src/data/discovery/official/application115/pdf-inventory";

dotenv.config({ path: ".env.local" });
dotenv.config();

const VERSION = "pdf-audit-v0.1.0";
const OUT = path.join(process.cwd(), "data", "processed", "official", "115", "application", "pdf-audit");

function walkPdfs(dirs: string[]): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".next", ".git", "out", "dist"]);
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir)) {
      if (skip.has(f)) continue;
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.pdf$/i.test(f)) out.push(p);
    }
  };
  for (const d of dirs) if (fs.existsSync(d)) walk(d);
  return out.sort();
}

async function main() {
  const root = process.cwd();
  const files = walkPdfs([path.join(root, "data"), path.join(root, "docs"), path.join(root, "tests")]);
  const indexPath = path.join(root, "data", "raw", "official", "115", "application", "universe", "school-index.json");
  const officialSchools = new Map<string, string>();
  if (fs.existsSync(indexPath)) {
    const j = JSON.parse(fs.readFileSync(indexPath, "utf8")) as { schools: { schoolCode: string; schoolName: string }[] };
    for (const s of j.schools) officialSchools.set(s.schoolCode, s.schoolName);
  }
  const schoolNames = [...officialSchools.values()];

  // ---- Phase 1: inventory ----
  let records: PdfFileRecord[] = files.map((p) => {
    const rel = path.relative(root, p).replace(/\\/g, "/");
    const buf = fs.readFileSync(p);
    return scanPdfBuffer(buf, rel, path.basename(p), schoolNames);
  });
  records = groupDuplicates(records);

  // ---- Phase 2: extraction (content-first; filename is only a clue) ----
  const rawRoot = path.join(root, "data", "raw", "official", "115", "application");
  const pdfTexts: Record<string, string> = {};
  for (const r of records) {
    if (!r.readable || !r.textExtractable) continue;
    try {
      pdfTexts[r.relativePath] = fs.readFileSync(path.join(root, r.relativePath), "latin1");
    } catch {
      /* unreadable mid-run -> flagged below */
    }
  }
  const candidates: DepartmentCandidate[] = [];
  for (const [rel, text] of Object.entries(pdfTexts)) {
    for (const c of extractDepartmentCandidates(text, { sourceFile: rel, pipeline: VERSION, departmentNames: PDF_NAMES })) {
      candidates.push(c);
    }
  }
  const master = buildMasterCandidate(candidates);

  // ---- authorities for cross-validation ----
  const manifest = new Map<string, { schoolCode: string; departmentName: string | null }>();
  try {
    const invTexts: Record<string, string> = {};
    for (const [code, file] of Object.entries(PDF_FILES)) {
      const full = path.join(rawRoot, file);
      if (fs.existsSync(full)) invTexts[code] = fs.readFileSync(full, "latin1");
    }
    for (const e of buildInventory(invTexts)) {
      if (!manifest.has(e.departmentCode)) manifest.set(e.departmentCode, { schoolCode: e.schoolCode, departmentName: e.departmentName });
    }
  } catch {
    /* manifest stays empty -> everything becomes new_candidate/unresolved, honestly */
  }
  const rawHtmlCodes = new Set<string>();
  const depDir = path.join(rawRoot, "departments");
  if (fs.existsSync(depDir)) {
    for (const f of fs.readdirSync(depDir)) {
      const m = f.match(/^115_(\d{6})\.htm$/i);
      if (m) rawHtmlCodes.add(m[1]!);
    }
  }
  const normalizedCodes = new Set<string>();
  let dbChecked = false;
  if (process.env.DATABASE_URL) {
    try {
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        const r = await client.query(`SELECT d.department_code FROM department_admissions a JOIN departments d ON d.id = a.department_id WHERE a.year = 115`);
        for (const row of r.rows) normalizedCodes.add(row.department_code as string);
        dbChecked = true;
      } finally {
        await client.end();
      }
    } catch {
      /* DB unreachable -> skip, report says so */
    }
  }

  const cross = crossValidate({ academicYear: "115", officialSchools, manifest, master, rawHtmlCodes, normalizedCodes, dbChecked });

  // ---- unresolved ----
  const unresolved: { kind: string; detail: unknown }[] = [];
  for (const r of cross.rows) {
    if (r.status === "unresolved" || r.status === "code_mismatch" || r.status === "name_mismatch") {
      unresolved.push({ kind: r.status, detail: r });
    }
  }
  for (const r of records) {
    if (!r.readable) unresolved.push({ kind: "unreadable-pdf", detail: { file: r.relativePath, size: r.sizeBytes } });
    else if (r.docType === "unknown") unresolved.push({ kind: "unknown-doctype", detail: { file: r.relativePath, schoolClue: r.schoolClue } });
    else if (r.likelyScannedImage) unresolved.push({ kind: "likely-scanned-image", detail: { file: r.relativePath, pages: r.pageCount } });
  }
  const manifestCodes = new Set(manifest.keys());
  const masterCodes = new Set(master.map((m) => m.departmentCode));
  const missingManifestSide = findMissingCodes(masterCodes, manifestCodes);

  // ---- Phase 3: outputs (gitignored derived dir; never overwrite formal manifest/dataset) ----
  fs.mkdirSync(OUT, { recursive: true });
  const generatedAt = new Date().toISOString();
  const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), JSON.stringify({ generatedAt, generator: VERSION, data }, null, 2));
  write("pdf-inventory.json", {
    total: records.length,
    unique: new Set(records.map((r) => r.sha256)).size,
    readable: records.filter((r) => r.readable).length,
    textExtractable: records.filter((r) => r.textExtractable).length,
    likelyScannedImage: records.filter((r) => r.likelyScannedImage).length,
    byDocType: {
      "national-master": records.filter((r) => r.docType === "national-master").length,
      "school-brochure": records.filter((r) => r.docType === "school-brochure").length,
      unknown: records.filter((r) => r.docType === "unknown").length,
    },
    records,
  });
  const coveredSchools = new Set(records.filter((r) => r.docType === "school-brochure" && r.schoolClue).map((r) => r.schoolClue));
  write("school-coverage.json", {
    officialTotal: officialSchools.size,
    officialSchools: [...officialSchools.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => a.code.localeCompare(b.code)),
    pdfCoveredNames: [...coveredSchools].sort(),
    completeness: cross.completeness,
    completenessNote:
      cross.completeness === "unjudgeable"
        ? "no official school list available; completeness UNJUDGEABLE"
        : "school list present, but file counts are not completeness proof; see cross-validation",
  });
  write("department-candidates.json", { total: candidates.length, candidates });
  write("department-master-candidate.json", {
    total: master.length,
    note: "CANDIDATE ONLY — not verified as the official complete master list",
    master,
  });
  write("unresolved.json", { total: unresolved.length, unresolved });
  const lines = [
    `# PDF audit report (${generatedAt})`,
    ``,
    `PDFs: total=${records.length} unique=${new Set(records.map((r) => r.sha256)).size} readable=${records.filter((r) => r.readable).length} text=${records.filter((r) => r.textExtractable).length} scanned-suspect=${records.filter((r) => r.likelyScannedImage).length}`,
    `Schools: official=${officialSchools.size} pdf-covered-names=${coveredSchools.size} completeness=${cross.completeness}`,
    `Candidates: raw=${candidates.length} master=${master.length} unresolved=${unresolved.length}`,
    `Cross-validation: ${JSON.stringify(cross.summary)}`,
    `Raw HTML codes=${rawHtmlCodes.size} manifest codes=${manifestCodes.size} master codes=${masterCodes.size} manifest-not-in-master=${missingManifestSide.length} db-checked=${dbChecked} normalized=${normalizedCodes.size}`,
    ``,
    `Coverage is NOT claimed complete from file counts. Master list is CANDIDATE ONLY.`,
  ];
  fs.writeFileSync(path.join(OUT, "pdf-audit-report.md"), lines.join("\n") + "\n");

  console.log(`pdfs=${records.length} unique=${new Set(records.map((r) => r.sha256)).size}`);
  console.log(`schools official=${officialSchools.size} completeness=${cross.completeness}`);
  console.log(`candidates=${candidates.length} master=${master.length} unresolved=${unresolved.length}`);
  console.log(`cross=${JSON.stringify(cross.summary)}`);
  console.log(`out: ${OUT}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
