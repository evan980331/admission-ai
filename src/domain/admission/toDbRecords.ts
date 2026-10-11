import type { CanonicalAdmissionDetail } from "./types";

/**
 * Canonical -> DB-ready record sets (pure, no SQL, no I/O).
 * Mirrors db/migrations/003_admission_detail.sql table-for-table, plus the
 * department_admissions header row (backward compatible: requirement TEXT
 * columns filled, screening_ratio_* stay null — superseded by
 * screening_subject_rules for the detail path, documented, never invented).
 */

const REQUIREMENT_COLUMN: Record<string, "chinese" | "english" | "math_a" | "math_b" | "social" | "science" | "english_listening"> = {
  "國文": "chinese",
  "英文": "english",
  "數學A": "math_a",
  "數學B": "math_b",
  "社會": "social",
  "自然": "science",
  "英聽": "english_listening",
};

export interface AdmissionHeaderRecord {
  academicYear: number;
  schoolCode: string;
  departmentCode: string;
  quota: number | null;
  requirements: Record<"chinese" | "english" | "math_a" | "math_b" | "social" | "science" | "english_listening", string | null>;
}

export interface DbSubjectRule {
  subject: string;
  requirement: string | null;
  multiplier: number | null;
  scoreMethod: string | null;
  status: string;
  sourceText: string;
  position: number;
}

export interface DbSequenceRule {
  kind: string;
  position: number;
  subjects: string | null;
  description: string;
  sourceText: string;
}

export interface DbSecondStageItem {
  position: number;
  name: string;
  requirement: string | null;
  weight: string | null;
  itemType: string | null;
  description: string | null;
  sourceText: string;
}

export interface DbApcsRequirement {
  position: number;
  subject: string;
  requirement: string | null;
  multiplier: number | null;
  note: string | null;
  sourceText: string;
}

export interface DbTechScreeningItem {
  position: number;
  name: string;
  requirement: string | null;
  multiplier: number | null;
  scoreMethod: string | null;
  sourceText: string;
}

export interface DbTechScreeningGroup {
  /** Raw aggregate 佔比; NULL when 1:1-attributed to second_stage or unstated. Never split. */
  weight: string | null;
  weightStatus: "shared" | "attributed_to_stage2" | "unstated";
  items: DbTechScreeningItem[];
  sourceText: string;
}

export interface DbReviewRequirement {
  position: number;
  categoryCode: string | null;
  categoryName: string | null;
  required: string | null;
  minimumCount: number | null;
  maximumCount: number | null;
  description: string | null;
  restriction: string | null;
  sourceText: string;
}

export interface DbSpecialRequirement {
  kind: string;
  value: string | null;
  sourceText: string | null;
}

export interface DbSchedule {
  applicationFee: number | null;
  applicationFeeSource: string | null;
  notificationDate: string | null;
  notificationSource: string | null;
  materialDeadline: string | null;
  materialDeadlineSource: string | null;
  secondStageDate: string | null;
  secondStageDateSource: string | null;
  resultDate: string | null;
  resultDateSource: string | null;
  recheckDeadline: string | null;
  recheckDeadlineSource: string | null;
}

export interface DbNotice {
  position: number;
  type: string;
  text: string;
  sourceText: string;
}

export interface DbAdmissionRecords {
  header: AdmissionHeaderRecord;
  firstStageWeight: string | null;
  secondStageWeight: string | null;
  subjects: DbSubjectRule[];
  sequences: DbSequenceRule[];
  secondStage: DbSecondStageItem[];
  apcs: DbApcsRequirement[];
  review: DbReviewRequirement[];
  special: DbSpecialRequirement[];
  schedule: DbSchedule;
  notices: DbNotice[];
  /** Arts-variant tech block; null when absent or content-free. */
  techGroup: DbTechScreeningGroup | null;
  provenance: CanonicalAdmissionDetail["provenance"];
}

export function toDbRecords(canonical: CanonicalAdmissionDetail): DbAdmissionRecords {
  const requirements: AdmissionHeaderRecord["requirements"] = {
    chinese: null,
    english: null,
    math_a: null,
    math_b: null,
    social: null,
    science: null,
    english_listening: null,
  };
  for (const s of canonical.firstStage.subjectRules) {
    const col = REQUIREMENT_COLUMN[s.subject];
    if (col) requirements[col] = s.requirement;
  }
  return {
    header: {
      academicYear: canonical.identity.academicYear,
      schoolCode: canonical.identity.schoolCode,
      departmentCode: canonical.identity.departmentCode,
      quota: canonical.identity.quota,
      requirements,
    },
    firstStageWeight: canonical.firstStage.overallWeight,
    secondStageWeight: canonical.secondStage.overallWeight,
    subjects: canonical.firstStage.subjectRules.map((s) => ({
      subject: s.subject,
      requirement: s.requirement,
      multiplier: s.multiplier,
      scoreMethod: s.scoreMethod,
      status: s.status,
      sourceText: s.sourceText,
      position: s.position,
    })),
    sequences: canonical.firstStage.sequences.map((s) => ({
      kind: s.kind,
      position: s.position,
      subjects: s.subjects ? s.subjects.join("、") : null,
      description: s.description,
      sourceText: s.sourceText,
    })),
    secondStage: canonical.secondStage.items.map((s) => ({
      position: s.position,
      name: s.name,
      requirement: s.requirement,
      weight: s.weight,
      itemType: s.itemType,
      description: s.description,
      sourceText: s.sourceText,
    })),
    apcs: (canonical.apcs ?? []).map((a) => ({
      position: a.position,
      subject: a.subject,
      requirement: a.requirement,
      multiplier: a.multiplier,
      note: a.note,
      sourceText: a.sourceText,
    })),
    review: canonical.reviewRequirements.map((r) => ({
      position: r.position,
      categoryCode: r.categoryCode,
      categoryName: r.categoryName,
      required: r.required,
      minimumCount: r.minimumCount,
      maximumCount: r.maximumCount,
      description: r.description,
      restriction: r.restriction,
      sourceText: r.sourceText,
    })),
    special: canonical.specialRequirements.map((s) => ({ kind: s.kind, value: s.value, sourceText: s.sourceText })),
    schedule: {
      applicationFee: canonical.schedule.applicationFee,
      applicationFeeSource: canonical.schedule.applicationFeeSource,
      notificationDate: canonical.schedule.notification.date,
      notificationSource: canonical.schedule.notification.sourceText,
      materialDeadline: canonical.schedule.materialDeadline.date,
      materialDeadlineSource: canonical.schedule.materialDeadline.sourceText,
      secondStageDate: canonical.schedule.secondStageDate.date,
      secondStageDateSource: canonical.schedule.secondStageDate.sourceText,
      resultDate: canonical.schedule.resultDate.date,
      resultDateSource: canonical.schedule.resultDate.sourceText,
      recheckDeadline: canonical.schedule.recheckDeadline.date,
      recheckDeadlineSource: canonical.schedule.recheckDeadline.sourceText,
    },
    notices: canonical.notices.map((n) => ({ position: n.position, type: n.type, text: n.text, sourceText: n.sourceText })),
    techGroup: canonical.techScreening
      ? {
          weight: canonical.techScreening.weight,
          weightStatus: canonical.techScreening.weightStatus,
          items: canonical.techScreening.items.map((t) => ({
            position: t.position,
            name: t.name,
            requirement: t.requirement,
            multiplier: t.multiplier,
            scoreMethod: t.scoreMethod,
            sourceText: t.sourceText,
          })),
          sourceText: canonical.techScreening.sourceText,
        }
      : null,
    provenance: canonical.provenance,
  };
}
