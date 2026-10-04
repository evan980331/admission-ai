import fs from "node:fs";
import path from "node:path";
import { normalizeHistoricalBatch } from "../../../../normalization/index";
import type { RawHistoricalInput } from "../../../../normalization/types";
import { toP2Row, toP3Input } from "../detail/normalizer";
import { validateDetail } from "../detail/validator";
import type { DetailRecord } from "../detail/types";
import { discoverHtmlFiles } from "./discover";
import { identifyFile, readSidecarMeta } from "./identify";
import { buildReport } from "./report";
import { validateFileEligible, validateSource } from "./validator";
import type { FileResult, FileStatus, ImportReport } from "./types";

export interface LocalImportOptions {
  inputDir: string;
  outputDir: string | null;
  academicYear: number;
  dryRun: boolean;
  dataVersion?: string;
}

export interface RecordEntry {
  sourceFile: string;
  sha256: string;
  status: FileStatus;
  detail: DetailRecord | null;
  p2Row: ReturnType<typeof toP2Row> | null;
  canonical: RawHistoricalInput | null;
}

export interface LocalImportResult {
  report: ImportReport;
  records: RecordEntry[];
  errors: { path: string; sha256: string; status: FileStatus; reasons: string[] }[];
}

/**
 * Local pipeline: discover -> identify (P3.7 reuse) -> source-validate ->
 * normalize (P3 reuse) -> report. No network, no DB writes, raws untouched.
 * Idempotent: content-hash dedupe within a run; deterministic sorted output.
 */
