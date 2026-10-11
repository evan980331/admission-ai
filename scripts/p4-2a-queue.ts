import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import dotenv from "dotenv";
import { buildInventory, PDF_FILES } from "../src/data/discovery/official/application115/pdf-inventory";
import {
  buildQueueCandidate,
  buildSchoolDetail,
  validateCandidate,
  type CandidateInput,
  type QueueCandidate,
  type ValidatedCandidate,
} from "../src/data/audit/official/application115/validation-queue";

dotenv.config({ path: ".env.local" });
dotenv.config();

const VERSION = "p4-2a-v0.1.0";
const AUDIT_DIR = path.join(process.cwd(), "data", "processed", "official", "115", "application", "pdf-audit");

/**
 * P4.2a validation + queue-candidate builder (dry-run output only).
 * Reads: pdf-audit master (P4.2-pre), official school-index, PDF inventory,
 * local raw HTML, PostgreSQL (read-only, env-gated). Writes: 5 derived
 * files under the gitignored audit dir. Never touches formal manifest,
 * dataset, school index, raw PDFs, or the database.
 */
async function main() {
  const root = process.cwd();
  const rawRoot = path.join(root, "data", "raw", "official", "115", "application");

  const masterJson = JSON.parse(fs.readFileSync(path.join(AUDIT_DIR, "department-master-candidate.json"), "utf8")) as {
    data: { master: { academicYear: string; schoolCode: string; departmentCode: string; departmentName: string | null; sources: { sourceFile: string; sourceUrl: string; evidenceIndex: number }[] }[] };
  };
  const indexJson = JSON.parse(fs.readFileSync(path.join(rawRoot, "universe", "school-index.json"), "utf8")) as {
    schools: { schoolCode: string; schoolName: string; listedDepartmentCount?: number }[];
  };
  const officialSchools = new Map(indexJson.schools.map((s) => [s.schoolCode, s.schoolName] as const));

  const invTexts: Record<string, string> = {};
  for (const [code, file] of Object.entries(PDF_FILES)) {
    const full = path.join(rawRoot, file);
    if (fs.existsSync(full)) invTexts[code] = fs.readFileSync(full, "latin1");
  }
  const manifest = new Map<string, { schoolCode: string; departmentName: string | null }>();
  for (const e of buildInventory(invTexts)) {
    if (!manifest.has(e.departmentCode)) manifest.set(e.departmentCode, { schoolCode: e.schoolCode, departmentName: e.departmentName });
  }

  const rawHtmlCodes = new Set<string>();
  const rawHtmlBySchool = new Map<string, number>();
  const depDir = path.join(rawRoot, "departments");
  if (fs.existsSync(depDir)) {
    for (const f of fs.readdirSync(depDir)) {
      const m = f.match(/^115_(\d{6})\.htm$/i);
      if (!m) continue;
      rawHtmlCodes.add(m[1]!);
      const s = m[1]!.slice(0, 3);
      rawHtmlBySchool.set(s, (rawHtmlBySchool.get(s) ?? 0) + 1);
    }
  }

  const normalizedCodes = new Set<string>();
  const normalizedCountBySchool = new Map<string, number>();
  let dbChecked = false;
  if (process.env.DATABASE_URL) {
    try {
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        const r = await client.query(
          `SELECT s.school_code, d.department_code FROM department_admissions a JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE a.year = 115`,
        );
        for (const row of r.rows) {
          normalizedCodes.add(row.department_code as string);
          const s = row.school_code as string;
          normalizedCountBySchool.set(s, (normalizedCountBySchool.get(s) ?? 0) + 1);
        }
        dbChecked = true;
      } finally {
        await client.end();
      }
    } catch {
      /* DB unreachable -> unverified, report says so */
    }
  }

  // ---- Phase 1: validate every master candidate ----
  const validated: ValidatedCandidate[] = masterJson.data.master.map((m) => {
    const input: CandidateInput = {
      academicYear: m.academicYear,
      schoolCode: m.schoolCode,
      departmentCode: m.departmentCode,
      departmentName: m.departmentName,
      admissionTrack: "application",
      trackEvidence: "CAC apply115 detail-URL path (all PDF annot links live under apply115)",
      sources: m.sources.map((s) => ({ ...s, pageNumber: null })),
    };
    return validateCandidate(input, { officialSchools, manifest, rawHtmlCodes, normalizedCodes, dbChecked });
  });
  const countBy = (s: ValidatedCandidate["validationStatus"]) => validated.filter((v) => v.validationStatus === s).length;

  // ---- Phase 2: per-school detail (64-school index baseline) ----
  const masterBySchool = new Map<string, { codes: string[]; files: string[] }>();
  for (const m of masterJson.data.master) {
    const hit = masterBySchool.get(m.schoolCode) ?? { codes: [], files: [] };
    hit.codes.push(m.departmentCode);
    for (const s of m.sources) if (!hit.files.includes(s.sourceFile)) hit.files.push(s.sourceFile);
    masterBySchool.set(m.schoolCode, hit);
  }
  const manifestCountBySchool = new Map<string, number>();
  for (const info of manifest.values()) manifestCountBySchool.set(info.schoolCode, (manifestCountBySchool.get(info.schoolCode) ?? 0) + 1);
  const validatedBySchool = new Map<string, { added: number; conflict: number; duplicate: number; manual: number }>();
  for (const v of validated) {
    const hit = validatedBySchool.get(v.schoolCode) ?? { added: 0, conflict: 0, duplicate: 0, manual: 0 };
    if (v.validationStatus === "confirmed_new") hit.added += 1;
    else if (v.validationStatus === "code_name_conflict") hit.conflict += 1;
    else if (v.validationStatus === "possible_duplicate") hit.duplicate += 1;
    else if (v.validationStatus === "needs_manual_review" || v.validationStatus === "missing_required_fields") hit.manual += 1;
    validatedBySchool.set(v.schoolCode, hit);
  }
  const schoolDetail = buildSchoolDetail({
    officialSchools: indexJson.schools.map((s) => ({ code: s.schoolCode, name: s.schoolName, expectedDepartments: s.listedDepartmentCount ?? null })),
    masterBySchool,
    manifestCountBySchool,
    rawHtmlBySchool,
    normalizedCountBySchool,
    dbChecked,
    validatedBySchool,
  });
  const notYetAcquired = schoolDetail.filter((r) => r.acquisitionState === "not-yet-acquired");

  // ---- Phase 3: queue candidates (verified-need only) + manual review ----
  const queue: QueueCandidate[] = [];
  const manual: ValidatedCandidate[] = [];
  for (const v of validated) {
    if (v.validationStatus === "confirmed_existing" || v.validationStatus === "confirmed_new") {
      const q = buildQueueCandidate(v, {
        schoolName: officialSchools.get(v.schoolCode) ?? null,
        detailUrl: v.sources[0]?.sourceUrl ?? null,
      });
      if (q) queue.push(q);
    } else {
      manual.push(v);
    }
  }
  queue.sort((a, b) => a.schoolCode === b.schoolCode ? a.departmentCode.localeCompare(b.departmentCode) : a.schoolCode.localeCompare(b.schoolCode));

  const generatedAt = new Date().toISOString();
  const write = (name: string, data: unknown) => fs.writeFileSync(path.join(AUDIT_DIR, name), JSON.stringify({ generatedAt, generator: VERSION, data }, null, 2));
  write("department-validation.json", {
    total: validated.length,
    byStatus: {
      confirmed_existing: countBy("confirmed_existing"),
      confirmed_new: countBy("confirmed_new"),
      possible_duplicate: countBy("possible_duplicate"),
      code_name_conflict: countBy("code_name_conflict"),
      missing_required_fields: countBy("missing_required_fields"),
      needs_manual_review: countBy("needs_manual_review"),
    },
    validated,
  });
  write("school-coverage-detail.json", { total: schoolDetail.length, notYetAcquired: notYetAcquired.map((r) => r.schoolCode), rows: schoolDetail });
  write("acquisition-queue-candidate.json", {
    total: queue.length,
    note: "CANDIDATE ONLY — verified-need items (no raw, not normalized); conflicts/duplicates/manual stay in manual-review.json",
    queue,
  });
  write("manual-review.json", { total: manual.length, items: manual });
  fs.writeFileSync(
    path.join(AUDIT_DIR, "p4.2a-report.md"),
    [
      `# P4.2a validation report (${generatedAt})`,
      ``,
      `Candidates: total=${validated.length} existing=${countBy("confirmed_existing")} new=${countBy("confirmed_new")} dup=${countBy("possible_duplicate")} conflict=${countBy("code_name_conflict")} missing=${countBy("missing_required_fields")} manual=${countBy("needs_manual_review")}`,
      `Schools: official=64 not-yet-acquired=${notYetAcquired.length} (${notYetAcquired.map((r) => r.schoolCode).join(",")})`,
      `Queue candidates=${queue.length} manual-review=${manual.length} db-checked=${dbChecked}`,
      ``,
      `"54 not-yet-acquired" = official-index schools with zero normalized year-115 application admissions (read-only DB count).`,
      `Queue holds verified-need items only; counts are not completeness claims.`,
      ``,
    ].join("\n"),
  );

  console.log(`validated=${validated.length} existing=${countBy("confirmed_existing")} new=${countBy("confirmed_new")}`);
  console.log(`dup=${countBy("possible_duplicate")} conflict=${countBy("code_name_conflict")} missing=${countBy("missing_required_fields")} manual=${countBy("needs_manual_review")}`);
  console.log(`schools=64 not-yet-acquired=${notYetAcquired.length} queue=${queue.length} manual-review=${manual.length} db-checked=${dbChecked}`);
  console.log(`out: ${AUDIT_DIR}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
