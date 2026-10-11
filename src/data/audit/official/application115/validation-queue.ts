/**
 * P4.2a candidate validation + per-school gap analysis + queue building.
 * Pure, offline, deterministic. Identity follows schema rules, never filename
 * guesses: departments are UNIQUE(school_id, department_code), admissions
 * UNIQUE(year, department_id, program_id). Same code + same school + same
 * year = same entity candidate; same name alone never merges; same code
 * with different names/schools/tracks never auto-merges.
 */
import {
  assertAnnotationMatchesBuilder,
  buildOfficialDetailUrl,
} from "../../../discovery/official/application115/universe";

export type ValidationStatus =
  | "confirmed_existing"
  | "confirmed_new"
  | "possible_duplicate"
  | "code_name_conflict"
  | "missing_required_fields"
  | "needs_manual_review";

export interface CandidateSource {
  sourceFile: string;
  sourceUrl: string;
  evidenceIndex: number;
  /** Null: current extraction tracks annot order, not PDF page numbers. */
  pageNumber: number | null;
}

export interface CandidateInput {
  academicYear: string;
  schoolCode: string;
  departmentCode: string;
  departmentName: string | null;
  /** Null unless the source itself states a track. */
  admissionTrack: string | null;
  trackEvidence: string | null;
  sources: CandidateSource[];
}

export interface CurrentState {
  inManifest: boolean;
  hasRawHtml: boolean;
  isNormalized: boolean;
  dbChecked: boolean;
}

export interface ValidatedCandidate extends CandidateInput {
  validationStatus: ValidationStatus;
  reasons: string[];
  currentState: CurrentState;
  suggestedMethod: "cdp-detail" | "manual-review";
  uncertainty?: string;
}

export interface ValidationAuthorities {
  officialSchools: Map<string, string>;
  manifest: Map<string, { schoolCode: string; departmentName: string | null }>;
  rawHtmlCodes: Set<string>;
  normalizedCodes: Set<string>;
  dbChecked: boolean;
}

const is3 = (s: string) => /^\d{3}$/.test(s);
const is6 = (s: string) => /^\d{6}$/.test(s);

export function validateCandidate(input: CandidateInput, auth: ValidationAuthorities): ValidatedCandidate {
  const reasons: string[] = [];
  const base = {
    ...input,
    reasons,
    currentState: {
      inManifest: auth.manifest.has(input.departmentCode),
      hasRawHtml: auth.rawHtmlCodes.has(input.departmentCode),
      isNormalized: auth.dbChecked && auth.normalizedCodes.has(input.departmentCode),
      dbChecked: auth.dbChecked,
    } as CurrentState,
    suggestedMethod: "manual-review" as const,
    uncertainty: undefined as string | undefined,
  };

  // 1. Required fields + formats. Codes stay strings (leading zeros kept).
  const missing: string[] = [];
  if (!/^\d{3}$/.test(input.academicYear)) missing.push(`academicYear ${JSON.stringify(input.academicYear)}`);
  if (!is3(input.schoolCode)) missing.push(`schoolCode ${JSON.stringify(input.schoolCode)}`);
  if (!is6(input.departmentCode)) missing.push(`departmentCode ${JSON.stringify(input.departmentCode)}`);
  else if (input.schoolCode && !input.departmentCode.startsWith(input.schoolCode)) {
    missing.push(`departmentCode ${input.departmentCode} does not start with schoolCode ${input.schoolCode}`);
  }
  if (input.sources.length === 0) missing.push("no source evidence");
  if (missing.length > 0) {
    return { ...base, validationStatus: "missing_required_fields", reasons: missing.map((m) => `missing/invalid: ${m}`) };
  }

  // 2. Internal consistency across sources (same year+code entity claim).
  const nameSet = new Set(
    input.sources.map(() => input.departmentName).filter((n): n is string => n !== null && n !== ""),
  );
  if (nameSet.size > 1) {
    return {
      ...base,
      validationStatus: "code_name_conflict",
      reasons: [`same code ${input.departmentCode} carries ${nameSet.size} distinct names: ${[...nameSet].sort().join(" / ")}`],
      uncertainty: "do not merge; human must decide which name (if any) is official",
    };
  }
  const trackSet = new Set(
    [input.admissionTrack].filter((t): t is string => t !== null && t !== ""),
  );
  if (trackSet.size > 1) {
    return {
      ...base,
      validationStatus: "needs_manual_review",
      reasons: [`same code ${input.departmentCode} claims tracks ${[...trackSet].sort().join(" / ")}; tracks are not identity, do not merge or split automatically`],
      uncertainty: "same department may run multiple tracks under one code; confirm against official source",
    };
  }

  // 3. Multi-source agreement on the same entity still needs review.
  const files = [...new Set(input.sources.map((s) => s.sourceFile))].sort();
  if (files.length > 1) {
    return {
      ...base,
      validationStatus: "possible_duplicate",
      reasons: [`code ${input.departmentCode} extracted from ${files.length} files: ${files.join(", ")}`],
      uncertainty: "likely the same entity; confirm before queueing twice",
    };
  }

  // 4. Manifest matching (code+school agree; names agree or candidate unnamed).
  const m = auth.manifest.get(input.departmentCode);
  if (m) {
    if (m.schoolCode !== input.schoolCode) {
      return {
        ...base,
        validationStatus: "code_name_conflict",
        reasons: [`code ${input.departmentCode}: pdf school ${input.schoolCode} != manifest school ${m.schoolCode}`],
        uncertainty: "same code claimed by two schools; do not merge",
      };
    }
    if (m.departmentName && input.departmentName && m.departmentName !== input.departmentName) {
      return {
        ...base,
        validationStatus: "code_name_conflict",
        reasons: [`code ${input.departmentCode}: pdf name ${input.departmentName} != manifest name ${m.departmentName}`],
        uncertainty: "alias or rename; confirm official name before queueing",
      };
    }
    return { ...base, validationStatus: "confirmed_existing", reasons: ["manifest code+school agree"], suggestedMethod: "cdp-detail" as const };
  }

  // 5. New candidate only inside the official school list.
  if (!auth.officialSchools.has(input.schoolCode)) {
    return {
      ...base,
      validationStatus: "needs_manual_review",
      reasons: [`school ${input.schoolCode} not in official school list`],
      uncertainty: "cannot confirm school exists; human check required",
    };
  }
  return { ...base, validationStatus: "confirmed_new", reasons: [`school ${input.schoolCode} official; code absent from manifest`], suggestedMethod: "cdp-detail" as const };
}

