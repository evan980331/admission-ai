import type { RecordEntry } from "../../../importers/official/application115/local/importer";
import {
  DATASET_VERSION,
  type CoverageReport,
  type CoverageRow,
  type Dataset,
  type DatasetBuildReport,
  type DatasetEntry,
  type DatasetEntryStatus,
} from "./types";

/**
 * Dataset merge: P3.11 local-import records (+) optional previous dataset
 * (+) optional manifest universe -> cumulative dataset + coverage.
 * Pure + deterministic (sorted keys). Same identity+sha => unchanged;
 * same identity + new sha => versioned content_changed, never silent.
 */
export function identityKey(academicYear: number, schoolCode: string, departmentCode: string): string {
  return `${academicYear}|${schoolCode}|${departmentCode}`;
}

export interface UniverseEntry {
  schoolCode: string;
  schoolName: string | null;
  departmentCode: string;
  departmentName: string | null;
  detailUrl: string | null;
}

export interface MergeOptions {
  academicYear: number;
  generatedAt?: string;
  previous?: Dataset | null;
  universe?: UniverseEntry[];
}

export interface MergeResult {
  dataset: Dataset;
  coverage: CoverageReport;
  buildReport: DatasetBuildReport;
  errors: { key: string; status: string; reasons: string[] }[];
}

const entryStatus = (r: RecordEntry): DatasetEntryStatus => {
  if (r.status === "imported" || r.status === "already_imported") return "ok";
  if (r.status === "source_unverified") return "source_unverified";
  if (r.status === "parser_error" || r.status === "invalid_html" || r.status === "unidentified") return "parse_error";
  return "normalization_error";
};

