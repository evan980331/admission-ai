import { identityKey } from "../../dataset/official/application115/dataset";
import type { DbAdmissionRecords } from "../../../domain/admission/toDbRecords";

export interface SqlStatement {
  text: string;
  values: unknown[];
}

export interface LoaderLookups {
  departmentId: string;
  programId: string;
  sourceId: string;
}

export interface SkippedEntry {
  key: string;
  reason: string;
}

/**
 * P1-B DB loader plan — pure statement builders (no I/O, no client).
 * Execution order (executor in scripts/load-official-admission.ts):
 *   BEGIN -> ensure source -> per entry: resolve FKs -> header UPSERT
 *   (RETURNING id) -> DELETE children -> INSERT children/schedule -> COMMIT.
 * Any failure rolls back the whole run (fail-closed). Idempotent: header
 * UPSERT by (year, department, program); children are delete+reinsert.
 */

export const DETAIL_SOURCE_NAME = "official-cac-detail";

export function lookupStatements(records: DbAdmissionRecords): SqlStatement[] {
  return [
    {
      text: `SELECT d.id FROM departments d JOIN schools s ON s.id = d.school_id WHERE s.school_code = $1 AND d.department_code = $2`,
      values: [records.header.schoolCode, records.header.departmentCode],
    },
    {
      text: `SELECT id FROM admission_programs WHERE year = $1 AND program_type = $2`,
      values: [records.header.academicYear, "application"],
    },
  ];
}

export function ensureSourceStatements(sourceName: string, dataVersion: string): SqlStatement[] {
  return [
    {
      text: `INSERT INTO data_sources (source_name, source_type, data_version) VALUES ($1, 'official', $2) ON CONFLICT (source_name, data_version) DO NOTHING`,
      values: [sourceName, dataVersion],
    },
    {
      text: `SELECT id FROM data_sources WHERE source_name = $1 AND data_version = $2`,
      values: [sourceName, dataVersion],
    },
  ];
}

export function buildHeaderUpsert(records: DbAdmissionRecords, lookups: LoaderLookups): SqlStatement {
  const r = records.header.requirements;
  return {
    text: `INSERT INTO department_admissions (year, department_id, program_id, quota, chinese_requirement, english_requirement, math_a_requirement, math_b_requirement, social_requirement, science_requirement, english_listening_requirement, screening_ratio_1, screening_ratio_2, screening_ratio_3, screening_score_1, screening_score_2, screening_score_3, final_quota, source_id, source_url, first_stage_weight, second_stage_weight) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) ON CONFLICT (year, department_id, program_id) DO UPDATE SET quota = EXCLUDED.quota, chinese_requirement = EXCLUDED.chinese_requirement, english_requirement = EXCLUDED.english_requirement, math_a_requirement = EXCLUDED.math_a_requirement, math_b_requirement = EXCLUDED.math_b_requirement, social_requirement = EXCLUDED.social_requirement, science_requirement = EXCLUDED.science_requirement, english_listening_requirement = EXCLUDED.english_listening_requirement, source_id = EXCLUDED.source_id, source_url = EXCLUDED.source_url, first_stage_weight = EXCLUDED.first_stage_weight, second_stage_weight = EXCLUDED.second_stage_weight, updated_at = now() RETURNING id`,
    values: [
      records.header.academicYear,
      lookups.departmentId,
      lookups.programId,
      records.header.quota,
      r.chinese,
      r.english,
      r.math_a,
      r.math_b,
      r.social,
      r.science,
      r.english_listening,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      lookups.sourceId,
      records.provenance.sourceUrl,
      records.firstStageWeight,
      records.secondStageWeight,
    ],
  };
}

const CHILD_TABLES = [
  "screening_subject_rules",
  "screening_sequences",
  "second_stage_items",
  "apcs_requirements",
  "review_requirements",
  "special_requirements",
  "admission_schedule",
  "admission_notices",
] as const;

export function buildChildDelete(admissionId: string): SqlStatement[] {
  return CHILD_TABLES.map((t) => ({
    text: `DELETE FROM ${t} WHERE admission_id = $1`,
    values: [admissionId],
  }));
}

