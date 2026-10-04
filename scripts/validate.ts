import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * P1 validation — 8 checks required by spec.
 * Returns non-zero exit when any check fails.
 */
export async function runValidation(
  client: pg.Client,
): Promise<{ results: CheckResult[]; failed: boolean }> {
  const results: CheckResult[] = [];
  const q = async (name: string, sql: string, params: unknown[] = []) => {
    const r = await client.query(sql, params as unknown[]);
    return r;
  };

  // 1. department -> school exists
  {
    const r = await q(
      "dept-school",
      `SELECT count(*)::int AS c FROM departments d LEFT JOIN schools s ON s.id = d.school_id WHERE s.id IS NULL`,
    );
    const c = Number(r.rows[0].c);
    results.push({ name: "department.school_id exists", ok: c === 0, detail: `orphans=${c}` });
  }
  // 2. admission -> department exists
  {
    const r = await q(
      "adm-dept",
      `SELECT count(*)::int AS c FROM department_admissions a LEFT JOIN departments d ON d.id = a.department_id WHERE d.id IS NULL`,
    );
    const c = Number(r.rows[0].c);
    results.push({ name: "admission.department_id exists", ok: c === 0, detail: `orphans=${c}` });
  }
  // 3. year is reasonable academic year (100..130 guard for 台灣學年度)
  {
    const r = await q(
      "year-range",
      `SELECT count(*)::int AS c FROM (
         SELECT year FROM admission_programs UNION ALL SELECT year FROM department_admissions
         UNION ALL SELECT year FROM historical_results UNION ALL SELECT year FROM score_statistics
         UNION ALL SELECT year FROM score_distributions UNION ALL SELECT year FROM admission_preferences
       ) t WHERE year IS NULL OR year < 100 OR year > 130`,
    );
    const c = Number(r.rows[0].c);
    results.push({ name: "year in [100,130]", ok: c === 0, detail: `bad_years=${c}` });
  }
  // 4. quota >= 0
  {
    const r = await q(
      "quota",
      `SELECT count(*)::int AS c FROM department_admissions WHERE quota < 0`,
    );
    const c = Number(r.rows[0].c);
    results.push({ name: "quota >= 0", ok: c === 0, detail: `violations=${c}` });
  }
  // 5. admitted <= quota (flag anomalies, do not silently fix)
  {
    const r = await q(
      "admitted-quota",
      `SELECT year, department_id, program_id, quota, admitted FROM historical_results
        WHERE quota IS NOT NULL AND admitted IS NOT NULL AND admitted > quota`,
    );
    results.push({
      name: "admitted <= quota (or flagged)",
      ok: r.rowCount === 0,
      detail: r.rowCount === 0 ? "ok" : `anomalies=${r.rowCount} e.g. ${JSON.stringify(r.rows[0])}`,
    });
  }
  // 6. 五標順序 top >= high >= avg >= low >= bottom
  {
    const r = await q(
      "five-levels",
      `SELECT count(*)::int AS c FROM score_statistics
        WHERE NOT (coalesce(top_standard,999) >= coalesce(high_standard,999)
          AND coalesce(high_standard,999) >= coalesce(average_standard,999)
          AND coalesce(average_standard,999) >= coalesce(low_standard,999)
          AND coalesce(low_standard,999) >= coalesce(bottom_standard,999))`,
    );
    const c = Number(r.rows[0].c);
    results.push({ name: "five-level ordering", ok: c === 0, detail: `violations=${c}` });
  }
  // 7. source_id must exist (where not null)
  {
    const parts = await Promise.all([
      q(
        "src-adm",
        `SELECT count(*)::int AS c FROM department_admissions a LEFT JOIN data_sources s ON s.id = a.source_id WHERE a.source_id IS NOT NULL AND s.id IS NULL`,
      ),
      q(
        "src-hist",
        `SELECT count(*)::int AS c FROM historical_results h LEFT JOIN data_sources s ON s.id = h.source_id WHERE h.source_id IS NOT NULL AND s.id IS NULL`,
      ),
      q(
        "src-pref",
        `SELECT count(*)::int AS c FROM admission_preferences p LEFT JOIN data_sources s ON s.id = p.source_id WHERE p.source_id IS NOT NULL AND s.id IS NULL`,
      ),
    ]);
    const c = parts.reduce((n, r) => n + Number(r.rows[0].c), 0);
    results.push({ name: "source_id exists", ok: c === 0, detail: `orphans=${c}` });
  }
  // 8. no duplicate admission record per (year, department, program)
  {
    const r = await q(
      "dup-adm",
      `SELECT count(*)::int AS c FROM (
         SELECT year, department_id, program_id, count(*) AS n FROM department_admissions
         GROUP BY 1,2,3 HAVING count(*) > 1
       ) t`,
    );
    const c = Number(r.rows[0].c);
    results.push({ name: "no duplicate admission record", ok: c === 0, detail: `dup_groups=${c}` });
  }

  return { results, failed: results.some((r) => !r.ok) };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Validation needs a database connection.");
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { results, failed } = await runValidation(client);
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name} — ${r.detail}`);
    if (failed) process.exit(1);
    console.log("validation done: all checks passed");
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/validate.ts");
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
