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

/**
 * Desktop detail URL builder (pure). Only academic years whose host/path
 * segments have been verified against live official hrefs are buildable;
 * anything else throws (never extrapolate to unverified years).
 * Emits the canonical form WITHOUT query (?v=1.0 is a page-load artifact,
 * not part of the address). Candidate-only: existence is confirmed solely
 * by a later manual or runner-driven open of the official page.
 */
const VERIFIED_DETAIL_YEARS = [115] as const;
const OFFICIAL_ORIGIN = "https://www.cac.edu.tw";

function desktopDetailDir(year: number): string {
  return `/apply${year}/system/ColQry_${year}xappLyfOrStu_Azd5gP29/html`;
}

export function buildOfficialDetailUrl(academicYear: number, departmentCode: string): string {
  if (!Number.isInteger(academicYear) || academicYear < 100 || academicYear > 130) {
    throw new Error(`academicYear must be integer 100-130, got ${JSON.stringify(academicYear)}`);
  }
  if (!(VERIFIED_DETAIL_YEARS as readonly number[]).includes(academicYear)) {
    throw new Error(`academicYear ${academicYear} has no VERIFIED detail URL pattern (verified: ${VERIFIED_DETAIL_YEARS.join(",")})`);
  }
  if (!/^\d{6}$/.test(departmentCode)) {
    throw new Error(`departmentCode must be 6 digits, got ${JSON.stringify(departmentCode)}`);
  }
  return `${OFFICIAL_ORIGIN}${desktopDetailDir(academicYear)}/${academicYear}_${departmentCode}.htm`;
}

/** Canonical pathname of a detail URL (query-insensitive comparison). */
export function detailPathname(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * PDF-annotation URL vs builder consistency: pathname must match exactly
 * (query ignored), plus year/code/school-prefix agreement. Any mismatch is
 * FAIL-CLOSED (throw) — never silently fix a URL.
 */
export function assertAnnotationMatchesBuilder(annotationUrl: string, academicYear: number, departmentCode: string): void {
  const expected = buildOfficialDetailUrl(academicYear, departmentCode);
  const gotPath = detailPathname(annotationUrl);
  const wantPath = detailPathname(expected);
  if (!gotPath || gotPath !== wantPath) {
    throw new Error(`annotation/builder mismatch for ${departmentCode}: ${gotPath ?? annotationUrl} != ${wantPath}`);
  }
  const m = gotPath.match(/\/(\d{3})_(\d{6})\.htm$/i);
  if (!m || Number(m[1]) !== academicYear || m[2] !== departmentCode) {
    throw new Error(`annotation year/code mismatch for ${departmentCode}: ${gotPath}`);
  }
}
