/**
 * P1-A Student / Preference domain — types only, no model, no probability.
 *
 * Hard boundary (see p1-reset.md R1-R4):
 * - Objective data (scores, listening, APCS) feeds `AdmissionPredictionInput`
 *   — the ONLY input shape a future prediction engine may accept.
 * - Preference data (regions, interests, aptitudes, department/career
 *   preferences) feeds `PreferenceRankingInput` and NOTHING else.
 * The two are branded so neither is assignable to the other; a combined
 * `VolunteerContext` keeps both side by side but never merges them into
 * a single score.
 */

/** ROC academic year, e.g. 115. Same 100-200 range as the DB schema. */
export type AcademicYear = number;

export interface StudentProfile {
  id: string;
  academicYear: AcademicYear;
  displayName: string | null;
  /** Current school name (free text, self-reported). */
  schoolName: string | null;
  /** Track/group, e.g. 一類/二類/三類 (free text, self-reported). */
  track: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GSAT subjects. Each level is 0-15 when known; null = missing/unknown (never 0-filled). */
export type GsatSubject = "chinese" | "english" | "mathA" | "mathB" | "social" | "science";
export const GSAT_SUBJECTS: readonly GsatSubject[] = ["chinese", "english", "mathA", "mathB", "social", "science"];

export type GsatLevel = number | null;

export interface GsatScores {
  academicYear: AcademicYear;
  chinese: GsatLevel;
  english: GsatLevel;
  mathA: GsatLevel;
  mathB: GsatLevel;
  social: GsatLevel;
  science: GsatLevel;
}

/** GSAT English listening bands (no D/E bands exist). null = missing/unknown. */
export type ListeningGrade = "A" | "B" | "C" | "F" | null;

/** APCS levels 1-5 per part. null = not taken/unknown. */
export interface ApcsScores {
  academicYear: AcademicYear;
  concept: number | null;
  implementation: number | null;
}

export const TAIWAN_REGIONS = ["北部", "中部", "南部", "東部", "離島"] as const;
export type TaiwanRegion = (typeof TAIWAN_REGIONS)[number];

export type RegionDirection = "included" | "excluded";

export interface RegionPreference {
  region: string;
  direction: RegionDirection;
  rank: number | null;
  /** 0-1 inclusive. null = unweighted. */
  weight: number | null;
}

export interface InterestPreference {
  /** Free label, must be non-empty. */
  label: string;
  rank: number | null;
  weight: number | null;
}

export const APTITUDE_DIMENSIONS = ["語文", "數理", "空間", "藝術", "體能", "社交", "領導", "實作"] as const;
export type AptitudeDimension = (typeof APTITUDE_DIMENSIONS)[number];

export interface AptitudePreference {
  dimension: string;
  rank: number | null;
  weight: number | null;
}

export interface DepartmentPreference {
  schoolCode: string;
  departmentCode: string;
  rank: number;
  weight: number | null;
}

export interface CareerPreference {
  label: string;
  rank: number | null;
  weight: number | null;
}

declare const objectiveBrand: unique symbol;
declare const preferenceBrand: unique symbol;

/**
 * Objective-only input for admission prediction.
 * A future engine MUST accept exactly this shape — preference fields
 * cannot be added here without breaking the brand. Build it only via
 * `toAdmissionPredictionInput` (validation.ts), which owns the single
 * internal brand assertion.
 */
export interface AdmissionPredictionData {
  academicYear: AcademicYear;
  gsat: GsatScores;
  listening: ListeningGrade;
  apcs: ApcsScores;
  /** Hard-rule context only (e.g. gender requirement, special quotas). Never preferences. */
  eligibilityContext: Record<string, string | null>;
}

export interface AdmissionPredictionInput extends AdmissionPredictionData {
  readonly [objectiveBrand]: true;
}

/**
 * Preference-only input for ranking. MUST NEVER be assignable to
 * (or embedded in) AdmissionPredictionInput.
 */
export interface PreferenceRankingInput {
  readonly [preferenceBrand]: unique symbol;
  regions: RegionPreference[];
  interests: InterestPreference[];
  aptitudes: AptitudePreference[];
  departmentPreferences: DepartmentPreference[];
  careerInterests: CareerPreference[];
}

/**
 * Holds both inputs for volunteer optimization WITHOUT merging them.
 * Consumers must present prediction-side and preference-side results
 * separately (p1-reset.md R2/R4) — never a single combined score.
 */
export interface VolunteerContext {
  prediction: AdmissionPredictionInput;
  preference: PreferenceRankingInput;
}
