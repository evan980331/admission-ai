import { OFFICIAL_HOST, OFFICIAL_ORIGIN } from "./types";

/**
 * Department detail URL handling.
 *
 * Preferred: the detail URL exactly as listed on the official per-school page
 * (ShowSchGsd.php) — see school-parser.ts. The builder below exists ONLY for the
 * confirmed filename convention `<year>_<6-digit-code>.htm` (observed e.g.
 * 115_001012.htm, 115_001702.htm) and must stay a pure, tested function.
 * The directory prefix below is marked UNVERIFIED until confirmed against a
 * manually downloaded official index page.
 */

/** UNVERIFIED directory prefix — confirm against a manually downloaded page before live use. */
export const DETAIL_DIR_UNVERIFIED =
  "/mobile_apply115/colqRy_Apply_8Rfsd57q/html";

export function validateDepartmentCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

export function validateYear(year: number): boolean {
  return Number.isInteger(year) && year >= 100 && year <= 130;
}

export function buildDepartmentUrl(year: number, departmentCode: string): string {
  if (!validateYear(year)) throw new Error(`invalid year: ${JSON.stringify(year)}`);
  if (!validateDepartmentCode(departmentCode)) {
    throw new Error(`department_code must be 6 digits, got ${JSON.stringify(departmentCode)}`);
  }
  return `${OFFICIAL_ORIGIN}${DETAIL_DIR_UNVERIFIED}/${year}_${departmentCode}.htm`;
}

/** True only for http(s) URLs on the official host ending in a 6-digit .htm detail page. */
export function isOfficialDetailUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.hostname.toLowerCase() !== OFFICIAL_HOST) return false;
    return /\/\d{3,}_\d{6}\.htm$/i.test(u.pathname) || /\/\d{6}\.htm$/i.test(u.pathname);
  } catch {
    return false;
  }
}
