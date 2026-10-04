import type { NormalizedScore, ScoreInput } from "./types";

/**
 * Score normalization abstraction (P3-6). No probability model here.
 *
 * Policy:
 *  - The original value is ALWAYS preserved (rawScore or grade).
 *  - percentile / normalizedScore are produced ONLY when the computation inputs
 *    exist (distribution table / mean+sd). Otherwise they stay null with the
 *    method recorded — never guessed.
 *  - Cross-year comparability is explicit: only same-year + same-method scores
 *    compare. Everything else is flagged non-comparable for P4 to adjust.
 */

export type ScoreMethod = "passthrough-grade" | "percentile-rank" | "zscore";

export interface ScoreContext {
  academicYear: number;
  method: ScoreMethod;
  /** Mean + sd required for zscore; distribution required for percentile-rank. */
  mean?: number | null;
  sd?: number | null;
  percentileLookup?: ((value: number) => number | null) | null;
}

export function normalizeScore(input: ScoreInput, ctx: ScoreContext): NormalizedScore {
  const base = {
    rawScore: input.kind === "raw" ? input.value : null,
    grade: input.kind === "grade" ? input.value : null,
    percentile: input.kind === "percentile" ? input.value : null,
    normalizedScore: input.kind === "normalized" ? input.value : null,
    normalizationMethod: ctx.method,
    academicYear: ctx.academicYear,
    comparable: false,
  };
  if (input.value === null) return base;

  switch (ctx.method) {
    case "passthrough-grade":
      return { ...base, comparable: input.kind === "grade" || input.kind === "raw" };
    case "percentile-rank": {
      if (input.kind === "percentile") return { ...base, comparable: true };
      const p = ctx.percentileLookup?.(input.value) ?? null;
      return { ...base, percentile: p, comparable: p !== null };
    }
    case "zscore": {
      if (ctx.mean === null || ctx.mean === undefined || ctx.sd === null || ctx.sd === undefined || ctx.sd === 0) {
        return base;
      }
      return { ...base, normalizedScore: (input.value - ctx.mean) / ctx.sd, comparable: true };
    }
  }
}

/** Scores compare only within the same year AND the same method. */
export function scoresComparable(a: NormalizedScore, b: NormalizedScore): boolean {
  return a.comparable && b.comparable && a.academicYear === b.academicYear && a.normalizationMethod === b.normalizationMethod;
}
