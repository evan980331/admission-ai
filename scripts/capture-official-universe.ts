import { captureUniverseIndex, storeUniverseIndex } from "../src/data/acquisition/browser/universe";
import { buildSchoolIndex, parseTotalGsdShow } from "../src/data/discovery/official/application115/universe";
import { BROWSER_DEFAULT_PORT } from "../src/data/acquisition/browser/types";
import fs from "node:fs";
import path from "node:path";

/**
 * P1-C.2A universe capture CLI. Reads ONLY the one CAC index page the user
 * already opened in their own Chrome (localhost CDP). No navigation, no new
 * tabs, zero requests to CAC. This phase supports TotalGsdShow only.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const portRaw = arg("--port");
  const port = portRaw === undefined ? BROWSER_DEFAULT_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`--port must be 1-65535, got ${JSON.stringify(portRaw)}`);
    process.exit(2);
  }
  const kind = arg("--kind") ?? "total";
  if (kind !== "total") {
    console.error(`only --kind total is supported this phase, got ${JSON.stringify(kind)}`);
    process.exit(2);
  }
  const universeDir = arg("--output") ?? `${process.cwd()}/data/raw/official/115/application/universe`;
  const dryRun = flag("--dry-run");

  const { sourceUrl, outerHtml, title } = await captureUniverseIndex(port);
  console.log(`tab: ${sourceUrl}`);
  console.log(`title: ${title}`);
  console.log(`htmlBytes: ${outerHtml.length}`);
  if (dryRun) {
    const parsed = parseTotalGsdShow(outerHtml, sourceUrl);
    console.log(`schools: ${parsed.schools.length} failures: ${parsed.failures.length} duplicates: ${parsed.duplicateCodes.length}`);
    console.log("dry-run: validated only, nothing stored");
    return;
  }
  const stored = storeUniverseIndex({ universeDir, sourceUrl, outerHtml });
  console.log(`stored: ${stored.htmlPath}`);
  console.log(`meta: ${stored.metaPath}`);
  console.log(`sha256: ${stored.meta.sha256}`);
  const parsed = parseTotalGsdShow(outerHtml, sourceUrl);
  console.log(`schools: ${parsed.schools.length} failures: ${parsed.failures.length} duplicates: ${parsed.duplicateCodes.length}`);
  for (const f of parsed.failures) console.log(`parse-failure: ${f}`);
  const index = buildSchoolIndex(parsed, { sourceUrl, retrievedAt: stored.meta.retrievedAt, sha256: stored.meta.sha256 });
  const indexPath = path.join(universeDir, "school-index.json");
  if (fs.existsSync(indexPath)) {
    throw new Error(`refusing to overwrite ${indexPath} (universe raw is append-only this phase)`);
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`school-index: ${indexPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
