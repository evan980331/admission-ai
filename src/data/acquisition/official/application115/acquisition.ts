import path from "node:path";
import { TextDecoder } from "node:util";
import { parseDetailHtml } from "../../../importers/official/application115/detail/parser";
import { validateDetail } from "../../../importers/official/application115/detail/validator";
import { buildManifest } from "../../../discovery/official/application115/normalizer";
import {
  MAX_BATCH,
  type AcquisitionReport,
  type AcquisitionStatus,
  type PageReport,
} from "./types";
import {
  Pacer,
  ROBOTS_URL,
  departmentPath,
  evaluateRobots,
  fetchWithMeta,
  readIfCached,
  writeRaw,
  type FetchMetaImpl,
} from "./client";
import { readCacheEntry, sha256Hex, writeCacheEntry } from "./cache";
import { validateResponse } from "./validator";

export interface ManifestInput {
  schoolCode: string;
  schoolName: string;
  schoolPageUrl: string;
  departmentCode: string;
  departmentName: string;
  detailUrl: string;
}

export interface AcquireOptions {
  academicYear: number;
  entries: ManifestInput[];
  limit: number;
  refresh: boolean;
  dryRun: boolean;
  offline: boolean;
  delayMs: number;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: FetchMetaImpl;
  rawDir?: string;
  discoveredAt?: string;
}

export const POC_CODES = ["001012", "001022", "001032", "001592"];

const POC_SCHOOL: Record<string, { name: string; page: string }> = {
  "001": {
    name: "國立臺灣大學",
    page: "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/ShowSchGsd.php?colno=001",
  },
};

const POC_NAMES: Record<string, string> = {
  "001012": "中國文學系",
  "001022": "外國語文學系",
  "001032": "歷史學系",
  "001592": "資訊工程學系(APCS組)",
};

/** Fixed PoC batch: verified-official URLs only (fetched OK in P3.7), never guessed. */
export function pocBatch(): ManifestInput[] {
  return POC_CODES.map((code) => {
    const school = code.slice(0, 3);
    const meta = POC_SCHOOL[school]!;
    return {
      schoolCode: school,
      schoolName: meta.name,
      schoolPageUrl: meta.page,
      departmentCode: code,
      departmentName: POC_NAMES[code]!,
      detailUrl: `https://www.cac.edu.tw/mobile_apply115/colqRy_Apply_8Rfsd57q/html/115_${code}.htm`,
    };
  });
}

function decodeBody(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("big5").decode(bytes);
  }
}

export interface AcquireResult {
  report: AcquisitionReport;
  /** "blocked" only when robots fail-closed; caller maps to exit code 3. */
  blocked: boolean;
  /** Parsed detail records keyed by department code (no DB writes). */
  parsed: Map<string, unknown>;
}

