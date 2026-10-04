import fs from "node:fs";
import path from "node:path";
import { parseUtwSchoolPage } from "../../../importers/third-party/university-tw/school-parser";
import { runDetailFile } from "../../../importers/official/application115/detail/index";
import { buildMatrix, type CoverageInputs } from "./coverage";
import { summarize, sourceSummary } from "./report";

/**
 * Offline audit entry: scan repo-local artifacts only. No fetch, no DB,
 * no raw-data modification. Missing inputs are reported, never fetched.
 */
export interface AuditScan {
  warnings: string[];
  inputs: CoverageInputs;
  pdfFiles: string[];
  utwMatch: number;
  utwMissing: number;
  utwExtra: number;
}

function readJson(p: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function listFiles(dir: string, ext: RegExp): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => ext.test(f)).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export function scanLocal(root = process.cwd()): AuditScan {
  const warnings: string[] = [];
  const rawDir = path.join(root, "data", "raw", "official", "115", "application");
  const procDir = path.join(root, "data", "processed", "official", "115", "application");
  const fixDetail = path.join(root, "tests", "fixtures", "official", "application115", "detail");
  const fixUtw = path.join(root, "tests", "fixtures", "third-party");
  const histDir = path.join(root, "data", "processed", "historical", "114");

  // PDF presence only (no PDF importer exists; content-level coverage is unknown).
  const pdfFiles = listFiles(rawDir, /\.pdf$/i).map((f) => path.basename(f));
  if (pdfFiles.length === 0) warnings.push("no official PDFs under data/raw/official/115/application/");

  // P3.7 detail fixtures -> parsed details (verified official URLs by filename).
  const detailFiles = listFiles(fixDetail, /^115_\d{6}\.htm$/);
  if (detailFiles.length === 0) warnings.push("no P3.7 detail fixtures found");
  const parsedDetails = new Map();
  const manifestRows = new Map<string, { schoolCode: string; schoolName: string | null; departmentCode: string; departmentName: string | null; detailUrl: string | null }>();
  for (const f of detailFiles) {
    const m = path.basename(f).match(/^115_(\d{6})\.htm$/);
    if (!m) {
      warnings.push(`${path.basename(f)}: filename does not match 115_<6code>.htm`);
      continue;
    }
    try {
      const { record, issues } = runDetailFile({
        inputPath: f,
        sourceUrl: `https://www.cac.edu.tw/mobile_apply115/colqRy_Apply_8Rfsd57q/html/115_${m[2]}.htm`,
        dataVersion: "audit-local",
      });
      if (!record) {
        warnings.push(`${path.basename(f)}: parse failed (${issues.map((i) => i.check).join(",")})`);
        continue;
      }
      const k = `${record.schoolCode}|${record.departmentCode}`;
      parsedDetails.set(k, {
        quota: record.quota,
        expectedInterviewCount: record.expectedInterviewCount,
        extraQuotas: record.extraQuotas,
        applicationFee: record.applicationFee,
        dates: [record.notificationDate, record.materialDeadline, record.secondStageDate, record.resultDate, record.recheckDeadline],
        subjectRequirements: record.subjectRequirements,
        overallFirstStageWeight: record.overallFirstStageWeight,
        overQuotaRules: record.overQuotaRules,
        apcs: record.apcs,
        secondStageItems: record.secondStageItems,
        reviewItems: record.reviewItems,
        interviewNotes: record.interviewNotes,
        tieBreakingRules: record.tieBreakingRules,
        notes: record.notes,
      });
      manifestRows.set(k, {
        schoolCode: record.schoolCode,
        schoolName: record.schoolName,
        departmentCode: record.departmentCode,
        departmentName: record.departmentName,
        detailUrl: record.sourceUrl,
      });
    } catch (err) {
      warnings.push(`${path.basename(f)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // UTW fixtures -> third-party codes (validation/discovery only).
  // Parser fixtures without a school code prefix in the filename are skipped
  // here (they remain parser-tested, just not attributable for coverage).
  const utwCodes = new Set<string>();
  for (const f of listFiles(fixUtw, /school.*\.html$/i)) {
    try {
      const html = fs.readFileSync(f, "utf8");
      const codeGuess = path.basename(f).match(/^(\d{3})[-_]/)?.[1];
      if (!codeGuess) continue;
      const { records } = parseUtwSchoolPage(html, codeGuess, "local-fixture");
      for (const r of records) utwCodes.add(`${r.schoolCode}|${r.departmentCode}`);
    } catch (err) {
      warnings.push(`${path.basename(f)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // P3.6 real diff report (from the earlier 3-school run, if present).
  // Only rows WITH a third-party name count as third-party evidence.
  let utwMatch = 0;
  let utwMissing = 0;
  let utwExtra = 0;
  const diff = readJson(path.join(root, "data", "processed", "source-cross-validation", "115", "diff-report.json")) as {
    totals?: Record<string, number>;
    rows?: { schoolCode: string; departmentCode: string; officialName: string | null; thirdPartyName: string | null }[];
  } | null;
  if (diff?.totals) {
    utwMatch = diff.totals["match"] ?? 0;
    utwMissing = diff.totals["missing_in_university_tw"] ?? 0;
    utwExtra = diff.totals["extra_in_university_tw"] ?? 0;
    for (const r of diff.rows ?? []) {
      const k = `${r.schoolCode}|${r.departmentCode}`;
      if (r.thirdPartyName) utwCodes.add(k);
      if (!manifestRows.has(k)) {
        manifestRows.set(k, {
          schoolCode: r.schoolCode,
          schoolName: null,
          departmentCode: r.departmentCode,
          departmentName: r.thirdPartyName ?? r.officialName,
          detailUrl: null,
        });
      }
    }
  } else {
    warnings.push("no P3.6 diff-report.json; UTW overlap limited to fixtures");
  }

  // Normalized codes (same academic year only — 114 rows must not mark 115 rows).
  const normalizedCodes = new Set<string>();
  const canon = readJson(path.join(histDir, "canonical-records.json")) as
    | { academicYear: number; schoolCode: string; departmentCode: string }[]
    | null;
  if (Array.isArray(canon)) {
    for (const r of canon) {
      if (r.academicYear === 115) normalizedCodes.add(`${r.schoolCode}|${r.departmentCode}`);
    }
  }

  return {
    warnings,
    inputs: {
      academicYear: 115,
      manifest: [...manifestRows.values()],
      pdfDepartments: [],
      thirdPartyCodes: utwCodes,
      parsedDetails,
      normalizedCodes,
    },
    pdfFiles,
    utwMatch,
    utwMissing,
    utwExtra,
  };
}

export { summarize, sourceSummary, buildMatrix };
