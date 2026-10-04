/**
 * P3.8 official discovery manifest — schema (domain layer, no downloading).
 * Chain: P2.5 parsers -> school/department indexes -> THIS manifest ->
 * P3.9 acquisition -> P3.7 detail parser -> P3 normalization.
 */

export const MANIFEST_VERSION = "official-manifest-v0.1.0";
export const MANIFEST_YEAR = 115;
export const OFFICIAL_HOST = "www.cac.edu.tw";

export type ManifestStatus = "discovered";

export interface OfficialDepartmentEntry {
  academicYear: number;
  schoolCode: string;
  schoolName: string;
  schoolPageUrl: string;
  departmentCode: string;
  departmentName: string;
  /** Canonical absolute official detail URL (validated). */
  detailUrl: string;
  /** Page where this entry was discovered (total or school page URL). */
  sourceUrl: string;
  sourceType: "official";
  discoveredAt: string;
  status: ManifestStatus;
  urlValidation: UrlValidation;
}

export interface OfficialSchoolManifest {
  academicYear: number;
  schoolCode: string;
  schoolName: string;
  schoolPageUrl: string;
  sourceUrl: string;
  sourceType: "official";
  departments: OfficialDepartmentEntry[];
}

export interface UrlValidation {
  valid: boolean;
  reason: string | null;
  canonicalUrl: string | null;
}

export interface ManifestIssue {
  level: "error" | "warning";
  check: string;
  detail: string;
}

export interface ManifestReport {
  academicYear: number;
  source: "official";
  sourceUrl: string;
  manifestVersion: string;
  generatedAt: string;
  schoolsFound: number;
  departmentsFound: number;
  errors: number;
  warnings: number;
  issues: ManifestIssue[];
}

export interface OfficialDepartmentManifest {
  academicYear: number;
  source: "official";
  sourceUrl: string;
  manifestVersion: string;
  generatedAt: string;
  count: number;
  departments: OfficialDepartmentEntry[];
  schools: OfficialSchoolManifest[];
}
