import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import dotenv from "dotenv";
import { normalizeHistoricalBatch, NORMALIZATION_VERSION } from "../src/data/normalization/index";
import type { RawHistoricalInput } from "../src/data/normalization/types";

dotenv.config({ path: ".env.local" });
dotenv.config();

/**
 * Historical normalization CLI (P3-9).
 * - Default: read-only SELECT from live DB for --year, write normalization-report.json.
 * - --input <json>: offline mode with a local JSON array (fixtures / manual extracts).
 * - Never fabricates rows: empty input -> inputRecords = 0 report.
 * - Reports live under data/processed/historical/<year>/ (gitignored).
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readFromDb(year: number): Promise<{ rows: RawHistoricalInput[]; dataVersion: string }> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (or use --input <json> for offline mode)");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await client.query(
      `SELECT h.year AS "academicYear", p.program_type AS "programType",
              s.school_code AS "schoolCode", d.department_code AS "departmentCode", d.name AS "departmentName",
              h.quota, h.applicants, h.screened, h.second_stage AS "secondStage",
              h.admitted, h.waitlisted, h.minimum_score AS "minimumScore", h.average_score AS "averageScore",
              h.source_id AS "sourceId", ds.data_version AS "dataVersion"
         FROM historical_results h
         JOIN departments d ON d.id = h.department_id
         JOIN schools s ON s.id = d.school_id
         JOIN admission_programs p ON p.id = h.program_id
         LEFT JOIN data_sources ds ON ds.id = h.source_id
        WHERE h.year = $1
        ORDER BY s.school_code, d.department_code`,
      [year],
    );
    return { rows: r.rows as RawHistoricalInput[], dataVersion: `db-${year}` };
  } finally {
    await client.end();
  }
}

async function main() {
  const year = Number(arg("--year"));
  if (!Number.isInteger(year) || year < 100 || year > 130) {
    console.error(`--year must be an academic year (e.g. 115), got ${JSON.stringify(arg("--year"))}`);
    process.exit(2);
  }
  const inputPath = arg("--input");
  const dataVersion = arg("--data-version") ?? `manual-${new Date().toISOString().slice(0, 10)}`;

  let rows: RawHistoricalInput[];
  let version = dataVersion;
  if (inputPath) {
    const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    rows = (Array.isArray(raw) ? raw : raw.records) as RawHistoricalInput[];
  } else {
    const fromDb = await readFromDb(year);
    rows = fromDb.rows;
    version = fromDb.dataVersion;
  }

  const { records, report } = normalizeHistoricalBatch(rows, { academicYear: year, dataVersion: version });
  const dir = path.join(process.cwd(), "data", "processed", "historical", String(year));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "normalization-report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, "canonical-records.json"), JSON.stringify(records, null, 2));

  console.log(`normalizer: ${NORMALIZATION_VERSION}`);
  console.log(`inputRecords: ${report.inputRecords}`);
  console.log(`normalizedRecords: ${report.normalizedRecords}`);
  console.log(`warnings: ${report.warnings}`);
  console.log(`errors: ${report.errors}`);
  console.log(`ambiguousMappings: ${report.ambiguousMappings}`);
  console.log(`report: data/processed/historical/${year}/normalization-report.json`);
  if (report.errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
