/** Predicter prediction interfaces — P1 stage: types only, no model implementation. */

export type ProgramType = "application" | "stars" | "distribution" | "tech_application";
export type ExamType = "gsat" | "ast" | "tve";

export interface PredictionInput {
  academicYear: number;
  programType: ProgramType;
  examType: ExamType;
  departmentId: string;
  /** e.g. { chinese: 13, english: 14, mathA: 12, ... } — 級分制，依 examType 而定 */
  subjectLevels: Record<string, number>;
  /** 當年度行為訊號（未來用，現階段可為空） */
  currentYearHeat?: number;
}

export interface PredictionFeatures {
  scoreGap: number | null;
  historicalPercentile: number | null;
  quotaChange: number | null;
  competitionChange: number | null;
  screeningRatio: number | null;
  screeningThreshold: number | null;
  currentYearHeat: number | null;
}

export interface PredictionOutput {
  pFirstStagePass: number | null;
  pSecondStagePass: number | null;
  pFinalAdmission: number | null;
  modelVersion: string;
  dataVersion: string;
  warnings: string[];
}

export interface PredictionModelVersion {
  id: string;
  name: string;
  version: string;
  description: string;
  trainingDataVersion: string;
}
