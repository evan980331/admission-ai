/**
 * application115 importer — shared types.
 * Phase P2: academic year 115 x 大學申請入學 (program_type = application) only.
 * Flow: SOURCE -> DOWNLOAD/LOCAL INPUT -> RAW -> PARSE -> NORMALIZE -> VALIDATE -> IMPORT -> data_import_runs
 * The parser must NEVER write to the DB.
 */

export const SOURCE_APPLICATION115 = "application115";
export const ACADEMIC_YEAR_115 = 115;
export const PROGRAM_TYPE_APPLICATION = "application" as const;
export const PARSER_VERSION = "application115-parser-v0.1.0";

export const SOURCE_NAME_DEPT_RULES = "cac-115-application-dept-rules";
export const SOURCE_NAME_SCREENING = "cac-115-application-screening";
export const SOURCE_URL_QUERY = "https://www.cac.edu.tw/apply115/query.php";

export type SupportedFormat = "html" | "csv" | "json";

/** One row as read from RAW input, before normalization. */
export interface RawParsedRecord {
  /** 1-based row/page index within the input file (for error reports). */
  rowIndex: number;
  /** Which source this row claims to come from. */
  sourceName: string;
  /** Raw key-value fields exactly as parsed (no guessing, no filling). */
  fields: Record<string, string>;
  /** Sections/tables the parser saw but has no mapping for (must become warnings, never silent). */
  unmappedSections: string[];
}

/** Row-level parse failure. The row is dropped from the pipeline but MUST appear in the error report. */
export interface ParseError {
  rowIndex: number;
  reason: string;
  excerpt?: string;
}

/** Result of the PARSE stage. */
export interface ParseResult {
  format: SupportedFormat;
  records: RawParsedRecord[];
  errors: ParseError[];
}

/** Normalized rows matching the DB schema (see db/migrations/001_initial_schema.sql). */
export interface NormalizedSchool {
  school_code: string;
  name: string;
}

export interface NormalizedDepartment {
  school_code: string;
  department_code: string;
  name: string;
  group_name: string | null;
}

export interface NormalizedAdmission {
  school_code: string;
  department_code: string;
  year: number;
  program_type: typeof PROGRAM_TYPE_APPLICATION;
  quota: number | null;
  chinese_requirement: string | null;
  english_requirement: string | null;
  math_a_requirement: string | null;
  math_b_requirement: string | null;
  social_requirement: string | null;
  science_requirement: string | null;
  english_listening_requirement: string | null;
  screening_ratio_1: number | null;
  screening_ratio_2: number | null;
  screening_ratio_3: number | null;
  screening_score_1: string | null;
  screening_score_2: string | null;
  screening_score_3: string | null;
  final_quota: number | null;
}

export interface NormalizeResult {
  schools: NormalizedSchool[];
  departments: NormalizedDepartment[];
  admissions: NormalizedAdmission[];
  /** Rows that could not be normalized (counted, reported, never silently dropped). */
  errors: ParseError[];
  warnings: string[];
}

export interface ValidationIssue {
  level: "error" | "warning";
  check: string;
  detail: string;
  rowIndex?: number;
}

export interface ValidateResult {
  validAdmissions: NormalizedAdmission[];
  issues: ValidationIssue[];
}

export interface ImportReport {
  source: string;
  year: number;
  parser_version: string;
  data_version: string;
  dry_run: boolean;
  records_read: number;
  records_parsed: number;
  records_valid: number;
  records_invalid: number;
  warnings: number;
  errors: number;
  schools: number;
  departments: number;
  admissions: number;
  inserted: number;
  updated: number;
  error_details: ValidationIssue[];
  generated_at: string;
}
