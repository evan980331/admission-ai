import { describe, expect, it } from "vitest";
import { buildMatrix, type CoverageInputs } from "../src/data/audit/official/application115/coverage";
import { classifyGap, classifyTier, usableAsOfficial } from "../src/data/audit/official/application115/source-classifier";
import { summarize } from "../src/data/audit/official/application115/report";
import type { ParsedDetailShape } from "../src/data/audit/official/application115/coverage";

const detail = (over: Partial<ParsedDetailShape> = {}): ParsedDetailShape => ({
  quota: 23,
  expectedInterviewCount: 69,
  extraQuotas: { indigenous: null, offshore: "1", vision: null },
  applicationFee: 1500,
  dates: ["115.5.15", null, null, null, null],
  subjectRequirements: [{ subject: "國文", requirement: "前標", multiplier: 3, scoreMethod: "*1.50" }],
  overallFirstStageWeight: "40%",
  overQuotaRules: ["一、..."],
  apcs: null,
  secondStageItems: [{ name: "審查資料", weight: "25%" }, { name: "筆試", weight: "20%" }],
  reviewItems: "修課紀錄(A)",
  interviewNotes: null,
  tieBreakingRules: ["一、..."],
  notes: ["1...."],
  ...over,
});

const inputs = (rows: CoverageInputs["manifest"] = [], extra: Partial<CoverageInputs> = {}): CoverageInputs => ({
  academicYear: 115,
  manifest: rows,
  pdfDepartments: [],
  thirdPartyCodes: new Set(),
  parsedDetails: new Map(),
  normalizedCodes: new Set(),
  ...extra,
});

const row = (code: string, name = "測試系") => ({
  schoolCode: "001",
  schoolName: "測試大學",
  departmentCode: code,
  departmentName: name,
  detailUrl: `https://www.cac.edu.tw/mobile_apply115/x/html/115_${code}.htm`,
});

describe("coverage audit (offline)", () => {
  it("1. department coverage counts", () => {
    const m = buildMatrix(inputs([row("001012")], { parsedDetails: new Map([["001|001012", detail()]]) }));
    expect(m).toHaveLength(1);
    expect(m[0]!.parsed).toBe(true);
    expect(m[0]!.officialHtmlAvailable).toBe(true);
  });
  it("2. field coverage from parsed details", () => {
    const m = buildMatrix(inputs([row("001012")], { parsedDetails: new Map([["001|001012", detail()]]) }));
    expect(m[0]!.fields.quota).toBe(true);
    expect(m[0]!.fields.screeningMultipliers).toBe(true);
    expect(m[0]!.fields.writtenTest).toBe(true);
    expect(m[0]!.fields.practicalTest).toBe("not_applicable");
  });
  it("3. official/third-party tiers", () => {
    expect(classifyTier("official")).toBe("official");
    expect(classifyTier("third_party")).toBe("third_party");
    expect(classifyTier("user_report")).toBe("research_only");
    expect(usableAsOfficial("official")).toBe(true);
    expect(usableAsOfficial("third_party")).toBe(false);
  });
  it("4. unknown is never false", () => {
    const m = buildMatrix(inputs([row("001012")]));
    expect(m[0]!.fields.quota).toBe("unknown");
    const s = summarize(m, 115);
    expect(s.fieldCoverage.quota).toMatchObject({ available: 0, applicable: 0, rate: null });
  });
  it("5. not_applicable excluded from rates", () => {
    const m = buildMatrix(inputs([row("001012")], { parsedDetails: new Map([["001|001012", detail()]]) }));
    const s = summarize(m, 115);
    expect(s.fieldCoverage.apcs).toMatchObject({ available: 0, applicable: 0, rate: null });
    expect(s.gapCounts.NOT_APPLICABLE).toBeGreaterThan(0);
  });
  it("6. acquisition gap (page known, not acquired)", () => {
    expect(classifyGap({ hasOfficialPage: true, pageAcquired: false, parsed: false, parserSupports: true, fieldApplicable: true })).toBe("ACQUISITION_GAP");
  });
  it("7. parser gap (acquired, unsupported)", () => {
    expect(classifyGap({ hasOfficialPage: true, pageAcquired: true, parsed: false, parserSupports: false, fieldApplicable: true })).toBe("PARSER_GAP");
  });
  it("8. source gap (no reliable source)", () => {
    expect(classifyGap({ hasOfficialPage: false, pageAcquired: false, parsed: false, parserSupports: true, fieldApplicable: true })).toBe("SOURCE_GAP");
    const m = buildMatrix(inputs([{ ...row("001012"), detailUrl: null }]));
    expect(m[0]!.fields.quota).toBe("unknown");
  });
  it("9. UTW subset modeling (third-party without official detail)", () => {
    const m = buildMatrix(
      inputs([row("001012")], { thirdPartyCodes: new Set(["001|001012", "001|009999"]) }),
    );
    expect(m[0]!.thirdPartyAvailable).toBe(true);
    expect(m).toHaveLength(1); // third-party-only codes don't invent manifest rows
  });
  it("10. duplicate manifest rows surface", () => {
    const m = buildMatrix(inputs([row("001012"), row("001012")]));
    expect(m).toHaveLength(2);
    const s = summarize(m, 115);
    expect(s.totalDepartments).toBe(2);
  });
  it("11. empty dataset yields zeros, not fake rows", () => {
    const m = buildMatrix(inputs([]));
    const s = summarize(m, 115);
    expect(s.totalDepartments).toBe(0);
    expect(s.fieldCoverage.quota!.rate).toBeNull();
  });
  it("12. report generation aggregates", () => {
    const m = buildMatrix(
      inputs([row("001012"), row("001022")], {
        parsedDetails: new Map([["001|001012", detail()]]),
        normalizedCodes: new Set(["001|001012"]),
      }),
    );
    const s = summarize(m, 115);
    expect(s.sourceCounts.parsed).toBe(1);
    expect(s.sourceCounts.normalized).toBe(1);
    expect(s.departmentCoverage.withOfficialHtml).toBe(2);
    expect(s.generatedAt).toBeTruthy();
  });
  it("13. offline guarantee (no fetch/pg imports in audit)", async () => {
    const fs = await import("node:fs");
    const files = [
      "src/data/audit/official/application115/types.ts",
      "src/data/audit/official/application115/coverage.ts",
      "src/data/audit/official/application115/source-classifier.ts",
      "src/data/audit/official/application115/report.ts",
      "src/data/audit/official/application115/index.ts",
      "scripts/audit-official-coverage.ts",
    ];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      expect(src).not.toMatch(/fetch\(|node-fetch|undici|from ["']pg["']|require\(["']pg["']\)/);
    }
  });
});
