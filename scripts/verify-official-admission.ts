import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

/**
 * P1-C.1 load verification (integration workflow, NOT a unit test).
 * Requires DATABASE_URL (Neon/local Postgres with 001-003 migrated +
 * masters + a loader run). Exits 2 when DATABASE_URL is absent so
 * `npm test` stays secret-free. Asserts every P1-C.1 §D check for
 * 001012 / 001022, FK integrity (no orphans), no '--'->0 coercion,
 * and provenance backfill. Prints per-table row counts for
 * idempotency comparison.
 */
const DESKTOP_001012 =
  "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001012.htm?v=1.0";
const DESKTOP_001022 =
  "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001022.htm";

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

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function admissionId(client: pg.Client, deptCode: string): Promise<string | null> {
  const r = await client.query(
    `SELECT a.id FROM department_admissions a JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE a.year = 115 AND s.school_code = '001' AND d.department_code = $1`,
    [deptCode],
  );
  return (r.rows[0]?.id as string | undefined) ?? null;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set; verification needs a database (unit tests must not).");
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // ---- 001012 ----
    const id12 = await admissionId(client, "001012");
    check("001012 header exists", id12 !== null);
    if (id12) {
      const h = (await client.query(`SELECT quota, chinese_requirement, english_requirement, social_requirement, english_listening_requirement, screening_ratio_1, source_id, source_url, first_stage_weight, second_stage_weight FROM department_admissions WHERE id = $1`, [id12])).rows[0];
      check("001012 quota=23", h.quota === 23, JSON.stringify(h.quota));
      check("001012 Chinese 前標", h.chinese_requirement === "前標");
      check("001012 English 均標", h.english_requirement === "均標");
      check("001012 Social 均標", h.social_requirement === "均標");
      check("001012 legacy ratios stay null", h.screening_ratio_1 === null);
      check("001012 sourceId filled", typeof h.source_id === "string" && h.source_id.length > 0);
      const subj = (await client.query(`SELECT subject, requirement, multiplier, score_method, status FROM screening_subject_rules WHERE admission_id = $1 ORDER BY position`, [id12])).rows;
      const bySubj = new Map(subj.map((s) => [s.subject, s]));
      check("001012 5 subject rows", subj.length === 5, `got ${subj.length}`);
      check("001012 國文 前標 x3 *1.50", bySubj.get("國文")?.requirement === "前標" && Number(bySubj.get("國文")?.multiplier) === 3 && bySubj.get("國文")?.score_method === "*1.50");
      check("001012 英文 均標 x6", bySubj.get("英文")?.requirement === "均標" && Number(bySubj.get("英文")?.multiplier) === 6);
      check("001012 社會 均標 x8", bySubj.get("社會")?.requirement === "均標" && Number(bySubj.get("社會")?.multiplier) === 8);
      check("001012 '--' stays null (not 0)", bySubj.get("數學A")?.multiplier === null && bySubj.get("數學B")?.score_method === null);
      const seq = (await client.query(`SELECT kind, description FROM screening_sequences WHERE admission_id = $1 ORDER BY kind, position`, [id12])).rows;
      check("001012 over-quota=3", seq.filter((s) => s.kind === "over_quota").length === 3);
      check("001012 tie-break=3", seq.filter((s) => s.kind === "tie_break").length === 3);
      const stage2 = (await client.query(`SELECT name, requirement, weight FROM second_stage_items WHERE admission_id = $1 ORDER BY position`, [id12])).rows;
      check("001012 stage2[0] 70分-25%", stage2[0]?.name === "審查資料" && stage2[0]?.requirement === "70分" && stage2[0]?.weight === "25%");
      check("001012 2 scoreless writing items kept", stage2.length === 3 && stage2[1]?.requirement === null && stage2[2]?.requirement === null);
      const sp = new Map((await client.query(`SELECT kind, value FROM special_requirements WHERE admission_id = $1`, [id12])).rows.map((r) => [r.kind, r.value]));
      check("001012 offshore=連江", sp.get("offshore_restriction") === "1名限連江縣", JSON.stringify(sp.get("offshore_restriction")));
      const sch = (await client.query(`SELECT application_fee, notification_date::text AS n, material_deadline::text AS m, second_stage_date::text AS s, result_date::text AS r, recheck_deadline::text AS c FROM admission_schedule WHERE admission_id = $1`, [id12])).rows[0];
      check("001012 fee=1500", sch?.application_fee === 1500);
      check("001012 5 schedule dates", sch?.n === "2026-03-31" && sch?.m === "2026-05-06" && sch?.s === "2026-05-15" && sch?.r === "2026-06-01" && sch?.c === "2026-05-27", JSON.stringify(sch));
      const rev = (await client.query(`SELECT source_text FROM review_requirements WHERE admission_id = $1`, [id12])).rows;
      check("001012 review row present, unstructured", rev.length === 1 && rev[0].source_text.includes("修課紀錄"));
      check("001012 J/K restrictions kept", rev[0].source_text.includes("得獎證明"));
      check("001012 O/P/Q limits kept", rev[0].source_text.includes("600字以內"));
      const notes = (await client.query(`SELECT text FROM admission_notices WHERE admission_id = $1 ORDER BY position`, [id12])).rows;
      check("001012 4 notes in order", notes.length === 4 && notes[0].text.startsWith("1."));
      const src = (await client.query(`SELECT ds.source_name, ds.source_type, a.source_id FROM department_admissions a JOIN data_sources ds ON ds.id = a.source_id WHERE a.id = $1`, [id12])).rows[0];
      check("001012 provenance source row", src?.source_name === "official-cac-detail" && src?.source_type === "official");
      check("001012 sourceUrl incl. ?v=1.0", h.source_url === DESKTOP_001012, JSON.stringify(h.source_url));
      check("001012 first-stage weight=40%", h.first_stage_weight === "40%", JSON.stringify(h.first_stage_weight));
    }

    // ---- 001022 ----
    const id22 = await admissionId(client, "001022");
    check("001022 header exists", id22 !== null);
    if (id22) {
      const h = (await client.query(`SELECT quota, source_url, first_stage_weight FROM department_admissions WHERE id = $1`, [id22])).rows[0];
      check("001022 quota=43", h?.quota === 43);
      check("001022 sourceUrl exact desktop", h?.source_url === DESKTOP_001022, JSON.stringify(h?.source_url));
      check("001022 first-stage weight=20%", h?.first_stage_weight === "20%", JSON.stringify(h?.first_stage_weight));
      const subj = (await client.query(`SELECT subject, requirement FROM screening_subject_rules WHERE admission_id = $1`, [id22])).rows;
      check("001022 6 subjects", subj.length === 6, `got ${subj.length}`);
      check("001022 listening=A", subj.find((s) => s.subject === "英聽")?.requirement === "A級");
      const sp = new Map((await client.query(`SELECT kind, value FROM special_requirements WHERE admission_id = $1`, [id22])).rows.map((r) => [r.kind, r.value]));
      check("001022 listening mirror=A", sp.get("english_listening") === "A級");
      const seq = (await client.query(`SELECT kind, description FROM screening_sequences WHERE admission_id = $1`, [id22])).rows;
      check("001022 over-quota=4", seq.filter((s) => s.kind === "over_quota").length === 4);
      const tie = seq.filter((s) => s.kind === "tie_break");
      check("001022 tie-break=4 incl. oral", tie.length === 4 && tie.some((t) => t.description.includes("英語口試")));
      const stage2 = (await client.query(`SELECT name, weight FROM second_stage_items WHERE admission_id = $1 ORDER BY position`, [id22])).rows;
      check("001022 3 stage2 items + weights", stage2.length === 3 && stage2[0]?.weight === "40%" && stage2[2]?.name === "英語口試測驗");
      const src = (await client.query(`SELECT a.source_id, ds.source_name FROM department_admissions a JOIN data_sources ds ON ds.id = a.source_id WHERE a.id = $1`, [id22])).rows[0];
      check("001022 provenance filled", typeof src?.source_id === "string" && src?.source_name === "official-cac-detail");
    }

    // ---- sourceUrl incl. query string ----
    const urls = await client.query(
      `SELECT d.department_code, ds.source_name FROM department_admissions a JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id JOIN data_sources ds ON ds.id = a.source_id WHERE a.year = 115 AND s.school_code = '001' AND d.department_code IN ('001012','001022')`,
    );
    check("both rows carry official source", urls.rows.length === 2);

    // ---- orphan check across all 8 child tables ----
    for (const t of CHILD_TABLES) {
      const orph = await client.query(`SELECT count(*)::int AS n FROM ${t} c LEFT JOIN department_admissions a ON a.id = c.admission_id WHERE a.id IS NULL`);
      check(`no orphans in ${t}`, orph.rows[0].n === 0, `orphans=${orph.rows[0].n}`);
    }

    // ---- row counts (idempotency baseline) ----
    const counts: Record<string, number> = {};
    counts["department_admissions@115"] = (await client.query(`SELECT count(*)::int AS n FROM department_admissions WHERE year = 115`)).rows[0].n;
    for (const t of CHILD_TABLES) {
      counts[t] = (await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    }
    console.log(`COUNTS ${JSON.stringify(counts)}`);
  } finally {
    await client.end();
  }
  if (failures > 0) {
    console.error(`verification failed: ${failures} check(s)`);
    process.exit(1);
  }
  console.log("verification done: all checks passed");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
