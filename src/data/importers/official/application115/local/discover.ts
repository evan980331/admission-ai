import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DiscoveredFile } from "./types";

/**
 * Recursive local discovery. Reads *.htm / *.html only.
 * Skips: .pdf, .json, .meta.json and everything else. No network, read-only.
 */
export function isSupportedFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".meta.json")) return false;
  return lower.endsWith(".htm") || lower.endsWith(".html");
}

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function discoverHtmlFiles(inputDir: string): { files: DiscoveredFile[]; skipped: string[] } {
  const files: DiscoveredFile[] = [];
  const skipped: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        if (!isSupportedFile(e.name)) {
          skipped.push(full);
          continue;
        }
        try {
          const content = fs.readFileSync(full);
          files.push({ path: full, sha256: sha256Hex(content), bytes: content.length });
        } catch {
          skipped.push(full);
        }
      }
    }
  };
  walk(inputDir);
  return { files, skipped };
}
