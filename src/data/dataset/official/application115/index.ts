import fs from "node:fs";
import path from "node:path";
import { runLocalImport } from "../../../importers/official/application115/local/index";
import type { RecordEntry } from "../../../importers/official/application115/local/importer";
import { parseDetailHtml } from "../../../importers/official/application115/detail/parser";
import { identityKey, mergeDataset, toCoverageRow, type UniverseEntry } from "./dataset";
import type { CoverageReport, Dataset, DatasetBuildReport } from "./types";

/**
 * Dataset build runner: P3.11 local import -> merge with previous dataset ->
 * coverage with transitions -> JSON outputs. Offline, no DB, raws untouched.
 */
export interface DatasetBuildOptions {
  inputDir: string;
  outputDir: string | null;
  academicYear: number;
  dryRun: boolean;
  universePath?: string;
  dataVersion?: string;
  generatedAt?: string;
}

export interface DatasetBuildResult {
  dataset: Dataset;
  coverage: CoverageReport;
  buildReport: DatasetBuildReport;
  errors: { key: string; status: string; reasons: string[] }[];
  localReport: ReturnType<typeof runLocalImport>["report"];
}

function readJson(p: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function runDatasetBuild(opts: DatasetBuildOptions): DatasetBuildResult {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const { report: localReport, records: localRecords } = runLocalImport({
    inputDir: opts.inputDir,
    outputDir: null,
    academicYear: opts.academicYear,
    dryRun: false,
    dataVersion: opts.dataVersion ?? "dataset-build",
  });

  // Surface P3.11 file-level failures in dataset errors too (they never
  // become entries, but must not disappear).
  const fileFailures = localReport.files
    .filter((f) => f.status !== "imported" && f.status !== "source_unverified" && f.status !== "already_imported")
    .map((f) => ({ key: f.path, status: f.status, reasons: f.reasons }));

  // Unverified files never enter the P3.11 record set; parse them here for
  // dataset visibility (P3.7 reuse, status stays source_unverified).
  // Year-guarded: filename/meta year other than requested is rejected, not guessed.
  const records: RecordEntry[] = [...localRecords];
  const extraErrors: { key: string; status: string; reasons: string[] }[] = [];
  for (const f of localReport.files) {
    if (f.status !== "source_unverified") continue;
    const full = path.isAbsolute(f.path) ? f.path : path.join(opts.inputDir, f.path);
    let html: string;
    try {
      html = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const yearHint =
      path.basename(full).match(/^(\d{3})_\d{6}\.html?$/i)?.[1] ??
      (f.sourceUrl ?? "").match(/\/(\d{3})_\d{6}\.htm/i)?.[1] ??
      null;
    if (yearHint !== null && Number(yearHint) !== opts.academicYear) {
      extraErrors.push({ key: f.path, status: "source_unverified", reasons: [`year ${yearHint} != requested ${opts.academicYear}; rejected, not guessed`] });
      continue;
    }
    const parsed = parseDetailHtml(html, { sourceUrl: `local-file:${path.basename(full)}`, dataVersion: opts.dataVersion ?? "dataset-build" });
    if (!parsed.record) {
      extraErrors.push({ key: f.path, status: "parse_error", reasons: parsed.issues.map((i) => `${i.check}: ${i.detail}`) });
      continue;
    }
    // No verified URL: keep the parsed content, but null out the pseudo-URL
    // so provenance never pretends to be verified.
    parsed.record.sourceUrl = "";
    const d = parsed.record;
    records.push({
      sourceFile: f.path,
      sha256: f.sha256,
      status: "source_unverified",
      detail: d,
      p2Row: null,
      canonical: null,
    });
  }

  const previous = (
    opts.outputDir ? readJson(path.join(opts.outputDir, "dataset.json")) : null
  ) as Dataset | null;

  let universe: UniverseEntry[] | undefined;
  if (opts.universePath) {
    const raw = readJson(opts.universePath) as {
      departments?: { schoolCode: string; schoolName: string | null; departmentCode: string; departmentName: string | null; detailUrl: string | null }[];
    } | null;
    if (Array.isArray(raw?.departments)) {
      universe = raw.departments.map((d) => ({
        schoolCode: d.schoolCode,
        schoolName: d.schoolName,
        departmentCode: d.departmentCode,
        departmentName: d.departmentName,
        detailUrl: d.detailUrl,
      }));
    }
  }

  const merged = mergeDataset(records, opts.inputDir, {
    academicYear: opts.academicYear,
    generatedAt,
    previous,
    universe,
  });
  merged.errors.push(...extraErrors);
  merged.errors.push(...fileFailures);
  merged.buildReport.errors += extraErrors.length + fileFailures.length;

  // Resolve per-row transitions against the previous dataset.
  // Carried rows (no current source) keep their "carried" status and are
  // never relabeled as captured/unchanged/normalized.
  const prevEntries = previous?.entries ?? {};
  for (const row of merged.coverage.rows) {
    if (row.status === "missing" || row.status === "carried") continue;
    const k = identityKey(opts.academicYear, row.schoolCode, row.departmentCode);
    const prev = prevEntries[k];
    const entry = merged.dataset.entries[k]!;
    if (!entry.sourcePresent) continue;
    if (!prev) {
      Object.assign(row, { ...toCoverageRow(entry, "captured"), inUniverse: row.inUniverse });
    } else if (prev.sha256 === entry.sha256) {
      Object.assign(row, { ...toCoverageRow(entry, "unchanged"), inUniverse: row.inUniverse });
    } else {
      Object.assign(row, { ...toCoverageRow(entry, "content_changed"), inUniverse: row.inUniverse });
    }
  }
  const count = (s: string) => merged.coverage.rows.filter((r) => r.status === s).length;
  // Full recount AFTER transitions. Currency states (captured/unchanged/
  // content_changed/carried/missing/errors) come from row labels;
  // processing states (normalized/parse_success) come from current entries,
  // so a freshly captured row counts as BOTH captured and normalized.
  // carried entries are excluded from captured/unchanged/normalized.
  const currentEntries = Object.values(merged.dataset.entries).filter((e) => e.sourcePresent);
  merged.coverage.captured = count("captured");
  merged.coverage.unchanged = count("unchanged");
  merged.coverage.contentChanged = count("content_changed");
  merged.coverage.carried = count("carried");
  merged.coverage.parseSuccess = currentEntries.filter((e) => e.parserStatus === "success" && e.normalizationStatus !== "success").length;
  merged.coverage.parseError = count("parse_error");
  merged.coverage.validationError = count("validation_error");
  merged.coverage.normalized = currentEntries.filter((e) => e.normalizationStatus === "success").length;
  merged.coverage.normalizationError = count("normalization_error");
  merged.coverage.missing = merged.coverage.rows.filter((r) => r.inUniverse && (r.status === "missing" || r.status === "carried")).length;

  if (!opts.dryRun && opts.outputDir) {
    fs.mkdirSync(opts.outputDir, { recursive: true });
    fs.writeFileSync(path.join(opts.outputDir, "dataset.json"), JSON.stringify(merged.dataset, null, 2));
    fs.writeFileSync(path.join(opts.outputDir, "coverage.json"), JSON.stringify(merged.coverage, null, 2));
    fs.writeFileSync(
      path.join(opts.outputDir, "errors.json"),
      JSON.stringify([...merged.errors, ...localReport.files.filter((f) => f.status !== "imported").map((f) => ({ key: f.path, status: f.status, reasons: f.reasons }))], null, 2),
    );
    fs.writeFileSync(path.join(opts.outputDir, "build-report.json"), JSON.stringify(merged.buildReport, null, 2));
  }

  return { ...merged, localReport };
}
