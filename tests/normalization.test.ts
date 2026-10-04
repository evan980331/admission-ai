import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { normalizeHistoricalBatch } from "../src/data/normalization/index";
import {
  buildIdentityKey,
  resolveDepartmentIdentity,
} from "../src/data/normalization/normalize-department";
import type { RawHistoricalInput } from "../src/data/normalization/types";

const FIX = path.join(__dirname, "fixtures", "normalization", "historical.json");
const fixtureRows = (): RawHistoricalInput[] =>
  (JSON.parse(fs.readFileSync(FIX, "utf8")) as { records: RawHistoricalInput[] }).records;

describe("normalization (canonical records)", () => {
  it("preserves nulls and never fills 0 for unknown", () => {
    const { records, report } = normalizeHistoricalBatch(fixtureRows(), {
      academicYear: 114,
      dataVersion: "fixture-v1",
    });
    const byCode = new Map(records.map((r) => [`${r.academicYear}:${r.departmentCode}`, r]));
    // case 2: averageScore null stays null
    expect(byCode.get("114:901002")!.averageScore).toBeNull();
    // case 3: applicants null stays null (not 0)
    expect(byCode.get("114:901003")!.applicants).toBeNull();
    // case 4: explicit zeros stay zero
    const zero = byCode.get("114:901004")!;
    expect(zero.quota).toBe(0);
    expect(zero.admitted).toBe(0);
    // case 5: "N/A" -> null + error, -5 flagged
    expect(report.errors).toBeGreaterThan(0);
    expect(report.issues.some((i) => i.check === "applicants-parse")).toBe(true);
    expect(report.issues.some((i) => i.check === "quota-negative")).toBe(true);
  });

  it("allows empty input (no real data yet) without fabricating rows", () => {
    const { records, report } = normalizeHistoricalBatch([], { academicYear: 115, dataVersion: "fixture-v1" });
    expect(records).toHaveLength(0);
    expect(report.inputRecords).toBe(0);
    expect(report.normalizedRecords).toBe(0);
  });

  it("merges same-identity rows and flags 3+ duplicates", () => {
    const { report } = normalizeHistoricalBatch(fixtureRows(), { academicYear: 114, dataVersion: "fixture-v1" });
    // case 6 pair merges; quality layer flags the duplicate identity as error
    expect(report.issues.some((i) => i.check === "duplicate-identity")).toBe(true);
  });
});

describe("department identity", () => {
  it("keys identity by school|dept|program|year, never name-only", () => {
    expect(buildIdentityKey("001", "001012", "application", 115)).toBe("001|001012|application|115");
  });

  it("links same code across years, recording renames (case 8/9)", () => {
    const history = fixtureRows()
      .filter((r) => r.schoolCode && r.departmentCode)
      .map((r) => ({
        schoolCode: r.schoolCode!,
        departmentCode: r.departmentCode!,
        programType: r.programType,
        academicYear: r.academicYear,
        departmentName: r.departmentName ?? null,
      }));
    const renamed = resolveDepartmentIdentity(
      { schoolCode: "901", departmentCode: "901002", programType: "application", academicYear: 115, departmentName: "測試電機工程學系" },
      history,
    );
    expect(renamed.status).toBe("matched");
    expect(renamed.notes.join("")).toContain("differs across years");
  });

  it("marks same-year conflicts ambiguous, never auto-merges (case 7)", () => {
    const r = resolveDepartmentIdentity(
      { schoolCode: "901", departmentCode: "901006", programType: "application", academicYear: 115 },
      [
        { schoolCode: "901", departmentCode: "901006", programType: "application", academicYear: 114, departmentName: "測試重複系A" },
        { schoolCode: "901", departmentCode: "901006", programType: "application", academicYear: 114, departmentName: "測試重複系B" },
      ],
    );
    expect(r.status).toBe("ambiguous");
  });

  it("marks gapped renames ambiguous (possible code reuse)", () => {
    const r = resolveDepartmentIdentity(
      { schoolCode: "901", departmentCode: "901007", programType: "application", academicYear: 115, departmentName: "新系" },
      [
        { schoolCode: "901", departmentCode: "901007", programType: "application", academicYear: 112, departmentName: "舊系" },
      ],
    );
    expect(r.status).toBe("ambiguous");
  });

  it("leaves changed-code rows unresolved (case 10)", () => {
    const r = resolveDepartmentIdentity(
      { schoolCode: "901", departmentCode: "901099", programType: "application", academicYear: 115 },
      [{ schoolCode: "901", departmentCode: "901001", programType: "application", academicYear: 114 }],
    );
    expect(r.status).toBe("unresolved");
  });

  it("batch counts ambiguous mappings", () => {
    const rows = fixtureRows();
    const dup = { ...rows.find((r) => r.departmentCode === "901001")! };
    const { report } = normalizeHistoricalBatch([...rows, dup, { ...dup }], {
      academicYear: 114,
      dataVersion: "fixture-v1",
    });
    expect(report.ambiguousMappings).toBeGreaterThan(0);
  });
});
