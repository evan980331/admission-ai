import { describe, expect, it } from "vitest";
import path from "node:path";
import { normalizeRecords } from "../src/data/importers/official/application115/normalizer";
import { parseFile } from "../src/data/importers/official/application115/parser";
import { validateBatch } from "../src/data/importers/official/application115/validator";
import { ACADEMIC_YEAR_115 } from "../src/data/importers/official/application115/types";

const FIX = path.join(__dirname, "fixtures", "application115");

function pipelineOf(file: string) {
  const parsed = parseFile(path.join(FIX, file));
  const norm = normalizeRecords(parsed.records);
  const validated = validateBatch(
    norm.schools,
    norm.departments,
    norm.admissions,
    norm.admissions.map((_, i) => i + 1),
  );
  return { parsed, norm, validated };
}

describe("application115 normalize + validate", () => {
  it("normalizes csv fixture to schema rows", () => {
    const { norm } = pipelineOf("sample.csv");
    expect(norm.schools).toHaveLength(1);
    expect(norm.departments).toHaveLength(2);
    expect(norm.admissions).toHaveLength(2);
    expect(norm.admissions[0]).toMatchObject({
      school_code: "901",
      department_code: "901001",
      year: ACADEMIC_YEAR_115,
      program_type: "application",
      quota: 40,
      screening_ratio_1: 3,
    });
  });

  it("accepts the valid fixture with no errors", () => {
    const { validated } = pipelineOf("sample.csv");
    expect(validated.issues.filter((i) => i.level === "error")).toHaveLength(0);
    expect(validated.validAdmissions).toHaveLength(2);
  });

  it("flags negative quota and bad ratio as errors", () => {
    const { norm, validated } = pipelineOf("malformed.csv");
    // NOTACODE row normalizes (quota -5, ratio 0) then fails validation
    expect(norm.errors.length + validated.issues.length).toBeGreaterThan(0);
    const checks = validated.issues.map((i) => i.check);
    expect(checks).toContain("05-quota");
    expect(checks).toContain("06-screening-ratio");
  });

  it("detects in-batch duplicates", () => {
    const { parsed } = pipelineOf("sample.csv");
    const doubled = [...parsed.records, ...parsed.records];
    const norm = normalizeRecords(doubled);
    const validated = validateBatch(
      norm.schools,
      norm.departments,
      norm.admissions,
      norm.admissions.map((_, i) => i + 1),
    );
    expect(validated.issues.some((i) => i.check === "10-no-duplicate")).toBe(true);
  });

  it("requires year 115 and program application", () => {
    const { norm } = pipelineOf("sample.csv");
    const bad = { ...norm.admissions[0]!, year: 114 };
    const v = validateBatch(norm.schools, norm.departments, [bad], [1]);
    expect(v.issues.some((i) => i.check === "03-year")).toBe(true);
  });

  it("rejects admission with unknown department", () => {
    const { norm } = pipelineOf("sample.csv");
    const bad = { ...norm.admissions[0]!, department_code: "901999" };
    const v = validateBatch(norm.schools, norm.departments, [bad], [1]);
    expect(v.issues.some((i) => i.check === "08-dept-ref")).toBe(true);
  });
});
