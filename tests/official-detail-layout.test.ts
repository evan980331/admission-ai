import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseDetailHtml } from "../src/data/importers/official/application115/detail/parser";
import { validateDetail } from "../src/data/importers/official/application115/detail/validator";

const DESKTOP = path.join(__dirname, "fixtures", "official", "application115", "detail-desktop");
const MOBILE = path.join(__dirname, "fixtures", "official", "application115", "detail");
const read = (p: string) => fs.readFileSync(p, "utf8");
const CAC_MOBILE = "https://www.cac.edu.tw/mobile_apply115/colqRy_Apply_8Rfsd57q/html/115_001012.htm";
const CAC_DESKTOP = "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001012.htm?v=1.0";

describe("layout-B real CAC 001012 (desktop template, byte-identical fixture)", () => {
  const { record, issues } = parseDetailHtml(
    read(path.join(DESKTOP, "115_001012.htm")),
    { sourceUrl: CAC_DESKTOP, dataVersion: "desktop-fixture" },
  );
  it("identity + quota (no guessing)", () => {
    expect(record!.schoolCode).toBe("001");
    expect(record!.departmentCode).toBe("001012");
    expect(record!.departmentName).toBe("中國文學系");
    expect(record!.quota).toBe(23);
    expect(record!.expectedInterviewCount).toBe(69);
    expect(record!.source).toBe("official");
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });
  it("first-stage subjects + multipliers + weighting", () => {
    const bySubj = new Map(record!.subjectRequirements.map((s) => [s.subject, s]));
    expect(bySubj.get("國文")).toMatchObject({ requirement: "前標", multiplier: 3, scoreMethod: "*1.50" });
    expect(bySubj.get("英文")).toMatchObject({ requirement: "均標", multiplier: 6 });
    expect(bySubj.get("社會")).toMatchObject({ requirement: "均標", multiplier: 8 });
    expect(record!.subjectRequirements.filter((s) => s.multiplier !== null)).toHaveLength(3);
    expect(record!.overallFirstStageWeight).toBe("40%");
  });
  it("GSAT percentage covered via second-stage weights + over-quota + tie-break", () => {
    expect(record!.secondStageItems).toHaveLength(3);
    expect(record!.secondStageItems[0]).toMatchObject({ name: "審查資料", requirement: "70分", weight: "25%" });
    expect(record!.overQuotaRules).toHaveLength(3);
    expect(record!.overQuotaRules[0]).toContain("國文、英文、社會");
    expect(record!.tieBreakingRules).toHaveLength(3);
  });
  it("review / interview / notes preserved, missing stays null", () => {
    expect(record!.reviewItems).toContain("修課紀錄(A)");
    expect(record!.reviewNotes).toContain("AOPQN");
    expect(record!.interviewNotes).toContain("5月15日");
    expect(record!.notes).toHaveLength(4);
    expect(record!.apcs).toBeNull();
    expect(record!.genderRequirement).toBeNull();
    expect(record!.extraQuotas).toMatchObject({ indigenous: null, offshore: "1", vision: null });
    expect(record!.offshoreRestriction).toBe("1名限連江縣");
  });
  it("validates clean and matches frozen expected JSON", () => {
    expect(validateDetail(record!).filter((i) => i.level === "error")).toHaveLength(0);
    // sourceUrl depends on caller input (desktop URL here vs mobile-derived
    // at expected-freeze time); assert it separately, not in the snapshot.
    expect(record!.sourceUrl).toBe(CAC_DESKTOP);
    const expected = JSON.parse(read(path.join(DESKTOP, "115_001012.desktop.expected.json")));
    const { retrievedAt: _a, dataVersion: _b, sourceUrl: _s1, ...got } = record!;
    const { retrievedAt: _c, dataVersion: _d, sourceUrl: _s2, ...want } = expected;
    expect(got).toEqual(want);
  });
});

describe("layout dispatch (A=mobile sections, B=desktop table)", () => {
  it("same department, both layouts, same canonical core", () => {
    const a = parseDetailHtml(read(path.join(MOBILE, "115_001012.htm")), { sourceUrl: CAC_MOBILE }).record!;
    const b = parseDetailHtml(read(path.join(DESKTOP, "115_001012.htm")), { sourceUrl: CAC_DESKTOP }).record!;
    for (const [field, va, vb] of [
      ["quota", a.quota, b.quota],
      ["expected", a.expectedInterviewCount, b.expectedInterviewCount],
      ["subjects", JSON.stringify(a.subjectRequirements), JSON.stringify(b.subjectRequirements)],
      ["stage2", JSON.stringify(a.secondStageItems), JSON.stringify(b.secondStageItems)],
      ["overQuota", JSON.stringify(a.overQuotaRules), JSON.stringify(b.overQuotaRules)],
    ] as const) {
      expect(vb, field).toBe(va);
    }
  });
  it("mobile fixtures still route to layout-A (no #BASIC regression)", () => {
    const { record, issues } = parseDetailHtml(read(path.join(MOBILE, "115_001592.htm")), { sourceUrl: "x" });
    expect(record!.departmentCode).toBe("001592");
    expect(record!.apcs!.items).toHaveLength(2);
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });
});

describe("001592 APCS regression (concept/implementation/multiplier)", () => {
  const { record } = parseDetailHtml(read(path.join(MOBILE, "115_001592.htm")), { sourceUrl: "x" });
  it("APCS concept row", () => {
    expect(record!.apcs!.items[0]).toMatchObject({ subject: "程式設計觀念題", requirement: "4級" });
  });
  it("APCS implementation row + multiplier", () => {
    expect(record!.apcs!.items[1]).toMatchObject({ subject: "程式設計實作題", requirement: "4級", multiplier: 5 });
  });
  it("APCS note preserved, quota intact", () => {
    expect(record!.apcs!.note).toContain("APCS");
    expect(record!.quota).toBe(4);
    expect(record!.expectedInterviewCount).toBe(20);
  });
});
