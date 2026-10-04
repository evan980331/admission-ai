import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BrowserCaptureStatus, CaptureMeta, CapturedPage } from "./types";
import { DETAIL_PARSER_VERSION } from "../../importers/official/application115/detail/types";

/**
 * Raw capture store. Never overwrites different content silently:
 * same hash -> already_captured; same code + different hash -> the previous
 * file is versioned to 115_<code>.<oldsha8>.htm and meta keeps previousSha256.
 * Stores NO cookies/headers/auth/profile — outerHTML + metadata only.
 */
export interface StoreOutcome {
  status: BrowserCaptureStatus;
  filePath: string;
  metaPath: string;
  sha256: string;
  previousSha256: string | null;
}

export function sha256Hex(s: string | Uint8Array): string {
  return createHash("sha256").update(s).digest("hex");
}

export function filenameFor(code: string): string {
  return `115_${code}.htm`;
}

export function storeCapture(opts: {
  rawDir: string;
  departmentCode: string;
  schoolCode: string;
  sourceUrl: string;
  browserPort: number;
  page: CapturedPage;
  capturedAt?: string;
}): StoreOutcome {
  const capturedAt = opts.capturedAt ?? new Date().toISOString();
  const sha = sha256Hex(opts.page.outerHtml);
  fs.mkdirSync(opts.rawDir, { recursive: true });
  const filePath = path.join(opts.rawDir, filenameFor(opts.departmentCode));
  const metaPath = `${filePath}.meta.json`;

  let previousSha: string | null = null;
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8");
    const existingSha = sha256Hex(existing);
    if (existingSha === sha) {
      return { status: "already_captured", filePath, metaPath, sha256: sha, previousSha256: null };
    }
    previousSha = existingSha;
    const versioned = path.join(opts.rawDir, `115_${opts.departmentCode}.${existingSha.slice(0, 8)}.htm`);
    fs.renameSync(filePath, versioned);
  }

  fs.writeFileSync(filePath, opts.page.outerHtml);
  const meta: CaptureMeta = {
    sourceType: "official",
    sourceUrl: opts.sourceUrl,
    capturedAt,
    academicYear: 115,
    departmentCode: opts.departmentCode,
    schoolCode: opts.schoolCode,
    sha256: sha,
    previousSha256: previousSha,
    acquisitionMethod: "browser_cdp",
    browserPort: opts.browserPort,
    parserVersion: DETAIL_PARSER_VERSION,
    status: previousSha ? "content_changed" : "captured",
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return {
    status: previousSha ? "content_changed" : "captured",
    filePath,
    metaPath,
    sha256: sha,
    previousSha256: previousSha,
  };
}
