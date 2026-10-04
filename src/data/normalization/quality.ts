import { buildIdentityKey } from "./normalize-department";
import type {
  CanonicalHistoricalRecord,
  QualityIssue,
} from "./types";

/**
 * Historical data quality checker (P3-8).
 *
 * Severity policy:
 *  - error: impossible format (missing identity codes, negative counts).
 *  - warning: plausible anomaly needing review (admitted > quota — special
 *    quotas / 回流 / definition differences exist, so this is NOT an error).
 *  - completeness is informational: missing vs zero vs unknown are distinguished
 *    upstream; here they surface as warnings, never auto-filled.
 */

function issue(
  level: QualityIssue["level"],
  category: QualityIssue["category"],
  check: string,
  detail: string,
  key?: string,
): QualityIssue {
  return { level, category, check, detail, identityKey: key };
}

export function checkRecordCompleteness(record: CanonicalHistoricalRecord): QualityIssue[] {
  const key = buildIdentityKey(record.schoolCode, record.departmentCode, record.programType, record.academicYear);
  const out: QualityIssue[] = [];
  const fields: (keyof CanonicalHistoricalRecord)[] = [
    "quota",
    "applicants",
    "screened",
    "secondStage",
    "admitted",
    "waitlisted",
    "averageScore",
  ];
  for (const f of fields) {
    if (record[f] === null) {
      out.push(issue("warning", "completeness", `${String(f)}-missing`, `${String(f)} is null (missing, not 0)`, key));
    }
  }
  return out;
}

export function checkHistoricalRecords(records: CanonicalHistoricalRecord[]): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const seen = new Map<string, number>();

  for (const r of records) {
    const key = buildIdentityKey(r.schoolCode, r.departmentCode, r.programType, r.academicYear);

    // Identity
    if (!r.schoolCode.trim()) issues.push(issue("error", "identity", "school-code", "schoolCode missing", key));
    if (!r.departmentCode.trim()) issues.push(issue("error", "identity", "dept-code", "departmentCode missing", key));
    seen.set(key, (seen.get(key) ?? 0) + 1);

    // Numeric: impossible negatives are errors.
    const numeric: [string, number | null][] = [
      ["quota", r.quota],
      ["applicants", r.applicants],
      ["screened", r.screened],
      ["secondStage", r.secondStage],
      ["admitted", r.admitted],
      ["waitlisted", r.waitlisted],
    ];
    for (const [name, v] of numeric) {
      if (v !== null && v < 0) issues.push(issue("error", "numeric", `${name}-negative`, `${name} = ${v}`, key));
    }
    if (r.minimumScore !== null && r.minimumScore.trim() === "") {
      issues.push(issue("error", "numeric", "minimum-score", "minimumScore is empty string", key));
    }

    // Relationship: admitted vs quota is a WARNING, not an error.
    if (r.quota !== null && r.admitted !== null && r.admitted > r.quota) {
      issues.push(
        issue(
          "warning",
          "relationship",
          "admitted-vs-quota",
          `admitted (${r.admitted}) > quota (${r.quota}); plausible via special quotas / 回流 / definitions — review, do not auto-reject`,
          key,
        ),
      );
    }
    if (r.screened !== null && r.applicants !== null && r.screened > r.applicants) {
      issues.push(issue("warning", "relationship", "screened-vs-applicants", `screened (${r.screened}) > applicants (${r.applicants})`, key));
    }

    issues.push(...checkRecordCompleteness(r));
  }

  for (const [key, n] of seen) {
    if (n > 1) issues.push(issue("error", "identity", "duplicate-identity", `identity ${key} appears ${n} times`, key));
  }
  return issues;
}
