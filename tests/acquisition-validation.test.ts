import { describe, expect, it } from "vitest";
import {
  buildQueueCandidate,
  buildSchoolDetail,
  validateCandidate,
  type CandidateInput,
  type ValidationAuthorities,
} from "../src/data/audit/official/application115/validation-queue";

function input(over: Partial<CandidateInput> = {}): CandidateInput {
  return {
    academicYear: "115",
    schoolCode: "012",
    departmentCode: "012012",
    departmentName: "中國醫藥學系",
    admissionTrack: "application",
    trackEvidence: "CAC apply115 detail-URL path",
    sources: [{ sourceFile: "data/raw/official/115/application/中國醫藥大學.pdf", sourceUrl: "https://www.cac.edu.tw/apply115/system/X/html/115_012012.htm", evidenceIndex: 1, pageNumber: null }],
    ...over,
  };
}

function auth(over: Partial<ValidationAuthorities> = {}): ValidationAuthorities {
  return {
    officialSchools: new Map([["012", "中國醫藥大學"]]),
    manifest: new Map(),
    rawHtmlCodes: new Set(),
    normalizedCodes: new Set(),
    dbChecked: true,
    ...over,
  };
}

describe("P4.2a candidate validation", () => {
  it("1. exact match across manifest/raw/normalized is confirmed_existing", () => {
    const v = validateCandidate(input(), auth({
      manifest: new Map([["012012", { schoolCode: "012", departmentName: "中國醫藥學系" }]]),
      rawHtmlCodes: new Set(["012012"]),
      normalizedCodes: new Set(["012012"]),
    }));
    expect(v.validationStatus).toBe("confirmed_existing");
    expect(v.currentState).toMatchObject({ inManifest: true, hasRawHtml: true, isNormalized: true, dbChecked: true });
    expect(v.suggestedMethod).toBe("cdp-detail");
    // Already acquired rows never enter the queue.
    expect(buildQueueCandidate(v, { schoolName: "中國醫藥大學", detailUrl: "u" })).toBeNull();
  });
  it("2. same school+dept under two tracks never merges", () => {
    const a = validateCandidate(input({ admissionTrack: "application" }), auth());
    const b = validateCandidate(input({ admissionTrack: "interview", trackEvidence: "other-source" }), auth());
    expect(a.validationStatus).toBe("confirmed_new");
    expect(b.validationStatus).toBe("confirmed_new");
    expect(a).not.toEqual(b);
    // Queued separately, each traceable to its own evidence.
    expect(buildQueueCandidate(a, { schoolName: null, detailUrl: "u1" })!.admissionTrack).toBe("application");
    expect(buildQueueCandidate(b, { schoolName: null, detailUrl: "u2" })!.admissionTrack).toBe("interview");
  });
  it("3. alias and code conflicts surface, never merge", () => {
    const schoolMismatch = validateCandidate(input(), auth({
      manifest: new Map([["012012", { schoolCode: "013", departmentName: "中國醫藥學系" }]]),
    }));
    expect(schoolMismatch.validationStatus).toBe("code_name_conflict");
    const nameMismatch = validateCandidate(input(), auth({
      manifest: new Map([["012012", { schoolCode: "012", departmentName: "藥學系" }]]),
    }));
    expect(nameMismatch.validationStatus).toBe("code_name_conflict");
    expect(schoolMismatch.suggestedMethod).toBe("manual-review");
    // Conflicts never enter the queue.
    expect(buildQueueCandidate(schoolMismatch, { schoolName: null, detailUrl: "u" })).toBeNull();
    expect(buildQueueCandidate(nameMismatch, { schoolName: null, detailUrl: "u" })).toBeNull();
  });
  it("4. leading zeros survive as strings", () => {
    const v = validateCandidate(input({ schoolCode: "001", departmentCode: "001012" }), auth({
      officialSchools: new Map([["001", "國立臺灣大學"]]),
    }));
    expect(v.schoolCode).toBe("001");
    expect(v.departmentCode).toBe("001012");
    expect(v.validationStatus).toBe("confirmed_new");
  });
  it("5. duplicates keep every source for traceability", () => {
    const v = validateCandidate(input({
      sources: [
        { sourceFile: "a.pdf", sourceUrl: "u1", evidenceIndex: 1, pageNumber: null },
        { sourceFile: "b.pdf", sourceUrl: "u2", evidenceIndex: 7, pageNumber: null },
      ],
    }), auth());
    expect(v.validationStatus).toBe("possible_duplicate");
    expect(v.sources).toHaveLength(2);
    expect(v.reasons.join(" ")).toContain("a.pdf");
    expect(v.reasons.join(" ")).toContain("b.pdf");
    expect(buildQueueCandidate(v, { schoolName: null, detailUrl: "u1" })).toBeNull();
  });
  it("6. missing sources fail closed", () => {
    const v = validateCandidate(input({ sources: [] }), auth());
    expect(v.validationStatus).toBe("missing_required_fields");
    const badCode = validateCandidate(input({ departmentCode: "12" }), auth());
    expect(badCode.validationStatus).toBe("missing_required_fields");
  });
});

