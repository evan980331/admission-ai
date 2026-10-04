import {
  APTITUDE_DIMENSIONS,
  GSAT_SUBJECTS,
  TAIWAN_REGIONS,
  type AdmissionPredictionData,
  type AdmissionPredictionInput,
  type ApcsScores,
  type AptitudePreference,
  type CareerPreference,
  type DepartmentPreference,
  type GsatScores,
  type InterestPreference,
  type ListeningGrade,
  type RegionDirection,
  type RegionPreference,
  type StudentProfile,
} from "./types";

export interface DomainIssue {
  level: "error" | "warning";
  check: string;
  detail: string;
}

const err = (check: string, detail: string): DomainIssue => ({ level: "error", check, detail });
const warn = (check: string, detail: string): DomainIssue => ({ level: "warning", check, detail });

export function isValidAcademicYear(year: unknown): boolean {
  return typeof year === "number" && Number.isInteger(year) && year >= 100 && year <= 200;
}

/** GSAT 級分 0-15 (null = missing). No percentile/z-score inference here. */
export function validateGsatScores(scores: GsatScores): DomainIssue[] {
  const issues: DomainIssue[] = [];
  if (!isValidAcademicYear(scores.academicYear)) {
    issues.push(err("academic-year", `academicYear must be integer 100-200, got ${JSON.stringify(scores.academicYear)}`));
  }
  for (const subject of GSAT_SUBJECTS) {
    const v = scores[subject];
    if (v === null) {
      issues.push(warn("score-missing", `${subject} is null (missing, not 0)`));
      continue;
    }
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 15) {
      issues.push(err("score-range", `${subject} must be integer 0-15 or null, got ${JSON.stringify(v)}`));
    }
  }
  return issues;
}

export function validateListening(grade: ListeningGrade): DomainIssue[] {
  if (grade === null) return [warn("listening-missing", "listening is null (missing, not failed)")];
  if (grade === "A" || grade === "B" || grade === "C" || grade === "F") return [];
  return [err("listening-grade", `listening must be A/B/C/F or null, got ${JSON.stringify(grade)}`)];
}

export function validateApcs(scores: ApcsScores): DomainIssue[] {
  const issues: DomainIssue[] = [];
  if (!isValidAcademicYear(scores.academicYear)) {
    issues.push(err("academic-year", `academicYear must be integer 100-200, got ${JSON.stringify(scores.academicYear)}`));
  }
  for (const part of ["concept", "implementation"] as const) {
    const v = scores[part];
    if (v === null) {
      issues.push(warn("apcs-missing", `apcs.${part} is null (not taken or unknown)`));
      continue;
    }
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5) {
      issues.push(err("apcs-range", `apcs.${part} must be integer 1-5 or null, got ${JSON.stringify(v)}`));
    }
  }
  return issues;
}

/** Scores from different academic years MUST NOT be directly compared. */
export function validateSameYear(a: number, b: number, context: string): DomainIssue[] {
  if (!isValidAcademicYear(a) || !isValidAcademicYear(b)) {
    return [err("academic-year", `${context}: academicYear must be integer 100-200`)];
  }
  if (a !== b) {
    return [err("cross-year", `${context}: years ${a} and ${b} must not be directly compared`)];
  }
  return [];
}

export function validateProfile(profile: StudentProfile): DomainIssue[] {
  const issues: DomainIssue[] = [];
  if (!profile.id || profile.id.trim() === "") issues.push(err("identity", "profile id must be non-empty"));
  if (!isValidAcademicYear(profile.academicYear)) {
    issues.push(err("academic-year", `academicYear must be integer 100-200, got ${JSON.stringify(profile.academicYear)}`));
  }
  return issues;
}

function validateRankWeight(rank: number | null, weight: number | null, where: string): DomainIssue[] {
  const issues: DomainIssue[] = [];
  if (rank !== null && (!Number.isInteger(rank) || rank < 1)) {
    issues.push(err("rank", `${where}: rank must be integer >= 1 or null, got ${JSON.stringify(rank)}`));
  }
  if (weight !== null && (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 1)) {
    issues.push(err("weight", `${where}: weight must be 0-1 or null, got ${JSON.stringify(weight)}`));
  }
  return issues;
}

function validateLabel(label: string, where: string): DomainIssue[] {
  if (typeof label !== "string" || label.trim() === "") {
    return [err("label", `${where}: label must be non-empty`)];
  }
  return [];
}

export function validateRegionPreferences(prefs: RegionPreference[]): DomainIssue[] {
  const issues: DomainIssue[] = [];
  if (prefs.length === 0) {
    issues.push(warn("preference-empty", "no region preferences (ranking falls back to unfiltered)"));
    return issues;
  }
  const seen = new Map<string, RegionDirection>();
  for (const p of prefs) {
    const where = `region ${JSON.stringify(p.region)}`;
    if (!(TAIWAN_REGIONS as readonly string[]).includes(p.region)) {
      issues.push(err("region", `${where}: unknown region (expected one of ${TAIWAN_REGIONS.join("/")})`));
      continue;
    }
    if (p.direction !== "included" && p.direction !== "excluded") {
      issues.push(err("direction", `${where}: direction must be included/excluded`));
      continue;
    }
    const prev = seen.get(p.region);
    if (prev !== undefined) {
      issues.push(
        prev === p.direction
          ? err("duplicate", `${where}: duplicate ${p.direction} preference`)
          : err("include-exclude-conflict", `${where}: cannot be both included and excluded`),
      );
      continue;
    }
    seen.set(p.region, p.direction);
    issues.push(...validateRankWeight(p.rank, p.weight, where));
  }
  return issues;
}

