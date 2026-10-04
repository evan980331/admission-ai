import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseDetailHtml } from "../src/data/importers/official/application115/detail/parser";
import { validateDetail } from "../src/data/importers/official/application115/detail/validator";
import { toP2Row, toP3Input } from "../src/data/importers/official/application115/detail/normalizer";
import { normalizeHistoricalBatch } from "../src/data/normalization/index";

const FIX = path.join(__dirname, "fixtures", "official", "application115", "detail");
const htmlOf = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8");
const parse = (f: string, code: string) =>
  parseDetailHtml(htmlOf(f), {
    sourceUrl: `https://www.cac.edu.tw/mobile_apply115/colqRy_Apply_8Rfsd57q/html/115_${code}.htm`,
    dataVersion: "fixture-manual",
  });

describe("detail fixtures parse successfully", () => {
  for (const [f, code] of [["115_001012.htm", "001012"], ["115_001022.htm", "001022"], ["115_001032.htm", "001032"], ["115_001592.htm", "001592"]]) {
    it(`${code}: identity + counts`, () => {
      const { record, issues } = parse(f, code);
      expect(record).not.toBeNull();
      expect(record!.schoolCode).toBe("001");
      expect(record!.departmentCode).toBe(code);
      expect(record!.academicYear).toBe(115);
      expect(record!.source).toBe("official");
      expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
    });
  }
});

describe("001012 field values (verified against CAC page)", () => {
  const { record } = parse("115_001012.htm", "001012");
  it("basic fields", () => {
    expect(record!.departmentName).toBe("中國文學系");
    expect(record!.quota).toBe(23);
    expect(record!.expectedInterviewCount).toBe(69);
    expect(record!.applicationFee).toBe(1500);
    expect(record!.secondStageDate).toBe("115.5.15");
    expect(record!.offshoreRestriction).toBe("1名限連江縣");
  });
  it("first-stage subjects", () => {
    const bySubj = new Map(record!.subjectRequirements.map((s) => [s.subject, s]));
    expect(bySubj.get("國文")).toMatchObject({ requirement: "前標", multiplier: 3, scoreMethod: "*1.50" });
    expect(bySubj.get("英文")).toMatchObject({ requirement: "均標", multiplier: 6 });
    expect(bySubj.get("社會")).toMatchObject({ requirement: "均標", multiplier: 8 });
    expect(record!.overallFirstStageWeight).toBe("40%");
  });
  it("screening ratios as multipliers (not invented sequence)", () => {
    expect(record!.subjectRequirements.filter((s) => s.multiplier !== null)).toHaveLength(3);
  });
  it("second-stage items with weights", () => {
    expect(record!.secondStageItems).toHaveLength(3);
    expect(record!.secondStageItems[0]).toMatchObject({ name: "審查資料", requirement: "70分", weight: "25%" });
    expect(record!.secondStageItems[1]).toMatchObject({ name: "語文測驗筆試", weight: "20%" });
    expect(record!.secondStageItems[2]).toMatchObject({ name: "寫作筆試", weight: "15%" });
  });
  it("over-quota, tie-break, review, notes", () => {
    expect(record!.overQuotaRules).toHaveLength(3);
    expect(record!.overQuotaRules[0]).toContain("國文、英文、社會");
    expect(record!.tieBreakingRules).toHaveLength(3);
    expect(record!.reviewItems).toContain("修課紀錄(A)");
    expect(record!.interviewNotes).toContain("5月15日");
    expect(record!.notes).toHaveLength(4);
  });
});

