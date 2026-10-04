import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * P3.9 raw cache adapter over P2.5 cache paths.
 * Reuses departmentPath()/readIfCached()/writeRaw; adds a metadata sidecar
 * (url, retrievedAt, status, contentType, sha256) for traceability.
 */

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface CacheMeta {
  url: string;
  retrievedAt: string;
  httpStatus: number;
  contentType: string | null;
  sha256: string;
  bytes: number;
}

export function metaPath(htmlPath: string): string {
  return `${htmlPath}.meta.json`;
}

export function readCacheEntry(
  htmlPath: string,
  force: boolean,
): { html: string; meta: CacheMeta } | null {
  if (force) return null;
  try {
    if (!fs.existsSync(htmlPath) || !fs.existsSync(metaPath(htmlPath))) return null;
    const html = fs.readFileSync(htmlPath, "utf8");
    const meta = JSON.parse(fs.readFileSync(metaPath(htmlPath), "utf8")) as CacheMeta;
    if (!html || !meta.sha256) return null;
    return { html, meta };
  } catch {
    return null;
  }
}

export function writeCacheEntry(htmlPath: string, html: string, meta: CacheMeta): void {
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(metaPath(htmlPath), JSON.stringify(meta, null, 2));
}
