import fs from "node:fs";
import path from "node:path";

/** Raw-file cache. Files are content-addressed by purpose, never re-downloaded unless --force. */

export function rawRoot(): string {
  return path.join(process.cwd(), "data", "raw", "official", "115", "application");
}

export function totalPath(root = rawRoot()): string {
  return path.join(root, "index", "total.html");
}

export function schoolPath(schoolCode: string, root = rawRoot()): string {
  return path.join(root, "schools", `${schoolCode}.html`);
}

export function departmentPath(year: number, departmentCode: string, root = rawRoot()): string {
  return path.join(root, "departments", `${year}_${departmentCode}.htm`);
}

export function robotsCachePath(root = rawRoot()): string {
  return path.join(root, "index", "robots.txt");
}

/** Returns file content when a usable cache entry exists (and !force), else null. */
export function readIfCached(filePath: string, force: boolean): string | null {
  if (force) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf8");
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

export function writeRaw(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}