describe("structural variants", () => {
  it("001022: listening row + rowspan=7 + 4 over-quota rules", () => {
    const { record } = parse("115_001022.htm", "001022");
    expect(record!.quota).toBe(43);
    expect(record!.expectedInterviewCount).toBe(108);
    const eng = record!.subjectRequirements.find((s) => s.subject === "英聽");
    expect(eng).toMatchObject({ requirement: "A級" });
    expect(record!.overQuotaRules).toHaveLength(4);
    expect(record!.secondStageItems.map((s) => s.name)).toContain("英語口試測驗");
  });
  it("001592 APCS: 3 subjects + apcs table + single over-quota rule", () => {
    const { record } = parse("115_001592.htm", "001592");
    expect(record!.quota).toBe(4);
    expect(record!.departmentName).toContain("APCS組");
    expect(record!.subjectRequirements.map((s) => s.subject)).toEqual(["英文", "數學A", "自然"]);
    expect(record!.apcs).not.toBeNull();
    expect(record!.apcs!.items).toHaveLength(2);
    expect(record!.apcs!.items[1]).toMatchObject({ subject: "程式設計實作題", requirement: "4級", multiplier: 5 });
    expect(record!.apcs!.note).toContain("APCS");
    expect(record!.overQuotaRules).toHaveLength(1);
  });
});

describe("whitespace/br/missing handling", () => {
  it("tolerates rewritten whitespace", () => {
    const noisy = htmlOf("115_001012.htm").replace(/>\s+</g, "><").replace(/ {2,}/g, " ");
    const { record, issues } = parseDetailHtml(noisy, { sourceUrl: "x" });
    expect(record!.quota).toBe(23);
    expect(record!.departmentCode).toBe("001012");
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });
  it("missing sections become warnings, not silent nulls", () => {
    const { record, issues } = parseDetailHtml('<html><body><div id="BASIC"><table><tr><td>校系代碼</td><td>001012</td></tr></table></div></body></html>', { sourceUrl: "x" });
    expect(record).not.toBeNull();
    expect(issues.some((i) => i.check === "section")).toBe(true);
  });
  it("missing code is an error with null record", () => {
    const { record, issues } = parseDetailHtml("<html><body>no data</body></html>", { sourceUrl: "x" });
    expect(record).toBeNull();
    expect(issues.some((i) => i.level === "error")).toBe(true);
  });
  it("template placeholders never leak (artifact error)", () => {
    const tainted = htmlOf("115_001012.htm").replace("前標</td>", "centertimes1</td>");
    const { record } = parseDetailHtml(tainted, { sourceUrl: "x" });
    const problems = validateDetail(record!);
    expect(problems.some((i) => i.check === "html-artifact" && i.level === "error")).toBe(true);
  });
});

describe("validator + canonical bridge + P3 handoff", () => {
  it("001012 validates with zero errors", () => {
    const { record } = parse("115_001012.htm", "001012");
    const problems = validateDetail(record!);
    expect(problems.filter((i) => i.level === "error")).toHaveLength(0);
  });
  it("rejects code mismatch and negative quota", () => {
    const { record } = parse("115_001012.htm", "001012");
    const bad = { ...record!, departmentCode: "002012" };
    expect(validateDetail(bad).some((i) => i.check === "code-relation")).toBe(true);
    const neg = { ...record!, quota: -1 };
    expect(validateDetail(neg).some((i) => i.check === "quota")).toBe(true);
  });
  it("toP2Row fills requirements, leaves numbered ratios null (honest)", () => {
    const { record } = parse("115_001012.htm", "001012");
    const row = toP2Row(record!);
    expect(row).toMatchObject({
      school_code: "001",
      department_code: "001012",
      quota: 23,
      chinese_requirement: "前標",
      english_requirement: "均標",
      screening_ratio_1: null,
    });
  });
  it("toP3Input flows through P3 normalization", () => {
    const { record } = parse("115_001012.htm", "001012");
    const { records, report } = normalizeHistoricalBatch([toP3Input(record!)], { academicYear: 115, dataVersion: "detail-poc" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ schoolCode: "001", departmentCode: "001012", quota: 23, admitted: null });
    expect(report.errors).toBe(0);
  });
  it("matches frozen expected JSON", () => {
    for (const code of ["001012", "001022", "001032", "001592"]) {
      const { record } = parse(`115_${code}.htm`, code);
      const expected = JSON.parse(fs.readFileSync(path.join(FIX, `115_${code}.expected.json`), "utf8"));
      const { retrievedAt: _a, ...got } = record!;
      const { retrievedAt: _b, ...want } = expected;
      expect(got).toEqual(want);
    }
  });
});