export async function runAcquisition(opts: AcquireOptions): Promise<AcquireResult> {
  const startedAt = new Date().toISOString();
  const rawDir = opts.rawDir ?? path.join(process.cwd(), "data", "raw", "official", "115", "application");
  const pacer = new Pacer(opts.delayMs);
  const parsed = new Map<string, unknown>();
  const pages: PageReport[] = [];

  if (opts.limit > MAX_BATCH) {
    throw new Error(`limit ${opts.limit} exceeds PoC cap ${MAX_BATCH}`);
  }
  // Manifest-only selection: every entry must validate through the P3.8 builder.
  const built = buildManifest(
    [...new Map(opts.entries.map((e) => [e.schoolCode, { school_code: e.schoolCode, school_name: e.schoolName, school_url: e.schoolPageUrl }])).values()],
    new Map(
      [...new Set(opts.entries.map((e) => e.schoolCode))].map((sc) => [
        sc,
        opts.entries
          .filter((x) => x.schoolCode === sc)
          .map((x) => ({ school_code: x.schoolCode, department_code: x.departmentCode, department_name: x.departmentName, url: x.detailUrl })),
      ]),
    ),
    { academicYear: opts.academicYear, totalUrl: "poc-batch", discoveredAt: opts.discoveredAt },
  );
  const manifestErrors = built.report.issues.filter((i) => i.level === "error");
  const batch = built.entries.filter((e) => e.urlValidation.valid).slice(0, opts.limit);

  const finish = (partial: Partial<AcquisitionReport>): AcquisitionReport => ({
    academicYear: opts.academicYear,
    source: "official",
    acquisitionVersion: "official-acquisition-v0.1.0",
    robotsAllowed: null,
    robotsNote: "",
    startedAt,
    finishedAt: new Date().toISOString(),
    requested: 0,
    success: 0,
    cached: 0,
    failed: 0,
    robotsBlocked: 0,
    invalid: 0,
    parseFailed: 0,
    manifestErrors: manifestErrors.map((i) => `${i.check}: ${i.detail}`),
    pages,
    ...partial,
  });

  if (opts.dryRun) {
    for (const e of batch) {
      pages.push({
        departmentCode: e.departmentCode,
        departmentName: e.departmentName,
        url: e.detailUrl,
        finalUrl: null,
        status: "cached",
        httpStatus: null,
        contentType: null,
        bytes: 0,
        sha256: null,
        retrievedAt: null,
        cacheHit: false,
        parserStatus: "skipped",
        errors: [],
        warnings: ["dry-run: URL listed, no HTTP request sent"],
      });
    }
    return {
      report: finish({ requested: batch.length, robotsNote: "dry-run: robots check skipped, no requests sent" }),
      blocked: false,
      parsed,
    };
  }

  // ---- Robots gate (fail-closed) ----
  let robotsText: string | null = null;
  if (!opts.offline) {
    await pacer.pace();
    try {
      const cached = readIfCached(`${rawDir}/index/robots.txt`, opts.refresh);
      if (cached !== null) {
        robotsText = cached;
      } else {
        const res = await fetchWithMeta(ROBOTS_URL, {
          timeoutMs: opts.timeoutMs,
          maxRetries: opts.maxRetries,
          fetchImpl: opts.fetchImpl,
        });
        robotsText = decodeBody(res.body);
        writeRaw(`${rawDir}/index/robots.txt`, robotsText);
      }
    } catch (err) {
      robotsText = null;
      void err;
    }
  }
  const verdict = evaluateRobots(robotsText);
  if (!verdict.allowed) {
    for (const e of batch) {
      pages.push({
        departmentCode: e.departmentCode,
        departmentName: e.departmentName,
        url: e.detailUrl,
        finalUrl: null,
        status: "robots_blocked",
        httpStatus: null,
        contentType: null,
        bytes: 0,
        sha256: null,
        retrievedAt: null,
        cacheHit: false,
        parserStatus: "skipped",
        errors: [`ROBOTS_BLOCKED: ${verdict.note}`],
        warnings: [],
      });
    }
    return {
      report: finish({
        requested: batch.length,
        robotsAllowed: false,
        robotsNote: verdict.note,
        robotsBlocked: batch.length,
      }),
      blocked: true,
      parsed,
    };
  }

  // ---- Serial acquisition (reachable only when robots allows) ----
  for (const e of batch) {
    const page: PageReport = {
      departmentCode: e.departmentCode,
      departmentName: e.departmentName,
      url: e.detailUrl,
      finalUrl: null,
      status: "failed",
      httpStatus: null,
      contentType: null,
      bytes: 0,
      sha256: null,
      retrievedAt: null,
      cacheHit: false,
      parserStatus: "skipped",
      errors: [],
      warnings: [],
    };
    pages.push(page);
    const htmlPath = departmentPath(opts.academicYear, e.departmentCode, rawDir);
    const hit = readCacheEntry(htmlPath, opts.refresh);
    let html: string | null = null;
    if (hit) {
      html = hit.html;
      page.cacheHit = true;
      page.status = "cached";
      page.httpStatus = hit.meta.httpStatus;
      page.contentType = hit.meta.contentType;
      page.bytes = hit.meta.bytes;
      page.sha256 = hit.meta.sha256;
      page.retrievedAt = hit.meta.retrievedAt;
      page.finalUrl = e.detailUrl;
    } else {
      await pacer.pace();
      try {
        const res = await fetchWithMeta(e.detailUrl, {
          timeoutMs: opts.timeoutMs,
          maxRetries: opts.maxRetries,
          fetchImpl: opts.fetchImpl,
        });
        const bodyText = decodeBody(res.body);
        const check = validateResponse({
          requestCode: e.departmentCode,
          finalUrl: res.finalUrl,
          status: res.status,
          headers: res.headers,
          bodyBytes: res.body.length,
          // Scan the full body: CAC pages carry ~3KB of head scripts before content.
          bodyTextSample: bodyText,
        });
        page.httpStatus = res.status;
        page.finalUrl = res.finalUrl;
        page.contentType = check.contentType;
        page.bytes = res.body.length;
        page.sha256 = sha256Hex(res.body);
        if (!check.ok) {
          page.status = "invalid";
          page.errors.push(...check.reasons);
          continue;
        }
        page.retrievedAt = new Date().toISOString();
        writeCacheEntry(htmlPath, bodyText, {
          url: e.detailUrl,
          retrievedAt: page.retrievedAt,
          httpStatus: res.status,
          contentType: check.contentType,
          sha256: page.sha256!,
          bytes: page.bytes,
        });
        html = bodyText;
        page.status = "success";
      } catch (err) {
        page.status = "failed";
        page.errors.push(err instanceof Error ? err.message : String(err));
        continue;
      }
    }
    // ---- P3.7 parse (cached or fresh, never DB) ----
    if (html !== null) {
      const parsedResult = parseDetailHtml(html, { sourceUrl: e.detailUrl, dataVersion: "acquisition-poc" });
      const problems = [
        ...parsedResult.issues,
        ...(parsedResult.record ? validateDetail(parsedResult.record) : []),
      ];
      if (!parsedResult.record || problems.some((p) => p.level === "error")) {
        page.status = page.cacheHit ? "cached" : page.status;
        if (!parsedResult.record) page.status = "parse_failed";
        page.parserStatus = "failed";
        page.errors.push(...problems.filter((p) => p.level === "error").map((p) => `${p.check}: ${p.detail}`));
      } else {
        page.parserStatus = "parsed";
        parsed.set(e.departmentCode, parsedResult.record);
      }
      page.warnings.push(...problems.filter((p) => p.level === "warning").map((p) => `${p.check}: ${p.detail}`));
    }
  }

  const count = (s: AcquisitionStatus) => pages.filter((p) => p.status === s).length;
  return {
    report: finish({
      requested: batch.length,
      robotsAllowed: true,
      robotsNote: "robots.txt allows (or offline cache prime)",
      success: count("success"),
      cached: count("cached"),
      failed: count("failed"),
      invalid: count("invalid"),
      parseFailed: count("parse_failed"),
    }),
    blocked: false,
    parsed,
  };
}
