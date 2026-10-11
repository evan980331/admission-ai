import { detailPathname } from "../discovery/official/application115/universe";
import { parseDetailHtml } from "../importers/official/application115/detail/parser";
import { auditCanonicalCompleteness } from "../../domain/admission/validation";
import { fromDetailRecord } from "../../domain/admission/fromDetail";
import { toDbRecords, type DbAdmissionRecords } from "../../domain/admission/toDbRecords";
import { deriveSchoolCode } from "./browser/identity";
import { storeCapture } from "./browser/capture";
import {
  DEFAULT_RUNNER_CONFIG,
  ensureSingleTab,
  navigateAndSettle,
  type RunnerCdpDeps,
  type RunnerConfig,
} from "./browser/navigate";
import { isErrorPageHtml, isTrafficLimitedHtml } from "./browser/universe";
import type { InventoryEntry } from "../discovery/official/application115/pdf-inventory";

export interface RunnerTarget {
  academicYear: number;
  schoolCode: string;
  departmentCode: string;
  departmentName: string | null;
  detailUrl: string;
}

export type DeptOutcomeStatus = "LOADED" | "FAILED" | "TRAFFIC_LIMITED" | "CAPTURED";

export interface DeptOutcome {
  target: RunnerTarget;
  status: DeptOutcomeStatus;
  stages: string[];
  admissionId: string | null;
  sha256: string | null;
  reasons: string[];
}

export interface RunnerDelays {
  delayMs: number;
}

export interface RunnerIO {
  navigateAndSettle: (wsUrl: string, url: string, expectedPath: string) => Promise<{ href: string; html: string }>;
  storeRaw: (args: { departmentCode: string; schoolCode: string; sourceUrl: string; outerHtml: string; browserPort: number }) => { sha256: string; status: string };
  loadDb: (records: DbAdmissionRecords, meta: { sourceName: string; dataVersion: string; departmentName: string | null }) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
}

export function toRunnerTarget(entry: InventoryEntry): RunnerTarget {
  return {
    academicYear: entry.academicYear,
    schoolCode: entry.schoolCode,
    departmentCode: entry.departmentCode,
    departmentName: entry.departmentName,
    detailUrl: entry.detailUrl,
  };
}

function expectedPathOf(url: string): string {
  const path = detailPathname(url);
  if (!path) throw new Error(`unparseable target URL: ${url.slice(0, 80)}`);
  return path;
}

/**
 * One department end-to-end: NAVIGATING -> CAPTURED -> STORED -> PARSED ->
 * VALIDATED -> LOADED. Any failure stops this department (FAILED, no further
 * steps); TRAFFIC_LIMITED additionally stops the whole runner (caller).
 * With opts.captureOnly the pipeline stops after VALIDATED (no loadDb call)
 * and reports status CAPTURED with admissionId null.
 */
