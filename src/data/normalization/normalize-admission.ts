import type {
  CanonicalHistoricalRecord,
  Completeness,
  QualityIssue,
  RawHistoricalInput,
} from "./types";
import { buildIdentityKey } from "./normalize-department";

/**
 * Admission/result row -> canonical record (P3-3).
 * Null-preserving: unknown stays null. Explicit 0 stays 0 (completeness `zero`).
 * Unparseable numerics (e.g. "N/A") become null + error issue, never 0.
 */

export function classifyCompleteness(value: number | string | null | undefined): {
  num: number | null;
  completeness: Completeness;
  invalid: string | null;
} {
  if (value === null || value === undefined) return { num: null, completeness: "missing", invalid: null };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { num: null, completeness: "unknown", invalid: String(value) };
    return { num: value, completeness: value === 0 ? "zero" : "present", invalid: null };
  }
  const t = value.trim();
  if (t === "" || t === "--" || t === "無") return { num: null, completeness: "missing", invalid: null };
  const n = Number(t);
  if (!Number.isFinite(n)) return { num: null, completeness: "unknown", invalid: t };
  return { num: n, completeness: n === 0 ? "zero" : "present", invalid: null };
}

function cleanText(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t === "" || t === "--" ? null : t;
}

export interface CanonicalizeResult {
  record: CanonicalHistoricalRecord | null;
  issues: QualityIssue[];
}

const NUMERIC_FIELDS = ["quota", "applicants", "screened", "secondStage", "admitted", "waitlisted"] as const;

export function canonicalizeRow(input: RawHistoricalInput, rowIndex: number): CanonicalizeResult {
  const issues: QualityIssue[] = [];
  const key = buildIdentityKey(
    input.schoolCode ?? "",
    input.departmentCode ?? "",
    input.programType,
    input.academicYear,
  );
  const issue = (level: QualityIssue["level"], category: QualityIssue["category"], check: string, detail: string) =>
    issues.push({ level, category, check, detail, identityKey: key });

  if (!input.schoolCode?.trim()) {
    issue("error", "identity", "school-code", `row ${rowIndex}: schoolCode missing`);
  }
  if (!input.departmentCode?.trim()) {
    issue("error", "identity", "dept-code", `row ${rowIndex}: departmentCode missing`);
  }

  const nums: Record<string, number | null> = {};
  for (const f of NUMERIC_FIELDS) {
    const { num, completeness, invalid } = classifyCompleteness(input[f]);
    nums[f] = num;
    if (invalid !== null) {
      issue("error", "numeric", `${f}-parse`, `row ${rowIndex}: ${f} unparseable ${JSON.stringify(invalid)} -> null (not 0)`);
    } else if (completeness === "missing") {
      issue("warning", "completeness", `${f}-missing`, `row ${rowIndex}: ${f} missing -> null`);
    }
    if (num !== null && num < 0) {
      issue("error", "numeric", `${f}-negative`, `row ${rowIndex}: ${f} = ${num} (impossible negative)`);
    }
  }

  const fatal = issues.some((i) => i.level === "error" && (i.category === "identity" || i.category === "numeric"));
  if (fatal && (!input.schoolCode?.trim() || !input.departmentCode?.trim())) {
    return { record: null, issues };
  }

  const record: CanonicalHistoricalRecord = {
    academicYear: input.academicYear,
    programType: input.programType as CanonicalHistoricalRecord["programType"],
    schoolCode: (input.schoolCode ?? "").trim(),
    departmentCode: (input.departmentCode ?? "").trim(),
    departmentName: cleanText(input.departmentName),
    quota: nums["quota"]!,
    applicants: nums["applicants"]!,
    screened: nums["screened"]!,
    secondStage: nums["secondStage"]!,
    admitted: nums["admitted"]!,
    waitlisted: nums["waitlisted"]!,
    minimumScore: cleanText(input.minimumScore),
    averageScore: cleanText(input.averageScore),
    sourceId: cleanText(input.sourceId),
    dataVersion: cleanText(input.dataVersion),
  };
  return { record, issues };
}
