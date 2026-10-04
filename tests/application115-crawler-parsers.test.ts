import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseTotalSchools } from "../src/data/crawlers/official/application115/index-parser";
import { parseSchoolDepartments } from "../src/data/crawlers/official/application115/school-parser";
import {
  buildDepartmentUrl,
  isOfficialDetailUrl,
} from "../src/data/crawlers/official/application115/department-url";

const FIX = path.join(__dirname, "fixtures", "application115", "crawler");
const read = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8");

describe("TotalGsdShow parser", () => {
  it("extracts school_code / name / official url", () => {
    const { schools, issues } = parseTotalSchools(read("total.html"));
    expect(schools).toHaveLength(3);
    expect(schools[0]).toMatchObject({ school_code: "001", school_name: "測試大學001" });
    expect(schools[0]!.school_url).toContain("ShowSchGsd.php?colno=001");
    expect(schools[0]!.school_url.startsWith("https://www.cac.edu.tw/")).toBe(true);
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("warns (never rewrites) when count differs from ~64", () => {
    const { issues } = parseTotalSchools(read("total.html"));
    expect(issues.some((i) => i.detail.includes("64"))).toBe(true);
  });
});

describe("per-school department parser", () => {
  const pageUrl = "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/ShowSchGsd.php?colno=001";

  it("extracts official departments and ignores nav links", () => {
    const { departments, issues } = parseSchoolDepartments(read("school-001.html"), "001", pageUrl);
    expect(departments).toHaveLength(3);
    expect(departments[0]).toMatchObject({
      school_code: "001",
      department_code: "001012",
      department_name: "測試中國文學系",
    });
    expect(departments.every((d) => d.url.startsWith("https://www.cac.edu.tw/"))).toBe(true);
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("reports duplicate department_code instead of duplicating", () => {
    const page2 = pageUrl.replace("colno=001", "colno=002");
    const { departments, issues } = parseSchoolDepartments(read("school-dup.html"), "002", page2);
    const codes = departments.map((d) => d.department_code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(issues.some((i) => i.detail.includes("duplicate department_code 002001"))).toBe(true);
  });

  it("rejects off-domain and empty urls", () => {
    const page2 = pageUrl.replace("colno=001", "colno=002");
    const { departments } = parseSchoolDepartments(read("school-dup.html"), "002", page2);
    expect(departments.every((d) => !d.url.includes("evil.example.com"))).toBe(true);
    expect(departments.every((d) => d.url.trim() !== "")).toBe(true);
  });

  it("rejects empty school_code", () => {
    const { departments, issues } = parseSchoolDepartments(read("school-001.html"), "", pageUrl);
    expect(departments).toHaveLength(0);
    expect(issues.some((i) => i.level === "error")).toBe(true);
  });
});

describe("department URL builder (pure)", () => {
  it("builds 115 + 001012 -> 115_001012.htm on the official host", () => {
    expect(buildDepartmentUrl(115, "001012")).toBe(
      "https://www.cac.edu.tw/mobile_apply115/colqRy_Apply_8Rfsd57q/html/115_001012.htm",
    );
  });

  it("throws on invented codes and out-of-range years", () => {
    expect(() => buildDepartmentUrl(115, "ABC")).toThrow();
    expect(() => buildDepartmentUrl(115, "00101")).toThrow();
    expect(() => buildDepartmentUrl(99, "001012")).toThrow();
  });

  it("accepts only official detail urls", () => {
    expect(isOfficialDetailUrl("https://www.cac.edu.tw/mobile_apply115/x/html/115_001012.htm")).toBe(true);
    expect(isOfficialDetailUrl("https://evil.example.com/115_001012.htm")).toBe(false);
    expect(isOfficialDetailUrl("https://www.cac.edu.tw/apply115/query.php")).toBe(false);
    expect(isOfficialDetailUrl("")).toBe(false);
    expect(isOfficialDetailUrl("not a url")).toBe(false);
  });
});
