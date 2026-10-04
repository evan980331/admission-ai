import type { FileResult, ImportReport } from "./types";

/**
 * Deterministic report assembly (sorted output; timestamps stay fresh by design).
 */
export function buildReport(opts: {
  generatedAt: string;
  academicYear: number;
  inputDir: string;
  dryRun: boolean;
  discovered: number;
  supported: number;
  skipped: number;
  results: FileResult[];
}): ImportReport {
  const count = (s: FileResult["status"]) => opts.results.filter((r) => r.status === s).length;
  return {
    generatedAt: opts.generatedAt,
    academicYear: opts.academicYear,
    inputDir: opts.inputDir,
    dryRun: opts.dryRun,
    discovered: opts.discovered,
    supported: opts.supported,
    imported: count("imported"),
    skipped: opts.skipped + count("already_imported"),
    unidentified: count("unidentified"),
    sourceUnverified: count("source_unverified"),
    parserErrors: count("parser_error") + count("invalid_html"),
    normalizationErrors: count("normalization_error"),
    duplicates: count("already_imported"),
    files: [...opts.results].sort((a, b) => a.path.localeCompare(b.path)),
  };
}
