import { describe, expect, it, expectTypeOf } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  toAdmissionPredictionInput,
  validateApcs,
  validateAptitudePreferences,
  validateCareerPreferences,
  validateDepartmentPreferences,
  validateGsatScores,
  validateInterestPreferences,
  validateListening,
  validateProfile,
  validateRegionPreferences,
  validateSameYear,
  type AdmissionPredictionInput,
  type PreferenceRankingInput,
} from "../src/domain/student";

import type { DomainIssue } from "../src/domain/student";

const errors = (issues: DomainIssue[]) => issues.filter((i) => i.level === "error");
const warnings = (issues: DomainIssue[]) => issues.filter((i) => i.level === "warning");

const goodGsat = { academicYear: 115, chinese: 13, english: 12, mathA: 10, mathB: null, social: 11, science: 9 };
const goodApcs = { academicYear: 115, concept: 4, implementation: 3 };

describe("academic scores", () => {
  it("accepts legal GSAT levels with null preserved (not 0-filled)", () => {
    const issues = validateGsatScores({ ...goodGsat });
    expect(errors(issues)).toHaveLength(0);
    expect(warnings(issues).some((w) => w.check === "score-missing")).toBe(true);
  });
  it("rejects out-of-range levels", () => {
    expect(errors(validateGsatScores({ ...goodGsat, chinese: 16 }))).toHaveLength(1);
    expect(errors(validateGsatScores({ ...goodGsat, english: -1 }))).toHaveLength(1);
    expect(errors(validateGsatScores({ ...goodGsat, social: 1.5 }))).toHaveLength(1);
  });
  it("rejects bad academicYear", () => {
    expect(errors(validateGsatScores({ ...goodGsat, academicYear: 99 }))).not.toHaveLength(0);
    expect(errors(validateProfile({ id: "s1", academicYear: 99, displayName: null, schoolName: null, track: null, createdAt: "", updatedAt: "" }))).not.toHaveLength(0);
    expect(errors(validateProfile({ id: "", academicYear: 115, displayName: null, schoolName: null, track: null, createdAt: "", updatedAt: "" })).some((e) => e.check === "identity")).toBe(true);
  });
  it("listening A/B/C/F ok, others rejected, null warns", () => {
    for (const g of ["A", "B", "C", "F"] as const) expect(validateListening(g)).toHaveLength(0);
    expect(errors(validateListening("D" as never))).toHaveLength(1);
    expect(errors(validateListening("a" as never))).toHaveLength(1);
    expect(warnings(validateListening(null))).toHaveLength(1);
  });
  it("APCS concept/implementation 1-5, rejects 0/6", () => {
    expect(errors(validateApcs({ ...goodApcs }))).toHaveLength(0);
    expect(errors(validateApcs({ ...goodApcs, concept: 0 }))).toHaveLength(1);
    expect(errors(validateApcs({ ...goodApcs, implementation: 6 }))).toHaveLength(1);
  });
  it("cross-year comparison refused", () => {
    expect(validateSameYear(115, 115, "t")).toHaveLength(0);
    const bad = validateSameYear(114, 115, "gsat-vs-current");
    expect(bad.some((i) => i.level === "error" && i.check === "cross-year")).toBe(true);
  });
});

