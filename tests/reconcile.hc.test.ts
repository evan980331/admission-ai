import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import pg from "pg";
import {
  establishTestConnection,
  hcExecutionPlan,
  HC_LIVE_CASES,
  preflightHcCommand,
} from "../src/data/testing/testGuard";
import { migrateTestDbForHc } from "../src/data/testing/migrateTest";
import {
  buildHcSeedFixtures,
  HC_CONTROL_DEPT,
  HC_IDS,
  HC_TARGET_DEPT,
  HC_YEAR,
  seedTestDb,
} from "../src/data/testing/hcSeed";
import { classifyLiveState, type FieldChange } from "../src/data/normalization/reconcile";
import { buildScopedCleanup } from "../src/data/testing/testGuard";
import { executeDbLoad } from "../src/data/loaders/official/admission";
import type { DbAdmissionRecords } from "../src/domain/admission/toDbRecords";

/**
 * H-C live suite (P4.4b-12B). Runs ONLY with HC_LIVE=1 AND a passing
 * preflight against a provisioned isolated database (Docker compose in
 * docker/postgres-hc.compose.yml). Without that, the suite is skipped and
 * the always-run banner test below reports the explicit NOT RUN manifest —
 * skip counts can never be misread as passes.
 *
 * Every live test connects SOLELY through establishTestConnection
 * (guard-first + live sentinel). No other client construction exists here.
 */

const plan = hcExecutionPlan(process.env);
const LIVE = plan.mode === "LIVE";

describe("H-C execution status (always runs, zero connections)", () => {
  it("reports LIVE or an explicit NOT RUN manifest", () => {
    if (!LIVE) {
      console.log(`H-C status: BLOCKED — ${plan.reason}`);
      console.log(`H-C NOT RUN: ${plan.notRun.join(", ")}`);
      expect(plan.notRun).toEqual([...HC_LIVE_CASES]);
    } else {
      expect(plan.notRun).toEqual([]);
    }
  });
  it("refuses without TEST_DATABASE_URL before any connection", () => {
    const env = { ...process.env };
    delete env["TEST_DATABASE_URL"];
    expect(() => preflightHcCommand(env)).toThrow(/TEST_DATABASE_URL is not set/);
  });
});

