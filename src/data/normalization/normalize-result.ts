import type {
  CanonicalHistoricalRecord,
  QualityIssue,
  RawHistoricalInput,
} from "./types";
import { buildIdentityKey } from "./normalize-department";
import { canonicalizeRow } from "./normalize-admission";

/**
 * historical_results rows -> canonical records (P3-3, result side).
 * Same null-preserving policy as normalize-admission; this module additionally
 * merges an admission-side and a result-side row that share one identity key.
 * A missing side stays null and is reported — never back-filled with 0.
 */

export function canonicalizeResultRow(
  input: RawHistoricalInput,
  rowIndex: number,
): { record: CanonicalHistoricalRecord | null; issues: QualityIssue[] } {
  return canonicalizeRow(input, rowIndex);
}

const MERGEABLE: (keyof CanonicalHistoricalRecord)[] = [
  "quota",
  "applicants",
  "screened",
  "secondStage",
  "admitted",
  "waitlisted",
  "minimumScore",
  "averageScore",
];

export function mergeCanonical(
  admission: CanonicalHistoricalRecord | null,
  result: CanonicalHistoricalRecord | null,
): { record: CanonicalHistoricalRecord | null; notes: string[] } {
  const notes: string[] = [];
  if (!admission && !result) return { record: null, notes: ["both sides missing"] };
  const base = (admission ?? result)!;
  const merged: CanonicalHistoricalRecord = { ...base };
  if (admission && result) {
    for (const f of MERGEABLE) {
      const a = admission[f];
      const r = result[f];
      if (a !== null && r !== null && a !== r) {
        notes.push(
          `field ${f} differs (admission=${JSON.stringify(a)} vs result=${JSON.stringify(r)}); kept admission-side`,
        );
      }
      if (a === null && r !== null) {
        (merged[f] as unknown) = r;
        notes.push(`field ${f} filled from result side (admission side missing)`);
      }
    }
    if (!merged.departmentName && result.departmentName) merged.departmentName = result.departmentName;
    if (!merged.sourceId && result.sourceId) merged.sourceId = result.sourceId;
    if (!merged.dataVersion && result.dataVersion) merged.dataVersion = result.dataVersion;
  } else {
    notes.push(admission ? "result side missing; admission-side values kept, rest null" : "admission side missing; result-side values kept, rest null");
  }
  void buildIdentityKey;
  return { record: merged, notes };
}
