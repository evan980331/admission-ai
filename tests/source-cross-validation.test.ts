import { describe, expect, it } from "vitest";
import { compareRows } from "../src/data/validation/source-cross-validation/compare";
import type { OfficialRow, ThirdPartyRow } from "../src/data/validation/source-cross-validation/types";

const off = (code: string, name: string, quota: number | null, extra: Partial<OfficialRow> = {}): OfficialRow => ({
  schoolCode: "901",
  departmentCode: code,
  departmentName: name,
  quota,
  ...extra,
});
const tp = (code: string, name: string, quota: number | null, extra: Partial<ThirdPartyRow> = {}): ThirdPartyRow => ({
  schoolCode: "901",
  departmentCode: code,
  departmentName: name,
  quota,
  sourceUrl: `https://university-tw.ldkrsi.men/caac/901/${code}`,
  ...extra,
});

describe("source cross-validation", () => {
  it("marks identical rows match", () => {
    const rows = compareRows(
      [off("901001", "測試大學資訊系", 40, { requirements: { chinese: "均標" }, screeningRatios: [3] })],
      [tp("901001", "測試大學資訊系", 40, { requirements: { chinese: "均標" }, screeningRatios: [3] })],
    );
    expect(rows[0]!.verdict).toBe("match");
  });

  it("marks official-only rows missing_in_university_tw", () => {
    const rows = compareRows([off("901002", "測試戲劇系", 17)], []);
    expect(rows[0]!.verdict).toBe("missing_in_university_tw");
  });

  it("marks third-party-only rows extra_in_university_tw", () => {
    const rows = compareRows([], [tp("901003", "測試新系", 5)]);
    expect(rows[0]!.verdict).toBe("extra_in_university_tw");
  });

  it("flags quota and requirement mismatches without auto-fixing", () => {
    const rows = compareRows(
      [off("901004", "測試電機系", 35, { requirements: { chinese: "前標" } })],
      [tp("901004", "測試電機系", 30, { requirements: { chinese: "均標" } })],
    );
    expect(rows[0]!.verdict).toBe("field_mismatch");
    expect(rows[0]!.diffs.map((d) => d.field)).toContain("quota");
    expect(rows[0]!.diffs.map((d) => d.field)).toContain("requirement.chinese");
  });

  it("tolerates school-prefix renames via normalization", () => {
    const rows = compareRows([off("901005", "國立臺灣大學企管系", 30)], [tp("901005", "企管系", 30)]);
    expect(rows[0]!.verdict).toBe("match");
  });

  it("marks duplicate third-party codes ambiguous", () => {
    const rows = compareRows(
      [off("901006", "測試重複系", 10)],
      [tp("901006", "測試重複系A", 10), tp("901006", "測試重複系B", 10)],
    );
    expect(rows[0]!.verdict).toBe("ambiguous");
  });

  it("folds print-PDF radical variants (⺠ vs 民)", () => {
    const rows = compareRows([off("901008", "國立臺灣大學公⺠教育系", 5)], [tp("901008", "公民教育系", 5)]);
    expect(rows[0]!.verdict).toBe("match");
  });

  it("treats one-sided null quota as mismatch, not match", () => {
    const rows = compareRows([off("901007", "測試系", null)], [tp("901007", "測試系", 10)]);
    expect(rows[0]!.verdict).toBe("field_mismatch");
  });
});
