import { buildSentinelSeedStatements } from "./testGuard";

/**
 * H-C synthetic seed (P4.4b-11). Deterministic fixtures + seed executor.
 *
 * Namespace: school "990", departments "990012" (reconcile target, partial
 * state mirroring the drifted shape) and "990022" (control, full state).
 * "990" is disjoint from every official school code (001–153, verified
 * against school-index + 1,710 candidates: none start with "9") and from
 * research seed rows (non-numeric codes). Names are fixed synthetic labels
 * containing 合成測試 — no personal data, no prod rows copied.
 *
 * Pure generation (no time, no randomness, no network); fixed UUID
 * literals. Execution takes an injected client, runs in ONE transaction,
 * never auto-runs migrations, never touches non-synthetic rows.
 */

export const HC_SCHOOL_CODE = "990";
export const HC_TARGET_DEPT = "990012";
export const HC_CONTROL_DEPT = "990022";
export const HC_YEAR = 115;
export const HC_PROGRAM = "application";
export const HC_SOURCE_NAME = "hc-synthetic-seed";
export const HC_SOURCE_VERSION = "hc-seed-v1";

const U = (s: string): string => s;

export interface HcSeedIds {
  school: string;
  deptTarget: string;
  deptControl: string;
  program: string;
  source: string;
  admissionTarget: string;
  admissionControl: string;
}

export const HC_IDS: HcSeedIds = {
  school: U("aaaaaaaa-0000-4000-8000-000000000001"),
  deptTarget: U("aaaaaaaa-0000-4000-8000-000000000002"),
  deptControl: U("aaaaaaaa-0000-4000-8000-000000000003"),
  program: U("aaaaaaaa-0000-4000-8000-000000000004"),
  source: U("aaaaaaaa-0000-4000-8000-000000000005"),
  admissionTarget: U("aaaaaaaa-0000-4000-8000-000000000006"),
  admissionControl: U("aaaaaaaa-0000-4000-8000-000000000007"),
};

export interface HcSeedFixtures {
  school: { id: string; school_code: string; name: string };
  departments: { id: string; schoolCode: string; department_code: string; name: string }[];
  program: { id: string; year: number; program_type: string; name: string };
  source: { id: string; source_name: string; source_type: string; data_version: string; parser_version: string };
  admissions: { id: string; departmentCode: string; year: number; quota: number }[];
  secondStage: { admissionCode: string; position: number; name: string; weight: string | null; sourceText: string }[];
}

/** Deterministic builder: same input -> byte-identical output, always. */
export function buildHcSeedFixtures(): HcSeedFixtures {
  return {
    school: { id: HC_IDS.school, school_code: HC_SCHOOL_CODE, name: "合成測試校（H-C專用）" },
    departments: [
      { id: HC_IDS.deptTarget, schoolCode: HC_SCHOOL_CODE, department_code: HC_TARGET_DEPT, name: "合成測試系A（reconcile目標）" },
      { id: HC_IDS.deptControl, schoolCode: HC_SCHOOL_CODE, department_code: HC_CONTROL_DEPT, name: "合成測試系B（對照）" },
    ],
    program: { id: HC_IDS.program, year: HC_YEAR, program_type: HC_PROGRAM, name: "合成測試申請入學" },
    source: { id: HC_IDS.source, source_name: HC_SOURCE_NAME, source_type: "research_only", data_version: HC_SOURCE_VERSION, parser_version: HC_SOURCE_VERSION },
    admissions: [
      { id: HC_IDS.admissionTarget, departmentCode: HC_TARGET_DEPT, year: HC_YEAR, quota: 7 },
      { id: HC_IDS.admissionControl, departmentCode: HC_CONTROL_DEPT, year: HC_YEAR, quota: 9 },
    ],
    secondStage: [
      // Target holds a PARTIAL state (one row; the "missing" row is what a
      // later reconcile would add) — control holds the full two rows.
      { admissionCode: HC_TARGET_DEPT, position: 1, name: "合成審查", weight: "40%", sourceText: "合成審查|" },
      { admissionCode: HC_CONTROL_DEPT, position: 1, name: "合成審查", weight: "40%", sourceText: "合成審查|" },
      { admissionCode: HC_CONTROL_DEPT, position: 2, name: "合成面談", weight: "60%", sourceText: "合成面談|" },
    ],
  };
}

