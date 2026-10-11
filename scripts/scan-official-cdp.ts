import { captureCurrentPage, listTargets } from "../src/data/acquisition/browser/cdp";
import { deriveSchoolCode } from "../src/data/acquisition/browser/identity";
import { isCacDetailTabUrl } from "../src/data/acquisition/browser/tabs";
import {
  BROWSER_DEFAULT_PORT,
  type CdpTarget,
} from "../src/data/acquisition/browser/types";
import {
  isCacApplicationIndexUrl,
  isCacSchoolTabUrl,
  isErrorPageHtml,
  isTrafficLimitedHtml,
  matchDepartmentTab,
  storeSchoolPage,
} from "../src/data/acquisition/browser/universe";
import { storeCapture } from "../src/data/acquisition/browser/capture";
import { parseSchoolDepartments } from "../src/data/crawlers/official/application115/school-parser";
import { parseDetailHtml } from "../src/data/importers/official/application115/detail/parser";
import { auditCanonicalCompleteness } from "../src/domain/admission/validation";
import { fromDetailRecord } from "../src/domain/admission/fromDetail";
import { toDbRecords } from "../src/domain/admission/toDbRecords";
import {
  DETAIL_SOURCE_NAME,
  executeDbLoad,
} from "../src/data/loaders/official/admission";
import { buildOfficialDetailUrl } from "../src/data/discovery/official/application115/universe";
import { buildAcquisitionTask, firstPending, PDF_001_ORDER } from "../src/data/discovery/official/application115/pdf-inventory";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import dotenv from "dotenv";

/**
 * P1-C.2A-2 scan-once: classify current CDP tabs, capture at most one
 * expected school page, then exit. No daemon, no polling, no navigation,
 * zero CAC requests — reads only pages the user already opened.
 * Exit codes: 0 captured/already-captured, 1 NO_TARGET_PAGE or mismatch,
 * 3 CAC_TRAFFIC_LIMIT.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Classification = "detail" | "school" | "ignored";

function classify(url: string): { kind: Classification; schoolCode: string | null } {
  const school = isCacSchoolTabUrl(url);
  if (school) return { kind: "school", schoolCode: school };
  if (isCacDetailTabUrl(url)) return { kind: "detail", schoolCode: null };
  if (isCacApplicationIndexUrl(url)) return { kind: "ignored", schoolCode: null };
  return { kind: "ignored", schoolCode: null };
}

async function main() {
  const portRaw = arg("--port");
  const port = portRaw === undefined ? BROWSER_DEFAULT_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`--port must be 1-65535, got ${JSON.stringify(portRaw)}`);
    process.exit(2);
  }
  const expectDepartment = arg("--expect-department");
  if (expectDepartment !== undefined) {
    await runDepartmentMode(port, expectDepartment);
    return;
  }
  await runSchoolMode(port);
}

async function runSchoolMode(port: number) {
  const expectSchool = arg("--expect-school") ?? "001";
  if (!/^\d{3}$/.test(expectSchool)) {
    console.error(`--expect-school must be 3 digits, got ${JSON.stringify(expectSchool)}`);
    process.exit(2);
  }
  const schoolDir = arg("--output") ?? `${process.cwd()}/data/raw/official/115/application/school`;

  const targets: CdpTarget[] = await listTargets(port);
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  console.log(`tabs: ${pages.length} page(s)`);
  for (const p of pages) {
    const c = classify(p.url);
    console.log(`- [${c.kind}]${c.schoolCode ? ` school=${c.schoolCode}` : ""} ${p.url}`);
  }
  const schools = pages.filter((p) => classify(p.url).kind === "school");
  const wanted = schools.filter((p) => isCacSchoolTabUrl(p.url) === expectSchool);
  if (wanted.length === 0) {
    if (schools.length > 0) {
      console.error(`TARGET MISMATCH: open school page(s) are not ${expectSchool}; refusing to capture anything else`);
    } else {
      console.error("NO_TARGET_PAGE: no open ShowSchGsd school page (open one manually first)");
    }
    const details = pages.filter((p) => classify(p.url).kind === "detail");
    for (const d of details) console.error(`note: open detail page is NOT a school sample: ${d.url}`);
    process.exit(1);
  }
  if (wanted.length > 1) {
    console.error(`refusing: ${wanted.length} matching school tabs open (keep exactly one)`);
    process.exit(1);
  }
  const target = wanted[0]!;
  console.log(`TARGET: CAC ShowSchGsd school=${expectSchool} ${target.url}`);
  const page = await captureCurrentPage(target.webSocketDebuggerUrl);
  const sourceUrl = page.tabUrl || target.url;
  if (isCacSchoolTabUrl(sourceUrl) !== expectSchool) {
    console.error(`live href left the expected school page: ${sourceUrl.slice(0, 120)}`);
    process.exit(1);
  }
  if (isTrafficLimitedHtml(page.outerHtml)) {
    console.error("CAC_TRAFFIC_LIMIT: page shows traffic limit; nothing stored, no retry");
    process.exit(3);
  }
  const stored = storeSchoolPage({ schoolDir, schoolCode: expectSchool, sourceUrl, outerHtml: page.outerHtml });
  console.log(`status: ${stored.status}`);
  console.log(`raw: ${stored.htmlPath}`);
  console.log(`meta: ${stored.metaPath}`);
  console.log(`sha256: ${stored.meta.sha256}`);
  // Offline smoke test with the existing school parser (no DB writes).
  const smoke = parseSchoolDepartments(page.outerHtml, expectSchool, sourceUrl);
  console.log(`smoke: departments=${smoke.departments.length} errors=${smoke.issues.filter((i) => i.level === "error").length} warnings=${smoke.issues.filter((i) => i.level === "warning").length}`);
  for (const d of smoke.departments.slice(0, 5)) console.log(`smoke-row: ${d.department_code} ${d.department_name}`);
  for (const issue of smoke.issues.filter((i) => i.level === "error").slice(0, 5)) {
    console.log(`smoke-error: ${issue.detail}`);
  }
}

/**
 * Department mode: PDF -> single department -> user-opened Chrome tab ->
 * capture -> parse -> canonical validate -> PostgreSQL load. One sample only,
 * no batch. Uses existing storeCapture / parser / canonical / loader plan
 * builders with the same transactional fail-closed semantics.
 */
