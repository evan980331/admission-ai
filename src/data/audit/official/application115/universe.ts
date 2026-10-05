/**
 * P1-C.2 universe / coverage audit — pure builders (no I/O, no DB, no network).
 * Universe = code-identified rows only (names never establish identity).
 * A row may carry multiple flags at once (e.g. EXPECTED + RAW_AVAILABLE +
 * PARSED + DATASET_PRESENT + DB_PRESENT + CANONICAL_COMPLETE).
 */

export type UniverseProvenance = "official" | "fixture";

export interface UniverseInput {
  schoolCode: string;
  schoolName: string | null;
  departmentCode: string;
  departmentName: string | null;
  /** Observed URL only (meta.sourceUrl / fixture sourceUrl). Never constructed. */
  detailUrl: string | null;
  provenance: UniverseProvenance;
  academicYear: number;
}

export type CoverageFlag =
  | "EXPECTED"
  | "RAW_AVAILABLE"
  | "PARSED"
  | "DATASET_PRESENT"
  | "DB_PRESENT"
  | "CANONICAL_COMPLETE"
  | "NEEDS_ACQUISITION"
  | "NEEDS_PARSE_FIX"
  | "NEEDS_SCHEMA_MAPPING";

export interface CoverageRow {
  schoolCode: string;
  schoolName: string | null;
  departmentCode: string;
  departmentName: string | null;
  detailUrl: string | null;
  provenance: UniverseProvenance;
  raw: boolean;
  parsed: boolean;
  dataset: boolean;
  db: boolean | null;
  canonicalComplete: boolean;
  flags: CoverageFlag[];
  status: string;
  reason: string;
}

export interface UniverseSummary {
  universe: number;
  raw: number;
  parsed: number;
  dataset: number;
  db: number;
  dbUnknown: number;
  canonicalComplete: number;
  needsAcquisition: number;
  needsParseFix: number;
  needsSchemaMapping: number;
  gapsBySchool: Record<string, number>;
}

export interface IdentityIssue {
  level: "error" | "warning";
  check: string;
  detail: string;
}

/**
 * Merge code-identified inputs into one universe (official wins on conflict;
 * name differences never fork identity — recorded as notes by the caller).
 */
export function buildUniverse(inputs: UniverseInput[]): UniverseInput[] {
  const byCode = new Map<string, UniverseInput>();
  for (const input of inputs) {
    const key = `${input.academicYear}|${input.schoolCode}|${input.departmentCode}`;
    const prev = byCode.get(key);
    if (!prev) {
      byCode.set(key, { ...input });
      continue;
    }
    byCode.set(key, {
      ...prev,
      schoolName: prev.schoolName ?? input.schoolName,
      departmentName: prev.departmentName ?? input.departmentName,
      detailUrl: prev.detailUrl ?? input.detailUrl,
      provenance: prev.provenance === "official" ? "official" : input.provenance,
    });
  }
  return [...byCode.values()].sort((a, b) =>
    `${a.schoolCode}|${a.departmentCode}`.localeCompare(`${b.schoolCode}|${b.departmentCode}`),
  );
}

export interface ObservedState {
  raw: boolean;
  parsed: boolean;
  dataset: boolean;
  /** null = not checked (e.g. no DATABASE_URL); never guessed. */
  db: boolean | null;
  canonicalComplete: boolean;
  schemaMapped: boolean;
}

export function classifyRow(input: UniverseInput, observed: ObservedState): CoverageRow {
  const flags: CoverageFlag[] = ["EXPECTED"];
  if (observed.raw) flags.push("RAW_AVAILABLE");
  if (observed.parsed) flags.push("PARSED");
  if (observed.dataset) flags.push("DATASET_PRESENT");
  if (observed.db === true) flags.push("DB_PRESENT");
  if (observed.canonicalComplete) flags.push("CANONICAL_COMPLETE");
  if (!observed.raw) flags.push("NEEDS_ACQUISITION");
  if (observed.raw && !observed.parsed) flags.push("NEEDS_PARSE_FIX");
  if (observed.parsed && !observed.schemaMapped) flags.push("NEEDS_SCHEMA_MAPPING");

  let status = "complete";
  let reason = "expected/raw/parsed/dataset/db/canonical all present";
  if (!observed.raw) {
    status = "needs_acquisition";
    reason = "in universe, no detail raw captured";
  } else if (!observed.parsed) {
    status = "needs_parse_fix";
    reason = "raw present but parser produced no record";
  } else if (!observed.schemaMapped) {
    status = "needs_schema_mapping";
    reason = "parsed but canonical/DB mapping incomplete";
  } else if (observed.db === false) {
    status = "needs_db_load";
    reason = "parsed + mapped but not in PostgreSQL";
  } else if (observed.db === null) {
    status = "db_unknown";
    reason = "DB presence not checked (no DATABASE_URL); file pipeline complete";
  }
  return {
    schoolCode: input.schoolCode,
    schoolName: input.schoolName,
    departmentCode: input.departmentCode,
    departmentName: input.departmentName,
    detailUrl: input.detailUrl,
    provenance: input.provenance,
    raw: observed.raw,
    parsed: observed.parsed,
    dataset: observed.dataset,
    db: observed.db,
    canonicalComplete: observed.canonicalComplete,
    flags,
    status,
    reason,
  };
}