describe("P4.2a school detail + queue gating", () => {
  const schools = (codes: [string, string, number | null][]) =>
    codes.map(([code, name, expectedDepartments]) => ({ code, name, expectedDepartments }));
  it("7. conflicts never auto-queue; verified-need items do", () => {
    const q = buildQueueCandidate(
      validateCandidate(input(), auth()),
      { schoolName: "中國醫藥大學", detailUrl: "https://x/115_012012.htm" },
    );
    expect(q).not.toBeNull();
    expect(q!).toMatchObject({
      schoolCode: "012", departmentCode: "012012", academicYear: "115",
      validationStatus: "confirmed_new", suggestedMethod: "cdp-detail",
    });
    expect(q!.pageEvidence).toContain("unverified");
    expect(q!.uncertainty).toContain("not an official completeness claim");
  });
  it("8. unknown counts are never called complete", () => {
    const rows = buildSchoolDetail({
      officialSchools: schools([["012", "中國醫藥大學", null]]),
      masterBySchool: new Map([["012", { codes: ["012012"], files: ["x.pdf"] }]]),
      manifestCountBySchool: new Map(),
      rawHtmlBySchool: new Map(),
      normalizedCountBySchool: new Map(),
      dbChecked: true,
      validatedBySchool: new Map([["012", { added: 1, conflict: 0, duplicate: 0, manual: 0 }]]),
    });
    expect(rows[0]!.coverageVerdict).toBe("no-expectation");
    expect(rows[0]!.expectationEvidence).toContain("withheld");
    // Counts-match is evidence-based, still not the word "complete".
    const ok = buildSchoolDetail({
      officialSchools: schools([["012", "中國醫藥大學", 1]]),
      masterBySchool: new Map([["012", { codes: ["012012"], files: ["x.pdf"] }]]),
      manifestCountBySchool: new Map(),
      rawHtmlBySchool: new Map(),
      normalizedCountBySchool: new Map(),
      dbChecked: true,
      validatedBySchool: new Map(),
    });
    expect(ok[0]!.coverageVerdict).toBe("counts-match");
    expect(JSON.stringify(ok[0])).not.toContain("complete");
  });
  it("not-yet-acquired = zero normalized rows, by definition", () => {
    const rows = buildSchoolDetail({
      officialSchools: schools([["012", "中國醫藥大學", 17], ["013", "X大學", 5]]),
      masterBySchool: new Map(),
      manifestCountBySchool: new Map(),
      rawHtmlBySchool: new Map(),
      normalizedCountBySchool: new Map([["013", 5]]),
      dbChecked: true,
      validatedBySchool: new Map(),
    });
    expect(rows.find((r) => r.schoolCode === "012")!.acquisitionState).toBe("not-yet-acquired");
    expect(rows.find((r) => r.schoolCode === "013")!.acquisitionState).toBe("acquired");
    const unchecked = buildSchoolDetail({
      officialSchools: schools([["012", "中國醫藥大學", 17]]),
      masterBySchool: new Map(),
      manifestCountBySchool: new Map(),
      rawHtmlBySchool: new Map(),
      normalizedCountBySchool: new Map(),
      dbChecked: false,
      validatedBySchool: new Map(),
    });
    expect(unchecked[0]!.acquisitionState).toBe("unverified");
  });
});
