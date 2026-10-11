import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import dotenv from "dotenv";
import { parseDetailHtml } from "../src/data/importers/official/application115/detail/parser";
import { auditCanonicalCompleteness } from "../src/domain/admission/validation";
import { fromDetailRecord } from "../src/domain/admission/fromDetail";
import { toDbRecords } from "../src/domain/admission/toDbRecords";
import { executeDbLoad } from "../src/data/loaders/official/admission";
import {
  P4_DATA_VERSION,
  P4_PARSER_VERSION,
  P4_SOURCE_DATA_VERSION,
  P4_SOURCE_NAME,
  corroborateTechRow,
  diffDbRecords,
  findDroppedGsatCells,
  normalizeBatch,
  resolveExpectedTotal,
  summarizeCorroboration,
  type DbSourcedAdmission,
  type NormIssue,
  type TechCorroboration,
} from "../src/data/normalization/admission115";
import { buildInventory, PDF_FILES } from "../src/data/discovery/official/application115/pdf-inventory";

dotenv.config({ path: ".env.local" });
dotenv.config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * P4 admission-115 normalization / reconciliation.
 * SOURCE = canonical DB rows (P3 output) + P3 raw HTML re-parse for
 * verification only (never re-fetched, never rewritten).
 * Default = dry-run (read-only). `--import` additionally reconciles any
 * drifted rows via the existing idempotent loader and books a
 * data_import_runs row. No migration, no schema change, no manual INSERTs
 * of admission data, no destructive SQL.
 */
