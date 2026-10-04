/**
 * P3.13 dataset store — types. Local cumulative dataset over P3.11 outputs.
 * Identity: academicYear + schoolCode + departmentCode. No silent overwrites,
 * no silent loss, deterministic merge. Missing stays null/[]. No DB, no network.
 */

export const DATASET_VERSION = "official-dataset-v0.1.0";

export type DatasetEntryStatus =
  | "ok"
  | "source_unverified"
  | "parse_error"
  | "validation_error"
  | "normalization_error";

export interface VersionRecord {
  sha256: string;
  capturedAt: string | null;
  sourceUrl: string | null;
  status: DatasetEntryStatus | "superseded";
}

export interface DatasetEntry {
  academicYear: number;
  schoolCode: string;
  schoolName: string | null;
  departmentCode: string;
  departmentName: string | null;
  detailUrl: string | null;
  status: DatasetEntryStatus;
  lastCapturedAt: string | null;
  sha256: string | null;
  parserStatus: "success" | "failed" | "skipped";
  normalizationStatus: "success" | "failed" | "skipped";
  sourceType: "official";
  sourceUrl: string | null;
  capturedAt: string | null;
  parserVersion: string | null;
  dataVersion: string | null;
  detail: unknown | null;
  p2Row: unknown | null;
  canonical: unknown | null;
  errors: string[];
  history: VersionRecord[];
  /** False when this entry is preserved without a current-run source file. */
  sourcePresent: boolean;
}

export interface Dataset {
  datasetVersion: string;
  academicYear: number;
  generatedAt: string;
  entries: Record<string, DatasetEntry>;
}

export type CoverageStatus =
  | "captured"
  | "unchanged"
  | "content_changed"
  | "carried"
  | "parse_success"
  | "parse_error"
  | "validation_error"
  | "normalized"
  | "normalization_error"
  | "missing";

export interface CoverageRow {
  schoolCode: string;
  schoolName: string | null;
  departmentCode: string;
  departmentName: string | null;
  detailUrl: string | null;
  status: CoverageStatus;
  lastCapturedAt: string | null;
  sha256: string | null;
  parserStatus: DatasetEntry["parserStatus"];
  normalizationStatus: DatasetEntry["normalizationStatus"];
  errors: string[];
  /** True when the row's code comes from the manifest universe. */
  inUniverse: boolean;
}

export interface CoverageReport {
  generatedAt: string;
  academicYear: number;
  totalDepartments: number;
  captured: number;
  unchanged: number;
  contentChanged: number;
  carried: number;
  parseSuccess: number;
  parseError: number;
  validationError: number;
  normalized: number;
  normalizationError: number;
  missing: number;
  rows: CoverageRow[];
}

export interface DatasetBuildReport {
  generatedAt: string;
  academicYear: number;
  inputDir: string;
  newEntries: number;
  unchanged: number;
  contentChanged: number;
  errors: number;
  skipped: string[];
}
