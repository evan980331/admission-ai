import { parseDetailHtml } from "../importers/official/application115/detail/parser";
import { fromDetailRecord } from "../../domain/admission/fromDetail";
import { auditCanonicalCompleteness } from "../../domain/admission/validation";
import { toDbRecords, type DbAdmissionRecords } from "../../domain/admission/toDbRecords";
import { executeDbLoad, type DbClient } from "../loaders/official/admission";
import { buildAdmissionExistenceQuery, sha256Hex } from "./reconcile";
import {
  diffDbRecords,
  identityKey,
  type DbSourcedAdmission,
} from "./admission115";

/**
 * Scoped reconcile applier (P4.4b decision track).
 *
 * Scope is FROZEN to the 16 approved identities below (the 16 departments
 * carrying the 23 reported diffs). Comparison rules are NOT duplicated:
 * planning reuses diffDbRecords / parseDetailHtml / fromDetailRecord /
 * auditCanonicalCompleteness / toDbRecords, and applying reuses
 * executeDbLoad. Anything outside the allowlist with a non-empty diff
 * BLOCKS the whole batch (fail-closed); out-of-scope errors are never
 * silently ignored. The global --import gate is untouched.
 */

export const SCOPED_ALLOWLIST: ReadonlyArray<string> = [
  "115|001|001262|application",
  "115|002|002532|application",
  "115|002|002552|application",
  "115|002|002562|application",
  "115|002|002572|application",
  "115|002|002582|application",
  "115|005|005092|application",
  "115|005|005252|application",
  "115|008|008382|application",
  "115|008|008432|application",
  "115|009|009032|application",
  "115|009|009062|application",
  "115|009|009432|application",
  "115|009|009452|application",
  "115|011|011552|application",
  "115|011|011562|application",
];

const ALLOW = new Set(SCOPED_ALLOWLIST);

/** New source-data version for scoped writes; historical rows keep theirs. */
export const SCOPED_DATA_VERSION = "reconcile-115-v1";

export type PlannedDisposition = "UPDATE" | "SKIP_UNCHANGED" | "REJECT";

export interface RawBundle {
  html: string;
  /** meta.sha256 read from the sidecar file. */
  metaSha256: string;
  sourceUrl: string | null;
}

export interface PlanInput {
  row: DbSourcedAdmission;
  /** Null when the raw file is absent (-> REJECT, never guessed). */
  raw: RawBundle | null;
}

export interface PlannedItem {
  key: string;
  departmentCode: string;
  inScope: boolean;
  disposition: PlannedDisposition;
  reasons: string[];
  /** Non-empty diff strings (re-parse vs DB). Empty when unchanged. */
  diffs: string[];
  records: DbAdmissionRecords | null;
  rawSha: string | null;
  parserVersion: string | null;
}

export interface ScopedPlan {
  valid: boolean;
  blocked: string[];
  items: PlannedItem[];
  updateCount: number;
  skipCount: number;
  rejectCount: number;
}

const keyOf = (row: DbSourcedAdmission): string =>
  identityKey(row.year, row.schoolCode, row.departmentCode, row.programType);

/**
 * Pure planning step (no I/O beyond the injected bundles): re-parse,
 * re-validate, SHA-check, diff. Never writes. A plan containing any REJECT
 * item is invalid and applyScopedPlan will refuse it without touching the
 * database.
 */
export function planScopedFixes(inputs: PlanInput[]): ScopedPlan {
  const items: PlannedItem[] = [];
  const blocked: string[] = [];
  for (const { row, raw } of inputs) {
    const key = keyOf(row);
    const inScope = ALLOW.has(key);
    const reject = (reasons: string[], diffs: string[] = []): PlannedItem => {
      const item: PlannedItem = {
        key, departmentCode: row.departmentCode, inScope, disposition: "REJECT",
        reasons, diffs, records: null, rawSha: null, parserVersion: null,
      };
      items.push(item);
      blocked.push(`${key}: ${reasons.join("; ")}`);
      return item;
    };
    if (!raw) {
      reject(["raw file absent"]);
      continue;
    }
    const rawSha = sha256Hex(raw.html);
    if (rawSha !== raw.metaSha256) {
      reject(["raw SHA mismatch (meta vs recomputed)"]);
      continue;
    }
    const parsed = parseDetailHtml(raw.html, { sourceUrl: raw.sourceUrl ?? `local-file:115_${row.departmentCode}.htm`, dataVersion: "scoped-plan" });
    const recErrors = parsed.issues.filter((i) => i.level === "error");
    if (!parsed.record || recErrors.length > 0) {
      reject(["re-parse failed: " + recErrors.map((i) => `${i.check}: ${i.detail}`).join("; ")]);
      continue;
    }
    const { canonical, issues: convIssues } = fromDetailRecord(parsed.record);
    const canonErrors = [...convIssues, ...auditCanonicalCompleteness(parsed.record, canonical)].filter((i) => i.level === "error");
    if (canonErrors.length > 0) {
      reject(["re-validate failed: " + canonErrors.map((i) => `${i.check}: ${i.detail}`).join("; ")]);
      continue;
    }
    const expected = toDbRecords(canonical);
    const diffs = diffDbRecords(key, expected, row);
    if (diffs.length === 0) {
      items.push({
        key, departmentCode: row.departmentCode, inScope, disposition: "SKIP_UNCHANGED",
        reasons: ["live diff empty: already applied"], diffs: [], records: null,
        rawSha, parserVersion: parsed.record.parserVersion,
      });
      continue;
    }
    if (!inScope) {
      reject([`non-empty diff outside approved scope (${diffs.length} diffs); refusing whole batch`], diffs);
      continue;
    }
    items.push({
      key, departmentCode: row.departmentCode, inScope, disposition: "UPDATE",
      reasons: [], diffs, records: expected, rawSha, parserVersion: parsed.record.parserVersion,
    });
  }
  const updateCount = items.filter((i) => i.disposition === "UPDATE").length;
  const skipCount = items.filter((i) => i.disposition === "SKIP_UNCHANGED").length;
  const rejectCount = items.filter((i) => i.disposition === "REJECT").length;
  return { valid: blocked.length === 0, blocked, items, updateCount, skipCount, rejectCount };
}

