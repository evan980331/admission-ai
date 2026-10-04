import { normalizeHistoricalBatch } from "../../normalization/index";
import { parseDetailHtml } from "../../importers/official/application115/detail/parser";
import { validateDetail } from "../../importers/official/application115/detail/validator";
import { toP3Input } from "../../importers/official/application115/detail/normalizer";
import { captureCurrentPage, listTargets, type HttpGet, type WsEvaluate } from "./cdp";
import { storeCapture } from "./capture";
import { selectCurrentTab } from "./tabs";
import { validateCapturedPage, validateTabUrl } from "./validate";
import { BROWSER_DEFAULT_PORT, type BrowserImportResult } from "./types";

export interface BrowserImportOptions {
  port?: number;
  rawDir?: string;
  dryRun?: boolean;
  httpGet?: HttpGet;
  wsEvaluate?: WsEvaluate;
  capturedAt?: string;
}

/**
 * Browser-assisted import (single current tab, no traversal):
 * localhost CDP -> validate tab -> capture outerHTML -> validate content ->
 * store raw (+meta) -> P3.7 parse -> P3 normalize. No CAC HTTP, no DB writes.
 */
export async function runBrowserImport(opts: BrowserImportOptions = {}): Promise<BrowserImportResult> {
  const port = opts.port ?? BROWSER_DEFAULT_PORT;
  const blank: BrowserImportResult = {
    tabUrl: null,
    schoolCode: null,
    schoolName: null,
    departmentCode: null,
    departmentName: null,
    htmlBytes: 0,
    sha256: null,
    captureStatus: "source_rejected",
    parserStatus: "skipped",
    normalizationStatus: "skipped",
    reasons: [],
  };

  let targets;
  try {
    targets = await listTargets(port, opts.httpGet);
  } catch (err) {
    return { ...blank, reasons: [err instanceof Error ? err.message : String(err)] };
  }
  const selected = selectCurrentTab(targets);
  if ("error" in selected) return { ...blank, reasons: [selected.error] };
  const tab = selected.target;

  const tabCheck = validateTabUrl(tab.url);
  if (!tabCheck.ok) return { ...blank, tabUrl: tab.url, reasons: tabCheck.reasons };

  let page;
  try {
    page = await captureCurrentPage(tab.webSocketDebuggerUrl, opts.wsEvaluate);
  } catch (err) {
    return { ...blank, tabUrl: tab.url, reasons: [`CDP capture failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
  // Live href wins over the /json listing (user may have navigated meanwhile).
  const contentCheck = validateCapturedPage({ ...page, tabUrl: page.tabUrl || tab.url });
  if (!contentCheck.ok) {
    return { ...blank, tabUrl: page.tabUrl || tab.url, reasons: contentCheck.reasons };
  }
  const sourceUrl = page.tabUrl || tab.url;

  if (opts.dryRun) {
    return {
      ...blank,
      tabUrl: sourceUrl,
      captureStatus: "captured",
      htmlBytes: page.outerHtml.length,
      reasons: ["dry-run: validated only, nothing stored or parsed"],
    };
  }

  // Identity via P3.7 (content first, never filename/URL alone).
  const parsed = parseDetailHtml(page.outerHtml, { sourceUrl, dataVersion: "browser-cdp" });
  const rawDir =
    opts.rawDir ?? `${process.cwd()}/data/raw/official/115/application/departments`;
  if (!parsed.record) {
    // Raw HTML is still persisted for forensics, marked parse_error.
    const fallback = sourceUrl.match(/(\d{3})_(\d{6})\.htm/i);
    const stored = storeCapture({
      rawDir,
      departmentCode: fallback?.[2] ?? "unknown",
      schoolCode: fallback?.[1] ?? "000",
      sourceUrl,
      browserPort: port,
      page,
      capturedAt: opts.capturedAt,
    });
    return {
      ...blank,
      tabUrl: sourceUrl,
      htmlBytes: page.outerHtml.length,
      sha256: stored.sha256,
      captureStatus: "parse_error",
      parserStatus: "failed",
      reasons: parsed.issues.map((i) => `${i.check}: ${i.detail}`),
    };
  }
  const detail = parsed.record;
  const codeFromUrl = sourceUrl.match(/(\d{3})_(\d{6})\.htm/i);
  if (!codeFromUrl || codeFromUrl[2] !== detail.departmentCode) {
    return {
      ...blank,
      tabUrl: sourceUrl,
      htmlBytes: page.outerHtml.length,
      captureStatus: "source_rejected",
      reasons: ["tab URL code disagrees with parsed department code"],
    };
  }

  const stored = storeCapture({
    rawDir,
    departmentCode: detail.departmentCode,
    schoolCode: detail.schoolCode,
    sourceUrl,
    browserPort: port,
    page,
    capturedAt: opts.capturedAt,
  });

  const problems = [...parsed.issues, ...validateDetail(detail)];
  const parserOk = !problems.some((p) => p.level === "error");
  let normalizationStatus: BrowserImportResult["normalizationStatus"] = "skipped";
  if (parserOk) {
    const batch = normalizeHistoricalBatch([toP3Input(detail)], { academicYear: 115, dataVersion: "browser-cdp" });
    normalizationStatus = batch.records.length === 1 && batch.report.errors === 0 ? "success" : "failed";
  }

  return {
    tabUrl: sourceUrl,
    schoolCode: detail.schoolCode,
    schoolName: detail.schoolName,
    departmentCode: detail.departmentCode,
    departmentName: detail.departmentName,
    htmlBytes: page.outerHtml.length,
    sha256: stored.sha256,
    captureStatus: stored.status,
    parserStatus: parserOk ? "success" : "failed",
    normalizationStatus,
    reasons: problems.filter((p) => p.level === "error").map((p) => `${p.check}: ${p.detail}`),
  };
}
