import fs from "node:fs";
import path from "node:path";
import { departmentPath, rawRoot, readIfCached, robotsCachePath, schoolPath, totalPath, writeRaw } from "./cache";
import { fetchText } from "./client";
import { parseTotalSchools } from "./index-parser";
import { Pacer, MAX_RETRIES, REQUEST_DELAY_MS, REQUEST_TIMEOUT_MS } from "./rate-limit";
import { evaluateRobots } from "./robots";
import { parseSchoolDepartments } from "./school-parser";
import {
  ACADEMIC_YEAR_115,
  CRAWLER_VERSION,
  ROBOTS_URL,
  SOURCE_APPLICATION115,
  TOTAL_INDEX_URL,
  type CrawlIssue,
  type CrawlReport,
  type FetchImpl,
  type SchoolWithDepartments,
} from "./types";

export interface CrawlOptions {
  year: number;
  dryRun: boolean;
  /** Max schools to process (live mode). Conservative default. */
  limitSchools: number;
  force: boolean;
  includeDepartments: boolean;
  /** Skip even the single robots.txt request (fully offline; uses last-known verdict). */
  offline: boolean;
  /** Local total HTML for offline/dry-run index building (manual download or fixture). */
  inputTotalHtml?: string;
  delayMs: number;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: FetchImpl;
  outDir?: string;
  rawDir?: string;
}

export const DEFAULT_LIMIT_SCHOOLS = 3;

export function defaultOptions(): Omit<CrawlOptions, "year" | "dryRun"> {
  return {
    limitSchools: DEFAULT_LIMIT_SCHOOLS,
    force: false,
    includeDepartments: true,
    offline: false,
    delayMs: REQUEST_DELAY_MS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  };
}

