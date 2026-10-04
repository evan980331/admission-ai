import { parseSchoolDepartments, parseTotalSchools } from "./parser";
import { buildManifest, type BuildResult } from "./normalizer";
import type { OfficialDepartmentEntry } from "./types";

/**
 * Adapters between layers. Downloading stays in P2.5; parsing stays in P2.5;
 * this file only converts already-parsed outputs.
 *
 *   P2.5 crawler parsers -> school/department indexes -> buildManifest (P3.8)
 *   manifest entry -> P3.7 detail input ({ htmlPath, sourceUrl })
 */

export interface AdapterOptions {
  academicYear?: number;
  totalUrl: string;
  discoveredAt?: string;
}

export function totalHtmlToManifestInput(
  totalHtml: string,
  schoolPages: Map<string, { html: string; url: string }>,
  opts: AdapterOptions,
): BuildResult {
  const total = parseTotalSchools(totalHtml);
  const deptMap = new Map<
    string,
    { school_code: string; department_code: string; department_name: string; url: string }[]
  >();
  const extraIssues = [...total.issues];
  for (const s of total.schools) {
    const page = schoolPages.get(s.school_code);
    if (!page) {
      extraIssues.push({
        level: "warning" as const,
        stage: "manifest-adapter",
        detail: `no local school page for ${s.school_code}; school kept with zero departments`,
      });
      deptMap.set(s.school_code, []);
      continue;
    }
    const parsed = parseSchoolDepartments(page.html, s.school_code, page.url);
    extraIssues.push(...parsed.issues);
    deptMap.set(
      s.school_code,
      parsed.departments.map((d) => ({
        school_code: d.school_code,
        department_code: d.department_code,
        department_name: d.department_name,
        url: d.url,
      })),
    );
  }
  const result = buildManifest(
    total.schools.map((s) => ({ school_code: s.school_code, school_name: s.school_name, school_url: s.school_url })),
    deptMap,
    { academicYear: opts.academicYear, totalUrl: opts.totalUrl, discoveredAt: opts.discoveredAt },
  );
  result.report.issues.unshift(
    ...extraIssues.map((i) => ({ level: i.level, check: `p25:${i.stage}`, detail: i.detail })),
  );
  result.report.errors = result.report.issues.filter((i) => i.level === "error").length;
  result.report.warnings = result.report.issues.filter((i) => i.level === "warning").length;
  return result;
}

/** Compatibility: what the P3.7 detail CLI needs for one manifest entry. */
export interface DetailInput {
  departmentCode: string;
  sourceUrl: string;
  expectedFilename: string;
}

export function manifestEntryToDetailInput(entry: OfficialDepartmentEntry): DetailInput | null {
  if (!entry.urlValidation.valid || !entry.urlValidation.canonicalUrl) return null;
  const m = entry.urlValidation.canonicalUrl.match(/(\d{3})_(\d{6})\.htm$/i);
  if (!m) return null;
  return {
    departmentCode: entry.departmentCode,
    sourceUrl: entry.urlValidation.canonicalUrl,
    expectedFilename: `${m[1]}_${m[2]}.htm`,
  };
}