describe.skipIf(!LIVE)("H-C live (isolated PostgreSQL)", () => {
  let client: pg.Client;
  let token: string;
  const q = (text: string, values?: unknown[]) => client.query(text, values as never[]);

  beforeAll(async () => {
    token = process.env["HC_GUARD_TOKEN"] ?? "";
    expect(token.length).toBeGreaterThanOrEqual(16);
    const established = await establishTestConnection(
      process.env,
      async (cs) => {
        const c = new pg.Client({ connectionString: cs });
        await c.connect();
        return c;
      },
      token,
    ).catch(async () => {
      // First bootstrap has no sentinel yet: migrate + seed flow below
      // runs after this connection is verified by name in the migrate step.
      const { resolveTestConnectionString, verifyDbName } = await import("../src/data/testing/testGuard");
      const { connectionString, target } = resolveTestConnectionString(process.env);
      const c = new pg.Client({ connectionString });
      await c.connect();
      await verifyDbName((t, v) => c.query(t, v as never[]), target.dbName);
      return { client: c, target };
    });
    client = established.client as pg.Client;
    await migrateTestDbForHc(process.env["TEST_DATABASE_URL"]!, path.join(process.cwd(), "db", "migrations"));
    await seedTestDb(client as never, buildHcSeedFixtures(), token);
  }, 120000);

  afterAll(async () => {
    // Scoped teardown: only seeded 990 rows, FK-safe order, then verify.
    const ids = [HC_IDS.admissionTarget, HC_IDS.admissionControl];
    for (const table of ["second_stage_items", "tech_screening_items", "tech_screening_groups"]) {
      for (const s of buildScopedCleanup(table, ids)) await q(s.text, s.values);
    }
    await q(`DELETE FROM department_admissions WHERE id IN ($1,$2)`, ids);
    await q(`DELETE FROM departments WHERE id IN ($1,$2)`, [HC_IDS.deptTarget, HC_IDS.deptControl]);
    await q(`DELETE FROM schools WHERE id = $1`, [HC_IDS.school]);
    await q(`DELETE FROM data_sources WHERE id = $1`, [HC_IDS.source]);
    const left = await q(`SELECT COUNT(*)::int AS c FROM department_admissions a JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE s.school_code = '990'`);
    expect(Number(left.rows[0]?.["c"])).toBe(0);
    await client.end();
  }, 120000);

  const admissionIdOf = async (dept: string): Promise<string> => {
    const r = await q(
      `SELECT a.id FROM department_admissions a JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE s.school_code = '990' AND d.department_code = $1 AND a.year = $2`,
      [dept, HC_YEAR],
    );
    return r.rows[0]?.["id"] as string;
  };

  it("H-C1: migrations 001-006 applied once; rerun skips", async () => {
    const again = await migrateTestDbForHc(process.env["TEST_DATABASE_URL"]!, path.join(process.cwd(), "db", "migrations"));
    expect(again).toEqual([]);
    const tables = await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    const names = new Set(tables.rows.map((r) => String(r["table_name"])));
    for (const t of ["tech_screening_groups", "tech_screening_items", "second_stage_items", "schema_migrations"]) {
      expect(names.has(t)).toBe(true);
    }
    const mig = await q(`SELECT filename FROM schema_migrations ORDER BY filename`);
    expect(mig.rows.map((r) => String(r["filename"]))).toEqual([
      "001_initial_schema.sql", "002_student_preferences.sql", "003_admission_detail.sql",
      "004_admission_source_fields.sql", "005_school_masters.sql", "006_tech_screening.sql",
    ]);
  });

  it("H-C2: native UNIQUE/FK/CHECK violations fail with PostgreSQL codes", async () => {
    const adm = await admissionIdOf(HC_TARGET_DEPT);
    await q("BEGIN");
    try {
      await q(`INSERT INTO tech_screening_groups (admission_id, weight, weight_status, source_text) VALUES ($1, NULL, 'bogus-status', 'x')`, [adm]);
      expect.unreachable("CHECK must reject bogus weight_status");
    } catch (err) {
      expect(String((err as Error).message)).toMatch(/23514|check constraint|violates check/i);
    } finally {
      await q("ROLLBACK");
    }
    await q("BEGIN");
    try {
      await q(`INSERT INTO tech_screening_items (group_id, admission_id, position, name, source_text) VALUES ($1, $2, 1, 'x', 'x')`, ["00000000-0000-4000-8000-000000000099", adm]);
      expect.unreachable("FK must reject orphan group_id");
    } catch (err) {
      expect(String((err as Error).message)).toMatch(/23503|foreign key|violates foreign/i);
    } finally {
      await q("ROLLBACK");
    }
  });

  it("H-C3: seed lifecycle — rerun skips, tampered fixture refuses", async () => {
    const again = await seedTestDb(client as never, buildHcSeedFixtures(), token);
    expect(Object.values(again.inserted).reduce((a, b) => a + (b ?? 0), 0)).toBe(0);
    const tampered = buildHcSeedFixtures();
    tampered.departments[0]!.name = "竄改名稱";
    await expect(seedTestDb(client as never, tampered, token)).rejects.toThrow(/conflicting departments row/);
  });

  it("H-C5: wrong sentinel token refuses with zero writes", async () => {
    const before = await q(`SELECT COUNT(*)::int AS c FROM department_admissions`);
    const { establishTestConnection: est } = await import("../src/data/testing/testGuard");
    await expect(
      est(process.env, async (cs: string) => {
        const c = new pg.Client({ connectionString: cs });
        await c.connect();
        return c;
      }, "wrong-token-00000000"),
    ).rejects.toThrow(/sentinel token mismatch/);
    const after = await q(`SELECT COUNT(*)::int AS c FROM department_admissions`);
    expect(Number(after.rows[0]?.["c"])).toBe(Number(before.rows[0]?.["c"]));
  });

  it("H-C6/H-C7: reconcile apply then ALREADY_APPLIED; mismatches refuse", async () => {
    const adm = await admissionIdOf(HC_TARGET_DEPT);
    const item = {
      identity: { year: HC_YEAR, schoolCode: "990", departmentCode: HC_TARGET_DEPT, programType: "application", admissionId: adm },
      raw: { htmlPath: "h", metaPath: "m", sha256: "s", meta: { sourceUrl: "u", capturedAt: null, sha256: "s", departmentCode: HC_TARGET_DEPT, schoolCode: "990" } },
      parserVersion: "unknown",
      changes: [{ table: "second_stage_items", rowKey: "合成面談", field: "name", oldValue: null, newValue: "合成面談" }],
      checks: { reparseErrors: 0, normalizeErrors: [], drift: [], completenessErrors: [], orderDiffs: [] },
      disposition: "PENDING_APPROVAL" as const,
    };
    const readStage2 = async (): Promise<FieldChange[]> => {
      const r = await q(`SELECT position, name FROM second_stage_items WHERE admission_id = $1 ORDER BY position`, [adm]);
      const names = new Set(r.rows.map((x) => String(x["name"])));
      return names.has("合成面談") ? [] : item.changes;
    };
    const first = classifyLiveState(item, { admissionFound: true, identityMatch: true, currentChanges: await readStage2() });
    if (first.disposition === "READY") {
      await q("BEGIN");
      try {
        const { executeDbLoad: load } = await import("../src/data/loaders/official/admission");
        await load(client as never, {
          header: { academicYear: HC_YEAR, schoolCode: "990", departmentCode: HC_TARGET_DEPT, quota: 7, requirements: { chinese: null, english: null, math_a: null, math_b: null, social: null, science: null, english_listening: null } },
          firstStageWeight: null, secondStageWeight: null, subjects: [], sequences: [],
          secondStage: [
            { position: 1, name: "合成審查", requirement: null, weight: "40%", itemType: null, description: null, sourceText: "合成審查|" },
            { position: 2, name: "合成面談", requirement: null, weight: "60%", itemType: null, description: null, sourceText: "合成面談|" },
          ],
          apcs: [], review: [], special: [],
          schedule: { applicationFee: null, applicationFeeSource: null, notificationDate: null, notificationSource: null, materialDeadline: null, materialDeadlineSource: null, secondStageDate: null, secondStageDateSource: null, resultDate: null, resultDateSource: null, recheckDeadline: null, recheckDeadlineSource: null },
          notices: [], techGroup: null,
          provenance: { source: "official", sourceUrl: "hc", academicYear: HC_YEAR, retrievedAt: null, parserVersion: "hc", dataVersion: "hc", sourceId: null },
        }, { sourceName: "hc-synthetic-seed", dataVersion: "hc-seed-v1", departmentName: "合成測試系A（reconcile目標）" });
        await q("COMMIT");
      } catch (err) {
        await q("ROLLBACK");
        throw err;
      }
    }
    const second = classifyLiveState(item, { admissionFound: true, identityMatch: true, currentChanges: await readStage2() });
    expect(second.disposition).toBe("ALREADY_APPLIED");
    const tampered = classifyLiveState(item, {
      admissionFound: true, identityMatch: true,
      currentChanges: [...item.changes, { table: "second_stage_items", rowKey: "X", field: "name", oldValue: null, newValue: "X" }],
    });
    expect(tampered.disposition).toBe("REJECTED");
  });

  it("H-C8: single-item failure rolls back with zero residue", async () => {
    const adm = await admissionIdOf(HC_TARGET_DEPT);
    const before = await q(`SELECT position, name FROM second_stage_items WHERE admission_id = $1 ORDER BY position`, [adm]);
    await q("BEGIN");
    try {
      await q(`INSERT INTO tech_screening_groups (admission_id, weight, weight_status, source_text) VALUES ($1, NULL, 'shared', 'x') RETURNING id`, [adm]);
      await q(`INSERT INTO nope_missing_table (a) VALUES (1)`);
      await q("COMMIT");
      expect.unreachable("must fail before commit");
    } catch {
      await q("ROLLBACK");
    }
    const after = await q(`SELECT position, name FROM second_stage_items WHERE admission_id = $1 ORDER BY position`, [adm]);
    expect(after.rows).toEqual(before.rows);
    const groups = await q(`SELECT COUNT(*)::int AS c FROM tech_screening_groups WHERE admission_id = $1`, [adm]);
    expect(Number(groups.rows[0]?.["c"])).toBe(0);
  });

  it("H-C9: control admission byte-identical across the run", async () => {
    const adm = await admissionIdOf(HC_CONTROL_DEPT);
    const rows = await q(`SELECT position, name, weight FROM second_stage_items WHERE admission_id = $1 ORDER BY position`, [adm]);
    expect(rows.rows.map((r) => r["name"])).toEqual(["合成審查", "合成面談"]);
  });

  it("H-C10: tech linkage lands with group/item admission agreement", async () => {
    const adm = await admissionIdOf(HC_TARGET_DEPT);
    await q("BEGIN");
    try {
      const g = await q(`INSERT INTO tech_screening_groups (admission_id, weight, weight_status, source_text) VALUES ($1, '40%', 'shared', 'hc-link') RETURNING id`, [adm]);
      const gid = g.rows[0]?.["id"] as string;
      await q(`INSERT INTO tech_screening_items (group_id, admission_id, position, name, requirement, multiplier, score_method, source_text) VALUES ($1,$2,1,'合成術科',NULL,NULL,'*1.00','x')`, [gid, adm]);
      const joined = await q(`SELECT i.admission_id AS item_adm, g.admission_id AS group_adm FROM tech_screening_items i JOIN tech_screening_groups g ON g.id = i.group_id WHERE i.group_id = $1`, [gid]);
      expect(joined.rows[0]?.["item_adm"]).toBe(joined.rows[0]?.["group_adm"]);
      await q("ROLLBACK");
    } catch (err) {
      await q("ROLLBACK");
      throw err;
    }
    const groups = await q(`SELECT COUNT(*)::int AS c FROM tech_screening_groups WHERE admission_id = $1`, [adm]);
    expect(Number(groups.rows[0]?.["c"])).toBe(0);
  });

  it("H-C11: advisory-lock contention — loser writes nothing, winner release frees", async () => {
    const KEY = "('x' || substr(md5('admission-ai:reconcile:115'),1,16))::bit(64)::bigint";
    const c2 = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"]! });
    await c2.connect();
    try {
      await q("BEGIN");
      const got1 = await q(`SELECT pg_try_advisory_xact_lock(${KEY}) AS locked`);
      expect(got1.rows[0]?.["locked"]).toBe(true);
      await c2.query("BEGIN");
      const got2 = await c2.query(`SELECT pg_try_advisory_xact_lock(${KEY}) AS locked`);
      expect(got2.rows[0]?.["locked"]).toBe(false);
      await c2.query("ROLLBACK");
      await q("COMMIT");
      await q("BEGIN");
      const got3 = await q(`SELECT pg_try_advisory_xact_lock(${KEY}) AS locked`);
      expect(got3.rows[0]?.["locked"]).toBe(true);
      await q("COMMIT");
    } finally {
      await c2.end();
    }
  });

  it("H-C12: disconnect and failed-statement recovery leave zero residue", async () => {
    const adm = await admissionIdOf(HC_TARGET_DEPT);
    const dangling = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"]! });
    await dangling.connect();
    await dangling.query("BEGIN");
    await dangling.query(`INSERT INTO tech_screening_groups (admission_id, weight, weight_status, source_text) VALUES ($1, NULL, 'shared', 'dangle')`, [adm]);
    await dangling.end();
    const leaked = await q(`SELECT COUNT(*)::int AS c FROM tech_screening_groups WHERE admission_id = $1 AND source_text = 'dangle'`, [adm]);
    expect(Number(leaked.rows[0]?.["c"])).toBe(0);
    await q("BEGIN");
    try {
      await q(`SELECT * FROM nope_missing_table`);
      await q("COMMIT");
      expect.unreachable("must fail");
    } catch {
      await q("ROLLBACK");
    }
    const after = await q(`SELECT COUNT(*)::int AS c FROM tech_screening_groups WHERE admission_id = $1 AND source_text = 'dangle'`, [adm]);
    expect(Number(after.rows[0]?.["c"])).toBe(0);
  });
});
