import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseUtwSchoolPage } from "../src/data/importers/third-party/university-tw/school-parser";
import { parseUtwDeptPage } from "../src/data/importers/third-party/university-tw/dept-parser";
import { UTW_SOURCE_NAME, UTW_SOURCE_TYPE } from "../src/data/importers/third-party/university-tw/types";

const FIX = path.join(__dirname, "fixtures", "third-party");
const schoolHtml = fs.readFileSync(path.join(FIX, "utw-school.html"), "utf8");
const deptHtml = fs.readFileSync(path.join(FIX, "utw-dept.html"), "utf8");

describe("UTW school parser", () => {
  it("extracts codes, names, quota, requirements, ratios with provenance", () => {
    const { records, issues } = parseUtwSchoolPage(schoolHtml, "901", "https://university-tw.ldkrsi.men/caac/901/");
    expect(records).toHaveLength(3);
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
    const r = records[0]!;
    expect(r.departmentCode).toBe("901012");
    expect(r.departmentName).toBe("測試中文系");
    expect(r.quota).toBe(23);
    expect(r.sourceType).toBe(UTW_SOURCE_TYPE);
    expect(r.sourceName).toBe(UTW_SOURCE_NAME);
    expect(r.sourceUrl).toContain("/caac/901/901012");
    expect(r.requirements).toMatchObject({ chinese: "前", english: "均", social: "均" });
    expect(r.screeningRatios).toEqual([3, 6, null, null, 8, null]);
  });

  it("keeps summed items and nulls instead of inventing", () => {
    const { records } = parseUtwSchoolPage(schoolHtml, "901", "https://university-tw.ldkrsi.men/caac/901/");
    expect(records[1]!.summedItem).toBe("2.5 (國英)");
    expect(records[1]!.requirements.chinese).toBeNull();
  });

  it("reports rows without codes instead of swallowing", () => {
    const bad = schoolHtml.replace(">901012<", ">NOTACODE<");
    const { records, issues } = parseUtwSchoolPage(bad, "901", "https://university-tw.ldkrsi.men/caac/901/");
    expect(records).toHaveLength(2);
    expect(issues.some((i) => i.level === "error")).toBe(true);
  });
});

describe("UTW dept parser", () => {
  it("extracts quota, prior quota, 115/114 tables, screening result", () => {
    const d = parseUtwDeptPage(deptHtml, "901012", "https://university-tw.ldkrsi.men/caac/901/901012");
    expect(d.quota).toBe(23);
    expect(d.priorYearQuota).toBe(20);
    expect(d.req115.slice(0, 2)).toEqual(["前標", "均標"]);
    expect(d.ratio115.slice(0, 2)).toEqual([3, 6]);
    expect(d.screening114).toContain("社=13");
    expect(d.officialLinks.some((u) => u.includes("115_901012.htm"))).toBe(true);
    expect(d.issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("rejects off-domain dept urls", () => {
    const d = parseUtwDeptPage(deptHtml, "901012", "https://evil.example.com/x");
    expect(d.issues.some((i) => i.level === "error")).toBe(true);
  });
});
