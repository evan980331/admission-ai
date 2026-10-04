import { classifyGap } from "./source-classifier";
import type {
  DepartmentCoverage,
  FieldFlags,
  GapKind,
  TriState,
} from "./types";

/**
 * Per-department coverage matrix builder (pure, offline).
 * Inputs are already-local artifacts: manifest rows, PDF inventory rows,
 * third-party rows, parsed detail records, normalized records.
 */

export interface CoverageInputs {
  academicYear: number;
  manifest: { schoolCode: string; schoolName: string | null; departmentCode: string; departmentName: string | null; detailUrl: string | null }[];
  pdfDepartments: { schoolCode: string; departmentCode: string }[];
  thirdPartyCodes: Set<string>;
  parsedDetails: Map<string, ParsedDetailShape>;
  normalizedCodes: Set<string>;
}

export interface ParsedDetailShape {
  quota: number | null;
  expectedInterviewCount: number | null;
  extraQuotas: Record<string, string | null>;
  applicationFee: number | null;
  dates: (string | null)[];
  subjectRequirements: { subject: string; requirement: string | null; multiplier: number | null; scoreMethod: string | null }[];
  overallFirstStageWeight: string | null;
  overQuotaRules: string[];
  apcs: { items: unknown[] } | null;
  secondStageItems: { name: string; weight: string | null }[];
  reviewItems: string | null;
  interviewNotes: string | null;
  tieBreakingRules: string[];
  notes: string[];
}

const key = (school: string, dept: string) => `${school}|${dept}`;

function flag(v: boolean | null | undefined): TriState {
  if (v === true) return true;
  if (v === false) return false;
  return "unknown";
}

function hasText(v: string | null | undefined): boolean {
  return v !== null && v !== undefined && v.trim() !== "";
}

/** Second-stage item kind detection from item names (conservative keyword match). */
function itemKinds(items: { name: string }[]): { written: boolean; practical: boolean; language: boolean } {
  const all = items.map((i) => i.name).join(" ");
  return {
    written: /筆試/.test(all),
    practical: /實作|術科|操作/.test(all),
    language: /語文|英文|英語|口試|面試/.test(all),
  };
}

export function buildMatrix(inputs: CoverageInputs): DepartmentCoverage[] {
  const pdfSet = new Set(inputs.pdfDepartments.map((d) => key(d.schoolCode, d.departmentCode)));
  return inputs.manifest.map((m) => {
    const k = key(m.schoolCode, m.departmentCode);
    const htmlAvailable = m.detailUrl ? true : ("unknown" as TriState);
    const pdfAvailable = pdfSet.has(k) ? true : ("unknown" as TriState);
    const tpAvailable = inputs.thirdPartyCodes.has(k) ? true : ("unknown" as TriState);
    const detail = inputs.parsedDetails.get(k) ?? null;
    const parsed = detail ? true : ("unknown" as TriState);
    const normalized = inputs.normalizedCodes.has(k) ? true : ("unknown" as TriState);

    const kinds = detail ? itemKinds(detail.secondStageItems.map((s) => ({ name: s.name }))) : null;
    const fields: FieldFlags = {
      quota: detail ? flag(detail.quota !== null) : "unknown",
      expectedInterviewCount: detail ? flag(detail.expectedInterviewCount !== null) : "unknown",
      extraQuota: detail ? flag(Object.values(detail.extraQuotas).some((v) => v !== null)) : "unknown",
      fee: detail ? flag(detail.applicationFee !== null) : "unknown",
      dates: detail ? flag(detail.dates.some((d) => d !== null)) : "unknown",
      subjectRequirements: detail ? flag(detail.subjectRequirements.some((s) => s.requirement !== null)) : "unknown",
      screeningMultipliers: detail ? flag(detail.subjectRequirements.some((s) => s.multiplier !== null)) : "unknown",
      subjectWeighting: detail ? flag(detail.subjectRequirements.some((s) => s.scoreMethod !== null) || detail.overallFirstStageWeight !== null) : "unknown",
      excessScreeningRules: detail ? flag(detail.overQuotaRules.length > 0) : "unknown",
      apcs: detail ? (detail.apcs && detail.apcs.items.length > 0 ? true : "not_applicable") : "unknown",
      secondStageItems: detail ? flag(detail.secondStageItems.length > 0) : "unknown",
      secondStageWeights: detail ? flag(detail.secondStageItems.some((s) => s.weight !== null)) : "unknown",
      reviewMaterial: detail ? flag(hasText(detail.reviewItems)) : "unknown",
      interview: detail ? flag(detail.secondStageItems.length > 0 || hasText(detail.interviewNotes)) : "unknown",
      writtenTest: detail && kinds ? (kinds.written ? flag(true) : "not_applicable") : "unknown",
      practicalTest: detail && kinds ? (kinds.practical ? flag(true) : "not_applicable") : "unknown",
      languageTest: detail && kinds ? (kinds.language ? flag(true) : "not_applicable") : "unknown",
      tieBreakingRules: detail ? flag(detail.tieBreakingRules.length > 0) : "unknown",
      notes: detail ? flag(detail.notes.length > 0) : "unknown",
    };

    const gaps: DepartmentCoverage["gaps"] = {};
    const pageKnown = m.detailUrl !== null;
    (Object.keys(fields) as (keyof FieldFlags)[]).forEach((f) => {
      const v = fields[f];
      // true = present, false = confirmed absent (explicit nulls in a parsed
      // page): both are KNOWN, no gap. unknown = needs classification.
      if (v === true || v === false) return;
      if (v === "not_applicable") {
        gaps[f] = "NOT_APPLICABLE";
        return;
      }
      gaps[f] = classifyGap({
        hasOfficialPage: pageKnown,
        pageAcquired: detail !== null,
        parsed: detail !== null,
        parserSupports: true,
        fieldApplicable: true,
      });
    });

    return {
      academicYear: inputs.academicYear,
      schoolCode: m.schoolCode,
      schoolName: m.schoolName,
      departmentCode: m.departmentCode,
      departmentName: m.departmentName,
      officialDetailUrl: m.detailUrl,
      officialHtmlAvailable: detail !== null || htmlAvailable === true ? true : ("unknown" as TriState),
      officialPdfAvailable: pdfAvailable,
      thirdPartyAvailable: tpAvailable,
      parsed,
      normalized,
      fields,
      gaps,
    };
  });
}
