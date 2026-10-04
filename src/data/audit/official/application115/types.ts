/**
 * P3.10 coverage audit — types. Fully offline: no fetch, no DB.
 * Three-state flags: true / false / "unknown" (unknown is NEVER false).
 */

export type TriState = true | false | "unknown";
export type SourceTier = "official" | "third_party" | "research_only";
export type GapKind =
  | "ACQUISITION_GAP"
  | "PARSER_GAP"
  | "SOURCE_GAP"
  | "NOT_APPLICABLE"
  | "UNKNOWN";

export interface FieldFlags {
  quota: TriState;
  expectedInterviewCount: TriState;
  extraQuota: TriState;
  fee: TriState;
  dates: TriState;
  subjectRequirements: TriState;
  screeningMultipliers: TriState;
  subjectWeighting: TriState;
  excessScreeningRules: TriState;
  apcs: TriState | "not_applicable";
  secondStageItems: TriState;
  secondStageWeights: TriState;
  reviewMaterial: TriState;
  interview: TriState;
  writtenTest: TriState | "not_applicable";
  practicalTest: TriState | "not_applicable";
  languageTest: TriState | "not_applicable";
  tieBreakingRules: TriState;
  notes: TriState;
}

export interface DepartmentCoverage {
  academicYear: number;
  schoolCode: string;
  schoolName: string | null;
  departmentCode: string;
  departmentName: string | null;
  officialDetailUrl: string | null;
  officialHtmlAvailable: TriState;
  officialPdfAvailable: TriState;
  thirdPartyAvailable: TriState;
  parsed: TriState;
  normalized: TriState;
  fields: FieldFlags;
  gaps: Partial<Record<keyof FieldFlags | "department", GapKind>>;
}

export interface CoverageReport {
  generatedAt: string;
  academicYear: number;
  totalDepartments: number;
  sourceCounts: {
    officialHtml: number;
    officialPdf: number;
    thirdParty: number;
    parsed: number;
    normalized: number;
  };
  fieldCoverage: Record<keyof FieldFlags, { available: number; applicable: number; rate: number | null }>;
  departmentCoverage: {
    withOfficialHtml: number;
    withOfficialPdf: number;
    withThirdParty: number;
    parsed: number;
    normalized: number;
  };
  gapCounts: Record<GapKind, number>;
}

export interface SourceSummary {
  generatedAt: string;
  tiers: Record<SourceTier, { sources: string[]; usableAsOfficial: boolean }>;
  robotsNote: string;
}
