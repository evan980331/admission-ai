import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import dotenv from "dotenv";
import readline from "node:readline";
import { storeCapture } from "../src/data/acquisition/browser/capture";
import { confirmChrome, inspectChrome } from "../src/data/acquisition/browser/confirm";
import { accessPolicyLines } from "../src/data/acquisition/browser/policy";
import { DEFAULT_RUNNER_CONFIG, acquireTarget, ensureSingleTab, loadFromRawHtml, navigateAndSettle, runQueue, summarizeOutcomes, toRunnerTarget } from "../src/data/acquisition/runner";
import { executeDbLoad } from "../src/data/loaders/official/admission";
import type { DbAdmissionRecords } from "../src/domain/admission/toDbRecords";
import { assertAnnotationMatchesBuilder } from "../src/data/discovery/official/application115/universe";
import { buildInventory, PDF_FILES, isActionableStatus, resolveStatus } from "../src/data/discovery/official/application115/pdf-inventory";

dotenv.config({ path: ".env.local" });
dotenv.config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

const num = (v: string | undefined, fallback: number) => {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Admission acquisition runner (single-tab, user-owned Chrome only).
 * PDF inventory -> DB/raw status -> PENDING queue -> CDP navigate (one tab)
 * -> capture -> parse -> validate -> PostgreSQL -> next. Stops hard on
 * traffic limits. Restart-safe: pending is recomputed from DB/raw each run.
 */
async function main() {
  const port = num(arg("--port"), 9222);
  const schoolFilter = arg("--school");
  const deptFilter = arg("--department");
  const dryRun = flag("--dry-run");
  const captureOnly = flag("--capture-only");
  const yes = flag("--yes");
  const delayMs = num(process.env.ADMISSION_ACQUIRE_DELAY_MS ?? arg("--delay-ms"), 5000);
  const settleMs = num(process.env.ADMISSION_PAGE_SETTLE_MS ?? arg("--settle-ms"), 1500);
  if (schoolFilter !== undefined && !/^\d{3}$/.test(schoolFilter)) {
    console.error("--school must be 3 digits");
    process.exit(2);
  }
  if (deptFilter !== undefined && !/^\d{6}$/.test(deptFilter)) {
    console.error("--department must be 6 digits");
    process.exit(2);
  }
  if (captureOnly && dryRun) {
    console.error("--capture-only and --dry-run are mutually exclusive (dry-run performs no work; capture-only captures without DB writes)");
    process.exit(2);
  }

  const rawRoot = path.join(process.cwd(), "data", "raw", "official", "115", "application");
  const rawDir = path.join(rawRoot, "departments");
  const pdfTexts: Record<string, string> = {};
  for (const [school, file] of Object.entries(PDF_FILES)) {
    const full = path.join(rawRoot, file);
    if (!fs.existsSync(full)) {
      console.error(`PDF inventory file missing: ${full} (future schools extend automatically once added)`);
      process.exit(1);
    }
    pdfTexts[school] = fs.readFileSync(full, "latin1");
  }
  const inventory = buildInventory(pdfTexts);
  // Startup gate: every annotation URL must agree with the builder (FAIL CLOSED).
  for (const e of inventory) {
    try {
      assertAnnotationMatchesBuilder(e.detailUrl, e.academicYear, e.departmentCode);
    } catch (err) {
      console.error(`URL GATE FAILED: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

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
  const needsDb = Boolean(process.env.DATABASE_URL);
  if (!needsDb && !dryRun) {
    console.error("DATABASE_URL is not set (dry-run needs none).");
    process.exit(1);
  }
  const dbLoaded = new Set<string>();
  let client: pg.Client | null = null;
  if (needsDb) {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const r = await client.query(
      `SELECT d.department_code FROM department_admissions a JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id WHERE a.year = 115`,
    );
    for (const row of r.rows) dbLoaded.add(row.department_code as string);
  }

  let targets = inventory
    .map((e) => {
      const inRaw = rawHtm.has(e.departmentCode);
      const status = resolveStatus(e, {
        dbLoaded: needsDb ? dbLoaded.has(e.departmentCode) : null,
        rawHtm: inRaw,
        rawMeta: rawMeta.has(e.departmentCode),
        parsed: null,
        validated: null,
      });
      return { entry: e, status };
    })
    .filter((r) => (schoolFilter ? r.entry.schoolCode === schoolFilter : true))
    .filter((r) => (deptFilter ? r.entry.departmentCode === deptFilter : true));
  const pending = targets.filter((r) => r.status === "PENDING");
  const reloads = targets.filter((r) => r.status === "LOAD_REQUIRED");
  const work = targets.filter((r) => isActionableStatus(r.status));
  const skippedLoaded = targets.filter((r) => r.status === "LOADED");

  console.log("Admission Acquisition Runner");
  for (const line of accessPolicyLines()) console.log(line);
  console.log(`Academic Year: 115`);
  if (schoolFilter) console.log(`School: ${schoolFilter}`);
  if (deptFilter) console.log(`Department: ${deptFilter}`);
  console.log(`Queue: ${inventory.length} total, ${skippedLoaded.length} loaded, ${pending.length} pending, ${reloads.length} load-required`);
  if (dryRun && !needsDb) console.log("(DB unchecked: no DATABASE_URL; file states only, LOADED unknown)");

  if (dryRun) {
    for (const r of work) console.log(`${r.entry.departmentCode} ${r.status} → ${r.entry.detailUrl}`);
    if (client) await client.end();
    console.log("dry-run: no navigation, no capture, no DB writes");
    return;
  }
  if (work.length === 0) {
    console.log("nothing pending; exiting");
    if (client) await client.end();
    return;
  }

  const config = { ...DEFAULT_RUNNER_CONFIG, settleStableMs: settleMs };
  const loadDbRecords = async (records: DbAdmissionRecords, meta: { sourceName: string; dataVersion: string; departmentName: string | null }) => {
    if (!client) throw new Error("no database client");
    await client.query("BEGIN");
    try {
      const id = await executeDbLoad(client, records, { ...meta, ensureDepartmentMaster: true });
      await client.query("COMMIT");
      return id;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  };
  // Capture-only guard: the ONLY database-write entry in this script is
  // loadDbRecords (single executeDbLoad call site). In capture-only mode it
  // is never wired in; this stub trips databaseWriteAttempted if any path
  // ever reaches a write, keeping the report honest.
  let databaseWriteAttempted = false;
  const forbiddenLoadDb = async (): Promise<string> => {
    databaseWriteAttempted = true;
    throw new Error("capture-only: database write blocked");
  };
  const loadDbImpl = captureOnly ? forbiddenLoadDb : loadDbRecords;

  // Chrome confirmation: before ANY tab is navigated or operated (browser
  // PENDING path only; raw reloads never touch the browser).
  if (pending.length > 0) {
    let inventory: Awaited<ReturnType<typeof inspectChrome>>;
    try {
      inventory = await inspectChrome(port);
    } catch (err) {
      if (client) await client.end();
      console.error(`Chrome unavailable: ${err instanceof Error ? err.message : String(err)}; fail-closed, no navigation performed`);
      process.exit(1);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const decision = await confirmChrome(
      inventory,
      { mode: captureOnly ? "capture-only" : "full", school: schoolFilter ?? null, department: deptFilter ?? null, targetCount: pending.length },
      { yes, ask: (q) => new Promise<string>((resolve) => rl.question(q, resolve)), log: (line) => console.log(line) },
    );
    rl.close();
    if (!decision.proceed) {
      if (client) await client.end();
      console.error(decision.reason);
      process.exit(decision.exitCode);
    }
  }

  // LOAD_REQUIRED: raw already captured+validated — load straight from the
  // stored file. No navigation, no CDP tab, no storeCapture (raw untouched).
  const reloadOutcomes = [];
  for (const r of reloads) {
    const target = toRunnerTarget(r.entry);
    console.log(`Current: ${target.departmentCode} ${target.departmentName ?? ""} (LOAD_REQUIRED, from raw)`);
    try {
      const html = fs.readFileSync(path.join(rawDir, `115_${target.departmentCode}.htm`), "utf8");
      const outcome = await loadFromRawHtml(target, {
        html,
        sourceUrl: r.entry.detailUrl,
        dataVersion: "acquire-runner",
        loadDb: loadDbImpl,
      }, { captureOnly });
      for (const s of outcome.stages) console.log(`STATUS: ${s}`);
      if (outcome.status === "LOADED") {
        console.log(`${target.departmentCode} ${target.departmentName ?? ""} PARSED VALIDATED LOADED (from raw)`);
      } else if (outcome.status === "CAPTURED") {
        console.log(`${target.departmentCode} ${target.departmentName ?? ""} PARSED VALIDATED CAPTURED (from raw, no DB write)`);
      } else {
        console.log(`FAILED ${target.departmentCode}: ${outcome.reasons.join("; ")}`);
      }
      reloadOutcomes.push(outcome);
    } catch (err) {
      console.log(`FAILED ${target.departmentCode}: ${err instanceof Error ? err.message : err}`);
      reloadOutcomes.push({ target, status: "FAILED" as const, stages: [], admissionId: null, sha256: null, reasons: [err instanceof Error ? err.message : String(err)] });
    }
  }

  const outcomes = [...reloadOutcomes];
  if (pending.length > 0) {
  const browserOutcomes = await runQueue(
    pending.map((r) => toRunnerTarget(r.entry)),
    {
      ensureTab: async () => ensureSingleTab(port),
      isLoaded: () => false,
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      delayMs: delayMs,
      onEvent: (line) => console.log(line),
      acquire: async (target, wsUrl) => {
        console.log(`Current: ${target.departmentCode} ${target.departmentName ?? ""}`);
        console.log(`URL: ${target.detailUrl}`);
        const outcome = await acquireTarget(
          target,
          {
            wsUrl,
            navigateAndSettle: (w, u, p) => navigateAndSettle(w, u, p, config),
            storeRaw: (args) =>
              storeCapture({ rawDir, departmentCode: args.departmentCode, schoolCode: args.schoolCode, sourceUrl: args.sourceUrl, browserPort: port, page: { tabUrl: args.sourceUrl, tabTitle: "", outerHtml: args.outerHtml } }),
            loadDb: loadDbImpl,
            sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
          },
          "acquire-runner",
          { captureOnly },
        );
        for (const s of outcome.stages) console.log(`STATUS: ${s}`);
        if (outcome.status === "LOADED") {
          console.log(`${target.departmentCode} ${target.departmentName ?? ""} CAPTURED PARSED VALIDATED LOADED`);
        } else if (outcome.status === "CAPTURED") {
          console.log(`${target.departmentCode} ${target.departmentName ?? ""} CAPTURED PARSED VALIDATED (no DB write)`);
        } else if (outcome.status === "TRAFFIC_LIMITED") {
          console.log("TRAFFIC_LIMITED STOP: runner halted, no further targets, no DB writes from here");
        } else {
          console.log(`FAILED ${target.departmentCode}: ${outcome.reasons.join("; ")}`);
        }
        return outcome;
      },
    },
  );
  outcomes.push(...browserOutcomes);
  }
  try {
    if (client) await client.end();
  } catch {
    /* noop */
  }
  for (const line of summarizeOutcomes(outcomes, { captureOnly, databaseWriteAttempted })) console.log(line);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
