import { validateDetailUrl } from "../../../../discovery/official/application115/validator";

/**
 * Official-source validation for manually downloaded files.
 * Accepted sourceUrl origins, in order:
 *  1. P3.9 sidecar .meta.json next to the file (must pass P3.8 URL policy AND
 *     match the HTML-parsed department code).
 *  2. Nothing else. Filenames and relative in-page links (Apply_ReviewData.pdf)
 *     are corroboration at best — without metadata the file is source_unverified.
 * Never guess. Never fetch to "confirm".
 */

export interface SourceVerdict {
  ok: boolean;
  sourceUrl: string | null;
  reasons: string[];
}

export function validateSource(
  metaUrl: string | null | undefined,
  htmlCode: string,
  academicYear: number,
): SourceVerdict {
  if (!metaUrl) {
    return {
      ok: false,
      sourceUrl: null,
      reasons: ["no sidecar .meta.json URL and no absolute official reference in HTML; source unverified, not guessed"],
    };
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(metaUrl);
  } catch {
    return { ok: false, sourceUrl: metaUrl, reasons: [`meta URL unparseable: ${metaUrl.slice(0, 100)}`] };
  }
  if (parsed.hostname.toLowerCase() !== "www.cac.edu.tw") {
    return { ok: false, sourceUrl: metaUrl, reasons: [`non-official hostname: ${parsed.hostname}`] };
  }
  const v = validateDetailUrl(metaUrl, metaUrl);
  if (!v.valid || !v.canonicalUrl) {
    return { ok: false, sourceUrl: metaUrl, reasons: [`fails P3.8 URL policy: ${v.reason}`] };
  }
  const m = v.canonicalUrl.match(/(\d{3})_(\d{6})\.htm$/i);
  if (!m) return { ok: false, sourceUrl: metaUrl, reasons: ["no <year>_<6code>.htm in meta URL"] };
  if (Number(m[1]) !== academicYear) {
    return { ok: false, sourceUrl: metaUrl, reasons: [`meta year ${m[1]} != ${academicYear}`] };
  }
  if (!/^\d{6}$/.test(htmlCode)) {
    return { ok: false, sourceUrl: metaUrl, reasons: ["HTML department code missing/malformed"] };
  }
  if (m[2] !== htmlCode) {
    return { ok: false, sourceUrl: metaUrl, reasons: [`meta code ${m[2]} != HTML code ${htmlCode}`] };
  }
  return { ok: true, sourceUrl: v.canonicalUrl, reasons: [] };
}

export function validateFileEligible(bytes: number, html: string): string[] {
  const problems: string[] = [];
  if (bytes <= 0) problems.push("empty file");
  if (bytes > 0 && !/<html|<!doctype html/i.test(html.slice(0, 500))) problems.push("not HTML content");
  return problems;
}
