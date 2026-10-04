import { describe, expect, it } from "vitest";
import { normalizeScore, scoresComparable } from "../src/data/normalization/normalize-score";
import { computeScoreGap } from "../src/data/normalization/score-gap";

describe("score normalization", () => {
  it("preserves the original value and method", () => {
    const s = normalizeScore({ kind: "grade", value: 13 }, { academicYear: 115, method: "passthrough-grade" });
    expect(s.grade).toBe(13);
    expect(s.rawScore).toBeNull();
    expect(s.normalizationMethod).toBe("passthrough-grade");
  });

  it("keeps percentile null when no distribution exists (never guessed)", () => {
    const s = normalizeScore({ kind: "grade", value: 13 }, { academicYear: 115, method: "percentile-rank" });
    expect(s.percentile).toBeNull();
    expect(s.comparable).toBe(false);
  });

  it("computes percentile only with an explicit lookup", () => {
    const s = normalizeScore(
      { kind: "grade", value: 13 },
      { academicYear: 115, method: "percentile-rank", percentileLookup: (v) => (v >= 13 ? 88 : null) },
    );
    expect(s.percentile).toBe(88);
  });

  it("computes zscore only with mean+sd", () => {
    const ok = normalizeScore({ kind: "raw", value: 52 }, { academicYear: 114, method: "zscore", mean: 50, sd: 2 });
    expect(ok.normalizedScore).toBe(1);
    const missing = normalizeScore({ kind: "raw", value: 52 }, { academicYear: 114, method: "zscore" });
    expect(missing.normalizedScore).toBeNull();
  });

  it("never compares raw scores across years", () => {
    const a = normalizeScore({ kind: "grade", value: 13 }, { academicYear: 114, method: "passthrough-grade" });
    const b = normalizeScore({ kind: "grade", value: 13 }, { academicYear: 115, method: "passthrough-grade" });
    expect(scoresComparable(a, b)).toBe(false);
  });
});

describe("score gap (deterministic feature only)", () => {
  it("candidate > threshold -> positive", () => {
    expect(computeScoreGap(1.5, 0.5)).toBeCloseTo(1.0);
  });
  it("candidate = threshold -> 0", () => {
    expect(computeScoreGap(0.5, 0.5)).toBe(0);
  });
  it("candidate < threshold -> negative", () => {
    expect(computeScoreGap(-1, 0.5)).toBeCloseTo(-1.5);
  });
  it("missing threshold -> null (never 0)", () => {
    expect(computeScoreGap(1.2, null)).toBeNull();
    expect(computeScoreGap(null, 0.5)).toBeNull();
    expect(computeScoreGap(undefined, undefined)).toBeNull();
  });
});