export function runLocalImport(opts: LocalImportOptions): LocalImportResult {
  const generatedAt = new Date().toISOString();
  const { files, skipped } = discoverHtmlFiles(opts.inputDir);
  const seenHash = new Map<string, string>();
  const results: FileResult[] = [];
  const records: RecordEntry[] = [];
  const errors: LocalImportResult["errors"] = [];
  const p3Inputs: { input: RawHistoricalInput; fileIndex: number }[] = [];

  files.forEach((f, fileIndex) => {
    const fail = (status: FileStatus, reasons: string[]): FileResult => ({
      path: f.path,
      sha256: f.sha256,
      status,
      schoolCode: null,
      departmentCode: null,
      departmentName: null,
      sourceUrl: null,
      reasons,
    });
    if (seenHash.has(f.sha256)) {
      const first = seenHash.get(f.sha256)!;
      const r = fail("already_imported", [`duplicate content of ${first} (sha256 match)`]);
      results.push(r);
      errors.push({ path: f.path, sha256: f.sha256, status: r.status, reasons: r.reasons });
      return;
    }
    seenHash.set(f.sha256, f.path);

    let html: string;
    try {
      html = fs.readFileSync(f.path, "utf8");
    } catch (err) {
      const r = fail("invalid_html", [`unreadable: ${err instanceof Error ? err.message : String(err)}`]);
      results.push(r);
      errors.push({ path: f.path, sha256: f.sha256, status: r.status, reasons: r.reasons });
      return;
    }
    const eligible = validateFileEligible(f.bytes, html);
    if (eligible.length > 0) {
      const r = fail("invalid_html", eligible);
      results.push(r);
      errors.push({ path: f.path, sha256: f.sha256, status: r.status, reasons: r.reasons });
      return;
    }

    // Identify via P3.7 (content first; filename only corroborates).
    const meta = readSidecarMeta(f.path);
    const id = identifyFile(f.path, html, meta?.url ?? `local-file:${path.basename(f.path)}`);
    if (!id.record) {
      const r = fail("unidentified", id.errors.length > 0 ? id.errors : ["P3.7 parser produced no record"]);
      results.push(r);
      errors.push({ path: f.path, sha256: f.sha256, status: r.status, reasons: r.reasons });
      return;
    }
    const detail = id.record;

    // Official source gate.
    const verdict = validateSource(meta?.url ?? null, detail.departmentCode, opts.academicYear);
    if (!verdict.ok) {
      const r: FileResult = {
        path: f.path,
        sha256: f.sha256,
        status: "source_unverified",
        schoolCode: detail.schoolCode,
        departmentCode: detail.departmentCode,
        departmentName: detail.departmentName,
        sourceUrl: verdict.sourceUrl,
        reasons: verdict.reasons,
      };
      results.push(r);
      errors.push({ path: f.path, sha256: f.sha256, status: r.status, reasons: r.reasons });
      return;
    }
    detail.sourceUrl = verdict.sourceUrl!;
    if (id.filenameAgrees === false) {
      const r: FileResult = {
        path: f.path,
        sha256: f.sha256,
        status: "source_unverified",
        schoolCode: detail.schoolCode,
        departmentCode: detail.departmentCode,
        departmentName: detail.departmentName,
        sourceUrl: verdict.sourceUrl,
        reasons: [`filename code ${id.filenameCode} disagrees with HTML code ${detail.departmentCode}`],
      };
      results.push(r);
      errors.push({ path: f.path, sha256: f.sha256, status: r.status, reasons: r.reasons });
      return;
    }

    // P3.7 detail validation problems that are errors stop the file here.
    const detailProblems = validateDetail(detail);
    const fatal = detailProblems.filter((p) => p.level === "error");
    if (fatal.length > 0) {
      const r: FileResult = {
        path: f.path,
        sha256: f.sha256,
        status: "parser_error",
        schoolCode: detail.schoolCode,
        departmentCode: detail.departmentCode,
        departmentName: detail.departmentName,
        sourceUrl: verdict.sourceUrl,
        reasons: fatal.map((p) => `${p.check}: ${p.detail}`),
      };
      results.push(r);
      errors.push({ path: f.path, sha256: f.sha256, status: r.status, reasons: r.reasons });
      return;
    }

    // Stage for P3 normalization (batch reuse, no semantics change).
    p3Inputs.push({ input: { ...toP3Input(detail), dataVersion: opts.dataVersion ?? "local-import" }, fileIndex });
    results.push({
      path: f.path,
      sha256: f.sha256,
      status: "imported",
      schoolCode: detail.schoolCode,
      departmentCode: detail.departmentCode,
      departmentName: detail.departmentName,
      sourceUrl: verdict.sourceUrl,
      reasons: detailProblems.filter((p) => p.level === "warning").map((p) => `${p.check}: ${p.detail}`),
    });
    records.push({ sourceFile: f.path, sha256: f.sha256, status: "imported", detail, p2Row: toP2Row(detail), canonical: null });
  });

  // P3 normalization over staged inputs (skipped entirely on dry-run).
  // Same-identity inputs from different files are flagged here (batch would
  // merge them silently); only the first proceeds.
  const seenIdentity = new Set<string>();
  const admitted: typeof p3Inputs = [];
  for (const p of p3Inputs) {
    const k = `${p.input.schoolCode}|${p.input.departmentCode}|${p.input.academicYear}`;
    if (seenIdentity.has(k)) {
      const rec = records.find((r) => r.sourceFile === files[p.fileIndex]!.path);
      if (rec) {
        rec.status = "normalization_error";
        rec.canonical = null;
      }
      const res = results.find((r) => r.path === files[p.fileIndex]!.path);
      if (res) {
        res.status = "normalization_error";
        res.reasons.push(`duplicate identity ${k} already imported in this run`);
      }
      errors.push({ path: files[p.fileIndex]!.path, sha256: files[p.fileIndex]!.sha256, status: "normalization_error", reasons: [`duplicate identity ${k}`] });
      continue;
    }
    seenIdentity.add(k);
    admitted.push(p);
  }
  if (!opts.dryRun && admitted.length > 0) {
    const batch = normalizeHistoricalBatch(
      admitted.map((p) => p.input),
      { academicYear: opts.academicYear, dataVersion: opts.dataVersion ?? "local-import" },
    );
    const byKey = new Map(batch.records.map((r) => [`${r.schoolCode}|${r.departmentCode}|${r.academicYear}`, r]));
    admitted.forEach((p) => {
      const rec = records.find((r) => r.sourceFile === files[p.fileIndex]!.path);
      const k = `${p.input.schoolCode}|${p.input.departmentCode}|${p.input.academicYear}`;
      const canon = byKey.get(k);
      if (rec && canon) {
        rec.canonical = { ...p.input };
      } else if (rec) {
        rec.status = "normalization_error";
        const res = results.find((r) => r.path === rec.sourceFile);
        if (res) {
          res.status = "normalization_error";
          res.reasons.push("P3 normalization dropped this row (see batch issues)");
        }
        errors.push({ path: rec.sourceFile, sha256: rec.sha256, status: "normalization_error", reasons: ["dropped by P3 batch"] });
      }
    });
    void batch;
  }
  if (opts.dryRun) {
    for (const r of records) {
      r.canonical = null;
      r.detail = null;
      r.p2Row = null;
    }
  }

  const report: ImportReport = buildReport({
    generatedAt,
    academicYear: opts.academicYear,
    inputDir: opts.inputDir,
    dryRun: opts.dryRun,
    discovered: files.length + skipped.length,
    supported: files.length,
    skipped: skipped.length,
    results,
  });
  return { report, records: [...records].sort((a, b) => a.sourceFile.localeCompare(b.sourceFile)), errors };
}
