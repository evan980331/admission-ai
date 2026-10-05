import fs from "node:fs";
import path from "node:path";
import { captureCurrentPage, listTargets } from "./cdp";
import { sha256Hex } from "./capture";
import { DETAIL_PARSER_VERSION } from "../../importers/official/application115/detail/types";

/**
 * P1-C.2A index capture adapter (TotalGsdShow / ShowSchGsd).
 * Separate from the detail pipeline on purpose:
 * - `isCacDetailTabUrl` is NEVER widened (detail gate untouched).
 * - Index pages use their own gate below and never enter runBrowserImport.
 * - No navigation, no new tabs, no CAC HTTP — reads the one page the user
 *   already opened via localhost CDP.
 */

export type IndexKind = "total" | "school";

export interface IndexTarget {
  target: { id: string; url: string; webSocketDebuggerUrl: string };
  kind: IndexKind;
  schoolCode: string | null;
}

/**
 * Independent index URL gate. Accepts ONLY the two official 115 index shapes:
 * - TotalGsdShow.htm (school universe)
 * - ShowSchGsd.php?colno=NNN (per-school department universe)
 * Detail pages (115_<6code>.htm, mobile or desktop) are NOT index pages.
 */
export function isCacApplicationIndexUrl(url: string): { kind: IndexKind; schoolCode: string | null } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.hostname.toLowerCase() !== "www.cac.edu.tw") return null;
  if (!/(^|\/)apply115\//.test(u.pathname)) return null;
  if (/mobile_apply115\//.test(u.pathname)) return null;
  const total = /\/TotalGsdShow\.htm$/i.test(u.pathname);
  const school = /\/ShowSchGsd\.php$/i.test(u.pathname);
  if (total && !school) return { kind: "total", schoolCode: null };
  if (school && !total) {
    const colno = u.searchParams.get("colno");
    if (!colno || !/^\d{3}$/.test(colno)) return null;
    return { kind: "school", schoolCode: colno };
  }
  return null;
}

/** Exactly one CAC index tab must be open (browser_ui entries ignored). */
export async function selectIndexTarget(port: number): Promise<IndexTarget> {
  const targets = await listTargets(port);
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const matches = pages
    .map((t) => ({ t, gate: isCacApplicationIndexUrl(t.url) }))
    .filter((m) => m.gate !== null);
  if (matches.length === 0) {
    throw new Error("no CAC 115 index tab found. Open TotalGsdShow.htm (or one ShowSchGsd.php?colno=NNN) in the debug Chrome first.");
  }
  if (matches.length > 1) {
    throw new Error(`found ${matches.length} CAC index tabs; keep exactly one open (no auto-iteration).`);
  }
  const m = matches[0]!;
  return { target: m.t, kind: m.gate!.kind, schoolCode: m.gate!.schoolCode };
}

export interface UniverseMeta {
  academicYear: 115;
  sourceType: "official-cac-universe";
  sourceUrl: string;
  retrievedAt: string;
  captureMethod: "browser-cdp";
  sha256: string;
  parserVersion: string | null;
}

export interface StoreUniverseOutcome {
  htmlPath: string;
  metaPath: string;
  meta: UniverseMeta;
  bytes: number;
}

/** Store TotalGsdShow raw + meta under universe/. Never overwrites silently. */
export function storeUniverseIndex(opts: {
  universeDir: string;
  sourceUrl: string;
  outerHtml: string;
  retrievedAt?: string;
}): StoreUniverseOutcome {
  const retrievedAt = opts.retrievedAt ?? new Date().toISOString();
  fs.mkdirSync(opts.universeDir, { recursive: true });
  const htmlPath = path.join(opts.universeDir, "total-gsd-show.html");
  const metaPath = `${htmlPath}.meta.json`;
  if (fs.existsSync(htmlPath)) {
    throw new Error(`refusing to overwrite ${htmlPath} (universe raw is append-only this phase)`);
  }
  fs.writeFileSync(htmlPath, opts.outerHtml);
  const meta: UniverseMeta = {
    academicYear: 115,
    sourceType: "official-cac-universe",
    sourceUrl: opts.sourceUrl,
    retrievedAt,
    captureMethod: "browser-cdp",
    sha256: sha256Hex(opts.outerHtml),
    parserVersion: DETAIL_PARSER_VERSION,
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return { htmlPath, metaPath, meta, bytes: Buffer.byteLength(opts.outerHtml, "utf8") };
}

export async function captureUniverseIndex(port: number): Promise<{ sourceUrl: string; outerHtml: string; title: string }> {
  const selected = await selectIndexTarget(port);
  if (selected.kind !== "total") {
    throw new Error(`this phase captures TotalGsdShow only; open tab is a school index page (colno=${selected.schoolCode})`);
  }
  const page = await captureCurrentPage(selected.target.webSocketDebuggerUrl);
  const sourceUrl = page.tabUrl || selected.target.url;
  if (!isCacApplicationIndexUrl(sourceUrl)) {
    throw new Error(`live href left the index page: ${sourceUrl.slice(0, 120)}`);
  }
  return { sourceUrl, outerHtml: page.outerHtml, title: page.tabTitle };
}
