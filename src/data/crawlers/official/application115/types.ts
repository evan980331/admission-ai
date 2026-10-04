/**
 * application115 crawler — shared types.
 *
 * Compliance-first design:
 *  - cac.edu.tw robots.txt currently says `Disallow: /` (verified 2026-10-04, P2).
 *  - The crawler fetches robots.txt at startup (ONE request, the compliance request).
 *  - If robots disallows, batch mode REFUSES to run; only dry-run (offline parsing
 *    of local fixtures) is available.
 *  - The crawler NEVER writes to Neon. It only produces raw files + index JSON.
 *    DB import stays in the P2 importer (`scripts/import-official.ts`).
 */

export const SOURCE_APPLICATION115 = "application115";
export const ACADEMIC_YEAR_115 = 115;
export const CRAWLER_VERSION = "application115-crawler-v0.1.0";

export const OFFICIAL_ORIGIN = "https://www.cac.edu.tw";
export const OFFICIAL_HOST = "www.cac.edu.tw";
export const ROBOTS_URL = "https://www.cac.edu.tw/robots.txt";
export const TOTAL_INDEX_URL =
  "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/TotalGsdShow.htm";

/** Honest, non-browser User-Agent. Never spoof a browser to evade limits. */
export const CRAWLER_USER_AGENT =
  "Predicter-P2-Research/0.1 (academic research crawler; respects robots.txt; manual-download fallback)";

export interface SchoolEntry {
  school_code: string;
  school_name: string;
  school_url: string;
}

export interface DepartmentEntry {
  school_code: string;
  department_code: string;
  department_name: string;
  url: string;
}

export interface SchoolWithDepartments {
  school_code: string;
  school_name: string;
  departments: DepartmentEntry[];
}

export interface CrawlIssue {
  level: "error" | "warning";
  stage: string;
  detail: string;
}

export interface CrawlReport {
  year: number;
  source: string;
  crawler_version: string;
  dry_run: boolean;
  started_at: string;
  finished_at: string;
  schools_found: number;
  schools_processed: number;
  departments_found: number;
  files_downloaded: number;
  files_cached: number;
  errors: number;
  warnings: number;
  robots_allowed: boolean;
  robots_note: string;
  notes: string[];
  issues: CrawlIssue[];
}

export type FetchImpl = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ status: number; text: () => Promise<string> }>;
