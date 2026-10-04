import dotenv from "dotenv";
import {
  ACADEMIC_YEAR_115,
  SOURCE_APPLICATION115,
} from "../src/data/importers/official/application115/types";
import { runPipeline } from "../src/data/importers/official/application115/index";

dotenv.config({ path: ".env.local" });
dotenv.config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const source = arg("--source");
  const year = Number(arg("--year"));
  const input = arg("--input");
  const dryRun = flag("--dry-run");
  const dataVersion =
    arg("--data-version") ?? `manual-${new Date().toISOString().slice(0, 10)}`;

  if (source !== SOURCE_APPLICATION115) {
    console.error(`unsupported --source ${JSON.stringify(source)} (expected "application115")`);
    process.exit(2);
  }
  if (year !== ACADEMIC_YEAR_115) {
    console.error(`P2 only supports --year 115, got ${JSON.stringify(arg("--year"))}`);
    process.exit(2);
  }
  if (!input) {
    console.error(
      "missing --input <local-file>. P2 is manual-download only (cac.edu.tw robots Disallow: /); " +
        "download the official file by hand into data/raw/official/115/application/ first.",
    );
    process.exit(2);
  }

  const { preview } = await runPipeline({ inputPath: input, year, dryRun, dataVersion });
  for (const line of preview) console.log(line);
  console.log(`report: data/processed/official/115/application/import-report.json`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
