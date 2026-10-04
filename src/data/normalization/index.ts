import { buildIdentityKey, resolveDepartmentIdentity, type IdentityCandidate } from "./normalize-department";
import { canonicalizeRow } from "./normalize-admission";
import { mergeCanonical } from "./normalize-result";
import { checkHistoricalRecords } from "./quality";
import { getYearMetadata } from "./normalize-year";
import type {
  CanonicalHistoricalRecord,
  NormalizationReport,
  QualityIssue,
  RawHistoricalInput,
} from "./types";

export const NORMALIZATION_VERSION = "historical-normalization-v0.1.0";

export interface NormalizeBatchOptions {
  academicYear: number;
  dataVersion: string;
  /** Known history for identity linking (same dept other years). Defaults to the batch itself. */
  history?: IdentityCandidate[];
}

export interface NormalizeBatchResult {
  records: CanonicalHistoricalRecord[];
  report: NormalizationReport;
}

/**
 * Full batch: canonicalize -> merge dup-side rows -> identity link -> quality.
 * Empty input is legal (no real data yet): returns zero counts, not fake rows.
 */
export function normalizeHistoricalBatch(
  rows: RawHistoricalInput[],
  opts: NormalizeBatchOptions,
): NormalizeBatchResult {
  const issues: QualityIssue[] = [];
  const byKey = new Map<string, { admission: CanonicalHistoricalRecord | null; result: CanonicalHistoricalRecord | null; count: number }>();
  let ambiguousMappings = 0;

  const history: IdentityCandidate[] =
    opts.history ??
    rows
      .filter((r) => r.schoolCode && r.departmentCode)
      .map((r) => ({
        schoolCode: r.schoolCode!,
        departmentCode: r.departmentCode!,
        programType: r.programType,
        academicYear: r.academicYear,
        departmentName: r.departmentName ?? null,
      }));

  rows.forEach((row, i) => {
    const meta = getYearMetadata(row.academicYear);
    if (!meta) {
      issues.push({
        level: "warning",
        category: "completeness",
        check: "year-metadata",
        detail: `row ${i + 1}: no year metadata for ${row.academicYear}; kept as reference-only`,
      });
    }
    const { record, issues: rowIssues } = canonicalizeRow(row, i + 1);
    issues.push(...rowIssues);
    if (!record) return;
    const key = buildIdentityKey(record.schoolCode, record.departmentCode, record.programType, record.academicYear);
    const slot = byKey.get(key) ?? { admission: null, result: null, count: 0 };
    slot.count++;
    // First row wins the admission slot, second fills the result slot (merge path).
    if (!slot.admission) slot.admission = record;
    else if (!slot.result) slot.result = record;
    else {
      issues.push({
        level: "error",
        category: "identity",
        check: "duplicate-identity",
        detail: `identity ${key} appears 3+ times in batch`,
        identityKey: key,
      });
    }
    if (slot.count === 2) {
      issues.push({
        level: "warning",
        category: "identity",
        check: "duplicate-identity",
        detail: `identity ${key} has 2 input rows; merged via admission+result slots (verify they are distinct sources)`,
        identityKey: key,
      });
    }
    byKey.set(key, slot);
  });

  const records: CanonicalHistoricalRecord[] = [];
  for (const [key, slot] of byKey) {
    const { record, notes } = mergeCanonical(slot.admission, slot.result);
    if (!record) continue;
    const resolution = resolveDepartmentIdentity(
      {
        schoolCode: record.schoolCode,
        departmentCode: record.departmentCode,
        programType: record.programType,
        academicYear: record.academicYear,
        departmentName: record.departmentName,
      },
      history,
    );
    if (resolution.status === "ambiguous") {
      ambiguousMappings++;
      issues.push({
        level: "warning",
        category: "identity",
        check: "ambiguous-mapping",
        detail: `${key}: ${resolution.notes.join("; ")}`,
        identityKey: key,
      });
    } else if (resolution.status === "unresolved") {
      issues.push({
        level: "warning",
        category: "identity",
        check: "unresolved-identity",
        detail: `${key}: no linkable history; kept standalone, not merged`,
        identityKey: key,
      });
    }
    for (const n of notes) {
      issues.push({ level: "warning", category: "completeness", check: "merge-note", detail: `${key}: ${n}`, identityKey: key });
    }
    void key;
    records.push(record);
  }

  issues.push(...checkHistoricalRecords(records));

  const errors = issues.filter((i) => i.level === "error").length;
  const warnings = issues.filter((i) => i.level === "warning").length;
  return {
    records,
    report: {
      academicYear: opts.academicYear,
      inputRecords: rows.length,
      normalizedRecords: records.length,
      warnings,
      errors,
      ambiguousMappings,
      dataVersion: opts.dataVersion,
      parserVersion: NORMALIZATION_VERSION,
      issues,
      generatedAt: new Date().toISOString(),
    },
  };
}
