import type { DbAdmissionRecords } from "../../domain/admission/toDbRecords";

/**
 * P4 admission-115 normalization (DB-sourced).
 *
 * P3 already parsed/validated/imported every record into the canonical
 * tables; there is deliberately NO separate normalized table (no migration
 * by design). P4 therefore normalizes FROM the canonical DB rows into a
 * deterministic in-memory representation, validates it, cross-checks it
 * against a fresh re-parse of the P3 raw HTML (verification only, never
 * re-fetched), and reconciles via the existing idempotent loader.
 *
 * Data-derived structural rules (live DB, 496 rows across 10 schools):
 *   every admission has ssr>=1, over_quota>=0 (warning if 0), secondStage>=1,
 *   review>=1, special>=1, schedule=1, notices>=1; tie_break>=0 and apcs>=0
 *   are optional (only APCS-group departments carry apcs rows — absence is
 *   NOT error; 008 carries none at all). Pure-tech admissions (no GSAT
 *   subject rules, e.g. 008432/009432) pass screening via tech items with a
 *   tech-only-screening warning, subject to raw corroboration in the runner
 *   script. Error thresholds below are set at the structural minimum so
 *   every school is judged by shape, never by assumed content.
 */

export const P4_PARSER_VERSION = "p4-normalize-v0.1.0";
export const P4_DATA_VERSION = "p4-normalize-115";
export const P4_SOURCE_NAME = "official-cac-detail";
/** Reuse the P3 source row so reconciliation never repoints source_id. */
export const P4_SOURCE_DATA_VERSION = "acquire-runner";

/**
 * Official 115 school_code -> expected admission count. Explicit record,
 * never a numeric range: 010 does not exist officially and must never be
 * added here. Totals are always derived from this table.
 */
export const P4_EXPECTED_COUNTS: Record<string, number> = {
  "001": 73,
  "002": 58,
  "003": 51,
  "004": 65,
  "005": 25,
  "006": 47,
  "007": 32,
  "008": 43,
  "009": 45,
  "011": 57,
};

export const P4_OFFICIAL_SCHOOL_CODES: readonly string[] = Object.keys(P4_EXPECTED_COUNTS).sort();

export function p4ExpectedTotal(schoolCode?: string): number {
  if (schoolCode === undefined) {
    return Object.values(P4_EXPECTED_COUNTS).reduce((n, c) => n + c, 0);
  }
  const n = P4_EXPECTED_COUNTS[schoolCode];
  if (n === undefined) throw new Error(`unknown official school code: ${schoolCode}`);
  return n;
}

export interface P4Requirements {
  chinese: string | null;
  english: string | null;
  math_a: string | null;
  math_b: string | null;
  social: string | null;
  science: string | null;
  english_listening: string | null;
}

export interface DbSourcedAdmission {
  year: number;
  schoolCode: string;
  schoolName: string;
  departmentCode: string;
  departmentName: string;
  groupName: string | null;
  programType: string;
  quota: number | null;
  requirements: P4Requirements;
  sourceUrl: string | null;
  firstStageWeight: string | null;
  secondStageWeight: string | null;
  sourceName: string | null;
  dataVersion: string | null;
  children: {
    subjects: Array<{ position: number; subject: string; requirement: string | null; multiplier: unknown; scoreMethod: string | null; status: string; sourceText: string }>;
    sequences: Array<{ kind: string; position: number; subjects: string | null; description: string; sourceText: string }>;
    secondStage: Array<{ position: number; name: string; requirement: string | null; weight: string | null; itemType: string | null; description: string | null; sourceText: string }>;
    apcs: Array<{ position: number; subject: string; requirement: string | null; multiplier: unknown; note: string | null; sourceText: string }>;
    review: Array<{ position: number; categoryCode: string | null; categoryName: string | null; required: string | null; minimumCount: unknown; maximumCount: unknown; description: string | null; restriction: string | null; sourceText: string }>;
    special: Array<{ kind: string; value: string | null; sourceText: string | null }>;
    schedule: null | { applicationFee: unknown; applicationFeeSource: string | null; notificationDate: unknown; notificationSource: string | null; materialDeadline: unknown; materialDeadlineSource: string | null; secondStageDate: unknown; secondStageDateSource: string | null; resultDate: unknown; resultDateSource: string | null; recheckDeadline: unknown; recheckDeadlineSource: string | null };
    notices: Array<{ position: number; type: string; text: string; sourceText: string }>;
    techGroup: null | { weight: unknown; weightStatus: string | null; sourceText: string | null; admissionId: unknown };
    techItems: Array<{ position: number; name: string; requirement: string | null; multiplier: unknown; scoreMethod: string | null; sourceText: string | null; groupAdmission: unknown; itemAdmission: unknown }>;
  };
}

