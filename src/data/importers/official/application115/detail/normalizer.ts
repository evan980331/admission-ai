import type { DetailRecord } from "./types";
import type { RawHistoricalInput } from "../../../../normalization/types";

/**
 * Detail -> existing canonical models (P3.7 §6, §10).
 * Reuses P2 CSV_COLUMNS shape and P3 RawHistoricalInput WITHOUT touching
 * their semantics. Detail-specific richness (per-subject multipliers, APCS,
 * second-stage items) stays in the detail JSON for P4; the P2/P3 bridge
 * carries only what those models already understand (nulls preserved).
 */

export interface P2DetailRow {
  school_code: string;
  school_name: string;
  department_code: string;
  department_name: string;
  group_name: string | null;
  quota: number | null;
  expected_screening_count: number | null;
  chinese_requirement: string | null;
  english_requirement: string | null;
  math_a_requirement: string | null;
  math_b_requirement: string | null;
  social_requirement: string | null;
  science_requirement: string | null;
  english_listening_requirement: string | null;
  screening_ratio_1: number | null;
  screening_ratio_2: number | null;
  screening_ratio_3: number | null;
  screening_score_1: string | null;
  screening_score_2: string | null;
  screening_score_3: string | null;
  final_quota: number | null;
}

const REQ_KEY: Record<string, "chinese_requirement" | "english_requirement" | "math_a_requirement" | "math_b_requirement" | "social_requirement" | "science_requirement" | "english_listening_requirement"> = {
  "國文": "chinese_requirement",
  "英文": "english_requirement",
  "數學A": "math_a_requirement",
  "數學B": "math_b_requirement",
  "社會": "social_requirement",
  "自然": "science_requirement",
  "英聽": "english_listening_requirement",
};

export function toP2Row(detail: DetailRecord): P2DetailRow {
  const row: P2DetailRow = {
    school_code: detail.schoolCode,
    school_name: detail.schoolName ?? detail.schoolCode,
    department_code: detail.departmentCode,
    department_name: detail.departmentName ?? detail.departmentCode,
    group_name: null,
    quota: detail.quota,
    expected_screening_count: detail.expectedInterviewCount,
    chinese_requirement: null,
    english_requirement: null,
    math_a_requirement: null,
    math_b_requirement: null,
    social_requirement: null,
    science_requirement: null,
    english_listening_requirement: null,
    // Detail pages list per-subject multipliers, not the numbered 1-2-3
    // screening sequence: deliberately null (see README), not invented.
    screening_ratio_1: null,
    screening_ratio_2: null,
    screening_ratio_3: null,
    screening_score_1: null,
    screening_score_2: null,
    screening_score_3: null,
    final_quota: null,
  };
  for (const s of detail.subjectRequirements) {
    const k = REQ_KEY[s.subject];
    if (k) row[k] = s.requirement;
  }
  return row;
}

/** Minimal P3 adapter: quota-carrying input row, everything else null. */
export function toP3Input(detail: DetailRecord): RawHistoricalInput {
  return {
    academicYear: detail.academicYear,
    programType: "application",
    schoolCode: detail.schoolCode,
    departmentCode: detail.departmentCode,
    departmentName: detail.departmentName,
    quota: detail.quota,
    applicants: null,
    screened: null,
    secondStage: null,
    admitted: null,
    waitlisted: null,
    minimumScore: null,
    averageScore: null,
    sourceId: null,
    dataVersion: detail.dataVersion || null,
  };
}
