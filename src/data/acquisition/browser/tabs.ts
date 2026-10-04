import type { CdpTarget } from "./types";

/**
 * Current-tab selection: exactly ONE open page may match the CAC 115 detail
 * pattern. Zero matches -> tell the user to open the page; multiple matches
 * -> refuse (never guess, never iterate tabs).
 */
export function isCacDetailTabUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (u.hostname.toLowerCase() !== "www.cac.edu.tw") return false;
    if (!/(^|\/)mobile_apply115\/|(^|\/)apply115\//.test(u.pathname)) return false;
    const m = u.pathname.match(/(\d{3})_(\d{6})\.htm$/i);
    if (!m || Number(m[1]) !== 115) return false;
    return true;
  } catch {
    return false;
  }
}

export function selectCurrentTab(targets: CdpTarget[]): { target: CdpTarget } | { error: string } {
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const matches = pages.filter((t) => isCacDetailTabUrl(t.url));
  if (matches.length === 0) {
    return {
      error:
        "no CAC 115 detail tab found. Open one official detail page (115_XXXXXX.htm) in the debug Chrome and keep other CAC tabs closed.",
    };
  }
  if (matches.length > 1) {
    return {
      error: `found ${matches.length} CAC detail tabs; keep exactly one open (no auto-iteration).`,
    };
  }
  return { target: matches[0]! };
}