export interface NormalizedAdmission115 {
  identityKey: string;
  year: number;
  schoolCode: string;
  schoolName: string;
  departmentCode: string;
  departmentName: string;
  groupName: string | null;
  programType: string;
  quota: number;
  childCounts: Record<"subjects" | "overQuota" | "tieBreak" | "secondStage" | "apcs" | "review" | "special" | "schedule" | "notices" | "techGroups" | "techItems", number>;
  provenance: { sourceUrl: string; sourceName: string; dataVersion: string };
}

export interface NormIssue {
  level: "error" | "warning";
  check: string;
  detail: string;
  identityKey?: string;
}

export function identityKey(year: number, schoolCode: string, departmentCode: string, programType: string): string {
  return `${year}|${schoolCode}|${departmentCode}|${programType}`;
}

/**
 * Pure-tech corroboration helper (P4.1d). Given a fresh re-parse's unmapped
 * list, returns GSAT-looking cells that never made it into subjects AND
 * whose screening content did not demonstrably survive. Bare `--`/empty
 * cells are expected on pure-tech pages; a `(second-stage captured: …)`
 * suffix (layout-B) proves the row's screening item was extracted, so such
 * rows are covered, not dropped. Anything else (composites included) means
 * a real subject may have been dropped and the row must NOT be classified
 * pure-tech.
 */