export function buildChildInserts(admissionId: string, records: DbAdmissionRecords): SqlStatement[] {
  const out: SqlStatement[] = [];
  for (const s of records.subjects) {
    out.push({
      text: `INSERT INTO screening_subject_rules (admission_id, position, subject, requirement, multiplier, score_method, status, source_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      values: [admissionId, s.position, s.subject, s.requirement, s.multiplier, s.scoreMethod, s.status, s.sourceText],
    });
  }
  for (const s of records.sequences) {
    out.push({
      text: `INSERT INTO screening_sequences (admission_id, kind, position, subjects, description, source_text) VALUES ($1,$2,$3,$4,$5,$6)`,
      values: [admissionId, s.kind, s.position, s.subjects, s.description, s.sourceText],
    });
  }
  for (const s of records.secondStage) {
    out.push({
      text: `INSERT INTO second_stage_items (admission_id, position, name, requirement, weight, item_type, description, source_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      values: [admissionId, s.position, s.name, s.requirement, s.weight, s.itemType, s.description, s.sourceText],
    });
  }
  for (const a of records.apcs) {
    out.push({
      text: `INSERT INTO apcs_requirements (admission_id, position, subject, requirement, multiplier, note, source_text) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      values: [admissionId, a.position, a.subject, a.requirement, a.multiplier, a.note, a.sourceText],
    });
  }
  for (const r of records.review) {
    out.push({
      text: `INSERT INTO review_requirements (admission_id, position, category_code, category_name, required, minimum_count, maximum_count, description, restriction, source_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      values: [admissionId, r.position, r.categoryCode, r.categoryName, r.required, r.minimumCount, r.maximumCount, r.description, r.restriction, r.sourceText],
    });
  }
  for (const s of records.special) {
    out.push({
      text: `INSERT INTO special_requirements (admission_id, kind, value, source_text) VALUES ($1,$2,$3,$4)`,
      values: [admissionId, s.kind, s.value, s.sourceText],
    });
  }
  const sc = records.schedule;
  out.push({
    text: `INSERT INTO admission_schedule (admission_id, application_fee, application_fee_source, notification_date, notification_source, material_deadline, material_deadline_source, second_stage_date, second_stage_date_source, result_date, result_date_source, recheck_deadline, recheck_deadline_source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (admission_id) DO UPDATE SET application_fee = EXCLUDED.application_fee, notification_date = EXCLUDED.notification_date, material_deadline = EXCLUDED.material_deadline, second_stage_date = EXCLUDED.second_stage_date, result_date = EXCLUDED.result_date, recheck_deadline = EXCLUDED.recheck_deadline, updated_at = now()`,
    values: [admissionId, sc.applicationFee, sc.applicationFeeSource, sc.notificationDate, sc.notificationSource, sc.materialDeadline, sc.materialDeadlineSource, sc.secondStageDate, sc.secondStageDateSource, sc.resultDate, sc.resultDateSource, sc.recheckDeadline, sc.recheckDeadlineSource],
  });
  for (const n of records.notices) {
    out.push({
      text: `INSERT INTO admission_notices (admission_id, position, type, text, source_text) VALUES ($1,$2,$3,$4,$5)`,
      values: [admissionId, n.position, n.type, n.text, n.sourceText],
    });
  }
  return out;
}

/** Identity key for a DB-ready record set (dataset-compatible). */
export function recordKey(records: DbAdmissionRecords): string {
  return identityKey(records.header.academicYear, records.header.schoolCode, records.header.departmentCode);
}

export function isLoadableDetail(detail: unknown): detail is {
  academicYear: number;
  schoolCode: string;
  departmentCode: string;
} {
  if (detail === null || typeof detail !== "object") return false;
  const d = detail as Record<string, unknown>;
  return (
    typeof d["academicYear"] === "number" &&
    typeof d["schoolCode"] === "string" &&
    (d["schoolCode"] as string) !== "" &&
    typeof d["departmentCode"] === "string" &&
    (d["departmentCode"] as string) !== ""
  );
}
