import {
  OFFICIAL_ORIGIN,
  type CrawlIssue,
  type DepartmentEntry,
} from "./types";
import { isOfficialDetailUrl, validateDepartmentCode } from "./department-url";

/**
 * Parse a per-school page (ShowSchGsd.php?colno=XXX) -> official department list.
 * Only anchors that resolve to the OFFICIAL domain and carry a valid 6-digit
 * department code are accepted. Everything else is reported, never invented.
 */

const DETAIL_LINK_RE = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi;

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
}

export interface SchoolParseResult {
  departments: DepartmentEntry[];
  issues: CrawlIssue[];
}

export function parseSchoolDepartments(
  html: string,
  schoolCode: string,
  schoolPageUrl: string,
): SchoolParseResult {
  const departments: DepartmentEntry[] = [];
  const issues: CrawlIssue[] = [];
  if (!schoolCode.trim()) {
    return { departments, issues: [{ level: "error", stage: "dept-index", detail: "school_code empty" }] };
  }
  const seen = new Set<string>();

  for (const m of html.matchAll(DETAIL_LINK_RE)) {
    const rawHref = m[1]!.trim();
    if (!rawHref) {
      issues.push({ level: "warning", stage: "dept-index", detail: `empty href ignored (school ${schoolCode})` });
      continue;
    }
    let url: string;
    try {
      url = new URL(rawHref, schoolPageUrl).toString();
    } catch {
      issues.push({ level: "warning", stage: "dept-index", detail: `unresolvable href ignored: ${rawHref}` });
      continue;
    }
    if (!isOfficialDetailUrl(url)) continue; // non-detail or off-domain links are navigation, not errors
    const codeMatch = url.match(/(\d{6})\.htm/i);
    const code = codeMatch?.[1] ?? "";
    if (!validateDepartmentCode(code)) {
      issues.push({ level: "error", stage: "dept-index", detail: `bad department_code in ${url}` });
      continue;
    }
    if (seen.has(code)) {
      issues.push({
        level: "error",
        stage: "dept-index",
        detail: `duplicate department_code ${code} in school ${schoolCode}`,
      });
      continue;
    }
    seen.add(code);
    const name = stripTags(m[2]!).replace(/\(\s*\d{6}\s*\)\s*$/, "").trim() || code;
    departments.push({ school_code: schoolCode, department_code: code, department_name: name, url });
  }

  void OFFICIAL_ORIGIN;
  return { departments, issues };
}