export async function acquireTarget(
  target: RunnerTarget,
  io: RunnerIO & { wsUrl: string },
  dataVersion: string,
  opts?: { captureOnly?: boolean },
): Promise<DeptOutcome> {
  const stages: string[] = [];
  const reasons: string[] = [];
  const fail = (stage: string, reason: string): DeptOutcome => ({
    target,
    status: "FAILED",
    stages,
    admissionId: null,
    sha256: null,
    reasons: [...reasons, `${stage}: ${reason}`],
  });

  let settled: { href: string; html: string };
  try {
    stages.push("NAVIGATING");
    settled = await io.navigateAndSettle(io.wsUrl, target.detailUrl, expectedPathOf(target.detailUrl));
  } catch (err) {
    return fail("NAVIGATING", err instanceof Error ? err.message : String(err));
  }
  if (detailPathname(settled.href) !== expectedPathOf(target.detailUrl)) {
    return fail("NAVIGATING", `wrong tab after navigate (got ${settled.href.slice(0, 80)})`);
  }
  if (isTrafficLimitedHtml(settled.html)) {
    return { target, status: "TRAFFIC_LIMITED", stages, admissionId: null, sha256: null, reasons: ["page shows traffic limit"] };
  }
  if (isErrorPageHtml(settled.html)) {
    return fail("CAPTURED", "error page (no store, no DB)");
  }
  if (settled.html.length === 0) return fail("CAPTURED", "empty HTML");
  stages.push("CAPTURED");

  const schoolCode = deriveSchoolCode(target.departmentCode);
  if (!schoolCode || schoolCode !== target.schoolCode) {
    return fail("STORED", `school derivation mismatch for ${target.departmentCode}`);
  }
  const stored = io.storeRaw({
    departmentCode: target.departmentCode,
    schoolCode,
    sourceUrl: settled.href,
    outerHtml: settled.html,
    browserPort: 0,
  });
  stages.push("STORED");

  const parsed = parseDetailHtml(settled.html, { sourceUrl: settled.href, dataVersion });
  const recordErrors = parsed.issues.filter((i) => i.level === "error");
  if (!parsed.record || recordErrors.length > 0) {
    return { ...fail("PARSED", recordErrors.map((i) => `${i.check}: ${i.detail}`).join("; ") || "no record"), sha256: stored.sha256 };
  }
  const detail = parsed.record;
  if (detail.departmentCode !== target.departmentCode || detail.schoolCode !== target.schoolCode) {
    return { ...fail("PARSED", `identity mismatch (got ${detail.schoolCode}/${detail.departmentCode})`), sha256: stored.sha256 };
  }
  stages.push("PARSED");

  const { canonical, issues } = fromDetailRecord(detail);
  const canonicalErrors = [...issues, ...auditCanonicalCompleteness(detail, canonical)].filter((i) => i.level === "error");
  if (canonicalErrors.length > 0) {
    return { ...fail("VALIDATED", canonicalErrors.map((i) => `${i.check}: ${i.detail}`).join("; ")), sha256: stored.sha256 };
  }
  stages.push("VALIDATED");

  if (opts?.captureOnly) {
    return { target, status: "CAPTURED", stages, admissionId: null, sha256: stored.sha256, reasons: [...reasons, "capture-only: database write skipped"] };
  }
  const records = toDbRecords(canonical);
  try {
    const admissionId = await io.loadDb(records, {
      sourceName: "official-cac-detail",
      dataVersion,
      departmentName: detail.departmentName,
    });
    stages.push("LOADED");
    return { target, status: "LOADED", stages, admissionId, sha256: stored.sha256, reasons };
  } catch (err) {
    return { ...fail("LOADED", err instanceof Error ? err.message : String(err)), sha256: stored.sha256 };
  }
}

/**
 * Reload path for LOAD_REQUIRED targets: raw capture already exists (and must
 * NOT be re-fetched or overwritten), so parse + validate the stored HTML and
 * load it into PostgreSQL. No navigation, no CDP contact, no storeRaw call —
 * the existing raw file is the input of record. Returns LOADED on success,
 * FAILED (with reasons, no DB writes) otherwise. With opts.captureOnly the
 * pipeline stops after VALIDATED (no loadDb call) and reports CAPTURED.
 */
export async function loadFromRawHtml(
  target: RunnerTarget,
  args: { html: string; sourceUrl: string; dataVersion: string; loadDb: RunnerIO["loadDb"] },
  opts?: { captureOnly?: boolean },
): Promise<DeptOutcome> {
  const stages: string[] = [];
  const reasons: string[] = [];
  const fail = (stage: string, reason: string): DeptOutcome => ({
    target,
    status: "FAILED",
    stages,
    admissionId: null,
    sha256: null,
    reasons: [...reasons, `${stage}: ${reason}`],
  });

  const parsed = parseDetailHtml(args.html, { sourceUrl: args.sourceUrl, dataVersion: args.dataVersion });
  const recordErrors = parsed.issues.filter((i) => i.level === "error");
  if (!parsed.record || recordErrors.length > 0) {
    return fail("PARSED", recordErrors.map((i) => `${i.check}: ${i.detail}`).join("; ") || "no record");
  }
  const detail = parsed.record;
  if (detail.departmentCode !== target.departmentCode || detail.schoolCode !== target.schoolCode) {
    return fail("PARSED", `identity mismatch (got ${detail.schoolCode}/${detail.departmentCode})`);
  }
  stages.push("PARSED");

  const { canonical, issues } = fromDetailRecord(detail);
  const canonicalErrors = [...issues, ...auditCanonicalCompleteness(detail, canonical)].filter((i) => i.level === "error");
  if (canonicalErrors.length > 0) {
    return fail("VALIDATED", canonicalErrors.map((i) => `${i.check}: ${i.detail}`).join("; "));
  }
  stages.push("VALIDATED");

  if (opts?.captureOnly) {
    return { target, status: "CAPTURED", stages, admissionId: null, sha256: null, reasons: [...reasons, "capture-only: database write skipped"] };
  }
  const records = toDbRecords(canonical);
  try {
    const admissionId = await args.loadDb(records, {
      sourceName: "official-cac-detail",
      dataVersion: args.dataVersion,
      departmentName: detail.departmentName,
    });
    stages.push("LOADED");
    return { target, status: "LOADED", stages, admissionId, sha256: null, reasons };
  } catch (err) {
    return fail("LOADED", err instanceof Error ? err.message : String(err));
  }
}