async function runDepartmentMode(port: number, expectedCode: string) {
  if (!/^\d{6}$/.test(expectedCode)) {
    console.error(`--expect-department must be 6 digits, got ${JSON.stringify(expectedCode)}`);
    process.exit(2);
  }
  const rawDir = arg("--output") ?? `${process.cwd()}/data/raw/official/115/application/departments`;
  const task = buildAcquisitionTask({ academicYear: 115, departmentCode: expectedCode });
  console.log(`TASK: PENDING ${task.departmentCode} school=${task.schoolCode} source=${task.source}`);
  console.log(`TASK URL: ${task.url}`);
  try {
    const rawCodes = new Set(
      fs
        .readdirSync(rawDir)
        .map((f) => f.match(/^115_(\d{6})\.htm$/i)?.[1])
        .filter((c): c is string => !!c),
    );
    console.log(`QUEUE: first PDF-backed code without raw: ${firstPending(PDF_001_ORDER, rawCodes) ?? "(none)"}`);
  } catch {
    console.log("QUEUE: raw dir unreadable (continues with explicit target only)");
  }

  const targets: CdpTarget[] = await listTargets(port);
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  console.log(`tabs: ${pages.length} page(s)`);
  for (const p of pages) {
    const c = classify(p.url);
    console.log(`- [${c.kind}]${c.schoolCode ? ` school=${c.schoolCode}` : ""} ${p.url}`);
  }
  const wanted = matchDepartmentTab(pages, 115, expectedCode);
  if (wanted.length === 0) {
    console.error("NO_TARGET_PAGE");
    console.error(`EXPECTED:\n${task.url}`);
    process.exit(1);
  }
  if (wanted.length > 1) {
    console.error(`refusing: ${wanted.length} matching tabs open (keep exactly one)`);
    process.exit(1);
  }
  const target = wanted[0]!;
  console.log(`TARGET: CAC detail ${expectedCode} ${target.url}`);
  const page = await captureCurrentPage(target.webSocketDebuggerUrl);
  const sourceUrl = page.tabUrl || target.url;
  if (matchDepartmentTab([{ url: sourceUrl }], 115, expectedCode).length !== 1) {
    console.error(`live href left the expected page: ${sourceUrl.slice(0, 120)}`);
    process.exit(1);
  }
  if (page.outerHtml.length === 0) {
    console.error("FAILED: empty HTML");
    process.exit(1);
  }
  if (isErrorPageHtml(page.outerHtml)) {
    if (isTrafficLimitedHtml(page.outerHtml)) {
      console.error("TRAFFIC_LIMITED: page shows traffic limit; NO_RAW_COMMIT, no retry");
    } else {
      console.error("FAILED: error page (no usable detail); NO_DB_WRITE, NO_RAW_COMMIT");
    }
    process.exit(1);
  }
  console.log(`TASK: CAPTURED htmlChars=${page.outerHtml.length}`);

  const schoolCode = deriveSchoolCode(expectedCode);
  if (!schoolCode) {
    console.error(`FAILED: cannot derive school from ${expectedCode}`);
    process.exit(1);
  }
  const stored = storeCapture({
    rawDir,
    departmentCode: expectedCode,
    schoolCode,
    sourceUrl,
    browserPort: port,
    page,
  });
  console.log(`TASK: STORED status=${stored.status} sha256=${stored.sha256}`);

  const parsed = parseDetailHtml(page.outerHtml, { sourceUrl, dataVersion: "scan-department" });
  const recordErrors = parsed.issues.filter((i) => i.level === "error");
  if (!parsed.record || recordErrors.length > 0) {
    console.error(`FAILED: parse failed: ${recordErrors.map((i) => `${i.check}: ${i.detail}`).join("; ")}; raw kept for forensics, NO_DB_WRITE`);
    process.exit(1);
  }
  const detail = parsed.record;
  if (detail.departmentCode !== expectedCode || detail.schoolCode !== schoolCode) {
    console.error(`FAILED: identity mismatch (got ${detail.schoolCode}/${detail.departmentCode}); NO_DB_WRITE`);
    process.exit(1);
  }
  if (detail.quota === 0) {
    console.error(`FAILED: quota=0 needs human review (unknown vs real zero); NO_DB_WRITE`);
    process.exit(1);
  }
  const { canonical, issues } = fromDetailRecord(detail);
  const canonicalErrors = [...issues, ...auditCanonicalCompleteness(detail, canonical)].filter((i) => i.level === "error");
  if (canonicalErrors.length > 0) {
    console.error(`FAILED: canonical validation: ${canonicalErrors.map((i) => `${i.check}: ${i.detail}`).join("; ")}; NO_DB_WRITE`);
    process.exit(1);
  }
  console.log(`TASK: PARSED dept=${detail.departmentName} quota=${detail.quota} subjects=${canonical.firstStage.subjectRules.length} stage2=${canonical.secondStage.items.length}`);
  console.log(`TASK: VALIDATED canonical errors=0`);

  // DB load via the shared loader executor (same transactional semantics).
  dotenv.config({ path: ".env.local" });
  dotenv.config();
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set; parsed + stored but NOT loaded (re-run with DB to load)");
    process.exit(1);
  }
  const records = toDbRecords(canonical);
  const dataVersion = canonical.provenance.dataVersion || "scan-department";
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    const admissionId = await executeDbLoad(client, records, {
      sourceName: DETAIL_SOURCE_NAME,
      dataVersion,
      departmentName: detail.departmentName,
      ensureDepartmentMaster: true,
    });
    await client.query("COMMIT");
    console.log(`TASK: LOADED admissionId=${admissionId}`);
    const counts = await client.query(
      `SELECT (SELECT count(*)::int FROM screening_subject_rules WHERE admission_id = $1) AS subjects, (SELECT count(*)::int FROM screening_sequences WHERE admission_id = $1) AS sequences, (SELECT count(*)::int FROM second_stage_items WHERE admission_id = $1) AS stage2, (SELECT count(*)::int FROM special_requirements WHERE admission_id = $1) AS special, (SELECT count(*)::int FROM admission_schedule WHERE admission_id = $1) AS schedule, (SELECT count(*)::int FROM admission_notices WHERE admission_id = $1) AS notices`,
      [admissionId],
    );
    console.log(`DB_SMOKE: ${JSON.stringify(counts.rows[0])}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
