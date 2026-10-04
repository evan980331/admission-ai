import {
  ACADEMIC_YEAR_115,
  PROGRAM_TYPE_APPLICATION,
  type NormalizeResult,
  type NormalizedAdmission,
  type NormalizedDepartment,
  type NormalizedSchool,
  type ParseError,
  type RawParsedRecord,
} from "./types";

/**
 * NORMALIZE stage — RawParsedRecord[] -> DB-shaped rows. No DB access.
 * Rules:
 *  - school_code = first 3 digits of the 6-digit 校系代碼 (cac convention, recorded not assumed).
 *  - Empty string means "official file has no value" -> NULL. Never invent values.
 *  - Rows that cannot be normalized are returned in errors, never silently dropped.
 */

function toNull(s: string | undefined): string | null {
  if (s === undefined) return null;
  const t = s.trim();
  return t === "" || t === "--" || t === "無" ? null : t;
}

function toIntOrNull(s: string | undefined, field: string, errors: string[]): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === "" || t === "--" || t === "無") return null;
  const n = Number(t);
  if (!Number.isInteger(n)) {
    errors.push(`field ${field} is not an integer: ${JSON.stringify(t)}`);
    return null;
  }
  return n;
}

function toRatioOrNull(s: string | undefined, field: string, errors: string[]): number | null {
  if (s === undefined) return null;
  const t = s.trim().replace(/倍$/, "");
  if (t === "" || t === "--" || t === "無") return null;
  const n = Number(t);
  if (!Number.isFinite(n)) {
    errors.push(`field ${field} is not numeric: ${JSON.stringify(t)}`);
    return null;
  }
  return n;
}

export function normalizeRecords(raw: RawParsedRecord[]): NormalizeResult {
  const schools = new Map<string, NormalizedSchool>();
  const departments = new Map<string, NormalizedDepartment>();
  const admissions: NormalizedAdmission[] = [];
  const errors: ParseError[] = [];
  const warnings: string[] = [];

  for (const r of raw) {
    const f = r.fields;
    const rowProblems: string[] = [];

    const deptCodeRaw = (f["department_code"] ?? "").trim();
    if (!/^\d{6}$/.test(deptCodeRaw)) {
      errors.push({
        rowIndex: r.rowIndex,
        reason: `department_code must be 6 digits, got ${JSON.stringify(deptCodeRaw)}`,
      });
      continue;
    }
    const schoolCode = deptCodeRaw.slice(0, 3);

    const schoolName = (f["school_name"] ?? f["page_title"] ?? "").trim();
    if (!schools.has(schoolCode)) {
      if (!schoolName) {
        rowProblems.push("school_name missing; school row will use school_code as placeholder name");
      }
      schools.set(schoolCode, { school_code: schoolCode, name: schoolName || schoolCode });
    }

    const deptKey = `${schoolCode}:${deptCodeRaw}`;
    if (!departments.has(deptKey)) {
      const deptName = (f["department_name"] ?? f["page_title"] ?? "").trim();
      if (!deptName) {
        errors.push({ rowIndex: r.rowIndex, reason: "department_name missing, cannot normalize" });
        continue;
      }
      departments.set(deptKey, {
        school_code: schoolCode,
        department_code: deptCodeRaw,
        name: deptName,
        group_name: toNull(f["group_name"]),
      });
    }

    const quota = toIntOrNull(f["quota"], "quota", rowProblems);
    const finalQuota = toIntOrNull(f["final_quota"], "final_quota", rowProblems);

    admissions.push({
      school_code: schoolCode,
      department_code: deptCodeRaw,
      year: ACADEMIC_YEAR_115,
      program_type: PROGRAM_TYPE_APPLICATION,
      quota,
      chinese_requirement: toNull(f["chinese_requirement"]),
      english_requirement: toNull(f["english_requirement"]),
      math_a_requirement: toNull(f["math_a_requirement"]),
      math_b_requirement: toNull(f["math_b_requirement"]),
      social_requirement: toNull(f["social_requirement"]),
      science_requirement: toNull(f["science_requirement"]),
      english_listening_requirement: toNull(f["english_listening_requirement"]),
      screening_ratio_1: toRatioOrNull(f["screening_ratio_1"], "screening_ratio_1", rowProblems),
      screening_ratio_2: toRatioOrNull(f["screening_ratio_2"], "screening_ratio_2", rowProblems),
      screening_ratio_3: toRatioOrNull(f["screening_ratio_3"], "screening_ratio_3", rowProblems),
      screening_score_1: toNull(f["screening_score_1"]),
      screening_score_2: toNull(f["screening_score_2"]),
      screening_score_3: toNull(f["screening_score_3"]),
      final_quota: finalQuota,
    });

    for (const p of rowProblems) warnings.push(`row ${r.rowIndex}: ${p}`);
    for (const s of r.unmappedSections) warnings.push(`row ${r.rowIndex}: unmapped — ${s}`);
  }

  return { schools: [...schools.values()], departments: [...departments.values()], admissions, errors, warnings };
}
