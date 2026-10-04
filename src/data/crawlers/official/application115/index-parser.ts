import { OFFICIAL_ORIGIN, type CrawlIssue, type SchoolEntry } from "./types";

/**
 * Parse TotalGsdShow.htm -> all schools.
 * Strategy (defensive, no hardcoded school list): collect every anchor whose
 * href points at the official per-school page `ShowSchGsd.php?colno=<3-digit>`.
 * Anchor text = school name. Duplicates collapse with a warning.
 */

const SCHOOL_LINK_RE =
  /<a\b[^>]*href\s*=\s*["']([^"']*ShowSchGsd\.php\?colno=(\d{3})[^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi;

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
}

function toAbsolute(href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  const base = OFFICIAL_ORIGIN + "/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/";
  return new URL(href, base).toString();
}

export interface TotalParseResult {
  schools: SchoolEntry[];
  issues: CrawlIssue[];
}

export function parseTotalSchools(html: string): TotalParseResult {
  const schools: SchoolEntry[] = [];
  const issues: CrawlIssue[] = [];
  const seen = new Map<string, number>();

  for (const m of html.matchAll(SCHOOL_LINK_RE)) {
    const href = m[1]!;
    const code = m[2]!;
    const name = stripTags(m[3]!).replace(/\(\s*0*\d+\s*\)\s*$/, "").trim() || code;
    const url = toAbsolute(href);
    if (!url.startsWith(OFFICIAL_ORIGIN + "/")) {
      issues.push({ level: "error", stage: "school-index", detail: `non-official school URL: ${url}` });
      continue;
    }
    if (seen.has(code)) {
      issues.push({
        level: "warning",
        stage: "school-index",
        detail: `duplicate school_code ${code} (kept first)`,
      });
      continue;
    }
    seen.set(code, schools.length);
    schools.push({ school_code: code, school_name: name, school_url: url });
  }

  if (schools.length === 0) {
    issues.push({ level: "error", stage: "school-index", detail: "no schools parsed from total page" });
  } else if (schools.length !== 64) {
    // Expected ~64 per the official overview page; never "fix" the count, just warn.
    issues.push({
      level: "warning",
      stage: "school-index",
      detail: `expected ~64 schools, parsed ${schools.length}; kept as-is`,
    });
  }
  return { schools, issues };
}
