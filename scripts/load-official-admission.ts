import fs from "node:fs";
import pg from "pg";
import dotenv from "dotenv";
import { fromDetailRecord } from "../src/domain/admission/fromDetail";
import { toDbRecords } from "../src/domain/admission/toDbRecords";
import {
  DETAIL_SOURCE_NAME,
  buildChildDelete,
  buildChildInserts,
  buildHeaderUpsert,
  ensureSourceStatements,
  isLoadableDetail,
  lookupStatements,
  recordKey,
} from "../src/data/loaders/official/admission";
import type { DetailRecord } from "../src/data/importers/official/application115/detail/types";

dotenv.config({ path: ".env.local" });
dotenv.config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

/**
 * P1-B DB loader: dataset.json (P3.13) -> canonical detail -> PostgreSQL.
 * Transactional + idempotent (header UPSERT, children delete+reinsert).
 * --dry-run prints the plan without touching any database (no DATABASE_URL
 * needed). Real runs use DATABASE_URL like db/migrate.ts; any failure
 * rolls back the whole run. Never invents values; skips are reported.
 */
async function main() {
  const input = arg("--input");
  const yearRaw = arg("--academic-year");
  const dryRun = flag("--dry-run");
  if (!input) {
    console.error("--input <dataset.json> is required");
    process.exit(2);
  }
  const academicYear = yearRaw === undefined ? 115 : Number(yearRaw);
  if (!Number.isInteger(academicYear) || academicYear < 100 || academicYear > 200) {
    console.error(`--academic-year must be 100-200, got ${JSON.stringify(yearRaw)}`);
    process.exit(2);
  }
  const dataset = JSON.parse(fs.readFileSync(input, "utf8")) as {
    entries?: Record<string, { status?: string; academicYear?: number; detail?: unknown }>;
  };
  const entries = Object.entries(dataset.entries ?? {});
  console.log(`entries: ${entries.length}`);

  let loaded = 0;
  let skipped = 0;
  const client = dryRun ? null : new pg.Client({ connectionString: process.env.DATABASE_URL });
  if (!dryRun && !process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set (dry-run needs none).");
    process.exit(1);
  }
  if (client) await client.connect();
  try {
    if (client) await client.query("BEGIN");
    for (const [key, entry] of entries) {
      if (entry.status !== "ok" || !isLoadableDetail(entry.detail) || entry.detail.academicYear !== academicYear) {
        console.log(`skip ${key}: status=${entry.status ?? "?"} (not loaded, reported not dropped)`);
        skipped++;
        continue;
      }
      const { canonical, issues } = fromDetailRecord(entry.detail as DetailRecord);
      const fatal = issues.filter((i) => i.level === "error");
      if (fatal.length > 0) {
        throw new Error(`${key}: canonicalization failed: ${fatal.map((f) => `${f.check}: ${f.detail}`).join("; ")}`);
      }
      const records = toDbRecords(canonical);
      const dataVersion = canonical.provenance.dataVersion || "unknown";
      if (dryRun) {
        console.log(`plan ${recordKey(records)}: subjects=${records.subjects.length} sequences=${records.sequences.length} stage2=${records.secondStage.length} apcs=${records.apcs.length} review=${records.review.length} special=${records.special.length} notices=${records.notices.length} source=${canonical.provenance.sourceUrl}`);
        loaded++;
        continue;
      }
      // ensure source
      for (const s of ensureSourceStatements(DETAIL_SOURCE_NAME, dataVersion)) {
        await client!.query(s.text, s.values as unknown[]);
      }
      const src = await client!.query(`SELECT id FROM data_sources WHERE source_name = $1 AND data_version = $2`, [DETAIL_SOURCE_NAME, dataVersion]);
      const sourceId = src.rows[0]?.id as string | undefined;
      if (!sourceId) throw new Error(`${key}: source row missing after ensure`);
      // resolve FKs (fail-closed: missing master rows abort the whole run)
      let departmentId: string | undefined;
      let programId: string | undefined;
      for (const s of lookupStatements(records)) {
        const r = await client!.query(s.text, s.values as unknown[]);
        if (s.text.startsWith("SELECT d.id")) departmentId = r.rows[0]?.id as string | undefined;
        else programId = r.rows[0]?.id as string | undefined;
      }
      if (!departmentId) throw new Error(`${key}: no departments row for ${records.header.schoolCode}/${records.header.departmentCode}; load masters first`);
      if (!programId) throw new Error(`${key}: no admission_programs row for year ${records.header.academicYear}; load masters first`);
      const header = await client!.query(buildHeaderUpsert(records, { departmentId, programId, sourceId }).text, buildHeaderUpsert(records, { departmentId, programId, sourceId }).values as unknown[]);
      const admissionId = header.rows[0]?.id as string | undefined;
      if (!admissionId) throw new Error(`${key}: header upsert returned no id`);
      for (const s of buildChildDelete(admissionId)) await client!.query(s.text, s.values as unknown[]);
      for (const s of buildChildInserts(admissionId, records)) await client!.query(s.text, s.values as unknown[]);
      loaded++;
      console.log(`loaded ${key}`);
    }
    if (client) {
      await client.query("COMMIT");
      console.log(`done: loaded=${loaded} skipped=${skipped}`);
    } else {
      console.log(`dry-run: planned=${loaded} skipped=${skipped}, no writes performed`);
    }
  } catch (err) {
    if (client) await client.query("ROLLBACK");
    throw err;
  } finally {
    if (client) await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