describe("preferences", () => {
  it("accepts a well-formed region list", () => {
    const issues = validateRegionPreferences([
      { region: "北部", direction: "included", rank: 1, weight: 0.8 },
      { region: "離島", direction: "excluded", rank: null, weight: null },
    ]);
    expect(errors(issues)).toHaveLength(0);
  });
  it("rejects bad rank/weight", () => {
    const issues = validateRegionPreferences([{ region: "北部", direction: "included", rank: 0, weight: 1.5 }]);
    expect(issues.filter((i) => i.check === "rank")).toHaveLength(1);
    expect(issues.filter((i) => i.check === "weight")).toHaveLength(1);
  });
  it("rejects duplicate + include/exclude conflict + unknown region", () => {
    const dup = validateRegionPreferences([
      { region: "北部", direction: "included", rank: 1, weight: null },
      { region: "北部", direction: "included", rank: 2, weight: null },
    ]);
    expect(dup.some((i) => i.check === "duplicate")).toBe(true);
    const conflict = validateRegionPreferences([
      { region: "中部", direction: "included", rank: null, weight: null },
      { region: "中部", direction: "excluded", rank: null, weight: null },
    ]);
    expect(conflict.some((i) => i.check === "include-exclude-conflict")).toBe(true);
    expect(errors(validateRegionPreferences([{ region: "火星", direction: "included", rank: null, weight: null }])).some((i) => i.check === "region")).toBe(true);
  });
  it("empty region list warns (falls back to unfiltered), interests/careers validate labels", () => {
    expect(warnings(validateRegionPreferences([])).some((w) => w.check === "preference-empty")).toBe(true);
    expect(errors(validateInterestPreferences([{ label: "  ", rank: null, weight: null }])).some((i) => i.check === "label")).toBe(true);
    expect(errors(validateInterestPreferences([
      { label: "寫作", rank: 1, weight: 0.5 },
      { label: "寫作", rank: 2, weight: 0.5 },
    ])).some((i) => i.check === "duplicate")).toBe(true);
    expect(errors(validateCareerPreferences([{ label: "", rank: null, weight: null }]))).toHaveLength(1);
  });
  it("aptitudes accept known dimensions, reject unknown + duplicates", () => {
    expect(errors(validateAptitudePreferences([{ dimension: "數理", rank: 1, weight: 0.9 }]))).toHaveLength(0);
    expect(errors(validateAptitudePreferences([{ dimension: "魔法", rank: null, weight: null }]))).toHaveLength(1);
    expect(errors(validateAptitudePreferences([
      { dimension: "語文", rank: null, weight: null },
      { dimension: "語文", rank: null, weight: null },
    ]))).toHaveLength(1);
  });
  it("department preferences require codes + strict ranks", () => {
    const good = validateDepartmentPreferences([
      { schoolCode: "001", departmentCode: "001012", rank: 1, weight: 0.9 },
      { schoolCode: "001", departmentCode: "001022", rank: 2, weight: null },
    ]);
    expect(errors(good)).toHaveLength(0);
    expect(errors(validateDepartmentPreferences([{ schoolCode: "1", departmentCode: "001012", rank: 1, weight: null }]))).toHaveLength(1);
    expect(errors(validateDepartmentPreferences([{ schoolCode: "001", departmentCode: "1012", rank: 1, weight: null }]))).toHaveLength(1);
    const dupRank = validateDepartmentPreferences([
      { schoolCode: "001", departmentCode: "001012", rank: 1, weight: null },
      { schoolCode: "001", departmentCode: "001022", rank: 1, weight: null },
    ]);
    expect(dupRank.filter((i) => i.check === "rank")).toHaveLength(1);
    const dupDept = validateDepartmentPreferences([
      { schoolCode: "001", departmentCode: "001012", rank: 1, weight: null },
      { schoolCode: "001", departmentCode: "001012", rank: 2, weight: null },
    ]);
    expect(dupDept.some((i) => i.check === "duplicate")).toBe(true);
  });
});

describe("Objective/Preference type boundary", () => {
  it("PreferenceRankingInput is not assignable to AdmissionPredictionInput", () => {
    expectTypeOf<PreferenceRankingInput>().not.toMatchTypeOf<AdmissionPredictionInput>();
    expectTypeOf<AdmissionPredictionInput>().not.toMatchTypeOf<PreferenceRankingInput>();
  });
  it("toAdmissionPredictionInput has no preference slot", () => {
    const { input, issues } = toAdmissionPredictionInput({
      academicYear: 115,
      gsat: { ...goodGsat },
      listening: "A",
      apcs: { ...goodApcs },
    });
    expect(errors(issues)).toHaveLength(0);
    expect("regions" in input).toBe(false);
    expect("interests" in input).toBe(false);
    expect("departmentPreferences" in input).toBe(false);
    expect(input.academicYear).toBe(115);
  });
  it("cross-year scores rejected at construction", () => {
    const { issues } = toAdmissionPredictionInput({
      academicYear: 115,
      gsat: { ...goodGsat, academicYear: 114 },
      listening: null,
      apcs: { ...goodApcs },
    });
    expect(issues.some((i) => i.level === "error" && i.check === "cross-year")).toBe(true);
  });
});

describe("002 migration (static, offline)", () => {
  const dir = path.join(__dirname, "..", "db", "migrations");
  const sql002 = fs.readFileSync(path.join(dir, "002_student_preferences.sql"), "utf8");
  const expected = [
    "student_profiles",
    "student_exam_scores",
    "student_special_scores",
    "student_region_preferences",
    "student_interest_preferences",
    "student_aptitude_preferences",
    "student_department_preferences",
    "student_career_preferences",
  ];
  it("creates the 8 student/preference tables, re-runnable", () => {
    for (const t of expected) {
      expect(sql002).toContain(`CREATE TABLE IF NOT EXISTS ${t} (`);
    }
  });
  it("every student table keys off student_id with timestamps", () => {
    for (const t of expected.slice(1)) {
      const block = sql002.slice(sql002.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`));
      expect(block).toContain("student_id");
      expect(block).toContain("REFERENCES student_profiles (id)");
      expect(block).toContain("created_at");
      expect(block).toContain("updated_at");
    }
  });
  it("stores no passwords, secrets, or probabilities", () => {
    const ddl = sql002
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(ddl).not.toMatch(/password|secret|token|probability|predicted/i);
  });
  it("001_initial_schema.sql untouched by P1-A", () => {
    const sql001 = fs.readFileSync(path.join(dir, "001_initial_schema.sql"), "utf8");
    for (const t of expected) expect(sql001).not.toContain(t);
  });
});