// ---------------------------------------------------------------------------
// Per-school gap analysis (64-school official index as baseline)
// ---------------------------------------------------------------------------

export interface SchoolDetailRow {
  schoolCode: string;
  schoolName: string;
  expectedDepartments: number | null;
  expectationEvidence: string;
  pdfCount: number;
  pdfCandidates: number;
  manifestCount: number;
  rawHtmlCount: number;
  normalizedCount: number;
  dbChecked: boolean;
  newCandidates: number;
  conflictCount: number;
  duplicateCount: number;
  manualReviewCount: number;
  coverageVerdict: "counts-match" | "below-expected" | "above-expected" | "no-expectation";
  acquisitionState: "acquired" | "partially-acquired" | "not-yet-acquired" | "unverified";
}

export interface SchoolDetailInputs {
  officialSchools: { code: string; name: string; expectedDepartments: number | null }[];
  /** departmentCode -> schoolCode, from PDF extraction master. */
  masterBySchool: Map<string, { codes: string[]; files: string[] }>;
  manifestCountBySchool: Map<string, number>;
  rawHtmlBySchool: Map<string, number>;
  normalizedCountBySchool: Map<string, number>;
  dbChecked: boolean;
  validatedBySchool: Map<string, { added: number; conflict: number; duplicate: number; manual: number }>;
}

/**
 * Per-school verdicts use listedDepartmentCount as the ONLY expectation
 * evidence. Without it: "no-expectation" (never "complete"/"missing").
 * normalizedCount==0 across the index defines "not-yet-acquired" (the 54).
 */
export function buildSchoolDetail(inputs: SchoolDetailInputs): SchoolDetailRow[] {
  return inputs.officialSchools
    .map((s) => {
      const m = inputs.masterBySchool.get(s.code);
      const pdfCandidates = m ? m.codes.length : 0;
      const manifestCount = inputs.manifestCountBySchool.get(s.code) ?? 0;
      const rawHtmlCount = inputs.rawHtmlBySchool.get(s.code) ?? 0;
      const normalizedCount = inputs.normalizedCountBySchool.get(s.code) ?? 0;
      const v = inputs.validatedBySchool.get(s.code) ?? { added: 0, conflict: 0, duplicate: 0, manual: 0 };
      const expected = s.expectedDepartments;
      const coverageVerdict: SchoolDetailRow["coverageVerdict"] =
        expected === null ? "no-expectation" : pdfCandidates === expected ? "counts-match" : pdfCandidates < expected ? "below-expected" : "above-expected";
      const acquisitionState: SchoolDetailRow["acquisitionState"] = !inputs.dbChecked
        ? "unverified"
        : normalizedCount === 0
          ? "not-yet-acquired"
          : normalizedCount >= (expected ?? Number.POSITIVE_INFINITY) && expected !== null
            ? "acquired"
            : "partially-acquired";
      return {
        schoolCode: s.code,
        schoolName: s.name,
        expectedDepartments: expected,
        expectationEvidence: expected === null ? "no official per-school count; verdict withheld" : "official school-index listedDepartmentCount",
        pdfCount: m ? m.files.length : 0,
        pdfCandidates,
        manifestCount,
        rawHtmlCount,
        normalizedCount,
        dbChecked: inputs.dbChecked,
        newCandidates: v.added,
        conflictCount: v.conflict,
        duplicateCount: v.duplicate,
        manualReviewCount: v.manual,
        coverageVerdict,
        acquisitionState,
      };
    })
    .sort((a, b) => a.schoolCode.localeCompare(b.schoolCode));
}

