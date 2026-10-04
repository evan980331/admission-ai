import type {
  CoverageReport,
  DepartmentCoverage,
  FieldFlags,
  GapKind,
  SourceSummary,
} from "./types";

/**
 * Metrics over a coverage matrix. Rates use available/applicable only:
 * not_applicable never counts as missing, unknown never counts as false.
 */
export function summarize(matrix: DepartmentCoverage[], academicYear: number): CoverageReport {
  const fieldKeys = [
    "quota",
    "expectedInterviewCount",
    "extraQuota",
    "fee",
    "dates",
    "subjectRequirements",
    "screeningMultipliers",
    "subjectWeighting",
    "excessScreeningRules",
    "apcs",
    "secondStageItems",
    "secondStageWeights",
    "reviewMaterial",
    "interview",
    "writtenTest",
    "practicalTest",
    "languageTest",
    "tieBreakingRules",
    "notes",
  ] as (keyof FieldFlags)[];

  const fieldCoverage = {} as CoverageReport["fieldCoverage"];
  for (const f of fieldKeys) {
    let available = 0;
    let applicable = 0;
    for (const row of matrix) {
      const v = row.fields[f];
      if (v === "not_applicable") continue;
      if (v === "unknown") continue;
      // true (present) and false (confirmed absent) are both KNOWN.
      applicable++;
      available++;
    }
    fieldCoverage[f] = { available, applicable, rate: applicable > 0 ? available / applicable : null };
  }

  const isTrue = (v: unknown) => v === true;
  const gapCounts: Record<GapKind, number> = {
    ACQUISITION_GAP: 0,
    PARSER_GAP: 0,
    SOURCE_GAP: 0,
    NOT_APPLICABLE: 0,
    UNKNOWN: 0,
  };
  for (const row of matrix) {
    for (const g of Object.values(row.gaps)) {
      if (g) gapCounts[g]++;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    academicYear,
    totalDepartments: matrix.length,
    sourceCounts: {
      officialHtml: matrix.filter((r) => isTrue(r.officialHtmlAvailable)).length,
      officialPdf: matrix.filter((r) => isTrue(r.officialPdfAvailable)).length,
      thirdParty: matrix.filter((r) => isTrue(r.thirdPartyAvailable)).length,
      parsed: matrix.filter((r) => isTrue(r.parsed)).length,
      normalized: matrix.filter((r) => isTrue(r.normalized)).length,
    },
    fieldCoverage,
    departmentCoverage: {
      withOfficialHtml: matrix.filter((r) => isTrue(r.officialHtmlAvailable)).length,
      withOfficialPdf: matrix.filter((r) => isTrue(r.officialPdfAvailable)).length,
      withThirdParty: matrix.filter((r) => isTrue(r.thirdPartyAvailable)).length,
      parsed: matrix.filter((r) => isTrue(r.parsed)).length,
      normalized: matrix.filter((r) => isTrue(r.normalized)).length,
    },
    gapCounts,
  };
}

export function sourceSummary(): SourceSummary {
  return {
    generatedAt: new Date().toISOString(),
    tiers: {
      official: {
        sources: ["CAC official HTML (detail pages)", "CAC official PDF (school lists)", "university official admission PDF/page"],
        usableAsOfficial: true,
      },
      third_party: { sources: ["University TW (/caac/) — validation/discovery only"], usableAsOfficial: false },
      research_only: { sources: ["com.tw (competitor only)", "test seeds", "fixtures"], usableAsOfficial: false },
    },
    robotsNote:
      "cac.edu.tw robots.txt is Disallow:/ (verified P2, still enforced); UTW robots only bans /search and /go-to/. This audit performs zero network requests and does not attempt to bypass CAC robots.",
  };
}