export interface RunnerCallbacks {
  onDeptStart?: (target: RunnerTarget, remaining: number) => void;
  onDeptDone?: (outcome: DeptOutcome) => void;
}

export interface QueueHooks {
  ensureTab: () => Promise<{ wsUrl: string }>;
  acquire: (target: RunnerTarget, wsUrl: string) => Promise<DeptOutcome>;
  isLoaded: (target: RunnerTarget) => boolean;
  sleep: (ms: number) => Promise<void>;
  delayMs: number;
  onEvent?: (line: string) => void;
}

/**
 * Queue orchestrator: skip LOADED, lazily ensure the single tab only when
 * work exists, run targets strictly sequentially, stop hard on traffic.
 * No parallelism by construction (awaited loop).
 */
export async function runQueue(targets: RunnerTarget[], hooks: QueueHooks): Promise<DeptOutcome[]> {
  const pending = targets.filter((t) => !hooks.isLoaded(t));
  const outcomes: DeptOutcome[] = [];
  if (pending.length === 0) return outcomes;
  const { wsUrl } = await hooks.ensureTab();
  for (let i = 0; i < pending.length; i++) {
    const target = pending[i]!;
    hooks.onEvent?.(`Current: ${target.departmentCode}`);
    const outcome = await hooks.acquire(target, wsUrl);
    outcomes.push(outcome);
    hooks.onEvent?.(`Done: ${target.departmentCode} ${outcome.status}`);
    if (outcome.status === "TRAFFIC_LIMITED") break;
    // Throttle between successful captures regardless of mode (LOADED in
    // full mode, CAPTURED in capture-only mode).
    if ((outcome.status === "LOADED" || outcome.status === "CAPTURED") && i < pending.length - 1) {
      await hooks.sleep(hooks.delayMs);
    }
  }
  return outcomes;
}

export { DEFAULT_RUNNER_CONFIG, ensureSingleTab, navigateAndSettle, storeCapture };
export type { RunnerCdpDeps, RunnerConfig };

/**
 * Pure report-line builder for run summaries. In capture-only mode the two
 * required markers are always emitted; databaseWriteAttempted must be wired
 * to a real flag flipped by the (forbidden) loadDb stub, never hardcoded.
 */
export function summarizeOutcomes(
  outcomes: DeptOutcome[],
  opts: { captureOnly: boolean; databaseWriteAttempted: boolean },
): string[] {
  const loaded = outcomes.filter((o) => o.status === "LOADED").length;
  if (!opts.captureOnly) {
    return [`capture_only=false`, `done: loaded=${loaded}`];
  }
  const captured = outcomes.filter((o) => o.status === "CAPTURED").length;
  const failed = outcomes.filter((o) => o.status === "FAILED").length;
  const limited = outcomes.filter((o) => o.status === "TRAFFIC_LIMITED").length;
  return [
    `capture_only=true`,
    `database_write_attempted=${opts.databaseWriteAttempted}`,
    `done: captured=${captured} failed=${failed} traffic_limited=${limited} loaded=${loaded}`,
  ];
}
