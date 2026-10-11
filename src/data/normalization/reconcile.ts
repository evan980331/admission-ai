import { createHash } from "node:crypto";
import type { SqlStatement } from "../loaders/official/admission";

/**
 * P4.4b-4 offline reconcile core (Fix List Contract v1, P4.4b-3).
 *
 * Pure, offline, side-effect free: no pg import, no fs access (file reads
 * are injected), no network, no writes. Anything that touches a real
 * database (006 apply, scoped apply, advisory locks) is OUT OF SCOPE here
 * and stays pending isolated-PostgreSQL verification (H-C).
 *
 * Interim decisions honored: list-only modeling (no apply path in this
 * module); parser "unknown" preserved verbatim; no manual-override column;
 * mutex here is process-local only (NOT a cross-process lock claim);
 * data_version vs runId never mixed (list carries both, separately).
 */

export const FIX_LIST_SCHEMA_VERSION = "reconcile-list-v1";

export type ItemDisposition =
  | "PENDING_APPROVAL"
  | "READY"
  | "ALREADY_APPLIED"
  | "REJECTED"
  | "BLOCKED";

export interface FixIdentity {
  year: number;
  schoolCode: string;
  departmentCode: string;
  programType: string;
  /** Admission UUID read from the DB at list-generation time, never derived. */
  admissionId: string;
}

export interface RawRef {
  htmlPath: string;
  metaPath: string;
  /** sha256(raw file) recomputed at generation time. */
  sha256: string;
  /** Full meta columns kept for the T1 re-read comparison. */
  meta: { sourceUrl: string; capturedAt: string | null; sha256: string; departmentCode: string; schoolCode: string };
}