export function mergeDataset(
  records: RecordEntry[],
  inputDir: string,
  opts: MergeOptions,
): MergeResult {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const prevEntries = opts.previous?.entries ?? {};
  const next: Record<string, DatasetEntry> = {};
  const errors: MergeResult["errors"] = [];
  let changed = 0;

  // Deterministic order: sort storable records by identity key.
  const ordered = [...records]
    .filter((r) => r.detail && (r.detail as { departmentCode?: unknown }).departmentCode)
    .sort((a, b) => {
      const da = a.detail as { schoolCode: string; departmentCode: string };
      const db = b.detail as { schoolCode: string; departmentCode: string };
      return `${da.schoolCode}|${da.departmentCode}`.localeCompare(`${db.schoolCode}|${db.departmentCode}`);
    });

  for (const r of ordered) {
    const d = r.detail as {
      academicYear: number;
      schoolCode: string;
      schoolName: string | null;
      departmentCode: string;
      departmentName: string | null;
      sourceUrl: string;
      parserVersion: string;
      dataVersion: string;
    };
    const k = identityKey(d.academicYear, d.schoolCode, d.departmentCode);
    if (next[k]) {
      errors.push({ key: k, status: "normalization_error", reasons: [`duplicate identity in this run; kept first (${next[k]!.sha256?.slice(0, 12)}…)`] });
      continue;
    }
    const prev = prevEntries[k] ?? null;
    const st = entryStatus(r);
    const sameSha = !!prev && prev.sha256 === r.sha256;
    if (sameSha && prev) {
      next[k] = { ...prev, sourcePresent: true };
      continue;
    }
    if (prev && prev.sha256 !== r.sha256) changed++;
    next[k] = {
      academicYear: d.academicYear,
      schoolCode: d.schoolCode,
      schoolName: d.schoolName,
      departmentCode: d.departmentCode,
      departmentName: d.departmentName,
      detailUrl: d.sourceUrl || null,
      status: st,
      lastCapturedAt: generatedAt,
      sha256: r.sha256,
      parserStatus: r.detail ? "success" : "failed",
      normalizationStatus: r.canonical ? "success" : st === "ok" ? "failed" : "skipped",
      sourceType: "official",
      sourceUrl: d.sourceUrl || null,
      capturedAt: generatedAt,
      parserVersion: d.parserVersion ?? null,
      dataVersion: d.dataVersion ?? null,
      detail: r.detail,
      p2Row: r.p2Row,
      canonical: r.canonical,
      errors: st === "ok" ? [] : [`local status ${r.status}`],
      sourcePresent: true,
      history: [
        ...(prev?.history ?? []),
        ...(prev
          ? [{ sha256: prev.sha256 ?? "none", capturedAt: prev.lastCapturedAt, sourceUrl: prev.sourceUrl, status: "superseded" as const }]
          : []),
      ],
    };
    if (st !== "ok") {
      errors.push({ key: k, status: st, reasons: next[k]!.errors });
    }
  }

  // Carry-forward: previous entries absent from this run survive untouched
  // (cumulative dataset; a transient missing/erroring file must not erase
  // earlier success). Provenance and history are NOT modified; the entry is
  // only flagged sourcePresent=false so coverage reports it as carried.
  for (const [k, prev] of Object.entries(prevEntries)) {
    if (!next[k]) next[k] = { ...prev, sourcePresent: false };
  }

  // Universe: manifest codes (or empty -> missing stays 0, never invented).
  // Row transition states (captured/unchanged/content_changed) are resolved
  // by the caller, which compares against the previous dataset.
  const universe = opts.universe ?? [];
  const universeKeys = new Set(universe.map((u) => identityKey(opts.academicYear, u.schoolCode, u.departmentCode)));
  const rows: CoverageRow[] = [];
  const seen = new Set(Object.keys(next));
  for (const u of universe) {
    const k = identityKey(opts.academicYear, u.schoolCode, u.departmentCode);
    const e = next[k];
    if (!e) {
      rows.push({
        schoolCode: u.schoolCode,
        schoolName: u.schoolName,
        departmentCode: u.departmentCode,
        departmentName: u.departmentName,
        detailUrl: u.detailUrl,
        status: "missing",
        lastCapturedAt: null,
        sha256: null,
        parserStatus: "skipped",
        normalizationStatus: "skipped",
        errors: ["not yet acquired"],
        inUniverse: true,
      });
      continue;
    }
    seen.delete(k);
    rows.push({ ...toCoverageRow(e), inUniverse: true });
  }
  // Entries outside the universe (should not happen via manifest flow) still reported.
  for (const k of [...seen].sort()) {
    rows.push({ ...toCoverageRow(next[k]!), inUniverse: false });
  }
  rows.sort((a, b) => `${a.schoolCode}|${a.departmentCode}`.localeCompare(`${b.schoolCode}|${b.departmentCode}`));

  const count = (s: CoverageRow["status"]) => rows.filter((r) => r.status === s).length;
  // missing = in-universe rows with no current source (absent entirely, or
  // carried over from an earlier run). carried is counted separately; the two
  // overlap by design and this is documented, not double-bookkeeping.
  const missing = rows.filter((r) => r.inUniverse && (r.status === "missing" || r.status === "carried")).length;
  const newEntries = Object.keys(next).filter((k) => !prevEntries[k]).length;
  return {
    dataset: { datasetVersion: DATASET_VERSION, academicYear: opts.academicYear, generatedAt, entries: next },
    coverage: {
      generatedAt,
      academicYear: opts.academicYear,
      totalDepartments: universe.length > 0 ? universe.length : Object.keys(next).length,
      captured: count("captured"),
      unchanged: count("unchanged"),
      contentChanged: count("content_changed"),
      carried: count("carried"),
      parseSuccess: count("parse_success"),
      parseError: count("parse_error"),
      validationError: count("validation_error"),
      normalized: count("normalized"),
      normalizationError: count("normalization_error"),
      missing,
      rows,
    },
    buildReport: {
      generatedAt,
      academicYear: opts.academicYear,
      inputDir,
      newEntries,
      unchanged: Object.keys(next).length - newEntries - changed,
      contentChanged: changed,
      errors: errors.length,
      skipped: [],
    },
    errors,
  };
}

export function toCoverageRow(
  e: DatasetEntry,
  transition: "captured" | "unchanged" | "content_changed" | null = null,
): CoverageRow {
  // Carried entries (preserved without a current-run source) are reported as
  // carried and excluded from captured/unchanged/normalized. Provenance and
  // history on the entry itself are untouched.
  let status: CoverageRow["status"];
  if (!e.sourcePresent) {
    status = "carried";
  } else if (e.status === "ok") {
    if (transition) status = transition;
    else status = e.normalizationStatus === "success" ? "normalized" : "parse_success";
  } else if (e.status === "parse_error") status = "parse_error";
  else if (e.status === "source_unverified") status = "validation_error";
  else status = "normalization_error";
  return {
    schoolCode: e.schoolCode,
    schoolName: e.schoolName,
    departmentCode: e.departmentCode,
    departmentName: e.departmentName,
    detailUrl: e.detailUrl,
    status,
    lastCapturedAt: e.lastCapturedAt,
    sha256: e.sha256,
    parserStatus: e.parserStatus,
    normalizationStatus: e.normalizationStatus,
    errors: e.errors,
    inUniverse: false,
  };
}
