import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import dotenv from "dotenv";
import { parseDetailHtml } from "../src/data/importers/official/application115/detail/parser";
import { auditCanonicalCompleteness } from "../src/domain/admission/validation";
import { fromDetailRecord } from "../src/domain/admission/fromDetail";
import { runDatasetBuild } from "../src/data/dataset/official/application115/index";
import {
  buildUniverse,
  checkIdentity,
  classifyRow,
  summarize,
  type CoverageRow,
  type ObservedState,
  type UniverseInput,
} from "../src/data/audit/official/application115/universe";

dotenv.config({ path: ".env.local" });
dotenv.config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

const EXPECTED_TABLES = [
  "screening_subject_rules",
  "screening_sequences",
  "second_stage_items",
  "apcs_requirements",
  "review_requirements",
  "special_requirements",
  "admission_schedule",
  "admission_notices",
];

function readJson(p: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * P1-C.2 universe / coverage audit. Fully offline: no fetch, no crawlers,
 * no DB writes, no secrets in output. DB presence is read-only and optional
 * (absent DATABASE_URL -> db=null with reason, never guessed).
 * Universe = code-identified verified fragments ONLY (raw captures + DB
 * masters + research fixtures, each labeled). There is deliberately NO
 * TotalGsdShow/school-index raw in repo, so the report is stamped
 * "universe source incomplete" — counts are a verified floor, not the 115 total.
 */
async function main() {
  const academicYear = Number(arg("--academic-year") ?? "115");
  const rawDir = arg("--raw-dir") ?? path.join(process.cwd(), "data", "raw", "official", "115", "application", "departments");
  const fixtureDir = arg("--fixture-dir") ?? path.join(process.cwd(), "tests", "fixtures", "official", "application115", "detail");
  const includeFixtures = !flag("--no-fixtures");
  const out = arg("--out") ?? null;

  const inputs: UniverseInput[] = [];
  const rawHtml = new Map<string, string>();
  const metaMismatches: string[] = [];
  if (fs.existsSync(rawDir)) {
    for (const f of fs.readdirSync(rawDir)) {
      const m = f.match(/^(\d{3})_(\d{6})\.htm$/i);
      if (!m) continue;
      const code = m[2]!;
      const html = fs.readFileSync(path.join(rawDir, f), "utf8");
      rawHtml.set(code, html);
      const meta = readJson(path.join(rawDir, `${f}.meta.json`)) as {
        academicYear?: number;
        schoolCode?: string;
        departmentCode?: string;
        sourceUrl?: string;
      } | null;
      // Canonical identity (P3.12 rule): 6-digit dept -> school = first 3.
      // A disagreeing meta value is recorded, never silently adopted.
      const canonicalSchool = code.slice(0, 3);
      if (typeof meta?.schoolCode === "string" && meta.schoolCode !== canonicalSchool) {
        metaMismatches.push(`${f}: meta schoolCode ${meta.schoolCode} != code prefix ${canonicalSchool} (stale pre-P3.12 capture; re-capture heals it)`);
      }
      inputs.push({
        schoolCode: canonicalSchool,
        schoolName: null,
        departmentCode: meta?.departmentCode ?? code,
        departmentName: null,
        detailUrl: meta?.sourceUrl ?? null,
        provenance: "official",
        academicYear: meta?.academicYear ?? academicYear,
      });
    }
  }

  const fixtureHtml = new Map<string, string>();
  if (includeFixtures && fs.existsSync(fixtureDir)) {
    for (const f of fs.readdirSync(fixtureDir)) {
      const m = f.match(/^(\d{3})_(\d{6})\.htm$/i);
      if (!m) continue;
      const code = m[2]!;
      fixtureHtml.set(code, fs.readFileSync(path.join(fixtureDir, f), "utf8"));
      const expected = readJson(path.join(fixtureDir, f.replace(/\.htm$/i, ".expected.json"))) as {
        schoolCode?: string;
        schoolName?: string | null;
        departmentCode?: string;
        departmentName?: string | null;
        sourceUrl?: string;
      } | null;
      inputs.push({
        schoolCode: expected?.schoolCode ?? code.slice(0, 3),
        schoolName: expected?.schoolName ?? null,
        departmentCode: expected?.departmentCode ?? code,
        departmentName: expected?.departmentName ?? null,
        detailUrl: expected?.sourceUrl ?? null,
        provenance: "fixture",
        academicYear,
      });
    }
  }

  // Read-only DB masters (optional; never written). research_only seed rows
  // (non-numeric codes) are excluded from the official universe by construction.
  const dbDepts = new Map<string, { schoolCode: string; schoolName: string | null; departmentName: string | null }>();
  const dbAdmissions = new Set<string>();
  let dbChecked = false;
  let dbSkippedResearch = 0;
  if (process.env.DATABASE_URL) {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const schools = await client.query(`SELECT school_code, name FROM schools`);
      const schoolName = new Map(schools.rows.map((r) => [r.school_code as string, (r.name as string) ?? null]));
      const depts = await client.query(`SELECT s.school_code, d.department_code, d.name FROM departments d JOIN schools s ON s.id = d.school_id`);
      for (const r of depts.rows) {
        const schoolCode = r.school_code as string;
        const deptCode = r.department_code as string;
        if (!/^\d{3}$/.test(schoolCode) || !/^\d{6}$/.test(deptCode)) {
          dbSkippedResearch++;
          continue;
        }
        dbDepts.set(r.department_code as string, {
          schoolCode: r.school_code as string,
          schoolName: schoolName.get(r.school_code as string) ?? null,
          departmentName: (r.name as string) ?? null,
        });
        inputs.push({
          schoolCode: r.school_code as string,
          schoolName: schoolName.get(r.school_code as string) ?? null,
          departmentCode: r.department_code as string,
          departmentName: (r.name as string) ?? null,
          detailUrl: null,
          provenance: "official",
          academicYear,
        });
      }
      const adm = await client.query(`SELECT s.school_code, d.department_code FROM department_admissions a JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE a.year = $1`, [academicYear]);
      for (const r of adm.rows) dbAdmissions.add(`${r.school_code}|${r.department_code}`);
      dbChecked = true;
    } finally {
      await client.end();
    }
  }

  // In-memory dataset over the raw dir (deterministic, no writes).
  let datasetKeys = new Set<string>();
  if (fs.existsSync(rawDir)) {
    try {
      const built = runDatasetBuild({ inputDir: rawDir, outputDir: null, academicYear, dryRun: true, dataVersion: "coverage-audit" });
      datasetKeys = new Set(Object.keys(built.dataset.entries));
    } catch (err) {
      console.error(`dataset build failed (continues without it): ${err instanceof Error ? err.message : err}`);
    }
  }

  // Static schema mapping: every canonical DB section needs a migrated table.
  const migrationSql = fs
    .readdirSync(path.join(process.cwd(), "db", "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => fs.readFileSync(path.join(process.cwd(), "db", "migrations", f), "utf8"))
    .join("\n");
  const schemaMapped = EXPECTED_TABLES.every((t) => migrationSql.includes(`CREATE TABLE IF NOT EXISTS ${t} (`));

  const universe = buildUniverse(inputs.filter((i) => i.academicYear === academicYear));
  const rows: CoverageRow[] = universe.map((u) => {
    const html = rawHtml.get(u.departmentCode) ?? (includeFixtures ? fixtureHtml.get(u.departmentCode) : undefined);
    const parsed = html ? parseDetailHtml(html, { sourceUrl: u.detailUrl ?? `local-file:${u.departmentCode}`, dataVersion: "coverage-audit" }) : null;
    let canonicalComplete = false;
    if (parsed?.record) {
      const { canonical } = fromDetailRecord(parsed.record);
      const errs = auditCanonicalCompleteness(parsed.record, canonical).filter((i) => i.level === "error");
      canonicalComplete = errs.length === 0 && canonical.identity.quota !== null && canonical.firstStage.subjectRules.length > 0;
      if (u.departmentName === null) u.departmentName = parsed.record.departmentName;
      if (u.schoolName === null) u.schoolName = parsed.record.schoolName;
    }
    const key = `${academicYear}|${u.schoolCode}|${u.departmentCode}`;
    const observed: ObservedState = {
      raw: rawHtml.has(u.departmentCode),
      parsed: parsed?.record != null,
      dataset: datasetKeys.has(key),
      db: dbChecked ? dbAdmissions.has(`${u.schoolCode}|${u.departmentCode}`) : null,
      canonicalComplete,
      schemaMapped,
    };
    void dbDepts;
    return classifyRow(u, observed);
  });

  const summary = summarize(rows);
  const identity = checkIdentity(rows);
  // School-level universe (P1-C.2A): read-only, admission rows untouched.
  let schoolIndex: { present: boolean; schools: number; sourceUrl: string | null; listedDepartments: number } = {
    present: false,
    schools: 0,
    sourceUrl: null,
    listedDepartments: 0,
  };
  const schoolIndexPath = path.join(rawDir, "..", "universe", "school-index.json");
  const schoolIndexRaw = readJson(schoolIndexPath) as {
    sourceUrl?: string;
    schools?: { schoolCode?: string; listedDepartmentCount?: number | null }[];
  } | null;
  if (schoolIndexRaw && Array.isArray(schoolIndexRaw.schools)) {
    schoolIndex = {
      present: true,
      schools: schoolIndexRaw.schools.length,
      sourceUrl: schoolIndexRaw.sourceUrl ?? null,
      listedDepartments: schoolIndexRaw.schools.reduce((n, s) => n + (s.listedDepartmentCount ?? 0), 0),
    };
  }
  const report = {
    generatedAt: new Date().toISOString(),
    academicYear,
    universeSourceComplete: false,
    universeSourceNote: "no TotalGsdShow / school-index raw in repo; universe is verified code-identified fragments only (official raw+DB masters, fixture-labeled research copies). Counts are a floor, not the 115 total.",
    dbResearchRowsExcluded: dbSkippedResearch,
    metaMismatches,
    schoolIndex,
    summary,
    identityIssues: identity,
    rows,
  };
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
  }
  console.log(`universe=${summary.universe} raw=${summary.raw} parsed=${summary.parsed} dataset=${summary.dataset} db=${summary.db}${summary.dbUnknown > 0 ? ` (unknown=${summary.dbUnknown})` : ""} canonical=${summary.canonicalComplete}`);
  console.log(`needsAcquisition=${summary.needsAcquisition} needsParseFix=${summary.needsParseFix} needsSchemaMapping=${summary.needsSchemaMapping}`);
  console.log(`gapsBySchool=${JSON.stringify(summary.gapsBySchool)}`);
  console.log(`identityIssues=${identity.length}${identity.length > 0 ? " " + JSON.stringify(identity) : ""}`);
  console.log(`schoolIndex: present=${schoolIndex.present} schools=${schoolIndex.schools} listedDepartments=${schoolIndex.listedDepartments}`);
  console.log(`universeSourceComplete=false (admission universe needs ShowSchGsd pages; floor only)`);
  if (out) console.log(`out: ${out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