export function findDroppedGsatCells(unmapped: string[]): string[] {
  return (unmapped ?? []).filter((u) => {
    if (!u.startsWith("grade subject without mapping:")) return false;
    const rest = u.slice("grade subject without mapping:".length);
    if (/^\s*(--)?\s*$/.test(rest)) return false;
    if (/\(second-stage captured:/.test(rest)) return false;
    return true;
  });
}

/**
 * Dynamic normalize scope (64-school era). Derives the expected total from
 * the approved inventory instead of the frozen 10-school table:
 * department filter -> 1; school filter -> that school's inventory count
 * (unknown schools throw, preserving the fail-closed typo guard);
 * no filter -> whole-inventory total. P4_EXPECTED_COUNTS stays frozen for
 * the legacy regression suite; the runner uses this.
 */
export function resolveExpectedTotal(
  filters: { schoolCode?: string; departmentCode?: string },
  inventory: { total: number; perSchool: Map<string, number> },
): number {
  if (filters.departmentCode) return 1;
  if (filters.schoolCode) {
    const n = inventory.perSchool.get(filters.schoolCode);
    if (n === undefined) throw new Error(`unknown official school code: ${filters.schoolCode}`);
    return n;
  }
  return inventory.total;
}

/**
 * Explicit tech corroboration verdict (P4.1f). Parser-raw corroboration and
 * DB-schema validation are DIFFERENT layers: raw verdicts say what the
 * source contains; only rows whose DB tech layer exists can claim DB-level
 * verification. `not_checked` is never a pass. `not_applicable` marks rows
 * outside corroboration scope and must never count toward verification
 * completion (P4.1g).
 */
export type TechCorroborationStatus = "verified" | "failed" | "not_checked" | "not_applicable";

export interface TechCorroboration {
  identityKey: string;
  status: TechCorroborationStatus;
  reason: string;
}

export function corroborateTechRow(args: {
  identityKey: string;
  rawExists: boolean;
  reparseOk: boolean;
  dbSubjects: number;
  dbTechItems: number;
  reparseTechItems: number;
  droppedGsatCells: string[];
  dbTechTablesPresent: boolean;
}): TechCorroboration {
  const { identityKey } = args;
  if (!args.rawExists) {
    return { identityKey, status: "not_checked", reason: "raw file absent; corroboration impossible" };
  }
  if (!args.reparseOk) {
    return { identityKey, status: "failed", reason: "raw re-parse failed; nothing verifiable" };
  }
  if (args.dbSubjects > 0) {
    // Applicability follows Gate logic, not tech-item absence: the
    // tech-only-screening question arises exactly when subjects==0
    // (normalizeDbAdmission). Rows with GSAT rules are out of scope even if
    // they carry tech items (e.g. 002582-like rows with both).
    return { identityKey, status: "not_applicable", reason: "not a pure-tech candidate (has GSAT subject rules)" };
  }
  if (!args.dbTechTablesPresent) {
    return { identityKey, status: "not_checked", reason: "migration 006 absent; DB tech layer unverifiable" };
  }
  if (args.dbTechItems === 0) {
    return { identityKey, status: "failed", reason: "no tech evidence in DB; pure-tech uncorroborated" };
  }
  if (args.droppedGsatCells.length > 0) {
    return { identityKey, status: "failed", reason: `substantive GSAT-looking cells unmapped (${args.droppedGsatCells.slice(0, 3).join(" / ")}); not verifiable as pure-tech` };
  }
  if (args.reparseTechItems === 0) {
    return { identityKey, status: "failed", reason: "raw re-parse finds no tech items; DB/raw tech disagreement" };
  }
  return { identityKey, status: "verified", reason: "raw GSAT cells corroborate emptiness; DB tech items agree with re-parse" };
}

export function summarizeCorroboration(records: TechCorroboration[]): {
  counts: Record<TechCorroborationStatus, number>;
  identifiers: Record<TechCorroborationStatus, string[]>;
} {
  const counts: Record<TechCorroborationStatus, number> = { verified: 0, failed: 0, not_checked: 0, not_applicable: 0 };
  const identifiers: Record<TechCorroborationStatus, string[]> = { verified: [], failed: [], not_checked: [], not_applicable: [] };
  for (const r of records) {
    counts[r.status]++;
    identifiers[r.status].push(r.identityKey);
  }
  return { counts, identifiers };
}

export function normalizeDbAdmission(row: DbSourcedAdmission): { normalized: NormalizedAdmission115 | null; issues: NormIssue[] } {
  const issues: NormIssue[] = [];
  const err = (check: string, detail: string) => issues.push({ level: "error", check, detail });
  const key = identityKey(row.year, row.schoolCode, row.departmentCode, row.programType);

  if (!Number.isInteger(row.year) || row.year !== 115) err("year", `expected 115, got ${String(row.year)}`);
  if (!/^\d{3}$/.test(row.schoolCode)) err("school-code", `not 3 digits: ${row.schoolCode}`);
  if (!/^\d{6}$/.test(row.departmentCode)) err("department-code", `not 6 digits: ${row.departmentCode}`);
  else if (!row.departmentCode.startsWith(row.schoolCode)) err("code-mismatch", `${row.departmentCode} does not belong to school ${row.schoolCode}`);
  if (!row.departmentName || row.departmentName.trim() === "") err("department-name", "missing department name");
  if (!row.programType) err("program-type", "missing program type");
  if (row.quota === null || row.quota === undefined) err("quota", "NULL quota");
  else if (!Number.isInteger(row.quota) || (row.quota as number) < 0) err("quota", `impossible quota: ${String(row.quota)}`);
  if (!row.sourceUrl || row.sourceUrl.trim() === "") err("source-url", "missing source_url");

  const c = row.children;
  const overQuota = c.sequences.filter((s) => s.kind === "over_quota").length;
  const tieBreak = c.sequences.filter((s) => s.kind === "tie_break").length;
  const hasTechItems = c.techItems.length > 0;
  if (c.subjects.length < 1 && !hasTechItems) err("subjects", "no screening_subject_rules");
  else if (c.subjects.length < 1) {
    // Pure-tech candidate: no GSAT rules but substantive tech items. Recorded
    // as warning here; the runner script must corroborate from raw (no real
    // subject hiding in unmapped cells) before this counts as verified.
    issues.push({ level: "warning", check: "tech-only-screening", detail: `${key}: no GSAT subject rules; pure-tech screening pending raw corroboration`, identityKey: key });
  }
  if (c.secondStage.length < 1) err("second-stage", "no second_stage_items");
  if (c.review.length < 1) err("review", "no review_requirements");
  if (c.notices.length < 1) err("notices", "no admission_notices");
  if (c.schedule === null) err("schedule", "no admission_schedule row");
  if (overQuota < 1) issues.push({ level: "warning", check: "over-quota-absent", detail: `${key}: no over_quota sequence`, identityKey: key });
  if (c.special.length < 1) issues.push({ level: "warning", check: "special-sparse", detail: `${key}: no special_requirements`, identityKey: key });
  if (c.apcs.length < 1) issues.push({ level: "warning", check: "apcs-absent", detail: `${key}: no apcs rows (informational; only APCS-group departments carry them)`, identityKey: key });
  // Tech admission/group linkage: every item must resolve to this row's group.
  for (const t of c.techItems) {
    if (t.groupAdmission === null || t.groupAdmission === undefined || t.itemAdmission === null || t.itemAdmission === undefined) {
      err("tech-admission", `${key}: tech item ${t.name} missing admission linkage`);
    } else if (String(t.groupAdmission) !== String(t.itemAdmission)) {
      err("tech-admission", `${key}: tech item ${t.name} admission mismatch (item=${String(t.itemAdmission)} group=${String(t.groupAdmission)})`);
    }
  }
  if (c.techGroup !== null && c.techItems.length === 0) {
    issues.push({ level: "warning", check: "tech-group-empty", detail: `${key}: tech group with no items`, identityKey: key });
  }

  const fatal = issues.some((i) => i.level === "error");
  if (fatal) return { normalized: null, issues };
  return {
    normalized: {
      identityKey: key,
      year: row.year,
      schoolCode: row.schoolCode,
      schoolName: row.schoolName,
      departmentCode: row.departmentCode,
      departmentName: row.departmentName,
      groupName: row.groupName,
      programType: row.programType,
      quota: row.quota as number,
      childCounts: {
        subjects: c.subjects.length, overQuota, tieBreak, secondStage: c.secondStage.length,
        apcs: c.apcs.length, review: c.review.length, special: c.special.length,
        schedule: c.schedule === null ? 0 : 1, notices: c.notices.length,
        techGroups: c.techGroup === null ? 0 : 1, techItems: c.techItems.length,
      },
      provenance: { sourceUrl: (row.sourceUrl as string).trim(), sourceName: row.sourceName ?? P4_SOURCE_NAME, dataVersion: row.dataVersion ?? P4_SOURCE_DATA_VERSION },
    },
    issues,
  };
}

export interface BatchSummary {
  total: number;
  normalized: number;
  errors: number;
  warnings: number;
  duplicateKeys: string[];
  perSchool: Record<string, { total: number; normalized: number; errors: number; warnings: number }>;
  childTotals: Record<string, number>;
}

export function normalizeBatch(rows: DbSourcedAdmission[]): { records: NormalizedAdmission115[]; issues: NormIssue[]; summary: BatchSummary } {
  const records: NormalizedAdmission115[] = [];
  const issues: NormIssue[] = [];
  const seen = new Map<string, number>();
  const summary: BatchSummary = { total: rows.length, normalized: 0, errors: 0, warnings: 0, duplicateKeys: [], perSchool: {}, childTotals: { subjects: 0, overQuota: 0, tieBreak: 0, secondStage: 0, apcs: 0, review: 0, special: 0, schedule: 0, notices: 0, techGroups: 0, techItems: 0 } };

  for (const row of rows) {
    const { normalized, issues: rowIssues } = normalizeDbAdmission(row);
    const key = identityKey(row.year, row.schoolCode, row.departmentCode, row.programType);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    for (const i of rowIssues) issues.push({ ...i, identityKey: i.identityKey ?? key });
    const ps = (summary.perSchool[row.schoolCode] ??= { total: 0, normalized: 0, errors: 0, warnings: 0 });
    ps.total++;
    if (normalized) {
      records.push(normalized);
      summary.normalized++;
      ps.normalized++;
      for (const [k, v] of Object.entries(normalized.childCounts)) summary.childTotals[k] = (summary.childTotals[k] ?? 0) + v;
    }
  }
  for (const [key, n] of seen) {
    if (n > 1) {
      summary.duplicateKeys.push(key);
      issues.push({ level: "error", check: "duplicate-key", detail: `${key} appears ${n} times`, identityKey: key });
    }
  }
  for (const i of issues) {
    if (i.level === "error") summary.errors++;
    else summary.warnings++;
    if (i.identityKey) {
      const school = i.identityKey.split("|")[1] ?? "?";
      const ps = (summary.perSchool[school] ??= { total: 0, normalized: 0, errors: 0, warnings: 0 });
      if (i.level === "error") ps.errors++;
      else ps.warnings++;
    }
  }
  return { records, issues, summary };
}

/** pg tolerance: NUMERIC arrives as string, DATE as Date, null vs undefined. */
function toDay(v: unknown): string {
  if (v instanceof Date) {
    const m = `${v.getMonth() + 1}`.padStart(2, "0");
    const d = `${v.getDate()}`.padStart(2, "0");
    return `${v.getFullYear()}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

function sameValue(a: unknown, b: unknown): boolean {
  const na = a === null || a === undefined;
  const nb = b === null || b === undefined;
  if (na && nb) return true;
  if (na || nb) return false;
  if (a instanceof Date || b instanceof Date) return toDay(a) === toDay(b);
  if (typeof a === "number" || typeof b === "number") {
    if ((typeof a === "string" && a.trim() === "") || (typeof b === "string" && (b as string).trim() === "")) return false;
    const x = Number(a);
    const y = Number(b);
    if (Number.isNaN(x) || Number.isNaN(y)) return String(a) === String(b);
    return x === y;
  }
  return a === b;
}

function diffRows(table: string, key: string, expected: Array<Record<string, unknown>>, actual: Array<Record<string, unknown>>, fields: string[]): string[] {
  const out: string[] = [];
  if (expected.length !== actual.length) {
    out.push(`${table}: row count ${actual.length} != re-parsed ${expected.length}`);
    return out;
  }
  const sortKey = (r: Record<string, unknown>) => JSON.stringify(fields.map((f) => (r[f] === undefined ? null : r[f])));
  const e = [...expected].sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : 1));
  const d = [...actual].sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : 1));
  for (let i = 0; i < e.length; i++) {
    for (const f of fields) {
      if (!sameValue(e[i]![f], d[i]![f])) {
        out.push(`${table}[${i}].${f}: db=${JSON.stringify(d[i]![f])} != raw=${JSON.stringify(e[i]![f])}`);
      }
    }
  }
  return out;
}

/**
 * DB-vs-raw reconciliation diff. `expected` is a fresh re-parse of the P3
 * raw HTML (toDbRecords output); `actual` is the same admission read back
 * from the canonical tables. Empty diff = identical = skip write.
 */
export function diffDbRecords(key: string, expected: DbAdmissionRecords, actual: DbSourcedAdmission): string[] {
  const out: string[] = [];
  const H = (f: string, e: unknown, d: unknown) => {
    if (!sameValue(e, d)) out.push(`header.${f}: db=${JSON.stringify(d)} != raw=${JSON.stringify(e)}`);
  };
  H("academicYear", expected.header.academicYear, actual.year);
  H("schoolCode", expected.header.schoolCode, actual.schoolCode);
  H("departmentCode", expected.header.departmentCode, actual.departmentCode);
  H("quota", expected.header.quota, actual.quota);
  for (const k of ["chinese", "english", "math_a", "math_b", "social", "science", "english_listening"] as const) {
    H(`requirements.${k}`, expected.header.requirements[k], actual.requirements[k]);
  }
  H("firstStageWeight", expected.firstStageWeight, actual.firstStageWeight);
  H("secondStageWeight", expected.secondStageWeight, actual.secondStageWeight);
  H("sourceUrl", expected.provenance.sourceUrl, actual.sourceUrl);
  const A = actual.children;
  out.push(...diffRows("subjects", key, expected.subjects as unknown as Array<Record<string, unknown>>, A.subjects as unknown as Array<Record<string, unknown>>, ["position", "subject", "requirement", "multiplier", "scoreMethod", "status", "sourceText"]));
  out.push(...diffRows("sequences", key, expected.sequences as unknown as Array<Record<string, unknown>>, A.sequences as unknown as Array<Record<string, unknown>>, ["kind", "position", "subjects", "description", "sourceText"]));
  out.push(...diffRows("secondStage", key, expected.secondStage as unknown as Array<Record<string, unknown>>, A.secondStage as unknown as Array<Record<string, unknown>>, ["position", "name", "requirement", "weight", "itemType", "description", "sourceText"]));
  out.push(...diffRows("apcs", key, expected.apcs as unknown as Array<Record<string, unknown>>, A.apcs as unknown as Array<Record<string, unknown>>, ["position", "subject", "requirement", "multiplier", "note", "sourceText"]));
  // Tech group: presence must match; then weight/status/source; then items.
  // Item admission linkage is covered by the gate; drift compares content.
  // `?? null` because older callers may omit the key (absent == null here).
  const expTech = (expected.techGroup ?? null) as { weight: unknown; weightStatus: unknown; sourceText: unknown; items: Array<Record<string, unknown>> } | null;
  const actTech = (A.techGroup ?? null) as { weight: unknown; weightStatus: unknown; sourceText: unknown } | null;
  if ((expTech === null) !== (actTech === null)) {
    out.push(`tech-group presence db=${actTech === null ? "absent" : "present"} != raw=${expTech === null ? "absent" : "present"}`);
  } else if (expTech && actTech) {
    for (const f of ["weight", "weightStatus", "sourceText"] as const) {
      if (!sameValue(expTech[f], actTech[f])) out.push(`tech-group.${f}: db=${JSON.stringify(actTech[f])} != raw=${JSON.stringify(expTech[f])}`);
    }
    out.push(...diffRows("techItems", key, expTech.items, A.techItems as unknown as Array<Record<string, unknown>>, ["position", "name", "requirement", "multiplier", "scoreMethod", "sourceText"]));
  }
  out.push(...diffRows("review", key, expected.review as unknown as Array<Record<string, unknown>>, A.review as unknown as Array<Record<string, unknown>>, ["position", "categoryCode", "categoryName", "required", "minimumCount", "maximumCount", "description", "restriction", "sourceText"]));
  out.push(...diffRows("special", key, expected.special as unknown as Array<Record<string, unknown>>, A.special as unknown as Array<Record<string, unknown>>, ["kind", "value", "sourceText"]));
  if (A.schedule === null) out.push("schedule: missing in db");
  else {
    const s = expected.schedule as unknown as Record<string, unknown>;
    const d = A.schedule as unknown as Record<string, unknown>;
    for (const f of ["applicationFee", "applicationFeeSource", "notificationDate", "notificationSource", "materialDeadline", "materialDeadlineSource", "secondStageDate", "secondStageDateSource", "resultDate", "resultDateSource", "recheckDeadline", "recheckDeadlineSource"]) {
      if (!sameValue(s[f], d[f])) out.push(`schedule.${f}: db=${JSON.stringify(d[f])} != raw=${JSON.stringify(s[f])}`);
    }
  }
  out.push(...diffRows("notices", key, expected.notices as unknown as Array<Record<string, unknown>>, A.notices as unknown as Array<Record<string, unknown>>, ["position", "type", "text", "sourceText"]));
  return out.map((d) => `${key}: ${d}`);
}
