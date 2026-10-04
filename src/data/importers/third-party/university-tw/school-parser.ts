import {
  UTW_ORIGIN,
  UTW_PARSER_VERSION,
  UTW_SOURCE_NAME,
  UTW_SOURCE_TYPE,
  UTW_YEAR,
  type ThirdPartyRecord,
  type UtwParseIssue,
  type UtwSchoolParseResult,
} from "./types";

/**
 * Parse a University TW school page (/caac/<school>/) into intermediate records.
 * Observed structure (115):
 *   <tr data-code-s=.. data-code-w=..>
 *     <a class=id-link href=<official 115_XXXXXX.htm>>CODE</a>
 *     <a class=name-link href=/caac/001/001012>NAME</a>
 *     <div class=subjects>採計：..</div>
 *     <td>quota</td>
 *     6 × <td class=data-cell><div><div>檢定</div><div>倍率</div></div></td>  (國英數A數B社自)
 *     <td>英聽</td><td>相加項</td>
 * Header-driven subject mapping with positional fallback. No DB access.
 */

const SUBJECT_KEYS = ["chinese", "english", "mathA", "mathB", "social", "science"] as const;

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

export function parseUtwSchoolPage(html: string, schoolCode: string, pageUrl: string): UtwSchoolParseResult {
  const records: ThirdPartyRecord[] = [];
  const issues: UtwParseIssue[] = [];

  const schoolName = (() => {
    const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    return m ? stripTags(m[1]!).split("115")[0]!.trim() || null : null;
  })();

  const rowRe = /<tr\b[^>]*data-code-[sw]=[^>]*>([\s\S]*?)<\/tr\s*>/gi;
  let rowCount = 0;
  for (const rm of html.matchAll(rowRe)) {
    rowCount++;
    const row = rm[1]!;
    const codeMatch = row.match(/class=["']?id-link["']?[^>]*>\s*(\d{6})\s*</i);
    const code = codeMatch?.[1] ?? "";
    if (!/^\d{6}$/.test(code)) {
      issues.push({ level: "error", detail: `row ${rowCount}: no 6-digit code in id-link` });
      continue;
    }
    const nameTag = row.match(/<a\b[^>]*class=["']?name-link["']?[^>]*>/i)?.[0] ?? row.match(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/i)?.[0] ?? "";
    const nameMatch = row.match(/class=["']?name-link["']?[^>]*>([\s\S]*?)<\/a\s*>/i);
    const deptUrlMatch = nameTag.match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    const name = nameMatch ? stripTags(nameMatch[1]!) : "";
    if (!name) {
      issues.push({ level: "error", detail: `row ${rowCount} (${code}): department name missing` });
      continue;
    }
    const deptUrlRaw = deptUrlMatch?.[1] ?? deptUrlMatch?.[2] ?? deptUrlMatch?.[3] ?? "";
    const deptUrl = deptUrlRaw.startsWith("/") ? UTW_ORIGIN + deptUrlRaw : deptUrlRaw;
    if (!deptUrl.startsWith(UTW_ORIGIN + "/caac/")) {
      issues.push({ level: "warning", detail: `${code}: dept url not on UTW (${deptUrl || "empty"})` });
    }
    const subjMatch = row.match(/class=subjects[^>]*>([\s\S]*?)<\/div\s*>/i);
    const subjectsTaken = subjMatch ? stripTags(subjMatch[1]!).replace(/^採計：/, "") || null : null;

    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)].map((m) => m[1]!);
    // cells[0] = name cell, cells[1] = quota, then data cells + 英聽 + 相加項
    const quota = cells.length > 1 ? Number(stripTags(cells[1]!)) : NaN;
    const pairs = [...row.matchAll(/<td\b[^>]*class=["']?data-cell["']?[^>]*>([\s\S]*?)<\/td\s*>/gi)].map((m) => {
      const divs = [...m[1]!.matchAll(/<div>\s*([^<>]*)\s*<\/div\s*>/gi)].map((d) => stripTags(d[1]!));
      return { req: toNull(divs[0] ?? ""), ratio: divs.length > 1 ? toRatio(divs[1] ?? "") : null };
    });
    // trailing plain cells: 英聽 then 相加項
    const plainCells = [...row.matchAll(/<td(?![^>]*class=["']?data-cell["']?)[^>]*>([\s\S]*?)<\/td\s*>/gi)]
      .map((m) => stripTags(m[1]!))
      .slice(2); // drop name + quota cells
    const englishListening = plainCells.length > 0 ? toNull(plainCells[0]!) : null;
    const summedItem = plainCells.length > 1 ? toNull(plainCells.slice(1).join(" ")) : null;

    const requirements = {
      chinese: null as string | null,
      english: null as string | null,
      mathA: null as string | null,
      mathB: null as string | null,
      social: null as string | null,
      science: null as string | null,
      englishListening,
    };
    const screeningRatios: (number | null)[] = [null, null, null, null, null, null];
    pairs.slice(0, 6).forEach((p, i) => {
      requirements[SUBJECT_KEYS[i]!] = p.req;
      screeningRatios[i] = p.ratio;
    });
    if (pairs.length !== 6) {
      issues.push({ level: "warning", detail: `${code}: expected 6 subject cells, found ${pairs.length}` });
    }

    records.push({
      sourceType: UTW_SOURCE_TYPE,
      sourceName: UTW_SOURCE_NAME,
      sourceUrl: deptUrl || pageUrl,
      academicYear: UTW_YEAR,
      schoolCode,
      schoolName,
      departmentCode: code,
      departmentName: name,
      quota: Number.isInteger(quota) && quota >= 0 ? quota : null,
      priorYearQuota: null,
      subjectsTaken,
      requirements,
      screeningRatios,
      summedItem,
      unmapped: [],
    });
    if (!Number.isInteger(quota) || quota < 0) {
      issues.push({ level: "warning", detail: `${code}: quota unparseable, kept null` });
    }
  }
  if (rowCount === 0) issues.push({ level: "error", detail: "no department rows found" });
  void UTW_PARSER_VERSION;
  return { records, issues };
}
