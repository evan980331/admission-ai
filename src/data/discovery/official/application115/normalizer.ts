import { detailCodeOf, validateDetailUrl } from "./validator";
import {
  MANIFEST_VERSION,
  MANIFEST_YEAR,
  type ManifestIssue,
  type ManifestReport,
  type OfficialDepartmentEntry,
  type OfficialSchoolManifest,
} from "./types";

/**
 * Manifest builder/normalizer: P2.5 parse outputs -> canonical manifest.
 * No fetching. Every entry carries provenance; unverified fields are never added.
 */

export interface DiscoveredSchool {
  school_code: string;
  school_name: string;
  school_url: string;
}

export interface DiscoveredDepartment {
  school_code: string;
  department_code: string;
  department_name: string;
  url: string;
}

export interface BuildOptions {
  academicYear?: number;
  totalUrl: string;
  discoveredAt?: string;
}

export interface BuildResult {
  schools: OfficialSchoolManifest[];
  entries: OfficialDepartmentEntry[];
  report: ManifestReport;
}

export function buildManifest(
  schools: DiscoveredSchool[],
  departmentsBySchool: Map<string, DiscoveredDepartment[]>,
  opts: BuildOptions,
): BuildResult {
  const year = opts.academicYear ?? MANIFEST_YEAR;
  const discoveredAt = opts.discoveredAt ?? new Date().toISOString();
  const issues: ManifestIssue[] = [];
  const err = (check: string, detail: string) => issues.push({ level: "error", check, detail });
  const warn = (check: string, detail: string) => issues.push({ level: "warning", check, detail });

  const seenSchools = new Set<string>();
  const seenDeptCodes = new Map<string, number>();
  const seenUrls = new Map<string, number>();
  const outSchools: OfficialSchoolManifest[] = [];
  const entries: OfficialDepartmentEntry[] = [];

  for (const s of schools) {
    if (!s.school_code.trim()) {
      err("school-code", "school with empty code skipped");
      continue;
    }
    if (seenSchools.has(s.school_code)) {
      err("school-unique", `duplicate school_code ${s.school_code}`);
      continue;
    }
    seenSchools.add(s.school_code);
    if (!s.school_name.trim()) warn("school-name", `school ${s.school_code} has empty name`);

    const schoolManifest: OfficialSchoolManifest = {
      academicYear: year,
      schoolCode: s.school_code,
      schoolName: s.school_name,
      schoolPageUrl: s.school_url,
      sourceUrl: opts.totalUrl,
      sourceType: "official",
      departments: [],
    };

    for (const d of departmentsBySchool.get(s.school_code) ?? []) {
      const v = validateDetailUrl(d.url, s.school_url);
      const urlCode = v.canonicalUrl ? detailCodeOf(v.canonicalUrl) : null;
      const entry: OfficialDepartmentEntry = {
        academicYear: year,
        schoolCode: s.school_code,
        schoolName: s.school_name,
        schoolPageUrl: s.school_url,
        departmentCode: d.department_code,
        departmentName: d.department_name,
        detailUrl: v.canonicalUrl ?? d.url,
        sourceUrl: s.school_url,
        sourceType: "official",
        discoveredAt,
        status: "discovered",
        urlValidation: v,
      };
      // Integrity checks: error/warning, never silent fix.
      if (year !== MANIFEST_YEAR) err("year", `entry year ${year} != ${MANIFEST_YEAR}`);
      if (!/^\d{6}$/.test(d.department_code)) {
        err("dept-code", `bad department_code ${JSON.stringify(d.department_code)} in school ${s.school_code}`);
      } else if (!d.department_code.startsWith(s.school_code)) {
        err("code-prefix", `department ${d.department_code} does not start with school ${s.school_code}`);
      }
      if (!d.department_name.trim()) err("dept-name", `department ${d.department_code} has empty name`);
      else if (d.department_name.trim() === d.department_code) {
        warn("dept-name", `department ${d.department_code} name equals its code (name likely missing upstream)`);
      }
      if (!v.valid) {
        err("detail-url", `department ${d.department_code}: ${v.reason}`);
      } else if (urlCode !== d.department_code) {
        err("url-code-mismatch", `department ${d.department_code} but URL points at ${urlCode}`);
      }
      const dk = `${s.school_code}|${d.department_code}`;
      seenDeptCodes.set(dk, (seenDeptCodes.get(dk) ?? 0) + 1);
      if (v.canonicalUrl) seenUrls.set(v.canonicalUrl, (seenUrls.get(v.canonicalUrl) ?? 0) + 1);
      schoolManifest.departments.push(entry);
      entries.push(entry);
    }
    outSchools.push(schoolManifest);
  }

  for (const [k, n] of seenDeptCodes) {
    if (n > 1) err("dept-unique", `duplicate department identity ${k} x${n}`);
  }
  for (const [u, n] of seenUrls) {
    if (n > 1) err("url-unique", `duplicate detailUrl ${u} x${n}`);
  }

  const errors = issues.filter((i) => i.level === "error").length;
  const warnings = issues.filter((i) => i.level === "warning").length;
  return {
    schools: outSchools,
    entries,
    report: {
      academicYear: year,
      source: "official",
      sourceUrl: opts.totalUrl,
      manifestVersion: MANIFEST_VERSION,
      generatedAt: discoveredAt,
      schoolsFound: outSchools.length,
      departmentsFound: entries.length,
      errors,
      warnings,
      issues,
    },
  };
}
