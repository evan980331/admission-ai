import fs from "node:fs";
import { parseDetailHtml } from "./parser";
import { validateDetail } from "./validator";
import type { DetailParseResult } from "./types";
import { DETAIL_PARSER_VERSION } from "./types";

/**
 * Detail pipeline entry: local HTML file -> validated DetailRecord.
 * File-only input (no fetching, no DB). Callers choose what to do with output.
 */
export interface DetailRunOptions {
  inputPath: string;
  sourceUrl: string;
  retrievedAt?: string | null;
  dataVersion?: string;
}

export function runDetailFile(opts: DetailRunOptions): DetailParseResult {
  const html = fs.readFileSync(opts.inputPath, "utf8");
  const parsed = parseDetailHtml(html, {
    sourceUrl: opts.sourceUrl,
    retrievedAt: opts.retrievedAt ?? null,
    dataVersion: opts.dataVersion ?? `manual-${new Date().toISOString().slice(0, 10)}`,
  });
  if (!parsed.record) return parsed;
  parsed.record.sourceUrl = opts.sourceUrl;
  if (opts.retrievedAt !== undefined) parsed.record.retrievedAt = opts.retrievedAt;
  if (opts.dataVersion !== undefined) parsed.record.dataVersion = opts.dataVersion;
  parsed.issues.push(...validateDetail(parsed.record));
  void DETAIL_PARSER_VERSION;
  return parsed;
}