async function main() {
  const schoolFilter = arg("--school");
  const deptFilter = arg("--department");
  const doImport = process.argv.includes("--import");
  if (schoolFilter !== undefined && !/^\d{3}$/.test(schoolFilter)) {
    console.error("--school must be 3 digits");
    process.exit(2);
  }
  if (deptFilter !== undefined && !/^\d{6}$/.test(deptFilter)) {
    console.error("--department must be 6 digits");
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
  }

  // Expected scope is derived from the approved PDF inventory (64 schools),
  // never from the frozen 10-school table: department filter -> 1; school
  // filter -> that school's inventory count (unknown schools exit 2);
  // no filter -> whole-inventory total. The count gate itself is unchanged.
  const rawRoot = path.join(process.cwd(), "data", "raw", "official", "115", "application");
  const pdfTexts: Record<string, string> = {};
  for (const [school, file] of Object.entries(PDF_FILES)) {
    pdfTexts[school] = fs.readFileSync(path.join(rawRoot, file), "latin1");
  }
  const inventory = buildInventory(pdfTexts);
  const perSchool = new Map<string, number>();
  for (const e of inventory) perSchool.set(e.schoolCode, (perSchool.get(e.schoolCode) ?? 0) + 1);
  let expectedTotal: number;
  try {
    expectedTotal = resolveExpectedTotal(
      { schoolCode: schoolFilter, departmentCode: deptFilter },
      { total: inventory.length, perSchool },
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // ---- SOURCE: canonical DB rows + children (bulk, read-only) ----
    const headerSql = `SELECT a.year, s.school_code, s.name AS school_name, d.department_code, d.name AS dept_name,
        d.group_name, ap.program_type, a.quota, a.chinese_requirement, a.english_requirement,
        a.math_a_requirement, a.math_b_requirement, a.social_requirement, a.science_requirement,
        a.english_listening_requirement, a.source_url, a.first_stage_weight, a.second_stage_weight,
        ds.source_name, ds.data_version
      FROM department_admissions a
      JOIN departments d ON d.id = a.department_id
      JOIN schools s ON s.id = d.school_id
      JOIN admission_programs ap ON ap.id = a.program_id
      LEFT JOIN data_sources ds ON ds.id = a.source_id
      WHERE a.year = 115
        ${schoolFilter ? "AND s.school_code = $1" : ""}
        ${deptFilter ? `AND d.department_code = $${schoolFilter ? 2 : 1}` : ""}
      ORDER BY s.school_code, d.department_code`;
    const h = await client.query(headerSql, [...(schoolFilter ? [schoolFilter] : []), ...(deptFilter ? [deptFilter] : [])]);
    const rows: DbSourcedAdmission[] = h.rows.map((r) => ({
      year: r.year, schoolCode: r.school_code, schoolName: r.school_name, departmentCode: r.department_code,
      departmentName: r.dept_name, groupName: r.group_name, programType: r.program_type, quota: r.quota,
      requirements: { chinese: r.chinese_requirement, english: r.english_requirement, math_a: r.math_a_requirement, math_b: r.math_b_requirement, social: r.social_requirement, science: r.science_requirement, english_listening: r.english_listening_requirement },
      sourceUrl: r.source_url, firstStageWeight: r.first_stage_weight, secondStageWeight: r.second_stage_weight,
      sourceName: r.source_name, dataVersion: r.data_version,
      children: { subjects: [], sequences: [], secondStage: [], apcs: [], review: [], special: [], schedule: null, notices: [], techGroup: null, techItems: [] },
    }));
    const byCode = new Map(rows.map((r) => [r.departmentCode, r]));
    const scope = schoolFilter ? "AND s.school_code = $1" : deptFilter ? "AND d.department_code = $1" : "";
    const scopeParams = schoolFilter ? [schoolFilter] : deptFilter ? [deptFilter] : [];
    const childQ = async (sql: string) => (await client.query(sql, scopeParams)).rows;
    for (const r of await childQ(`SELECT d.department_code AS code, position, subject, requirement, multiplier, score_method AS "scoreMethod", status, source_text AS "sourceText" FROM screening_subject_rules x JOIN department_admissions a ON a.id = x.admission_id JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE a.year = 115 ${scope} ORDER BY 1, position`)) byCode.get(r.code)?.children.subjects.push(r);
    for (const r of await childQ(`SELECT d.department_code AS code, kind, position, subjects, description, source_text AS "sourceText" FROM screening_sequences x JOIN department_admissions a ON a.id = x.admission_id JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE a.year = 115 ${scope} ORDER BY 1, kind, position`)) byCode.get(r.code)?.children.sequences.push(r);
    for (const r of await childQ(`SELECT d.department_code AS code, x.position, x.name, requirement, weight, item_type AS "itemType", description, source_text AS "sourceText" FROM second_stage_items x JOIN department_admissions a ON a.id = x.admission_id JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE a.year = 115 ${scope} ORDER BY 1, position`)) byCode.get(r.code)?.children.secondStage.push(r);
    for (const r of await childQ(`SELECT d.department_code AS code, position, subject, requirement, multiplier, note, source_text AS "sourceText" FROM apcs_requirements x JOIN department_admissions a ON a.id = x.admission_id JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE a.year = 115 ${scope} ORDER BY 1, position`)) byCode.get(r.code)?.children.apcs.push(r);
    for (const r of await childQ(`SELECT d.department_code AS code, position, category_code AS "categoryCode", category_name AS "categoryName", required, minimum_count AS "minimumCount", maximum_count AS "maximumCount", description, restriction, source_text AS "sourceText" FROM review_requirements x JOIN department_admissions a ON a.id = x.admission_id JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE a.year = 115 ${scope} ORDER BY 1, position`)) byCode.get(r.code)?.children.review.push(r);
    for (const r of await childQ(`SELECT d.department_code AS code, kind, value, source_text AS "sourceText" FROM special_requirements x JOIN department_admissions a ON a.id = x.admission_id JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE a.year = 115 ${scope} ORDER BY 1, kind`)) byCode.get(r.code)?.children.special.push(r);
    for (const r of await childQ(`SELECT d.department_code AS code, application_fee AS "applicationFee", application_fee_source AS "applicationFeeSource", notification_date AS "notificationDate", notification_source AS "notificationSource", material_deadline AS "materialDeadline", material_deadline_source AS "materialDeadlineSource", second_stage_date AS "secondStageDate", second_stage_date_source AS "secondStageDateSource", result_date AS "resultDate", result_date_source AS "resultDateSource", recheck_deadline AS "recheckDeadline", recheck_deadline_source AS "recheckDeadlineSource" FROM admission_schedule x JOIN department_admissions a ON a.id = x.admission_id JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE a.year = 115 ${scope}`)) {
      const t = byCode.get(r.code);
      if (t) {
        const { code: _c, ...rest } = r;
        t.children.schedule = rest;
      }
    }
    for (const r of await childQ(`SELECT d.department_code AS code, position, type, text, source_text AS "sourceText" FROM admission_notices x JOIN department_admissions a ON a.id = x.admission_id JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE a.year = 115 ${scope} ORDER BY 1, position`)) byCode.get(r.code)?.children.notices.push(r);
    // Tech tables (migration 006). Guarded: pre-migration DBs lack them and
    // must not break the read path; absence simply yields no tech rows.
    const techTables = await client.query(`SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('tech_screening_groups','tech_screening_items')`);
    const hasTech = Number(techTables.rows[0]?.c ?? 0) === 2;
    if (hasTech) {
      for (const r of await childQ(`SELECT d.department_code AS code, g.weight, g.weight_status AS "weightStatus", g.source_text AS "sourceText", g.admission_id AS "admissionId" FROM tech_screening_groups g JOIN department_admissions a ON a.id = g.admission_id JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE a.year = 115 ${scope}`)) {
        const t = byCode.get(r.code);
        if (t) {
          const { code: _c, ...rest } = r;
          t.children.techGroup = rest;
        }
      }
      for (const r of await childQ(`SELECT d.department_code AS code, i.position, i.name, i.requirement, i.multiplier, i.score_method AS "scoreMethod", i.source_text AS "sourceText", i.admission_id AS "itemAdmission", g.admission_id AS "groupAdmission" FROM tech_screening_items i JOIN tech_screening_groups g ON g.id = i.group_id JOIN department_admissions a ON a.id = g.admission_id JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE a.year = 115 ${scope} ORDER BY 1, position`)) byCode.get(r.code)?.children.techItems.push(r);
    } else {
      console.log("note: tech_screening tables absent (pre-006 DB); tech checks skipped");
    }

    console.log("P4 Admission-115 Normalization");
    console.log(`Source records: ${rows.length} (expected ${expectedTotal})`);
    if (rows.length !== expectedTotal) {
      console.error(`SOURCE COUNT GATE FAILED: got ${rows.length}, expected ${expectedTotal} — stopping, no import`);
      await client.end();
      process.exit(1);
    }

    // ---- NORMALIZE + VALIDATE ----
    const { records, issues, summary } = normalizeBatch(rows);

    // ---- CROSS-CHECK vs P3 raw re-parse (verification only) ----
    const rawDir = path.join(process.cwd(), "data", "raw", "official", "115", "application", "departments");
    const xcheck: NormIssue[] = [];
    const techCorroborations: TechCorroboration[] = [];
    // Source-proven empty notices (e.g. 101022): the re-parse proves the
    // 備註 section exists but holds no text, so a normalize "notices"
    // error for that row is demoted to a warning WITH evidence. The rule
    // itself is untouched (still error by default); only proven-empty rows
    // qualify, one identity at a time.
    const emptyNoticesKeys = new Set<string>();
    let reparseFailed = 0;
    const coroArgs = (over: Partial<Parameters<typeof corroborateTechRow>[0]>): Parameters<typeof corroborateTechRow>[0] => ({
      identityKey: "",
      rawExists: false,
      reparseOk: false,
      dbSubjects: 0,
      dbTechItems: 0,
      reparseTechItems: 0,
      droppedGsatCells: [],
      dbTechTablesPresent: hasTech,
      ...over,
    });
    for (const row of rows) {
      const key = `${row.year}|${row.schoolCode}|${row.departmentCode}|${row.programType}`;
      const file = path.join(rawDir, `115_${row.departmentCode}.htm`);
      const dbSubjects = row.children.subjects.length;
      const dbTechItems = row.children.techItems.length;
      if (!fs.existsSync(file)) {
        xcheck.push({ level: "error", check: "raw-missing", detail: `${key}: raw file absent`, identityKey: key });
        techCorroborations.push(corroborateTechRow(coroArgs({ identityKey: key, dbSubjects, dbTechItems })));
        continue;
      }
      try {
        const html = fs.readFileSync(file, "utf8");
        const parsed = parseDetailHtml(html, { sourceUrl: row.sourceUrl ?? `local-file:115_${row.departmentCode}.htm`, dataVersion: "p4-crosscheck" });
        const recErrors = parsed.issues.filter((i) => i.level === "error");
        if (!parsed.record || recErrors.length > 0) {
          reparseFailed++;
          xcheck.push({ level: "error", check: "raw-reparse", detail: `${key}: re-parse failed`, identityKey: key });
          techCorroborations.push(corroborateTechRow(coroArgs({ identityKey: key, rawExists: true, dbSubjects, dbTechItems })));
          continue;
        }
        const { canonical, issues: convIssues } = fromDetailRecord(parsed.record);
        const canonErrors = [...convIssues, ...auditCanonicalCompleteness(parsed.record, canonical)].filter((i) => i.level === "error");
        if (canonErrors.length > 0) {
          reparseFailed++;
          xcheck.push({ level: "error", check: "raw-revalidate", detail: `${key}: re-validate failed`, identityKey: key });
          techCorroborations.push(corroborateTechRow(coroArgs({ identityKey: key, rawExists: true, dbSubjects, dbTechItems })));
          continue;
        }
        // Pure-tech corroboration (P4.1d): subjects==0 + tech items is only
        // pure-tech if raw shows no substantive GSAT cells. Anything beyond
        // bare `--`/empty (composites included) means a real subject may have
        // been dropped -> error, never silent pure-tech.
        const dropped = findDroppedGsatCells(parsed.record.unmapped ?? []);
        if (dbSubjects === 0 && dbTechItems > 0 && dropped.length > 0) {
          xcheck.push({ level: "error", check: "tech-unmapped-subject", detail: `${key}: substantive GSAT-looking cells unmapped (${dropped.join(" / ").slice(0, 200)}); not verifiable as pure-tech`, identityKey: key });
        }
        if ((parsed.record.unmapped ?? []).some((u) => u === "notes section present but empty (no published notices)")) {
          emptyNoticesKeys.add(key);
        }
        techCorroborations.push(corroborateTechRow(coroArgs({
          identityKey: key,
          rawExists: true,
          reparseOk: true,
          dbSubjects,
          dbTechItems,
          reparseTechItems: parsed.record.techScreening?.items.length ?? 0,
          droppedGsatCells: dropped,
        })));
        const expected = toDbRecords(canonical);
        for (const d of diffDbRecords(key, expected, row)) xcheck.push({ level: "error", check: "db-raw-drift", detail: d, identityKey: key });
      } catch (err) {
        reparseFailed++;
        xcheck.push({ level: "error", check: "raw-reparse", detail: `${key}: ${err instanceof Error ? err.message : err}`, identityKey: key });
        techCorroborations.push(corroborateTechRow(coroArgs({ identityKey: key, rawExists: true, dbSubjects, dbTechItems })));
      }
    }
    const techCoro = summarizeCorroboration(techCorroborations);

    const allIssues = [...issues, ...xcheck].map((i) =>
      i.level === "error" && i.check === "notices" && i.identityKey !== undefined && emptyNoticesKeys.has(i.identityKey)
        ? { ...i, level: "warning" as const, check: "notices-empty-source", detail: `${i.detail} [source 備註 section present-but-empty; kept as warning with evidence, rule not relaxed globally]` }
        : i,
    );
    const demotedCount = [...issues, ...xcheck].filter(
      (i) => i.level === "error" && i.check === "notices" && i.identityKey !== undefined && emptyNoticesKeys.has(i.identityKey),
    ).length;
    if (demotedCount > 0) console.log(`notices-empty-source demotions: ${demotedCount} (evidence-gated, see warnings)`);
    const errors = allIssues.filter((i) => i.level === "error");
    const warnings = allIssues.filter((i) => i.level === "warning");
    console.log(`normalized: ${summary.normalized}/${summary.total}`);
    console.log(`validation: ${errors.length} errors, ${warnings.length} warnings (reparse-failed=${reparseFailed})`);
    console.log(`child totals: ${JSON.stringify(summary.childTotals)}`);
    console.log(`per-school: ${JSON.stringify(summary.perSchool)}`);
    console.log(`tech corroboration: verified=${techCoro.counts.verified} failed=${techCoro.counts.failed} not_checked=${techCoro.counts.not_checked} not_applicable=${techCoro.counts.not_applicable}`);
    console.log(`tech corroboration coverage (applicable only): verified=${techCoro.counts.verified}/${techCoro.counts.verified + techCoro.counts.failed + techCoro.counts.not_checked}`);
    if (techCoro.identifiers.verified.length > 0) console.log(`tech corroborated: ${techCoro.identifiers.verified.join(", ")}`);
    if (techCoro.identifiers.failed.length > 0) console.log(`tech corroboration failed: ${techCoro.identifiers.failed.join(", ")}`);
    if (techCoro.identifiers.not_checked.length > 0) console.log(`tech not checked: ${techCoro.identifiers.not_checked.join(", ")}`);
    if (summary.duplicateKeys.length > 0) console.log(`duplicate keys: ${summary.duplicateKeys.join(", ")}`);
    for (const e of errors.slice(0, 20)) console.log(`ERROR ${e.check}: ${e.detail}`);
    if (errors.length > 20) console.log(`... and ${errors.length - 20} more errors`);

    const report = {
      mode: doImport ? "import" : "dry-run",
      parser_version: P4_PARSER_VERSION,
      data_version: P4_DATA_VERSION,
      expectedTotal,
      summary,
      errors: errors.length,
      warnings: warnings.length,
      error_details: allIssues,
      tech_corroboration: {
        counts: techCoro.counts,
        identifiers: techCoro.identifiers,
      },
      generated_at: new Date().toISOString(),
    };

    // ---- IMPORT (reconcile-only; skips identical rows) ----
    let reconciled = 0;
    let verifiedUnchanged = 0;
    let runId: string | null = null;
    if (doImport) {
      if (errors.length > 0) {
        console.error(`IMPORT BLOCKED: ${errors.length} errors — fix pipeline, no writes performed`);
        await client.end();
        process.exit(1);
      }
      const src = await client.query(`SELECT id FROM data_sources WHERE source_name = $1 AND data_version = $2`, [P4_SOURCE_NAME, P4_SOURCE_DATA_VERSION]);
      if (src.rows.length === 0) throw new Error(`P3 source row missing (${P4_SOURCE_NAME}/${P4_SOURCE_DATA_VERSION}); refusing to invent provenance`);
      const sourceId: string = src.rows[0].id;
      await client.query("BEGIN");
      try {
        const run = await client.query(
          `INSERT INTO data_import_runs (source_id, academic_year, status, parser_version, data_version) VALUES ($1,115,'started',$2,$3) RETURNING id`,
          [sourceId, P4_PARSER_VERSION, P4_DATA_VERSION],
        );
        runId = run.rows[0].id as string;
        for (const row of rows) {
          const html = fs.readFileSync(path.join(rawDir, `115_${row.departmentCode}.htm`), "utf8");
          const parsed = parseDetailHtml(html, { sourceUrl: row.sourceUrl ?? `local-file:115_${row.departmentCode}.htm`, dataVersion: "p4-reconcile" });
          if (!parsed.record) throw new Error(`re-parse failed for ${row.departmentCode} at import time`);
          const { canonical } = fromDetailRecord(parsed.record);
          const recs = toDbRecords(canonical);
          if (diffDbRecords(`${row.year}|${row.schoolCode}|${row.departmentCode}|${row.programType}`, recs, row).length === 0) {
            verifiedUnchanged++;
            continue;
          }
          await executeDbLoad(client, recs, { sourceName: P4_SOURCE_NAME, dataVersion: P4_SOURCE_DATA_VERSION, departmentName: row.departmentName, ensureDepartmentMaster: true });
          reconciled++;
        }
        await client.query(
          `UPDATE data_import_runs SET finished_at = now(), status = 'succeeded', records_processed = $2, records_inserted = 0, records_updated = $3, error_count = 0 WHERE id = $1`,
          [runId, summary.normalized, reconciled],
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
      console.log(`import: verified-unchanged=${verifiedUnchanged} reconciled=${reconciled} run=${runId}`);
    } else {
      console.log("mode: dry-run (no DB writes)");
    }

    const reportPath = path.join(process.cwd(), "data", "processed", "official", "115", "application", "p4-normalization-report.json");
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({ ...report, import: doImport ? { reconciled, verifiedUnchanged, runId } : null }, null, 2));
    console.log(`report: ${reportPath}`);
    await client.end();
    if (errors.length > 0) process.exit(1);
  } catch (err) {
    try {
      await client.end();
    } catch {
      /* noop */
    }
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