export interface CrawlResult {
  report: CrawlReport;
  blocked: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function runCrawl(opts: CrawlOptions): Promise<CrawlResult> {
  if (opts.year !== ACADEMIC_YEAR_115) {
    throw new Error(`P2.5 only supports year 115, got ${opts.year}`);
  }
  const started = nowIso();
  const issues: CrawlIssue[] = [];
  const notes: string[] = [];
  const rawDir = opts.rawDir ?? rawRoot();
  const outDir = opts.outDir ?? path.join(process.cwd(), "data", "processed", "official", "115", "application");
  const pacer = new Pacer(opts.delayMs);
  let filesDownloaded = 0;
  let filesCached = 0;

  const baseReport = (partial: Partial<CrawlReport>): CrawlReport => ({
    year: ACADEMIC_YEAR_115,
    source: SOURCE_APPLICATION115,
    crawler_version: CRAWLER_VERSION,
    dry_run: opts.dryRun,
    started_at: started,
    finished_at: nowIso(),
    schools_found: 0,
    schools_processed: 0,
    departments_found: 0,
    files_downloaded: filesDownloaded,
    files_cached: filesCached,
    errors: 0,
    warnings: 0,
    robots_allowed: false,
    robots_note: "",
    notes,
    issues,
    ...partial,
  });
  const writeReport = (report: CrawlReport): CrawlReport => {
    report.errors = issues.filter((i) => i.level === "error").length;
    report.warnings = issues.filter((i) => i.level === "warning").length;
    report.files_downloaded = filesDownloaded;
    report.files_cached = filesCached;
    report.finished_at = nowIso();
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "crawl-report.json"), JSON.stringify(report, null, 2));
    return report;
  };

  // ---- Stage 0: robots.txt (ONE request; skipped only with --offline) ----
  let robotsText: string | null = null;
  if (opts.offline) {
    robotsText = readIfCached(robotsCachePath(rawDir), false);
    notes.push("offline mode: live robots.txt not fetched; using cache or fail-closed verdict");
  } else {
    await pacer.pace();
    try {
      const cached = readIfCached(robotsCachePath(rawDir), opts.force);
      if (cached !== null) {
        robotsText = cached;
        filesCached++;
        notes.push("robots.txt served from cache");
      } else {
        robotsText = await fetchText(ROBOTS_URL, {
          timeoutMs: opts.timeoutMs,
          maxRetries: opts.maxRetries,
          fetchImpl: opts.fetchImpl,
        });
        writeRaw(robotsCachePath(rawDir), robotsText);
        filesDownloaded++;
      }
    } catch (err) {
      notes.push(`robots.txt fetch failed (${err instanceof Error ? err.message : String(err)}); fail closed`);
    }
  }
  const verdict = evaluateRobots(robotsText);

  // ---- Dry-run: offline parsing only, never batch-request ----
  if (opts.dryRun) {
    let fixtureNote = "dry-run: no website requests except the single robots.txt compliance check above";
    let totalHtml: string | null = null;
    if (opts.inputTotalHtml) {
      totalHtml = fs.readFileSync(opts.inputTotalHtml, "utf8");
      fixtureNote += `; parsed local input ${opts.inputTotalHtml}`;
    } else {
      notes.push("dry-run without --input: indexes not built from fixture by default (use --input <total.html>)");
    }
    let schoolsFound = 0;
    if (totalHtml !== null) {
      const parsed = parseTotalSchools(totalHtml);
      schoolsFound = parsed.schools.length;
      issues.push(...parsed.issues);
      notes.push(`dry-run parsed ${schoolsFound} schools from local file (no network)`);
    }
    const report = baseReport({
      schools_found: schoolsFound,
      robots_allowed: verdict.allowed,
      robots_note: verdict.note,
    });
    notes.push(fixtureNote);
    report.notes = [...notes];
    return { report: writeReport(report), blocked: false };
  }

  // ---- Live mode gate ----
  if (!verdict.allowed) {
    issues.push({ level: "error", stage: "robots", detail: verdict.note });
    notes.push("batch fetch REFUSED: robots.txt disallows automated access; use manual-download mode");
    const report = baseReport({ robots_allowed: false, robots_note: verdict.note });
    return { report: writeReport(report), blocked: true };
  }

  // ---- Live mode (only reachable when robots allows) ----
  await pacer.pace();
  let totalHtml = readIfCached(totalPath(rawDir), opts.force);
  if (totalHtml !== null) {
    filesCached++;
  } else {
    totalHtml = await fetchText(TOTAL_INDEX_URL, {
      timeoutMs: opts.timeoutMs,
      maxRetries: opts.maxRetries,
      fetchImpl: opts.fetchImpl,
    });
    writeRaw(totalPath(rawDir), totalHtml);
    filesDownloaded++;
  }
  const total = parseTotalSchools(totalHtml);
  issues.push(...total.issues);
  const schools = total.schools.slice(0, Math.max(0, opts.limitSchools));
  notes.push(`live crawl limited to ${schools.length} of ${total.schools.length} schools found`);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "school-index.json"),
    JSON.stringify({ year: ACADEMIC_YEAR_115, source: SOURCE_APPLICATION115, schools: total.schools }, null, 2),
  );

  const withDepts: SchoolWithDepartments[] = [];
  let deptCount = 0;
  for (const s of schools) {
    await pacer.pace();
    let html = readIfCached(schoolPath(s.school_code, rawDir), opts.force);
    if (html !== null) {
      filesCached++;
    } else {
      html = await fetchText(s.school_url, {
        timeoutMs: opts.timeoutMs,
        maxRetries: opts.maxRetries,
        fetchImpl: opts.fetchImpl,
      });
      writeRaw(schoolPath(s.school_code, rawDir), html);
      filesDownloaded++;
    }
    const parsed = parseSchoolDepartments(html, s.school_code, s.school_url);
    issues.push(...parsed.issues);
    withDepts.push({ school_code: s.school_code, school_name: s.school_name, departments: parsed.departments });
    deptCount += parsed.departments.length;

    if (opts.includeDepartments) {
      for (const d of parsed.departments) {
        await pacer.pace();
        const p = departmentPath(ACADEMIC_YEAR_115, d.department_code, rawDir);
        const hit = readIfCached(p, opts.force);
        if (hit !== null) {
          filesCached++;
          continue;
        }
        const body = await fetchText(d.url, {
          timeoutMs: opts.timeoutMs,
          maxRetries: opts.maxRetries,
          fetchImpl: opts.fetchImpl,
        });
        writeRaw(p, body);
        filesDownloaded++;
      }
    }
  }
  fs.writeFileSync(
    path.join(outDir, "department-index.json"),
    JSON.stringify({ year: ACADEMIC_YEAR_115, schools: withDepts }, null, 2),
  );

  const report = baseReport({
    schools_found: total.schools.length,
    schools_processed: schools.length,
    departments_found: deptCount,
    robots_allowed: true,
    robots_note: verdict.note,
  });
  return { report: writeReport(report), blocked: false };
}
