import {
  UTW_ORIGIN,
  type ThirdPartyRecord,
  type UtwParseIssue,
} from "./types";

/**
 * Parse a University TW department page (/caac/<school>/<dept>) for detail fields:
 * quota, prior-year quota (去年), 115+114 檢定/倍率 tables, 114 篩選結果.
 * Supplements (never replaces) school-page rows. No DB access.
 */

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
}
function toNull(s: string): string | null {
  const t = s.trim();
  return t === "" || t === "--" ? null : t;
}
function toRatio(s: string): number | null {
  const t = s.trim();
  if (t === "" || t === "--") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getDd(html: string, dtLabel: string): string | null {
  const m = html.match(new RegExp(`<dt>\\s*${dtLabel}\\s*</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd\\s*>`, "i"));
  return m ? m[1]! : null;
}

function parseStandardTable(ddHtml: string): { subjects: string[]; y115: string[]; y114: string[] } {
  const empty = { subjects: [] as string[], y115: [] as string[], y114: [] as string[] };
  const head = ddHtml.match(/<thead>([\s\S]*?)<\/thead>/i)?.[1] ?? "";
  const subjects = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th\s*>/gi)].map((m) => stripTags(m[1]!)).filter(Boolean);
  const body = ddHtml.match(/<tbody>([\s\S]*?)<\/tbody>/i)?.[1] ?? "";
  const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((m) =>
    [...m[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)].map((c) => stripTags(c[1]!)),
  );
  const r115 = rows.find((r) => r[0]?.includes("115"))?.slice(1) ?? [];
  const r114 = rows.find((r) => r[0]?.includes("114"))?.slice(1) ?? [];
  if (subjects.length === 0 && rows.length === 0) return empty;
  return { subjects, y115: r115, y114: r114 };
}

export interface UtwDeptDetail {
  quota: number | null;
  priorYearQuota: number | null;
  subjectsTaken: string | null;
  req115: string[];
  ratio115: (number | null)[];
  req114: string[];
  ratio114: (number | null)[];
  screening114: string | null;
  officialLinks: string[];
  issues: UtwParseIssue[];
}

export function parseUtwDeptPage(html: string, departmentCode: string, pageUrl: string): UtwDeptDetail {
  const issues: UtwParseIssue[] = [];
  if (!pageUrl.startsWith(UTW_ORIGIN + "/caac/")) {
    issues.push({ level: "error", detail: `dept page url not on UTW: ${pageUrl}` });
  }

  const quotaDd = getDd(html, "招收人數");
  const quotaText = quotaDd ? stripTags(quotaDd) : "";
  const quota = quotaText.match(/(\d+)\s*人/)?.[1];
  const prior = quotaText.match(/去年[：:]\s*(\d+)\s*人/)?.[1];

  const subjectsDd = getDd(html, "採計科目");
  const subjectsTaken = subjectsDd ? stripTags(subjectsDd).replace(/^採計：/, "") || null : null;

  const reqTable = parseStandardTable(getDd(html, "學測檢定標準") ?? "");
  const ratioTable = parseStandardTable(getDd(html, "篩選倍率") ?? "");
  const screeningDd = getDd(html, "114年篩選結果");
  const screening114 = screeningDd ? stripTags(screeningDd).replace(/\s+/g, " ") || null : null;

  const officialLinks = [...html.matchAll(/<a\b[^>]*href\s*=\s*["'](https:\/\/www\.cac\.edu\.tw[^"']*)["']/gi)].map(
    (m) => m[1]!,
  );

  const req115 = reqTable.y115.map(toNull).map((v) => v ?? "--") as string[];
  return {
    quota: quota !== undefined && quota !== null ? Number(quota) : null,
    priorYearQuota: prior !== undefined && prior !== null ? Number(prior) : null,
    subjectsTaken,
    req115,
    ratio115: ratioTable.y115.map(toRatio),
    req114: reqTable.y114.map(toNull).map((v) => v ?? "--"),
    ratio114: ratioTable.y114.map(toRatio),
    screening114,
    officialLinks: [...new Set(officialLinks)],
    issues,
  };
}

export function attachDeptDetail(base: ThirdPartyRecord, detail: UtwDeptDetail): ThirdPartyRecord {
  return {
    ...base,
    priorYearQuota: detail.priorYearQuota,
    subjectsTaken: detail.subjectsTaken ?? base.subjectsTaken,
    unmapped: [
      ...base.unmapped,
      ...(detail.issues.map((i) => i.detail) ?? []),
      ...(detail.screening114 ? [`114 screening: ${detail.screening114}`] : []),
    ],
  };
}
