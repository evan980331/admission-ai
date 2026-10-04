import { describe, expect, it } from "vitest";
import { checkHistoricalRecords } from "../src/data/normalization/quality";
import { areComparable, getYearMetadata, supportedYears } from "../src/data/normalization/normalize-year";
import type { CanonicalHistoricalRecord } from "../src/data/normalization/types";

const base: CanonicalHistoricalRecord = {
  academicYear: 114,
  programType: "application",
  schoolCode: "901",
  departmentCode: "901001",
  departmentName: "測試系",
  quota: 40,
  applicants: 320,
  screened: 120,
  secondStage: 120,
  admitted: 40,
  waitlisted: 5,
  minimumScore: "52",
  averageScore: "55",
  sourceId: "fixture",
  dataVersion: "fixture-v1",
};

describe("quality validation", () => {
  it("passes clean records with at most completeness silence (no missing here)", () => {
    const issues = checkHistoricalRecords([base]);
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("errors on missing identity codes and negatives", () => {
    const issues = checkHistoricalRecords([
      { ...base, schoolCode: "", quota: -1, departmentCode: "901002" },
    ]);
    expect(issues.some((i) => i.check === "school-code" && i.level === "error")).toBe(true);
    expect(issues.some((i) => i.check === "quota-negative" && i.level === "error")).toBe(true);
  });

  it("warns (not errors) when admitted > quota", () => {
    const issues = checkHistoricalRecords([{ ...base, admitted: 45 }]);
    const rel = issues.filter((i) => i.check === "admitted-vs-quota");
    expect(rel).toHaveLength(1);
    expect(rel[0]!.level).toBe("warning");
  });

  it("errors on duplicate identity", () => {
    const issues = checkHistoricalRecords([base, { ...base }]);
    expect(issues.some((i) => i.check === "duplicate-identity" && i.level === "error")).toBe(true);
  });

  it("flags nulls as missing-completeness warnings, never fills", () => {
    const issues = checkHistoricalRecords([{ ...base, departmentCode: "901003", applicants: null }]);
    expect(issues.some((i) => i.check === "applicants-missing" && i.level === "warning")).toBe(true);
  });
});

describe("year comparability", () => {
  it("covers 111-115 with metadata", () => {
    expect(supportedYears()).toEqual([111, 112, 113, 114, 115]);
    expect(getYearMetadata(115)!.examSystem).toContain("gsat");
  });

  it("returns null for unknown years", () => {
    expect(getYearMetadata(99)).toBeNull();
  });

  it("treats 111-115 as mutually comparable regimes (reference-only)", () => {
    expect(areComparable(111, 115)).toBe(true);
    expect(areComparable(114, 114)).toBe(true);
    expect(areComparable(115, 99)).toBe(false);
  });
});