export function validateInterestPreferences(prefs: InterestPreference[]): DomainIssue[] {
  const issues: DomainIssue[] = [];
  const seen = new Set<string>();
  for (const p of prefs) {
    issues.push(...validateLabel(p.label, "interest").map((i) => ({ ...i })));
    if (typeof p.label === "string" && p.label.trim() !== "") {
      const key = p.label.trim();
      if (seen.has(key)) issues.push(err("duplicate", `interest ${JSON.stringify(key)}: duplicate preference`));
      seen.add(key);
      issues.push(...validateRankWeight(p.rank, p.weight, `interest ${JSON.stringify(key)}`));
    }
  }
  return issues;
}

export function validateAptitudePreferences(prefs: AptitudePreference[]): DomainIssue[] {
  const issues: DomainIssue[] = [];
  const seen = new Set<string>();
  for (const p of prefs) {
    if (!(APTITUDE_DIMENSIONS as readonly string[]).includes(p.dimension)) {
      issues.push(err("aptitude", `unknown aptitude dimension ${JSON.stringify(p.dimension)} (expected one of ${APTITUDE_DIMENSIONS.join("/")})`));
      continue;
    }
    if (seen.has(p.dimension)) issues.push(err("duplicate", `aptitude ${p.dimension}: duplicate preference`));
    seen.add(p.dimension);
    issues.push(...validateRankWeight(p.rank, p.weight, `aptitude ${p.dimension}`));
  }
  return issues;
}

const CODE_6 = /^\d{6}$/;
const CODE_3 = /^\d{3}$/;

export function validateDepartmentPreferences(prefs: DepartmentPreference[]): DomainIssue[] {
  const issues: DomainIssue[] = [];
  const seenCode = new Set<string>();
  const seenRank = new Set<number>();
  for (const p of prefs) {
    const where = `department ${p.schoolCode}/${p.departmentCode}`;
    if (!CODE_3.test(p.schoolCode)) issues.push(err("department-reference", `${where}: schoolCode must be 3 digits`));
    if (!CODE_6.test(p.departmentCode)) {
      issues.push(err("department-reference", `${where}: departmentCode must be 6 digits`));
      continue;
    }
    if (seenCode.has(p.departmentCode)) issues.push(err("duplicate", `${where}: duplicate department preference`));
    seenCode.add(p.departmentCode);
    if (!Number.isInteger(p.rank) || p.rank < 1) {
      issues.push(err("rank", `${where}: rank must be integer >= 1, got ${JSON.stringify(p.rank)}`));
    } else {
      if (seenRank.has(p.rank)) issues.push(err("rank", `${where}: duplicate rank ${p.rank} (ranks must order departments)`));
      seenRank.add(p.rank);
    }
    if (p.weight !== null && (typeof p.weight !== "number" || !Number.isFinite(p.weight) || p.weight < 0 || p.weight > 1)) {
      issues.push(err("weight", `${where}: weight must be 0-1 or null`));
    }
  }
  return issues;
}

export function validateCareerPreferences(prefs: CareerPreference[]): DomainIssue[] {
  const issues: DomainIssue[] = [];
  const seen = new Set<string>();
  for (const p of prefs) {
    issues.push(...validateLabel(p.label, "career"));
    if (typeof p.label === "string" && p.label.trim() !== "") {
      const key = p.label.trim();
      if (seen.has(key)) issues.push(err("duplicate", `career ${JSON.stringify(key)}: duplicate preference`));
      seen.add(key);
      issues.push(...validateRankWeight(p.rank, p.weight, `career ${JSON.stringify(key)}`));
    }
  }
  return issues;
}

/**
 * Build the objective-only prediction input. Accepts ONLY objective parts —
 * there is no parameter slot for preferences, so they cannot leak in.
 */
export function toAdmissionPredictionInput(args: {
  academicYear: number;
  gsat: GsatScores;
  listening: ListeningGrade;
  apcs: ApcsScores;
  eligibilityContext?: Record<string, string | null>;
}): { input: AdmissionPredictionInput; issues: DomainIssue[] } {
  const issues: DomainIssue[] = [
    ...validateGsatScores(args.gsat),
    ...validateListening(args.listening),
    ...validateApcs(args.apcs),
    ...validateSameYear(args.academicYear, args.gsat.academicYear, "gsat"),
    ...validateSameYear(args.academicYear, args.apcs.academicYear, "apcs"),
  ];
  // Single internal brand assertion: the literal carries exactly the
  // objective data shape; only this factory may mint the branded input.
  const data: AdmissionPredictionData = {
    academicYear: args.academicYear,
    gsat: args.gsat,
    listening: args.listening,
    apcs: args.apcs,
    eligibilityContext: args.eligibilityContext ?? {},
  };
  const input = data as AdmissionPredictionInput;
  return { input, issues };
}