/** One differing column only. Snapshots are forbidden as write sources. */
export interface FieldChange {
  table: string;
  rowKey: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface ItemChecks {
  reparseErrors: number;
  normalizeErrors: string[];
  drift: string[];
  completenessErrors: string[];
  orderDiffs: string[];
}

export interface FixListItem {
  identity: FixIdentity;
  raw: RawRef;
  /** Parser version that produced expectedNew, or the literal "unknown". */
  parserVersion: string;
  changes: FieldChange[];
  checks: ItemChecks;
  disposition: ItemDisposition;
  blockReason?: string;
}

export interface FixList {
  schemaVersion: string;
  runId: string;
  generatedAt: string;
  generator: string;
  source: { academicYear: number; inventoryScope: string; rawRoot: string };
  dataVersion: string;
  scope: string[];
  items: FixListItem[];
  unlistedErrors: { identityKey: string; check: string; detail: string }[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/i;
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Structural validation only (never consults a database). Returns error
 * strings; empty = schema-valid. Tampered fields and unsupported
 * schemaVersion are rejected here, never downstream.
 */
export function validateFixListSchema(list: unknown): string[] {
  const errs: string[] = [];
  if (!isRec(list)) return ["list must be an object"];
  if (list["schemaVersion"] !== FIX_LIST_SCHEMA_VERSION) {
    return [`unsupported schemaVersion: ${JSON.stringify(list["schemaVersion"])} (supports ${FIX_LIST_SCHEMA_VERSION})`];
  }
  for (const f of ["runId", "generatedAt", "generator", "dataVersion"] as const) {
    if (typeof list[f] !== "string" || (list[f] as string).length === 0) errs.push(`missing ${f}`);
  }
  if (typeof list["runId"] === "string" && !UUID_RE.test(list["runId"] as string)) errs.push("runId must be a UUID");
  if (!isRec(list["source"])) errs.push("missing source");
  if (!Array.isArray(list["scope"])) errs.push("scope must be an array");
  if (!Array.isArray(list["items"])) return [...errs, "items must be an array"];
  const scope = new Set((list["scope"] as unknown[]).filter((s): s is string => typeof s === "string"));
  for (const [i, raw] of (list["items"] as unknown[]).entries()) {
    const at = `items[${i}]`;
    if (!isRec(raw)) {
      errs.push(`${at} must be an object`);
      continue;
    }
    const id = raw["identity"];
    if (!isRec(id)) {
      errs.push(`${at}.identity missing`);
      continue;
    }
    if (id["year"] !== 115) errs.push(`${at}.identity.year must be 115`);
    if (typeof id["schoolCode"] !== "string" || !/^\d{3}$/.test(id["schoolCode"] as string)) errs.push(`${at}.identity.schoolCode must be 3 digits`);
    if (typeof id["departmentCode"] !== "string" || !/^\d{6}$/.test(id["departmentCode"] as string)) errs.push(`${at}.identity.departmentCode must be 6 digits`);
    if (
      typeof id["schoolCode"] === "string" &&
      typeof id["departmentCode"] === "string" &&
      !(id["departmentCode"] as string).startsWith(id["schoolCode"] as string)
    ) {
      errs.push(`${at}.identity: departmentCode does not start with schoolCode`);
    }
    if (typeof id["programType"] !== "string" || (id["programType"] as string).length === 0) errs.push(`${at}.identity.programType missing`);
    if (typeof id["admissionId"] !== "string" || !UUID_RE.test(id["admissionId"] as string)) errs.push(`${at}.identity.admissionId must be a UUID`);
    const key = `${String(id["year"])}|${String(id["schoolCode"])}|${String(id["departmentCode"])}|${String(id["programType"])}`;
    if (!scope.has(key)) errs.push(`${at} identity ${key} not in scope`);
    const rr = raw["raw"];
    if (!isRec(rr)) {
      errs.push(`${at}.raw missing`);
    } else {
      if (typeof rr["sha256"] !== "string" || !SHA_RE.test(rr["sha256"] as string)) errs.push(`${at}.raw.sha256 must be hex64`);
      for (const f of ["htmlPath", "metaPath"] as const) {
        if (typeof rr[f] !== "string" || (rr[f] as string).length === 0) errs.push(`${at}.raw.${f} missing`);
      }
    }
    if (typeof raw["parserVersion"] !== "string" || (raw["parserVersion"] as string).length === 0) {
      errs.push(`${at}.parserVersion missing (use "unknown", never guess)`);
    }
    if (!Array.isArray(raw["changes"]) || (raw["changes"] as unknown[]).length === 0) {
      errs.push(`${at}.changes must be a non-empty array (diff-only, no snapshots)`);
    } else {
      for (const [j, c] of (raw["changes"] as unknown[]).entries()) {
        if (!isRec(c) || typeof c["table"] !== "string" || typeof c["field"] !== "string") {
          errs.push(`${at}.changes[${j}] malformed`);
          continue;
        }
        if (JSON.stringify(c["oldValue"] ?? null) === JSON.stringify(c["newValue"] ?? null)) {
          errs.push(`${at}.changes[${j}] oldValue equals newValue (not a change)`);
        }
      }
    }
    const disp = (raw as Record<string, unknown>)["disposition"];
    if (!["PENDING_APPROVAL", "READY", "ALREADY_APPLIED", "REJECTED", "BLOCKED"].includes(disp as string)) {
      errs.push(`${at}.disposition invalid`);
    }
  }
  if (!Array.isArray(list["unlistedErrors"])) errs.push("unlistedErrors must be an array");
  return errs;
}

/** Offline sha256 (hex). Only ever applied to injected file content. */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface ShaEvidence {
  listSha: string;
  metaSha: string;
  actualSha: string | null;
  metaMatch: boolean;
}

/**
 * Three-way SHA check (contract §2.3): list value vs meta value vs freshly
 * read raw file. readFile is injected (returns null when absent) so this
 * stays pure and testable. Errors are fail-closed strings.
 */
export function verifyItemSha(
  item: FixListItem,
  readFile: (path: string) => string | null,
): { ok: boolean; errors: string[]; evidence: ShaEvidence } {
  const errors: string[] = [];
  const html = readFile(item.raw.htmlPath);
  const actualSha = html === null ? null : sha256Hex(html);
  const evidence: ShaEvidence = { listSha: item.raw.sha256, metaSha: item.raw.meta.sha256, actualSha, metaMatch: false };
  if (html === null) {
    errors.push(`raw file absent: ${item.raw.htmlPath}`);
    return { ok: false, errors, evidence };
  }
  if (item.raw.sha256 !== item.raw.meta.sha256) {
    errors.push(`list sha != meta sha for ${item.identity.departmentCode}`);
  }
  if (actualSha !== item.raw.sha256 || actualSha !== item.raw.meta.sha256) {
    errors.push(`raw file changed since list generation for ${item.identity.departmentCode}`);
  }
  const metaRaw = readFile(item.raw.metaPath);
  if (metaRaw === null) {
    errors.push(`meta file absent: ${item.raw.metaPath}`);
    return { ok: false, errors, evidence };
  }
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(metaRaw) as Record<string, unknown>;
  } catch {
    errors.push(`meta file unparseable: ${item.raw.metaPath}`);
    return { ok: false, errors, evidence };
  }
  evidence.metaMatch =
    meta["sha256"] === item.raw.meta.sha256 &&
    meta["departmentCode"] === item.raw.meta.departmentCode &&
    meta["sourceUrl"] === item.raw.meta.sourceUrl;
  if (!evidence.metaMatch) errors.push(`meta content mismatch for ${item.identity.departmentCode}`);
  return { ok: errors.length === 0, errors, evidence };
}

export function fieldChangeKey(c: FieldChange): string {
  return `${c.table}|${c.rowKey}|${c.field}`;
}

/** Set equality of change sets (contract §3-6: no more, no fewer). */
export function fieldSetEquals(a: FieldChange[], b: FieldChange[]): boolean {
  const ka = a.map(fieldChangeKey).sort();
  const kb = b.map(fieldChangeKey).sort();
  return JSON.stringify(ka) === JSON.stringify(kb);
}

export interface OrderCheck {
  contentDiffs: string[];
  orderDiffs: string[];
}

/**
 * D5 order-sensitive comparison. Rows are matched by CONTENT key (all
 * fields except the order field); content differences are reported as
 * contentDiffs, while identical content in a different sequence is reported
 * as orderDiffs — never silently absorbed the way position-inclusive
 * sorting would. Duplicate content keys fall back to pairwise compare.
 */
export function orderSensitiveCompare(
  expected: Record<string, unknown>[],
  actual: Record<string, unknown>[],
  fields: string[],
  orderField = "position",
): OrderCheck {
  const contentDiffs: string[] = [];
  const orderDiffs: string[] = [];
  const contentFields = fields.filter((f) => f !== orderField);
  const keyFields = contentFields.length > 0 ? contentFields : fields;
  const ckey = (r: Record<string, unknown>) => JSON.stringify(keyFields.map((f) => (r[f] === undefined ? null : r[f])));
  if (expected.length !== actual.length) {
    contentDiffs.push(`row count ${actual.length} != expected ${expected.length}`);
    return { contentDiffs, orderDiffs };
  }
  const eKeys = expected.map(ckey).sort();
  const aKeys = actual.map(ckey).sort();
  if (JSON.stringify(eKeys) !== JSON.stringify(aKeys)) {
    const canon = (r: Record<string, unknown>) => JSON.stringify(fields.map((f) => (r[f] === undefined ? null : r[f])));
    const e = [...expected].sort((x, y) => (canon(x) < canon(y) ? -1 : 1));
    const d = [...actual].sort((x, y) => (canon(x) < canon(y) ? -1 : 1));
    for (let i = 0; i < e.length; i++) {
      for (const f of fields) {
        if (JSON.stringify(e[i]![f] ?? null) !== JSON.stringify(d[i]![f] ?? null)) {
          contentDiffs.push(`[${i}].${f}: ${JSON.stringify(d[i]![f] ?? null)} != ${JSON.stringify(e[i]![f] ?? null)}`);
        }
      }
    }
    return { contentDiffs, orderDiffs };
  }
  if (new Set(eKeys).size !== eKeys.length) {
    contentDiffs.push("duplicate content keys: order attribution ambiguous, manual review required");
    return { contentDiffs, orderDiffs };
  }
  const byKey = (rows: Record<string, unknown>[]) => {
    const m = new Map<string, Record<string, unknown>>();
    for (const r of rows) m.set(ckey(r), r);
    return m;
  };
  const em = byKey(expected);
  const am = byKey(actual);
  const eOrder = [...em.keys()].sort().map((k) => em.get(k)![orderField]);
  const aOrder = [...am.keys()].sort().map((k) => am.get(k)![orderField]);
  if (JSON.stringify(eOrder) !== JSON.stringify(aOrder)) {
    orderDiffs.push(`order differs: expected ${orderField} sequence ${JSON.stringify(eOrder)} != actual ${JSON.stringify(aOrder)} (same content, different sequence)`);
  }
  return { contentDiffs, orderDiffs };
}

export interface LiveState {
  admissionFound: boolean;
  identityMatch: boolean;
  /** Freshly recomputed diff (DB vs re-parse); empty = already applied. */
  currentChanges: FieldChange[];
}

export interface Classification {
  disposition: "READY" | "ALREADY_APPLIED" | "REJECTED";
  reasons: string[];
}

/**
 * Pre-apply disposition (contract §3-1/4/6/9). Pure: the caller supplies
 * the freshly read live state; this function never touches I/O.
 */
export function classifyLiveState(item: FixListItem, live: LiveState): Classification {
  if (!live.admissionFound) return { disposition: "REJECTED", reasons: ["admission absent: refusing (never INSERT via reconcile)"] };
  if (!live.identityMatch) return { disposition: "REJECTED", reasons: ["identity mismatch: DB (admissionId, code, school) != list"] };
  if (live.currentChanges.length === 0) return { disposition: "ALREADY_APPLIED", reasons: ["live diff empty: already applied, no rewrite"] };
  if (!fieldSetEquals(live.currentChanges, item.changes)) {
    return { disposition: "REJECTED", reasons: ["live diff != listed diff: DB changed since review (no more, no fewer)"] };
  }
  return { disposition: "READY", reasons: [] };
}

/** Scope accounting (contract: out-of-scope errors stay reported, never claimed fixed). */
export function partitionScopeErrors(
  all: { identityKey: string }[],
  scope: Set<string>,
): { inScope: { identityKey: string }[]; outOfScope: { identityKey: string }[] } {
  const inScope: { identityKey: string }[] = [];
  const outOfScope: { identityKey: string }[] = [];
  for (const e of all) (scope.has(e.identityKey) ? inScope : outOfScope).push(e);
  return { inScope, outOfScope };
}

/**
 * Minimal pre-existence assertion query (contract §3-1). NEW statement
 * (the existing loader has no admission-existence check — its UPSERT would
 * INSERT a missing admission). Joins the same masters the loader resolves
 * so the check and the write can never disagree on identity.
 */
export function buildAdmissionExistenceQuery(
  year: number,
  schoolCode: string,
  departmentCode: string,
  programType: string,
): SqlStatement {
  return {
    text: `SELECT a.id FROM department_admissions a JOIN departments d ON d.id = a.department_id JOIN schools s ON s.id = d.school_id JOIN admission_programs ap ON ap.id = a.program_id WHERE a.year = $1 AND s.school_code = $2 AND d.department_code = $3 AND ap.program_type = $4`,
    values: [year, schoolCode, departmentCode, programType],
  };
}

/** Minimal read interface for the pre-existence assertion (SELECT only). */
export interface ExistenceClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Testable admission pre-existence assertion (contract §3-1/2). SELECT
 * only — never writes, never creates. Fail-closed: zero rows (absent) or
 * more than one row (identity ambiguous) both throw; the caller must abort
 * the whole batch without touching the loader.
 */
export async function assertAdmissionPreexists(
  client: ExistenceClient,
  identity: FixIdentity,
): Promise<string> {
  const q = buildAdmissionExistenceQuery(identity.year, identity.schoolCode, identity.departmentCode, identity.programType);
  const res = await client.query(q.text, q.values);
  if (res.rows.length === 0) {
    throw new Error(
      `reconcile refused: admission absent for ${identity.schoolCode}/${identity.departmentCode} (never INSERT via reconcile)`,
    );
  }
  if (res.rows.length > 1) {
    throw new Error(`reconcile refused: ambiguous identity for ${identity.schoolCode}/${identity.departmentCode} (${res.rows.length} rows)`);
  }
  const id = res.rows[0]!["id"];
  if (typeof id !== "string" || id.length === 0) throw new Error("reconcile refused: admission id unreadable");
  if (id !== identity.admissionId) {
    throw new Error(`reconcile refused: admissionId mismatch (list ${identity.admissionId} != db ${id})`);
  }
  return id;
}

/**
 * Concurrency mutual-exclusion interface (D6). PROCESS-LOCAL ONLY: this
 * in-memory implementation proves the acquire/fail protocol in tests but
 * proves nothing across processes. Real PostgreSQL advisory-lock behavior
 * is explicitly pending H-C verification; no DB apply may rely on this.
 */
export interface ReconcileMutex {
  tryAcquire(owner: string): boolean;
  release(owner: string): void;
}

export function createInMemoryMutex(): ReconcileMutex {
  let holder: string | null = null;
  return {
    tryAcquire(owner: string): boolean {
      if (holder !== null) return false;
      holder = owner;
      return true;
    },
    release(owner: string): void {
      if (holder === owner) holder = null;
    },
  };
}
