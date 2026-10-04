import fs from "node:fs";
import { parseDetailHtml } from "../detail/parser";
import type { DetailRecord } from "../detail/types";

/**
 * Identification reuses the P3.7 parser (no copied logic): identity comes
 * from parsed HTML content, never from the filename alone. Filename-code
 * agreement is recorded as corroboration only.
 */
export interface Identification {
  record: DetailRecord | null;
  filenameCode: string | null;
  filenameAgrees: boolean | null;
  errors: string[];
}

export function identifyFile(filePath: string, html: string, sourceUrl: string): Identification {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const m = base.match(/(\d{6})\.html?$/i);
  const filenameCode = m ? m[1]! : null;
  const { record, issues } = parseDetailHtml(html, { sourceUrl, dataVersion: "local-import" });
  if (!record) {
    return {
      record: null,
      filenameCode,
      filenameAgrees: null,
      errors: issues.filter((i) => i.level === "error").map((i) => `${i.check}: ${i.detail}`),
    };
  }
  return {
    record,
    filenameCode,
    filenameAgrees: filenameCode ? filenameCode === record.departmentCode : null,
    errors: [],
  };
}

export interface SidecarMeta {
  /** Canonical source URL (P3.12 browser capture writes `sourceUrl`). */
  url?: string;
  /** Set when `sourceUrl` and legacy `url` disagree — never pick silently. */
  conflict?: string;
}

export function readSidecarMeta(filePath: string): SidecarMeta | null {
  for (const candidate of [`${filePath}.meta.json`]) {
    try {
      if (!fs.existsSync(candidate)) return null;
      const raw = JSON.parse(fs.readFileSync(candidate, "utf8")) as { url?: unknown; sourceUrl?: unknown };
      if (raw === null || typeof raw !== "object") return null;
      const canonical = typeof raw.sourceUrl === "string" && raw.sourceUrl.trim() !== "" ? raw.sourceUrl.trim() : undefined;
      const legacy = typeof raw.url === "string" && raw.url.trim() !== "" ? raw.url.trim() : undefined;
      if (canonical && legacy && canonical !== legacy) {
        return { conflict: `sidecar sourceUrl != url (${canonical.slice(0, 80)} vs ${legacy.slice(0, 80)}); refusing to pick` };
      }
      if (canonical ?? legacy) return { url: (canonical ?? legacy)! };
      return {};
    } catch {
      return null;
    }
  }
  return null;
}