// ---------------------------------------------------------------------------
// Acquisition queue candidates (dry-run output only)
// ---------------------------------------------------------------------------

export interface QueueCandidate {
  schoolCode: string;
  schoolName: string | null;
  departmentCode: string;
  departmentName: string | null;
  academicYear: string;
  admissionTrack: string | null;
  trackEvidence: string | null;
  sourceFile: string;
  pageNumber: number | null;
  pageEvidence: string;
  inManifest: boolean;
  hasRawHtml: boolean;
  isNormalized: boolean;
  validationStatus: ValidationStatus;
  suggestedMethod: "cdp-detail";
  uncertainty: string;
  detailUrl: string | null;
}

export function buildQueueCandidate(
  v: ValidatedCandidate,
  args: { schoolName: string | null; detailUrl: string | null },
): QueueCandidate | null {  // Queue admits ONLY verified-need items. Conflicts/duplicates/manual stay
  // in the review list; already-acquired rows stay out.
  const needsAcquisition = !v.currentState.hasRawHtml && !v.currentState.isNormalized;
  const eligible = v.validationStatus === "confirmed_new" || v.validationStatus === "confirmed_existing";
  if (!eligible || !needsAcquisition) return null;
  const primary = v.sources[0];
  if (!primary) return null;
  return {
    schoolCode: v.schoolCode,
    schoolName: args.schoolName,
    departmentCode: v.departmentCode,
    departmentName: v.departmentName,
    academicYear: v.academicYear,
    admissionTrack: v.admissionTrack,
    trackEvidence: v.trackEvidence,
    sourceFile: primary.sourceFile,
    pageNumber: primary.pageNumber,
    pageEvidence: primary.pageNumber === null ? "annot-order only; PDF page mapping unverified" : `PDF page ${primary.pageNumber}`,
    inManifest: v.currentState.inManifest,
    hasRawHtml: v.currentState.hasRawHtml,
    isNormalized: v.currentState.isNormalized,
    validationStatus: v.validationStatus,
    suggestedMethod: "cdp-detail",
    uncertainty: v.validationStatus === "confirmed_new" ? "candidate, not an official completeness claim" : "existing entity, re-acquisition only if raw missing",
    detailUrl: args.detailUrl,
  };
}

// ---------------------------------------------------------------------------
// Department-URL audit (offline). Reuses the existing official URL builder;
// never guesses URL shapes. A row whose URL cannot be built is NOT
// collectable, no matter what else checks out.
// ---------------------------------------------------------------------------

export interface DepartmentUrlAudit {
  departmentCode: string;
  builtUrl: string | null;
  buildError: string | null;
  annotUrl: string | null;
  /** True = built URL agrees with the PDF annot URL for this code. */
  matchesAnnot: boolean | null;
  collectable: boolean;
}

export function auditDepartmentUrl(departmentCode: string, annotUrl: string | null): DepartmentUrlAudit {
  let built: string | null = null;
  let buildError: string | null = null;
  try {
    built = buildOfficialDetailUrl(115, departmentCode);
  } catch (e) {
    buildError = e instanceof Error ? e.message : String(e);
  }
  if (!built || !annotUrl) {
    return { departmentCode, builtUrl: built, buildError, annotUrl, matchesAnnot: null, collectable: false };
  }
  let matches = false;
  try {
    assertAnnotationMatchesBuilder(annotUrl, 115, departmentCode);
    const bCode = built.match(/115_(\d{6})\.htm/)?.[1];
    const aCode = annotUrl.match(/115_(\d{6})\.htm/)?.[1];
    matches = bCode === departmentCode && aCode === departmentCode;
  } catch {
    matches = false;
  }
  return { departmentCode, builtUrl: built, buildError, annotUrl, matchesAnnot: matches, collectable: matches };
}

/** Duplicate built URLs across rows (same URL claimed by several codes). */
export function findDuplicateUrls(rows: { departmentCode: string; builtUrl: string | null }[]): { url: string; codes: string[] }[] {
  const byUrl = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.builtUrl) continue;
    const hit = byUrl.get(r.builtUrl) ?? [];
    hit.push(r.departmentCode);
    byUrl.set(r.builtUrl, hit);
  }
  return [...byUrl.entries()]
    .filter(([, codes]) => codes.length > 1)
    .map(([url, codes]) => ({ url, codes: [...codes].sort() }))
    .sort((a, b) => a.url.localeCompare(b.url));
}
