import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPipeline } from "../src/data/importers/official/application115/index";

const FIX = path.join(__dirname, "fixtures", "application115");

describe("application115 dry-run (no DB)", () => {
  it("produces preview + report without touching the DB", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-"));
    const reportPath = path.join(tmp, "import-report.json");
    const { report, preview } = await runPipeline({
      inputPath: path.join(FIX, "sample.csv"),
      year: 115,
      dryRun: true,
      dataVersion: "test-fixture",
      reportPath,
    });
    expect(report.dry_run).toBe(true);
    expect(report.records_read).toBe(2);
    expect(report.records_valid).toBe(2);
    expect(report.inserted).toBe(0);
    expect(report.errors).toBe(0);
    expect(preview.join("\n")).toContain("schools: 1");
    expect(preview.join("\n")).toContain("admissions: 2");
    const saved = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(saved.source).toBe("cac-115-application-dept-rules");
    expect(saved.records_read).toBe(2);
  });

  it("dry-run on malformed input reports errors honestly", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-"));
    const { report } = await runPipeline({
      inputPath: path.join(FIX, "malformed.csv"),
      year: 115,
      dryRun: true,
      dataVersion: "test-fixture",
      reportPath: path.join(tmp, "import-report.json"),
    });
    expect(report.errors).toBeGreaterThan(0);
    expect(report.records_invalid).toBeGreaterThan(0);
    expect(report.error_details.length).toBeGreaterThan(0);
  });

  it("rejects non-115 years", async () => {
    await expect(
      runPipeline({
        inputPath: path.join(FIX, "sample.csv"),
        year: 114,
        dryRun: true,
        dataVersion: "test-fixture",
        reportPath: path.join(os.tmpdir(), "should-not-exist.json"),
      }),
    ).rejects.toThrow("only supports year 115");
  });
});
