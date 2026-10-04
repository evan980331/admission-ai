/**
 * CAC official detail HTML parser — shared types (P3.7 PoC).
 * Source: CAC mobile detail pages, e.g. .../html/115_001012.htm (manually acquired fixture).
 * Provenance: source=official, academicYear=115. Never writes to the DB.
 */

export const DETAIL_PARSER_VERSION = "official-detail-parser-v0.1.0";
export const DETAIL_YEAR = 115;

export interface SubjectScreening {
  subject: string;
  requirement: string | null;
  multiplier: number | null;
  scoreMethod: string | null;
}

export interface SecondStageItem {
  name: string;
  requirement: string | null;
  weight: string | null;
}

export interface ApcsScreening {
  subject: string;
  requirement: string | null;
  multiplier: number | null;
}

export interface DetailRecord {
  academicYear: number;
  schoolCode: string;
  departmentCode: string;
  schoolName: string | null;
  departmentName: string | null;
  quota: number | null;
  expectedInterviewCount: number | null;
  genderRequirement: string | null;

  subjectRequirements: SubjectScreening[];
  overallFirstStageWeight: string | null;
  overQuotaRules: string[];
  tieBreakingRules: string[];

  secondStageItems: SecondStageItem[];
  reviewItems: string | null;
  reviewNotes: string | null;
  interviewNotes: string | null;

  extraQuotas: Record<string, string | null>;
  applicationFee: number | null;
  notificationDate: string | null;
  materialDeadline: string | null;
  secondStageDate: string | null;
  resultDate: string | null;
  recheckDeadline: string | null;
  offshoreRestriction: string | null;
  notes: string[];

  apcs: { items: ApcsScreening[]; note: string | null } | null;

  source: "official";
  sourceUrl: string;
  retrievedAt: string | null;
  parserVersion: string;
  dataVersion: string;

  /** Original label->value pairs as seen (debug/audit). */
  rawFields: Record<string, string>;
  /** Seen-but-unmapped content — warnings, never silent. */
  unmapped: string[];
}

export interface DetailIssue {
  level: "error" | "warning";
  check: string;
  detail: string;
}

export interface DetailParseResult {
  record: DetailRecord | null;
  issues: DetailIssue[];
}
