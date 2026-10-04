import {
  MANIFEST_YEAR,
  type OfficialDepartmentEntry,
  type OfficialSchoolManifest,
  type UrlValidation,
} from "./types";

/**
 * Strict detail-URL validation. Never regex-only: parse with `new URL()`,
 * then verify hostname, path scope, year and department code.
 *
 * Accepted: https://www.cac.edu.tw/{apply115,mobile_apply115}/.../<year>_<6code>.htm
 * Rejected: other hosts, javascript:, unresolvable relatives, off-scope paths,
 * year/code mismatch, missing code.
 */

const DETAIL_FILE_RE = /(\d{3})_(\d{6})\.htm$/i;

export function validateDetailUrl(rawUrl: string, baseUrl: string): UrlValidation {
  const fail = (reason: string): UrlValidation => ({ valid: false, reason, canonicalUrl: null });
  if (!rawUrl || !rawUrl.trim()) return fail("empty url");
  const t = rawUrl.trim();
  if (/^\s*javascript:/i.test(t)) return fail("javascript: url rejected");
  let u: URL;
  try {
    u = new URL(t, baseUrl);
  } catch {
    return fail(`unresolvable relative url: ${t.slice(0, 80)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return fail(`unexpected protocol: ${u.protocol}`);
  }
  if (u.hostname.toLowerCase() !== "www.cac.edu.tw") {
    return fail(`non-official host: ${u.hostname}`);
  }
  // Scope: both the desktop (/apply115/) and mobile (/mobile_apply115/) trees
  // are official CAC 115 hierarchies carrying the same detail files.
  if (!/(^|\/)mobile_apply115\/|(^|\/)apply115\//.test(u.pathname)) {
    return fail(`path outside apply115 scope: ${u.pathname.slice(0, 80)}`);
  }
  const m = u.pathname.match(DETAIL_FILE_RE);
  if (!m) return fail(`not an official detail file: ${u.pathname.slice(-60)}`);
  const year = Number(m[1]);
  if (year !== MANIFEST_YEAR) return fail(`year ${year} != ${MANIFEST_YEAR}`);
  u.hash = "";
  return { valid: true, reason: null, canonicalUrl: u.toString() };
}

export function detailCodeOf(canonicalUrl: string): string | null {
  try {
    const m = new URL(canonicalUrl).pathname.match(DETAIL_FILE_RE);
    return m ? m[2]! : null;
  } catch {
    return null;
  }
}
