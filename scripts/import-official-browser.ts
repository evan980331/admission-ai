import { runBrowserImport } from "../src/data/acquisition/browser/index";
import { BROWSER_DEFAULT_PORT } from "../src/data/acquisition/browser/types";

/**
 * Browser-assisted import CLI. Connects ONLY to the user's own Chrome on
 * localhost (CDP) and reads the currently open official detail tab.
 * Sends zero requests to CAC. Never opens/navigates tabs.
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
  const dryRun = flag("--dry-run");
  const result = await runBrowserImport({
    port,
    rawDir: arg("--output"),
    dryRun,
  });

  console.log(`tab: ${result.tabUrl ?? "(none)"}`);
  if (result.departmentCode) {
    console.log(`school: ${result.schoolCode} ${result.schoolName ?? ""}`);
    console.log(`department: ${result.departmentCode} ${result.departmentName ?? ""}`);
  }
  console.log(`htmlBytes: ${result.htmlBytes} sha256: ${result.sha256 ? result.sha256.slice(0, 16) + "…" : "(none)"}`);
  console.log(`capture: ${result.captureStatus}`);
  console.log(`parser: ${result.parserStatus} normalization: ${result.normalizationStatus}`);
  for (const r of result.reasons) console.log(`note: ${r}`);
  if (dryRun) console.log("dry-run: nothing stored or parsed");
  if (
    result.captureStatus === "source_rejected" ||
    result.captureStatus === "parse_error" ||
    result.parserStatus === "failed" ||
    result.normalizationStatus === "failed"
  ) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
