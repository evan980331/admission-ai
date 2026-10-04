import type { PredictionInput, PredictionModelVersion, PredictionOutput } from "./types";
import { buildPlaceholderFeatures } from "./features";

export const PLACEHOLDER_MODEL: PredictionModelVersion = {
  id: "placeholder-v0",
  name: "placeholder",
  version: "v0.0.0",
  description: "Interface-only model. MUST NOT be used to claim admission probability.",
  trainingDataVersion: "none",
};

/**
 * 預留預測介面。現階段一律回傳 null 機率 + 明確警告，
 * 防止任何人把測試資料／佔位邏輯當成正式預測。
 */
export function predictPlaceholder(
  input: PredictionInput,
  model: PredictionModelVersion = PLACEHOLDER_MODEL,
): PredictionOutput {
  void buildPlaceholderFeatures(input);
  return {
    pFirstStagePass: null,
    pSecondStagePass: null,
    pFinalAdmission: null,
    modelVersion: `${model.name}@${model.version}`,
    dataVersion: model.trainingDataVersion,
    warnings: [
      "P1 基礎建設階段：不提供錄取機率，模型尚未實作。",
      "禁止將測試資料當成正式資料或宣稱預測準確率。",
    ],
  };
}
