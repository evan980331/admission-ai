import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import dotenv from "dotenv";
import {
  applyScopedPlan,
  planScopedFixes,
  plansEqual,
  SCOPED_ALLOWLIST,
  SCOPED_DATA_VERSION,
  type PlanInput,
  type ScopedPlan,
} from "../src/data/normalization/scopedApply";
import type { DbSourcedAdmission } from "../src/data/normalization/admission115";
import { P4_SOURCE_NAME } from "../src/data/normalization/admission115";

dotenv.config({ path: ".env.local" });
dotenv.config();

/**
 * Scoped reconcile CLI (P4.4b decision track).
 *
 * Default = dry-run (read-only): plans the FROZEN 16-identity scope,
 * prints per-item UPDATE/SKIP/REJECT lines + summary, exits 1 when the
 * plan is blocked. Writes NOTHING (no BEGIN, no loader calls).
 *
 * --apply --yes = executes a valid plan in ONE transaction via the
 * existing executeDbLoad path. Both flags are required; anything else
 * exits before any write. The global --import gate is untouched.
 */

interface ReadClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Read-only mirror of the normalize script's row loading (SELECTs only). */
async function readDbRows(client: ReadClient): Promise<DbSourcedAdmission[]> {
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
    ORDER BY s.school_code, d.department_code`;
  const h = await client.query(headerSql);
  const rows: DbSourcedAdmission[] = h.rows.map((r) => ({
    year: r["year"] as number, schoolCode: r["school_code"] as string, schoolName: r["school_name"] as string,
    departmentCode: r["department_code"] as string, departmentName: r["dept_name"] as string,
    groupName: r["group_name"] as string | null, programType: r["program_type"] as string, quota: r["quota"] as number,
    requirements: {
      chinese: r["chinese_requirement"] as string | null, english: r["english_requirement"] as string | null,
      math_a: r["math_a_requirement"] as string | null, math_b: r["math_b_requirement"] as string | null,
      social: r["social_requirement"] as string | null, science: r["science_requirement"] as string | null,
      english_listening: r["english_listening_requirement"] as string | null,
    },
    sourceUrl: r["source_url"] as string | null, firstStageWeight: r["first_stage_weight"] as string | null,
    secondStageWeight: r["second_stage_weight"] as string | null,
    sourceName: r["source_name"] as string | null, dataVersion: r["data_version"] as string | null,
    children: { subjects: [], sequences: [], secondStage: [], apcs: [], review: [], special: [], schedule: null, notices: [], techGroup: null, techItems: [] },
  }));
  const byCode = new Map(rows.map((r) => [r.departmentCode, r]));
  const childQ = async (sql: string) => (await client.query(sql)).rows;
  for (const r of await childQ(`SELECT d.department_code AS code, position, subject, requirement, multiplier, score_method AS "scoreMethod", status, source_text AS "sourceText" FROM screening_subject_rules x JOIN department_admissions a ON a.id = x.admission_id JOIN departments d ON d.id = a.department_id WHERE a.year = 115 ORDER BY 1, position`)) byCode.get(r["code"] as string)?.children.subjects.push(r as never);
  for (const r of await childQ(`SELECT d.department_code AS code, kind, position, subjects, description, source_text AS "sourceText" FROM screening_sequences x JOIN department_admissions a ON a.id = x.admission_id JOIN departments d ON d.id = a.department_id WHERE a.year = 115 ORDER BY 1, kind, position`)) byCode.get(r["code"] as string)?.children.sequences.push(r as never);
  for (const r of await childQ(`SELECT d.department_code AS code, x.position, x.name, requirement, weight, item_type AS "itemType", description, source_text AS "sourceText" FROM second_stage_items x JOIN department_admissions a ON a.id = x.admission_id JOIN departments d ON d.id = a.department_id WHERE a.year = 115 ORDER BY 1, position`)) byCode.get(r["code"] as string)?.children.secondStage.push(r as never);
  for (const r of await childQ(`SELECT d.department_code AS code, position, subject, requirement, multiplier, note, source_text AS "sourceText" FROM apcs_requirements x JOIN department_admissions a ON a.id = x.admission_id JOIN departments d ON d.id = a.department_id WHERE a.year = 115 ORDER BY 1, position`)) byCode.get(r["code"] as string)?.children.apcs.push(r as never);
  for (const r of await childQ(`SELECT d.department_code AS code, position, category_code AS "categoryCode", category_name AS "categoryName", required, minimum_count AS "minimumCount", maximum_count AS "maximumCount", description, restriction, source_text AS "sourceText" FROM review_requirements x JOIN department_admissions a ON a.id = x.admission_id JOIN departments d ON d.id = a.department_id WHERE a.year = 115 ORDER BY 1, position`)) byCode.get(r.code as string)?.children.review.push(r as never);
  for (const r of await childQ(`SELECT d.department_code AS code, kind, value, source_text AS "sourceText" FROM special_requirements x JOIN department_admissions a ON a.id = x.admission_id JOIN departments d ON d.id = a.department_id WHERE a.year = 115 ORDER BY 1, kind`)) byCode.get(r.code as string)?.children.special.push(r as never);
  for (const r of await childQ(`SELECT d.department_code AS code, application_fee AS "applicationFee", application_fee_source AS "applicationFeeSource", notification_date AS "notificationDate", notification_source AS "notificationSource", material_deadline AS "materialDeadline", material_deadline_source AS "materialDeadlineSource", second_stage_date AS "secondStageDate", second_stage_date_source AS "secondStageDateSource", result_date AS "resultDate", result_date_source AS "resultDateSource", recheck_deadline AS "recheckDeadline", recheck_deadline_source AS "recheckDeadlineSource" FROM admission_schedule x JOIN department_admissions a ON a.id = x.admission_id JOIN departments d ON d.id = a.department_id WHERE a.year = 115`)) {
    const t = byCode.get(r["code"] as string);
    if (t) {
      const { code: _c, ...rest } = r;
      t.children.schedule = rest as never;
    }
  }
  for (const r of await childQ(`SELECT d.department_code AS code, position, type, text, source_text AS "sourceText" FROM admission_notices x JOIN department_admissions a ON a.id = x.admission_id JOIN departments d ON d.id = a.department_id WHERE a.year = 115 ORDER BY 1, position`)) byCode.get(r.code as string)?.children.notices.push(r as never);
  const techTables = await client.query(`SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('tech_screening_groups','tech_screening_items')`);
  if (Number(techTables.rows[0]?.["c"] ?? 0) === 2) {
    for (const r of await childQ(`SELECT d.department_code AS code, g.weight, g.weight_status AS "weightStatus", g.source_text AS "sourceText", g.admission_id AS "admissionId" FROM tech_screening_groups g JOIN department_admissions a ON a.id = g.admission_id JOIN departments d ON d.id = a.department_id WHERE a.year = 115`)) {
      const t = byCode.get(r["code"] as string);
      if (t) {
        const { code: _c, ...rest } = r;
        t.children.techGroup = rest as never;
      }
    }
    for (const r of await childQ(`SELECT d.department_code AS code, i.position, i.name, i.requirement, i.multiplier, i.score_method AS "scoreMethod", i.source_text AS "sourceText", i.admission_id AS "itemAdmission", g.admission_id AS "groupAdmission" FROM tech_screening_items i JOIN tech_screening_groups g ON g.id = i.group_id JOIN department_admissions a ON a.id = g.admission_id JOIN departments d ON d.id = a.department_id WHERE a.year = 115 ORDER BY 1, position`)) byCode.get(r.code as string)?.children.techItems.push(r as never);
  } else {
    console.log("note: tech_screening tables absent; tech reads skipped");
  }
  return rows;
}

async function main(): Promise<void> {
  const doApply = process.argv.includes("--apply");
  const yes = process.argv.includes("--yes");
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
  }
  if (doApply && !yes) {
    console.error("--apply requires --yes (scoped writes need explicit operator intent); dry-run otherwise");
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const first = await buildPlan(client);
    printPlan(first.plan);
    if (!doApply) {
      console.log("dry-run: no database writes (pass --apply --yes to execute after authorization)");
      await client.end();
      process.exit(first.plan.valid ? 0 : 1);
    }
    if (!first.plan.valid) {
      console.error(`scoped apply refused: ${first.plan.blocked.length} blocked item(s), no writes performed`);
      await client.end();
      process.exit(1);
    }
    // Re-verify immediately before ANY write: rebuild the plan from live
    // reads and require it to match the reviewed plan exactly. Any drift
    // in raw files or DB rows since review aborts with zero writes.
    const second = await buildPlan(client);
    const cmp = plansEqual(first.plan, second.plan);
    if (!cmp.equal) {
      console.error(`scoped apply refused: plan changed since review (${cmp.reasons.slice(0, 3).join(" | ")}); no writes performed`);
      await client.end();
      process.exit(1);
    }
    const deptName = new Map(second.rows.map((r) => [r.departmentCode, r.departmentName]));
    const result = await applyScopedPlan(client, second.plan, {
      sourceName: P4_SOURCE_NAME,
      departmentNameOf: (code) => deptName.get(code) ?? null,
    });
    console.log(`scoped apply done: applied=${result.applied.length} skipped=${result.skipped.length}`);
    // Post-apply acceptance: replan from live state; every applied item
    // must now read SKIP_UNCHANGED with zero pending updates.
    const after = await buildPlan(client);
    const accepted = after.plan.valid && after.plan.updateCount === 0;
    console.log(
      `post-apply verification: updates=${after.plan.updateCount} skipped=${after.plan.skipCount} rejected=${after.plan.rejectCount} -> ${accepted ? "ACCEPTED" : "NOT ACCEPTED"}`,
    );
    await client.end();
    process.exit(accepted ? 0 : 1);
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

/** Build inputs from live DB + raw files and plan. Pure reads, no writes. */
async function buildPlan(client: pg.Client): Promise<{ plan: ScopedPlan; rows: DbSourcedAdmission[] }> {
  const rows = await readDbRows(client);
  const rawDir = path.join(process.cwd(), "data", "raw", "official", "115", "application", "departments");
  const inputs: PlanInput[] = rows.map((row) => {
    const htmlPath = path.join(rawDir, `115_${row.departmentCode}.htm`);
    const metaPath = `${htmlPath}.meta.json`;
    if (!fs.existsSync(htmlPath) || !fs.existsSync(metaPath)) return { row, raw: null };
    let meta: { sha256?: unknown; sourceUrl?: unknown };
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as typeof meta;
    } catch {
      return { row, raw: null };
    }
    if (typeof meta.sha256 !== "string") return { row, raw: null };
    return {
      row,
      raw: {
        html: fs.readFileSync(htmlPath, "utf8"),
        metaSha256: meta.sha256,
        sourceUrl: typeof meta.sourceUrl === "string" ? meta.sourceUrl : null,
      },
    };
  });
  return { plan: planScopedFixes(inputs), rows };
}

function printPlan(plan: ScopedPlan): void {
  console.log(`scoped reconcile plan: scope=${SCOPED_ALLOWLIST.length} rows=${plan.items.length} updates=${plan.updateCount} skipped=${plan.skipCount} rejected=${plan.rejectCount} data_version=${SCOPED_DATA_VERSION}`);
  for (const item of plan.items) {
    if (item.disposition === "UPDATE") {
      console.log(`UPDATE ${item.key} (${item.diffs.length} diffs) sha=${(item.rawSha ?? "?").slice(0, 12)} parser=${item.parserVersion ?? "?"}`);
      for (const d of item.diffs.slice(0, 5)) console.log(`  - ${d.slice(0, 160)}`);
    } else if (item.disposition === "REJECT") {
      console.log(`REJECT ${item.key}: ${item.reasons.join("; ").slice(0, 200)}`);
    }
  }
  for (const b of plan.blocked) console.log(`BLOCKED: ${b.slice(0, 200)}`);
}

void main();
