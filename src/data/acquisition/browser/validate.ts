import type { CapturedPage } from "./types";
import { isCacDetailTabUrl } from "./tabs";

/**
 * Official-page + HTML validation for browser-captured content.
 * Rejects: wrong host/year/shape, javascript:/data:/blank, non-HTML,
 * content that is not a CAC detail page. Missing FIELDS are the parser's
 * call, not a rejection reason here.
 */

export function validateTabUrl(url: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!url || /^(about:blank|chrome-?newtab)/i.test(url.trim())) reasons.push("blank page");
  else if (/^\s*javascript:/i.test(url)) reasons.push("javascript: url rejected");
  else if (/^\s*data:/i.test(url)) reasons.push("data: url rejected");
  else if (!isCacDetailTabUrl(url)) reasons.push("not a CAC 115 official detail URL (official host …/115_<6code>.htm)");
  return { ok: reasons.length === 0, reasons };
}

const DETAIL_MARKERS = ["校系代碼", "招生名額", "基本資料及時程"];

export function validateCapturedHtml(html: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!html || html.length < 500) reasons.push("HTML too small to be a CAC detail page");
  if (!/<html|<!doctype html/i.test(html.slice(0, 500))) reasons.push("not an HTML document");
  if (html.length > 0) {
    const hits = DETAIL_MARKERS.filter((m) => html.includes(m)).length;
    if (hits < 2) reasons.push(`missing CAC detail markers (${hits}/3)`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function validateCapturedPage(page: CapturedPage): { ok: boolean; reasons: string[] } {
  const url = validateTabUrl(page.tabUrl);
  const html = validateCapturedHtml(page.outerHtml);
  return { ok: url.ok && html.ok, reasons: [...url.reasons, ...html.reasons] };
}