export function summarize(rows: CoverageRow[]): UniverseSummary {
  const gapsBySchool: Record<string, number> = {};
  const summary: UniverseSummary = {
    universe: rows.length,
    raw: 0,
    parsed: 0,
    dataset: 0,
    db: 0,
    dbUnknown: 0,
    canonicalComplete: 0,
    needsAcquisition: 0,
    needsParseFix: 0,
    needsSchemaMapping: 0,
    gapsBySchool,
  };
  for (const r of rows) {
    if (r.raw) summary.raw++;
    if (r.parsed) summary.parsed++;
    if (r.dataset) summary.dataset++;
    if (r.db === true) summary.db++;
    if (r.db === null) summary.dbUnknown++;
    if (r.canonicalComplete) summary.canonicalComplete++;
    if (r.flags.includes("NEEDS_ACQUISITION")) summary.needsAcquisition++;
    if (r.flags.includes("NEEDS_PARSE_FIX")) summary.needsParseFix++;
    if (r.flags.includes("NEEDS_SCHEMA_MAPPING")) summary.needsSchemaMapping++;
    if (r.status !== "complete") {
      gapsBySchool[r.schoolCode] = (gapsBySchool[r.schoolCode] ?? 0) + 1;
    }
  }
  return summary;
}

/**
 * Identity consistency over universe rows + observed URLs.
 * - schoolCode MUST equal departmentCode[:3] (P3.12 rule; the `115_` filename
 *   prefix is the year, never the school).
 * - Duplicates are detected by code; name differences never fork identity.
 * - Observed desktop URLs keep their query string verbatim (?v=1.0 must survive).
 */
export function checkIdentity(rows: CoverageRow[]): IdentityIssue[] {
  const issues: IdentityIssue[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.schoolCode}|${r.departmentCode}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (!/^\d{6}$/.test(r.departmentCode)) {
      issues.push({ level: "error", check: "department-code", detail: `${r.departmentCode}: not a 6-digit official code` });
      continue;
    }
    if (r.departmentCode.slice(0, 3) !== r.schoolCode) {
      issues.push({ level: "error", check: "school-derivation", detail: `${r.departmentCode}: schoolCode ${r.schoolCode} != code prefix ${r.departmentCode.slice(0, 3)} (year prefix is not a school)` });
    }
    if (r.detailUrl) {
      let u: URL | null = null;
      try {
        u = new URL(r.detailUrl);
      } catch {
        u = null;
      }
      if (!u || u.hostname.toLowerCase() !== "www.cac.edu.tw") {
        issues.push({ level: "error", check: "detail-url", detail: `${r.departmentCode}: non-official detail URL` });
      } else if (!/\/(apply115)\//.test(u.pathname) || /mobile_apply115\//.test(u.pathname)) {
        issues.push({ level: "warning", check: "detail-url", detail: `${r.departmentCode}: not a desktop /apply115/ URL: ${r.detailUrl}` });
      }
      const m = u?.pathname.match(/(\d{3})_(\d{6})\.htm$/i);
      if (u && (!m || m[2] !== r.departmentCode)) {
        issues.push({ level: "error", check: "detail-url", detail: `${r.departmentCode}: URL code disagrees with row code` });
      }
    }
  }
  for (const [key, n] of seen) {
    if (n > 1) issues.push({ level: "error", check: "duplicate", detail: `${key}: ${n} rows share one code identity` });
  }
  return issues;
}
