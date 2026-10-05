import { parse } from "node-html-parser";

/**
 * P1-C.2A TotalGsdShow parser — school index only (no departments).
 * Identity: schoolCode comes from the official `colno` link parameter;
 * never from the year prefix, never from fuzzy name matching.
 * schoolUrl is resolved absolute with the query string preserved verbatim.
 */

export interface UniverseSchool {
  schoolCode: string;
  schoolName: string;
  schoolUrl: string;
  /** "(NNN)name -NN系(組)" trailing count; null when absent/unparseable. */
  listedDepartmentCount: number | null;
  sourceText: string;
}

export interface TotalGsdShowParseResult {
  schools: UniverseSchool[];
  /** Anchors that could not be reliably parsed (kept, never guessed). */
  failures: string[];
  duplicateCodes: string[];
}

function cleanText(s: string): string {
  return s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function parseTotalGsdShow(html: string, sourceUrl: string): TotalGsdShowParseResult {
  const schools: UniverseSchool[] = [];
  const failures: string[] = [];
  const seen = new Map<string, number>();
  const duplicates: string[] = [];

  let root;
  try {
    root = parse(html);
  } catch (e) {
    return { schools, failures: [`HTML parse failed: ${(e as Error).message}`], duplicateCodes: [] };
  }
  let base: URL;
  try {
    base = new URL(sourceUrl);
  } catch {
    return { schools, failures: [`sourceUrl unparseable: ${sourceUrl.slice(0, 100)}`], duplicateCodes: [] };
  }

  for (const a of root.querySelectorAll("a")) {
    const rawHref = a.getAttribute("href") ?? "";
    if (!/ShowSchGsd/i.test(rawHref)) continue;
    let href: URL;
    try {
      href = new URL(rawHref, base);
    } catch {
      failures.push(`unresolvable href: ${rawHref.slice(0, 80)}`);
      continue;
    }
    const colno = href.searchParams.get("colno") ?? "";
    if (!/^\d{3}$/.test(colno)) {
      failures.push(`non-3-digit colno: ${rawHref.slice(0, 80)}`);
      continue;
    }
    const text = cleanText(a.text);
    const m = text.match(/^\((\d{3})\)\s*(.+?)\s*(?:-\s*(\d+)\s*系\(組\))?$/);
    if (!m) {
      failures.push(`unrecognized anchor text for colno=${colno}: ${text.slice(0, 60)}`);
      continue;
    }
    if (m[1] !== colno) {
      failures.push(`colno/text mismatch: href=${colno} text=${m[1]} (${text.slice(0, 60)})`);
      continue;
    }
    const schoolUrl = href.toString();
    if (seen.has(colno)) {
      if (!duplicates.includes(colno)) duplicates.push(colno);
      continue;
    }
    seen.set(colno, 1);
    schools.push({
      schoolCode: colno,
      schoolName: m[2]!.trim(),
      schoolUrl,
      listedDepartmentCount: m[3] !== undefined ? Number(m[3]) : null,
      sourceText: text,
    });
  }
  schools.sort((a, b) => a.schoolCode.localeCompare(b.schoolCode));
  duplicates.sort();
  return { schools, failures, duplicateCodes: duplicates };
}

export interface SchoolIndex {
  academicYear: number;
  source: "official-cac";
  sourceUrl: string;
  retrievedAt: string;
  sha256: string;
  schools: { schoolCode: string; schoolName: string; schoolUrl: string; listedDepartmentCount: number | null }[];
}

export function buildSchoolIndex(parsed: TotalGsdShowParseResult, opts: {
  sourceUrl: string;
  retrievedAt: string;
  sha256: string;
}): SchoolIndex {
  return {
    academicYear: 115,
    source: "official-cac",
    sourceUrl: opts.sourceUrl,
    retrievedAt: opts.retrievedAt,
    sha256: opts.sha256,
    schools: parsed.schools.map((s) => ({
      schoolCode: s.schoolCode,
      schoolName: s.schoolName,
      schoolUrl: s.schoolUrl,
      listedDepartmentCount: s.listedDepartmentCount,
    })),
  };
}