export interface SeedClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }>;
}

export interface SeedSummary {
  inserted: Record<string, number>;
  skippedIdentical: Record<string, number>;
}

/** Tables the seeder requires (read-only existence gate; never created here). */
export const HC_REQUIRED_TABLES = [
  "schools",
  "departments",
  "admission_programs",
  "data_sources",
  "department_admissions",
  "screening_subject_rules",
  "screening_sequences",
  "second_stage_items",
  "apcs_requirements",
  "review_requirements",
  "special_requirements",
  "admission_schedule",
  "admission_notices",
  "tech_screening_groups",
  "tech_screening_items",
];

const sameRow = (a: Record<string, unknown>, keys: string[], b: Record<string, unknown>): boolean =>
  keys.every((k) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));

/**
 * Seed executor (injected client only; no env access, no migration, no
 * TRUNCATE/DELETE/DROP). Order: existence gate -> sentinel init+verify ->
 * masters/compare-insert -> admissions -> children. One transaction;
 * identical reruns skip, conflicting content refuses (never overwrites).
 * Errors are rethrown with DB-detail-free summaries by the caller.
 */
export async function seedTestDb(
  client: SeedClient,
  fixtures: HcSeedFixtures,
  guardToken: string,
): Promise<SeedSummary> {
  const summary: SeedSummary = { inserted: {}, skippedIdentical: {} };
  const bump = (m: Record<string, number>, k: string) => {
    m[k] = (m[k] ?? 0) + 1;
  };
  const ensure = async (
    table: string,
    selectText: string,
    selectValues: unknown[],
    compareKeys: string[],
    wanted: Record<string, unknown>,
    insertText: string,
    insertValues: unknown[],
  ): Promise<void> => {
    const cur = await client.query(selectText, selectValues);
    if (cur.rows.length === 0) {
      await client.query(insertText, insertValues);
      bump(summary.inserted, table);
      return;
    }
    if (cur.rows.length > 1 || !sameRow(cur.rows[0]!, compareKeys, wanted)) {
      throw new Error(`H-C seed refused: conflicting ${table} row (not silently overwritten)`);
    }
    bump(summary.skippedIdentical, table);
  };

  await client.query("BEGIN");
  try {
    // 0. Required tables must already exist (migrated); never created here.
    const present = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const have = new Set(present.rows.map((r) => String(r["table_name"])));
    for (const t of HC_REQUIRED_TABLES) {
      if (!have.has(t)) throw new Error(`H-C seed refused: required table missing: ${t} (run migrations first; seeder never migrates)`);
    }
    // 1. Sentinel first: unknown non-empty databases are never initialized.
    const sentinel = await client.query(`SELECT token FROM __hc_guard WHERE id = $1`, ["hc"]).catch(() => ({ rows: [] as Record<string, unknown>[] }));
    if (sentinel.rows.length === 0) {
      const adm = await client.query(`SELECT COUNT(*)::int AS c FROM department_admissions`);
      if (Number(adm.rows[0]?.["c"] ?? 1) !== 0) {
        throw new Error("H-C seed refused: sentinel absent on a non-empty database (unknown target, not initialized)");
      }
      for (const s of buildSentinelSeedStatements(guardToken)) await client.query(s.text, s.values);
    }
    const check = await client.query(`SELECT token FROM __hc_guard WHERE id = $1`, ["hc"]);
    if (check.rows[0]?.["token"] !== guardToken) throw new Error("H-C seed refused: sentinel token mismatch");

    // 2. Masters (compare-then-act; official masters untouched — 990 only).
    await ensure(
      "schools",
      `SELECT id, school_code, name FROM schools WHERE school_code = $1`,
      [fixtures.school.school_code],
      ["school_code", "name"],
      { school_code: fixtures.school.school_code, name: fixtures.school.name },
      `INSERT INTO schools (id, school_code, name) VALUES ($1, $2, $3)`,
      [fixtures.school.id, fixtures.school.school_code, fixtures.school.name],
    );
    for (const d of fixtures.departments) {
      await ensure(
        "departments",
        `SELECT d.id, d.department_code, d.name FROM departments d JOIN schools s ON s.id = d.school_id WHERE s.school_code = $1 AND d.department_code = $2`,
        [d.schoolCode, d.department_code],
        ["department_code", "name"],
        { department_code: d.department_code, name: d.name },
        `INSERT INTO departments (id, school_id, department_code, name) SELECT $1, s.id, $2, $3 FROM schools s WHERE s.school_code = $4`,
        [d.id, d.department_code, d.name, d.schoolCode],
      );
    }
    await ensure(
      "admission_programs",
      `SELECT id, year, program_type, name FROM admission_programs WHERE year = $1 AND program_type = $2`,
      [fixtures.program.year, fixtures.program.program_type],
      ["year", "program_type", "name"],
      { year: fixtures.program.year, program_type: fixtures.program.program_type, name: fixtures.program.name },
      `INSERT INTO admission_programs (id, year, program_type, name) VALUES ($1, $2, $3, $4)`,
      [fixtures.program.id, fixtures.program.year, fixtures.program.program_type, fixtures.program.name],
    );
    await ensure(
      "data_sources",
      `SELECT id, source_name, source_type, data_version, parser_version FROM data_sources WHERE source_name = $1 AND data_version = $2`,
      [fixtures.source.source_name, fixtures.source.data_version],
      ["source_name", "source_type", "data_version", "parser_version"],
      { source_name: fixtures.source.source_name, source_type: fixtures.source.source_type, data_version: fixtures.source.data_version, parser_version: fixtures.source.parser_version },
      `INSERT INTO data_sources (id, source_name, source_type, data_version, parser_version) VALUES ($1, $2, $3, $4, $5)`,
      [fixtures.source.id, fixtures.source.source_name, fixtures.source.source_type, fixtures.source.data_version, fixtures.source.parser_version],
    );
    // 3. Admissions + children (count-gated: exact expected rows or refuse).
    for (const a of fixtures.admissions) {
      await ensure(
        "department_admissions",
        `SELECT a.id, a.year, a.quota FROM department_admissions a JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE s.school_code = $1 AND d.department_code = $2 AND a.year = $3`,
        [HC_SCHOOL_CODE, a.departmentCode, a.year],
        ["year", "quota"],
        { year: a.year, quota: a.quota },
        `INSERT INTO department_admissions (id, year, department_id, program_id, quota) SELECT $1, $2, d.id, (SELECT id FROM admission_programs WHERE year = $2 AND program_type = 'application'), $3 FROM departments d JOIN schools s ON s.id = d.school_id WHERE s.school_code = $4 AND d.department_code = $5`,
        [a.id, a.year, a.quota, HC_SCHOOL_CODE, a.departmentCode],
      );
    }
    for (const s of fixtures.secondStage) {
      await ensure(
        "second_stage_items",
        `SELECT position, name, weight FROM second_stage_items WHERE admission_id = (SELECT a.id FROM department_admissions a JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE s.school_code = $1 AND d.department_code = $2 AND a.year = $3) AND position = $4`,
        [HC_SCHOOL_CODE, s.admissionCode, HC_YEAR, s.position],
        ["position", "name", "weight"],
        { position: s.position, name: s.name, weight: s.weight },
        `INSERT INTO second_stage_items (admission_id, position, name, requirement, weight, source_text) SELECT a.id, $1, $2, NULL, $3, $4 FROM department_admissions a JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE s.school_code = $5 AND d.department_code = $6 AND a.year = $7`,
        [s.position, s.name, s.weight, s.sourceText, HC_SCHOOL_CODE, s.admissionCode, HC_YEAR],
      );
    }
    await client.query("COMMIT");
    return summary;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err instanceof Error ? new Error(err.message) : err;
  }
}
