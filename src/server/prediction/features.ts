import type { PredictionFeatures, PredictionInput } from "./types";

/**
 * Feature builder placeholder.
 * P1: 只定義欄位，不實作真正統計邏輯。
 * 未來特徵: score_gap / historical_percentile / quota_change /
 * competition_change / screening_ratio / screening_threshold / current_year_heat
 */
export function buildPlaceholderFeatures(input: Partial<PredictionInput>): PredictionFeatures {
  return {
    scoreGap: null,
    historicalPercentile: null,
    quotaChange: null,
    competitionChange: null,
    screeningRatio: null,
    screeningThreshold: null,
    currentYearHeat: input.currentYearHeat ?? null,
  };
}
