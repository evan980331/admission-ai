import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import dotenv from "dotenv";
import { parseDetailHtml } from "../src/data/importers/official/application115/detail/parser";
import { auditCanonicalCompleteness } from "../src/domain/admission/validation";
import { fromDetailRecord } from "../src/domain/admission/fromDetail";
import {
  buildInventory,
  PDF_FILES,
  isActionableStatus,
  resolveStatus,
  type QueueStatus,
} from "../src/data/discovery/official/application115/pdf-inventory";

dotenv.config({ path: ".env.local" });
dotenv.config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * P1-C.2A-5 acquisition queue (offline planning only).
 * Reads: official school PDFs (link annots), raw captures, PostgreSQL
 * admissions (read-only, env-gated). Writes nothing, fetches nothing,
 * never navigates. Statuses: DB canonical > raw capture > inventory.
 */
async function main() {
  const rawRoot = path.join(process.cwd(), "data", "raw", "official", "115", "application");
  const rawDir = path.join(rawRoot, "departments");
  const schoolFilter = arg("--school");
  const deptFilter = arg("--department");
  const nextOnly = process.argv.includes("--next");
  if (schoolFilter !== undefined && !/^\d{3}$/.test(schoolFilter)) {
    console.error(`--school must be 3 digits`);
    process.exit(2);
  }
  if (deptFilter !== undefined && !/^\d{6}$/.test(deptFilter)) {
    console.error(`--department must be 6 digits`);
    process.exit(2);
  }

  const pdfTexts: Record<string, string> = {};
  for (const [school, file] of Object.entries(PDF_FILES)) {
    pdfTexts[school] = fs.readFileSync(path.join(rawRoot, file), "latin1");
  }
  const inventory = buildInventory(pdfTexts);

  const rawHtm = new Set<string>();
  const rawMeta = new Set<string>();
  if (fs.existsSync(rawDir)) {
    for (const f of fs.readdirSync(rawDir)) {
      const m = f.match(/^115_(\d{6})\.htm(\.meta\.json)?$/i);
      if (!m) continue;
      rawHtm.add(m[1]!);
      if (f.endsWith(".meta.json")) rawMeta.add(m[1]!);
    }
  }

  const dbLoaded = new Set<string>();
  let dbChecked = false;
  if (process.env.DATABASE_URL) {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      // No school filter: department codes embed the school prefix and are
      // globally unique, so DB state is read for the whole inventory.
      // (A hardcoded IN-list here hid 004+ LOADED rows as LOAD_REQUIRED.)
      const r = await client.query(
        `SELECT d.department_code FROM department_admissions a JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE a.year = 115`,
      );
      for (const row of r.rows) dbLoaded.add(row.department_code as string);
      dbChecked = true;
    } finally {
      await client.end();
    }
  }

  const parseCache = new Map<string, { parsed: boolean; validated: boolean }>();
  const checkRaw = (code: string) => {
    const hit = parseCache.get(code);
    if (hit) return hit;
    const result = { parsed: false, validated: false };
    if (rawHtm.has(code)) {
      try {
        const html = fs.readFileSync(path.join(rawDir, `115_${code}.htm`), "utf8");
        const parsed = parseDetailHtml(html, { sourceUrl: `local-file:115_${code}.htm`, dataVersion: "queue-audit" });
        if (parsed.record) {
          result.parsed = true;
          const { canonical } = fromDetailRecord(parsed.record);
          result.validated = auditCanonicalCompleteness(parsed.record, canonical).filter((i) => i.level === "error").length === 0;
        }
      } catch {
        result.parsed = false;
      }
    }
    parseCache.set(code, result);
    return result;
  };

  const rows = inventory.map((e) => {
    const parsed = rawHtm.has(e.departmentCode) ? checkRaw(e.departmentCode) : { parsed: false, validated: false };
    const status = resolveStatus(e, {
      dbLoaded: dbChecked ? dbLoaded.has(e.departmentCode) : null,
      rawHtm: rawHtm.has(e.departmentCode),
      rawMeta: rawMeta.has(e.departmentCode),
      parsed: rawHtm.has(e.departmentCode) ? parsed.parsed : null,
      validated: rawHtm.has(e.departmentCode) ? parsed.validated : null,
    });
    return { entry: e, status };
  });

  const bySchool = (e: { schoolCode: string }) => e.schoolCode;
  let view = rows;
  if (schoolFilter) view = view.filter((r) => bySchool(r.entry) === schoolFilter);
  if (deptFilter) view = view.filter((r) => r.entry.departmentCode === deptFilter);

  if (deptFilter) {
    const hit = view[0];
    if (!hit) {
      console.error(`${deptFilter}: not in PDF inventory`);
      process.exit(1);
    }
    console.log(hit.entry.departmentCode);
    console.log(hit.entry.departmentName ?? "(name unverified)");
    console.log(hit.status);
    return;
  }

  if (nextOnly) {
    if (!schoolFilter) {
      console.error("--next requires --school");
      process.exit(2);
    }
    const next = view.find((r) => r.status === "PENDING");
    if (!next) {
      console.log(`no PENDING target in school ${schoolFilter}`);
      return;
    }
    console.log("NEXT TARGET");
    console.log("");
    console.log(`School: ${next.entry.schoolCode}`);
    console.log(`Department: ${next.entry.departmentCode}`);
    console.log(`Name: ${next.entry.departmentName ?? "(name unverified)"}`);
    console.log(`Status: ${next.status}`);
    console.log("");
    console.log("Open this URL manually:");
    console.log("");
    console.log(next.entry.detailUrl);
    console.log("");
    console.log("Then run:");
    console.log("");
    console.log(`npx tsx scripts/scan-official-cdp.ts --expect-department ${next.entry.departmentCode}`);
    return;
  }

  const counts = new Map<string, number>();
  for (const s of ["LOADED", "LOAD_REQUIRED", "CAPTURED", "STORED", "PARSED", "VALIDATED", "PENDING", "FAILED", "TRAFFIC_LIMITED", "NO_TARGET_PAGE"] as QueueStatus[]) {
    counts.set(s, 0);
  }
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);

  console.log("115 Admission Acquisition Queue");
  console.log("");
  console.log("PDF inventory:");
  // Derived from inventory records — never a hardcoded or numeric range
  // (010 is officially absent and must never appear here).
  for (const school of [...new Set(rows.map((r) => r.entry.schoolCode))].sort()) {
    console.log(`${school}  ${rows.filter((r) => r.entry.schoolCode === school).length}`);
  }
  console.log(`TOTAL ${rows.length}`);
  console.log("");
  console.log("Status:");
  for (const [k, v] of counts) console.log(`${k.padEnd(15)} ${v}`);
  if (!dbChecked) console.log("(DB unchecked: no DATABASE_URL; LOADED unknown, file states only)");
  console.log("");
  console.log("READY:");
  const ready = view.filter((r) => isActionableStatus(r.status));
  if (schoolFilter) {
    console.log(`${ready.length} actionable (pending + load-required)`);
    for (const r of ready.slice(0, 30)) console.log(`${r.entry.departmentCode} ${r.entry.departmentName ?? ""} [${r.status}]`);
    if (ready.length > 30) console.log(`... and ${ready.length - 30} more`);
  } else {
    for (const r of ready) console.log(`${r.entry.departmentCode} ${r.entry.departmentName ?? ""} [${r.status}]`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
