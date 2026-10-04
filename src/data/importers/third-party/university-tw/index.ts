import { parseUtwDeptPage } from "./dept-parser";
import { parseUtwSchoolPage } from "./school-parser";
import type { ThirdPartyRecord, UtwParseIssue, UtwSchoolParseResult } from "./types";

/**
 * Third-party entry point: HTML strings in, intermediate records out.
 * Fetching/caching lives outside (manual local files in P3.6); this module
 * never touches the network or the DB.
 */
export function parseSchoolHtml(html: string, schoolCode: string, pageUrl: string): UtwSchoolParseResult {
  return parseUtwSchoolPage(html, schoolCode, pageUrl);
}

export function enrichWithDeptHtml(
  base: ThirdPartyRecord[],
  pages: Map<string, { html: string; url: string }>,
): { records: ThirdPartyRecord[]; issues: UtwParseIssue[] } {
  const issues: UtwParseIssue[] = [];
  const records = base.map((r) => {
    const p = pages.get(r.departmentCode);
    if (!p) return r;
    const detail = parseUtwDeptPage(p.html, r.departmentCode, p.url);
    issues.push(...detail.issues);
    return {
      ...r,
      priorYearQuota: detail.priorYearQuota,
      subjectsTaken: detail.subjectsTaken ?? r.subjectsTaken,
      unmapped: [
        ...r.unmapped,
        ...(detail.screening114 ? [`114 screening: ${detail.screening114}`] : []),
      ],
    };
  });
  return { records, issues };
}
