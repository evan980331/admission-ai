import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { normalizeRecords } from "./normalizer";
import { parseFile } from "./parser";
import { validateBatch } from "./validator";
import {
  ACADEMIC_YEAR_115,
  PARSER_VERSION,
  SOURCE_NAME_DEPT_RULES,
  SOURCE_URL_QUERY,
  type ImportReport,
  type NormalizedAdmission,
  type ValidationIssue,
} from "./types";

/**
 * Orchestration: PARSE -> NORMALIZE -> VALIDATE -> (dry-run preview | IMPORT) -> report.
 * - dry-run: never touches the DB (no client is even created).
 * - import: single transaction, upserts only, data_import_runs bookkeeping, rollback on fatal.
 */

export interface PipelineOptions {
  inputPath: string;
  year: number;
  dryRun: boolean;
  dataVersion: string;
  databaseUrl?: string;
  reportPath?: string;
}

export interface PipelineResult {
  report: ImportReport;
  preview: string[];
}

export const PROCESSED_DIR = path.join(
  process.cwd(),
  "data",
  "processed",
  "official",
  "115",
  "application",
);

async function checkDbDuplicates(
  client: pg.Client | pg.PoolClient,
  admissions: NormalizedAdmission[],
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  for (const a of admissions) {
    const r = await client.query(
      `SELECT 1 FROM department_admissions da
        JOIN departments d ON d.id = da.department_id
        JOIN schools s ON s.id = d.school_id
        JOIN admission_programs p ON p.id = da.program_id
       WHERE da.year = $1 AND s.school_code = $2 AND d.department_code = $3
         AND p.year = $1 AND p.program_type = 'application'`,
      [a.year, a.school_code, a.department_code],
    );
    if ((r.rowCount ?? 0) > 0) {
      issues.push({
        level: "warning",
        check: "10-no-duplicate",
        detail:
          `DB already has admission ${a.year}:${a.school_code}:${a.department_code}:application ` +
          `(will be updated, not duplicated)`,
      });
    }
  }
  return issues;
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  if (opts.year !== ACADEMIC_YEAR_115) {
    throw new Error(`P2 only supports year 115, got ${opts.year}`);
  }
  if (!fs.existsSync(opts.inputPath)) {
    throw new Error(`input file not found: ${opts.inputPath}`);
  }

  // PARSE
  const parsed = parseFile(opts.inputPath);
  const recordsRead = parsed.records.length + parsed.errors.length;

  // NORMALIZE
  const normalized = normalizeRecords(parsed.records);
  const rowIndexByAdmission = normalized.admissions.map((_, i) => i + 1);

  // VALIDATE (batch)
  const validated = validateBatch(
    normalized.schools,
    normalized.departments,
    normalized.admissions,
    rowIndexByAdmission,
  );

  const issues: ValidationIssue[] = [
    ...parsed.errors.map((e): ValidationIssue => ({
      level: "error",
      check: "11-parse",
      detail: `row ${e.rowIndex}: ${e.reason}`,
      rowIndex: e.rowIndex,
    })),
    ...normalized.errors.map((e): ValidationIssue => ({
      level: "error",
      check: "12-normalize",
      detail: `row ${e.rowIndex}: ${e.reason}`,
      rowIndex: e.rowIndex,
    })),
    ...normalized.warnings.map((w): ValidationIssue => ({ level: "warning", check: "warn", detail: w })),
    ...validated.issues,
  ];

  let inserted = 0;
  let updated = 0;

  if (!opts.dryRun) {
    const url = opts.databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set (refusing to guess; set .env.local)");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      // DB-level duplicate visibility before writing.
      issues.push(...(await checkDbDuplicates(client, validated.validAdmissions)));

      await client.query("BEGIN");
      try {
        const src = await client.query(
          `INSERT INTO data_sources (source_name, source_type, source_url, license_note, retrieved_at, parser_version, data_version)
           VALUES ($1,'official',$2,'甄選會公開招生資訊；內部統計建模用，不重新發布原始檔', now(), $3, $4)
           ON CONFLICT (source_name, data_version) DO UPDATE SET retrieved_at = now()
           RETURNING id`,
          [SOURCE_NAME_DEPT_RULES, SOURCE_URL_QUERY, PARSER_VERSION, opts.dataVersion],
        );
        const sourceId: string = src.rows[0].id;

        const run = await client.query(
          `INSERT INTO data_import_runs (source_id, academic_year, status, parser_version, data_version)
           VALUES ($1,$2,'started',$3,$4) RETURNING id`,
          [sourceId, ACADEMIC_YEAR_115, PARSER_VERSION, opts.dataVersion],
        );
        const runId: string = run.rows[0].id;

        // program row (idempotent)
        const prog = await client.query(
          `INSERT INTO admission_programs (year, program_type, name, description)
           VALUES (115,'application','大學個人申請','official 115 application')
           ON CONFLICT (year, program_type) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
        );
        const programId: string = prog.rows[0].id;

        let processed = 0;
        let errCount = 0;
        for (const s of normalized.schools) {
          await client.query(
            `INSERT INTO schools (school_code, name) VALUES ($1,$2)
             ON CONFLICT (school_code) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
            [s.school_code, s.name],
          );
        }
        const deptIds = new Map<string, string>();
        for (const d of normalized.departments) {
          const school = await client.query(`SELECT id FROM schools WHERE school_code = $1`, [
            d.school_code,
          ]);
          const r = await client.query(
            `INSERT INTO departments (school_id, department_code, name, group_name)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (school_id, department_code) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
             RETURNING id`,
            [school.rows[0].id, d.department_code, d.name, d.group_name],
          );
          deptIds.set(`${d.school_code}:${d.department_code}`, r.rows[0].id);
        }
        for (const a of validated.validAdmissions) {
          processed++;
          const deptId = deptIds.get(`${a.school_code}:${a.department_code}`);
          if (!deptId) {
            errCount++;
            issues.push({
              level: "error",
              check: "08-dept-ref",
              detail: `no department id for ${a.school_code}:${a.department_code} at import time`,
            });
            continue;
          }
          const existed = await client.query(
            `SELECT id FROM department_admissions WHERE year=$1 AND department_id=$2 AND program_id=$3`,
            [a.year, deptId, programId],
          );
          const isUpdate = (existed.rowCount ?? 0) > 0;
          await client.query(
            `INSERT INTO department_admissions
              (year, department_id, program_id, quota, chinese_requirement, english_requirement,
               math_a_requirement, math_b_requirement, social_requirement, science_requirement,
               english_listening_requirement, screening_ratio_1, screening_ratio_2, screening_ratio_3,
               screening_score_1, screening_score_2, screening_score_3, final_quota, source_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
             ON CONFLICT (year, department_id, program_id) DO UPDATE SET
               quota=EXCLUDED.quota, chinese_requirement=EXCLUDED.chinese_requirement,
               english_requirement=EXCLUDED.english_requirement, math_a_requirement=EXCLUDED.math_a_requirement,
               math_b_requirement=EXCLUDED.math_b_requirement, social_requirement=EXCLUDED.social_requirement,
               science_requirement=EXCLUDED.science_requirement,
               english_listening_requirement=EXCLUDED.english_listening_requirement,
               screening_ratio_1=EXCLUDED.screening_ratio_1, screening_ratio_2=EXCLUDED.screening_ratio_2,
               screening_ratio_3=EXCLUDED.screening_ratio_3, screening_score_1=EXCLUDED.screening_score_1,
               screening_score_2=EXCLUDED.screening_score_2, screening_score_3=EXCLUDED.screening_score_3,
               final_quota=EXCLUDED.final_quota, source_id=EXCLUDED.source_id, updated_at=now()`,
            [
              a.year, deptId, programId, a.quota, a.chinese_requirement, a.english_requirement,
              a.math_a_requirement, a.math_b_requirement, a.social_requirement, a.science_requirement,
              a.english_listening_requirement, a.screening_ratio_1, a.screening_ratio_2,
              a.screening_ratio_3, a.screening_score_1, a.screening_score_2, a.screening_score_3,
              a.final_quota, sourceId,
            ],
          );
          if (isUpdate) updated++;
          else inserted++;
        }

        const fatal = issues.filter((i) => i.level === "error").length;
        await client.query(
          `UPDATE data_import_runs SET finished_at = now(), status = $2,
             records_processed = $3, records_inserted = $4, records_updated = $5, error_count = $6
           WHERE id = $1`,
          [runId, fatal > 0 ? "partial" : "succeeded", processed, inserted, updated, fatal],
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    } finally {
      await client.end();
    }
  }

  const errorCount = issues.filter((i) => i.level === "error").length;
  const warningCount = issues.filter((i) => i.level === "warning").length;
  const report: ImportReport = {
    source: SOURCE_NAME_DEPT_RULES,
    year: ACADEMIC_YEAR_115,
    parser_version: PARSER_VERSION,
    data_version: opts.dataVersion,
    dry_run: opts.dryRun,
    records_read: recordsRead,
    records_parsed: parsed.records.length,
    records_valid: validated.validAdmissions.length,
    records_invalid: recordsRead - validated.validAdmissions.length,
    warnings: warningCount,
    errors: errorCount,
    schools: normalized.schools.length,
    departments: normalized.departments.length,
    admissions: normalized.admissions.length,
    inserted,
    updated,
    error_details: issues,
    generated_at: new Date().toISOString(),
  };
  const reportPath =
    opts.reportPath ?? path.join(PROCESSED_DIR, "import-report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const preview = [
    `schools: ${report.schools}`,
    `departments: ${report.departments}`,
    `admissions: ${report.admissions}`,
    `warnings: ${report.warnings}`,
    `errors: ${report.errors}`,
    ...(opts.dryRun ? ["mode: dry-run (no DB writes)"] : [`inserted: ${inserted}`, `updated: ${updated}`]),
  ];
  return { report, preview };
}
