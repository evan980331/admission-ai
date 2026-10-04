/**
 * P3 Historical Normalization Layer — shared types.
 *
 * Core policy: missing data is NEVER filled with 0.
 * `null` = unknown/missing. Explicit zero (quota = 0, e.g. 停招) stays 0
 * and is classified as `zero` completeness, not `missing`.
 */

export type ProgramType = "application" | "stars" | "distribution" | "tech_application";

/** How to read a nullable value: present ≠ missing ≠ zero ≠ not_applicable ≠ unknown. */
export type Completeness = "present" | "missing" | "zero" | "not_applicable" | "unknown";

/** Canonical internal representation of one historical record (one dept × year × program). */
export interface CanonicalHistoricalRecord {
  academicYear: number;
  programType: ProgramType;
  schoolCode: string;
  departmentCode: string;
  departmentName: string | null;

  quota: number | null;
  applicants: number | null;
  screened: number | null;
  secondStage: number | null;
  admitted: number | null;
  waitlisted: number | null;

  minimumScore: string | null;
  averageScore: string | null;

  sourceId: string | null;
  dataVersion: string | null;
}

export type AdmissionYearMetadata = {
  academicYear: number;
  examSystem: string;
  admissionSystem: string;
  comparableWith: number[];
  notes: string[];
};

export type IdentityStatus = "matched" | "ambiguous" | "unresolved";

export interface IdentityResolution {
  status: IdentityStatus;
  identityKey: string;
  notes: string[];
}

export type ScoreKind = "raw" | "grade" | "percentile" | "normalized";

export interface ScoreInput {
  kind: ScoreKind;
  value: number | null;
}

export interface NormalizedScore {
  rawScore: number | null;
  grade: number | null;
  percentile: number | null;
  normalizedScore: number | null;
  normalizationMethod: string;
  academicYear: number;
  comparable: boolean;
}

export interface QualityIssue {
  level: "error" | "warning";
  category: "identity" | "numeric" | "relationship" | "completeness";
  check: string;
  detail: string;
  identityKey?: string;
}

export interface NormalizationReport {
  academicYear: number;
  inputRecords: number;
  normalizedRecords: number;
  warnings: number;
  errors: number;
  ambiguousMappings: number;
  dataVersion: string;
  parserVersion: string;
  issues: QualityIssue[];
  generatedAt: string;
}

/** Raw DB-like row accepted by the normalizers (both importer and fixture shapes). */
export interface RawHistoricalInput {
  academicYear: number;
  programType: string;
  schoolCode: string | null;
  departmentCode: string | null;
  departmentName?: string | null;
  quota?: number | string | null;
  applicants?: number | string | null;
  screened?: number | string | null;
  secondStage?: number | string | null;
  admitted?: number | string | null;
  waitlisted?: number | string | null;
  minimumScore?: string | null;
  averageScore?: string | null;
  sourceId?: string | null;
  dataVersion?: string | null;
}