export interface ApplyResult {
  applied: string[];
  skipped: string[];
}

export interface PlansComparison {
  equal: boolean;
  reasons: string[];
}

/**
 * Plan-equality check for the dry-run/apply seam: the --apply path builds
 * a SECOND fresh plan immediately before writing and requires it to match
 * the reviewed plan key-by-key (disposition, diffs, raw SHA, parser
 * version). Any drift in raw files or DB rows between review and execution
 * aborts with zero writes. Pure.
 */
export function plansEqual(a: ScopedPlan, b: ScopedPlan): PlansComparison {
  const reasons: string[] = [];
  const byKey = (p: ScopedPlan): Map<string, PlannedItem> => new Map(p.items.map((i) => [i.key, i]));
  const am = byKey(a);
  const bm = byKey(b);
  if (am.size !== bm.size) reasons.push(`item count ${am.size} != ${bm.size}`);
  for (const [key, ia] of am) {
    const ib = bm.get(key);
    if (!ib) {
      reasons.push(`${key}: vanished from second plan`);
      continue;
    }
    if (ia.disposition !== ib.disposition) reasons.push(`${key}: disposition ${ia.disposition} != ${ib.disposition}`);
    if (JSON.stringify(ia.diffs) !== JSON.stringify(ib.diffs)) reasons.push(`${key}: diff set changed`);
    if (ia.rawSha !== ib.rawSha) reasons.push(`${key}: raw SHA changed`);
    if (ia.parserVersion !== ib.parserVersion) reasons.push(`${key}: parser version changed`);
  }
  for (const key of bm.keys()) {
    if (!am.has(key)) reasons.push(`${key}: appeared in second plan`);
  }
  return { equal: reasons.length === 0, reasons };
}

/**
 * Executes a VALID plan in ONE transaction (all-or-nothing). Per UPDATE
 * item: pre-existence assertion (exactly one admission row; the UPSERT must
 * resolve to it — the returned id is compared, so a silent INSERT is
 * impossible), then the existing executeDbLoad path (no new SQL, no
 * ensureDepartmentMaster: departments must already exist). Any failure —
 * including a post-hoc id mismatch — rolls back the entire batch.
 */
export async function applyScopedPlan(
  client: DbClient,
  plan: ScopedPlan,
  opts: { sourceName: string; departmentNameOf: (departmentCode: string) => string | null },
): Promise<ApplyResult> {
  if (!plan.valid || plan.items.some((i) => i.disposition === "REJECT")) {
    throw new Error(`scoped apply refused: ${plan.blocked.length} blocked item(s): ${plan.blocked.slice(0, 3).join(" | ")}`);
  }
  const updates = plan.items.filter((i) => i.disposition === "UPDATE");
  const skipped = plan.items.filter((i) => i.disposition === "SKIP_UNCHANGED").map((i) => i.key);
  const applied: string[] = [];
  if (updates.length === 0) return { applied, skipped };
  await client.query("BEGIN");
  try {
    for (const item of updates) {
      if (!item.records) {
        throw new Error(`scoped apply refused: UPDATE item without records for ${item.key}`);
      }
      const [year, schoolCode, departmentCode, programType] = item.key.split("|");
      const q = buildAdmissionExistenceQuery(Number(year), schoolCode!, departmentCode!, programType!);
      const found = await client.query(q.text, q.values);
      const preId = found.rows.length === 1 ? (found.rows[0]!["id"] as string | undefined) : undefined;
      if (!preId) {
        throw new Error(`scoped apply refused: admission absent or ambiguous for ${item.key} (never INSERT via reconcile)`);
      }
      const returnedId = await executeDbLoad(client, item.records!, {
        sourceName: opts.sourceName,
        dataVersion: SCOPED_DATA_VERSION,
        departmentName: opts.departmentNameOf(item.departmentCode),
        parserVersion: item.parserVersion ?? undefined,
      });
      if (returnedId !== preId) {
        throw new Error(`scoped apply refused: UPSERT resolved to unexpected admission for ${item.key}`);
      }
      applied.push(item.key);
    }
    await client.query("COMMIT");
    return { applied, skipped };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
