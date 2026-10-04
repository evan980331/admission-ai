/**
 * Source cross-validation — shared types (P3.6).
 *
 * Compares OFFICIAL rows (CAC / university PDFs, authoritative) against
 * THIRD-PARTY rows (University TW, validation/discovery only).
 * Never auto-fixes. On conflict, official wins.
 */

export type RowVerdict =
  | "match"
  | "missing_in_university_tw"
  | "extra_in_university_tw"
  | "field_mismatch"
  | "ambiguous";

/** Minimal official row (e.g. extracted from official PDFs). */
export interface OfficialRow {
  schoolCode: string;
  departmentCode: string;
  departmentName: string;
  quota: number | null;
  requirements?: Record<string, string | null>;
  screeningRatios?: (number | null)[];
  sourceUrl?: string;
}

/** Minimal third-party row (subset of ThirdPartyRecord). */
export interface ThirdPartyRow {
  schoolCode: string;
  departmentCode: string;
  departmentName: string;
  quota: number | null;
  requirements?: Record<string, string | null>;
  screeningRatios?: (number | null)[];
  sourceUrl: string;
}

export interface FieldDiff {
  field: string;
  official: string;
  thirdParty: string;
}

export interface ComparedRow {
  schoolCode: string;
  departmentCode: string;
  officialName: string | null;
  thirdPartyName: string | null;
  verdict: RowVerdict;
  diffs: FieldDiff[];
  note: string;
}

export interface CrossValidationReport {
  academicYear: number;
  officialSource: string;
  thirdPartySource: string;
  generatedAt: string;
  totals: Record<RowVerdict, number>;
  rows: ComparedRow[];
}
