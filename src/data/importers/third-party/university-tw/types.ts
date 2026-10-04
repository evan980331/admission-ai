/**
 * University TW third-party importer — shared types (P3.6).
 *
 * Scope: parse University TW 115 個人申請 HTML (school + department pages)
 * into intermediate records. NEVER writes to the DB, NEVER labeled official.
 *
 * Provenance is attached to every record:
 *   sourceType = "third_party" / sourceName = "University TW" / sourceUrl = page URL
 * Policy: official CAC data is authoritative; third-party rows are for
 * validation / discovery only and must never overwrite official rows.
 */

export const UTW_SOURCE_TYPE = "third_party" as const;
export const UTW_SOURCE_NAME = "University TW" as const;
export const UTW_ORIGIN = "https://university-tw.ldkrsi.men";
export const UTW_PARSER_VERSION = "utw-parser-v0.1.0";
export const UTW_YEAR = 115;

/** Requirement level per subject as shown on UTW (頂/前/均/後/底/--). Null = not required / not shown. */
export type RequirementLevel = string | null;

export interface UtwRequirements {
  chinese: RequirementLevel;
  english: RequirementLevel;
  mathA: RequirementLevel;
  mathB: RequirementLevel;
  social: RequirementLevel;
  science: RequirementLevel;
  englishListening: RequirementLevel;
}

/** Screening multipliers in subject order [國,英,數A,數B,社,自]. Null = no screening. */
export type ScreeningRatios = (number | null)[];

export interface ThirdPartyRecord {
  sourceType: typeof UTW_SOURCE_TYPE;
  sourceName: typeof UTW_SOURCE_NAME;
  sourceUrl: string;
  academicYear: number;
  schoolCode: string;
  schoolName: string | null;
  departmentCode: string;
  departmentName: string;
  quota: number | null;
  priorYearQuota: number | null;
  subjectsTaken: string | null;
  requirements: UtwRequirements;
  screeningRatios: ScreeningRatios;
  summedItem: string | null;
  /** Sections the parser saw but has no mapping for — warnings, never silent. */
  unmapped: string[];
}

export interface UtwParseIssue {
  level: "error" | "warning";
  detail: string;
}

export interface UtwSchoolParseResult {
  records: ThirdPartyRecord[];
  issues: UtwParseIssue[];
}
