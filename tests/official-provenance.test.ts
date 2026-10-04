import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runLocalImport } from "../src/data/importers/official/application115/local/index";
import { runDatasetBuild } from "../src/data/dataset/official/application115/index";

/**
 * P3.14 provenance regression: canonical sidecar key is `sourceUrl`
 * (what P3.12 browser capture writes); legacy `url` still accepted;
 * both-present-but-different is a conflict, never picked silently.
 * Real desktop URLs below were observed via CDP, not constructed.
 */
const P37 = path.join(__dirname, "fixtures", "official", "application115", "detail");
const DESKTOP_URL = (code: string) =>
  `https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_${code}.htm`;
const MOBILE_URL = (code: string) =>
  `https://www.cac.edu.tw/mobile_apply115/colqRy_Apply_8Rfsd57q/html/115_${code}.htm`;

const realHtml = (code: string) => fs.readFileSync(path.join(P37, `115_${code}.htm`), "utf8");

function stage(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-prov-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

/** Browser-capture-shaped sidecar: canonical `sourceUrl`, no legacy `url`. */
const browserMeta = (code: string, sourceUrl: string) => ({
  [`${code}.htm`]: realHtml(code),
  [`${code}.htm.meta.json`]: JSON.stringify({
    sourceType: "official",
    sourceUrl,
    academicYear: 115,
    departmentCode: code,
    schoolCode: code.slice(0, 3),
    acquisitionMethod: "browser_cdp",
  }),
});

describe("P3.14 canonical provenance (sourceUrl)", () => {
  it("A. official CAC sourceUrl -> verified", () => {
    const dir = stage(browserMeta("001012", DESKTOP_URL("001012")));
    const { report, records } = runLocalImport({ inputDir: dir, outputDir: null, academicYear: 115, dryRun: false, dataVersion: "test" });
    expect(report.imported).toBe(1);
    expect(records[0]!.status).toBe("imported");
    expect(records[0]!.detail!.sourceUrl).toBe(DESKTOP_URL("001012"));
  });

  it("B. desktop /apply115/ 001022 URL -> verified", () => {
    const dir = stage(browserMeta("001022", DESKTOP_URL("001022")));
    const { report, records } = runLocalImport({ inputDir: dir, outputDir: null, academicYear: 115, dryRun: false, dataVersion: "test" });
    expect(report.imported).toBe(1);
    expect(records[0]!.detail!.departmentCode).toBe("001022");
    expect(records[0]!.detail!.sourceUrl).toBe(DESKTOP_URL("001022"));
    expect(records[0]!.detail!.sourceUrl).not.toContain("/mobile_apply115/");
  });

  it("C. mobile URL is kept as-is, never rewritten to desktop", () => {
    const dir = stage(browserMeta("001012", MOBILE_URL("001012")));
    const { report, records } = runLocalImport({ inputDir: dir, outputDir: null, academicYear: 115, dryRun: false, dataVersion: "test" });
    expect(report.imported).toBe(1);
    expect(records[0]!.detail!.sourceUrl).toBe(MOBILE_URL("001012"));
  });

  it("D. missing source URL -> still source_unverified", () => {
    const dir = stage({
      "001012.htm": realHtml("001012"),
      "001012.htm.meta.json": JSON.stringify({ sourceType: "official", academicYear: 115 }),
    });
    const { report } = runLocalImport({ inputDir: dir, outputDir: null, academicYear: 115, dryRun: false, dataVersion: "test" });
    expect(report.sourceUnverified).toBe(1);
    expect(report.imported).toBe(0);
  });

  it("conflicting sourceUrl/url -> source_unverified, never picked silently", () => {
    const dir = stage({
      "001012.htm": realHtml("001012"),
      "001012.htm.meta.json": JSON.stringify({ sourceUrl: DESKTOP_URL("001012"), url: MOBILE_URL("001012") }),
    });
    const { report } = runLocalImport({ inputDir: dir, outputDir: null, academicYear: 115, dryRun: false, dataVersion: "test" });
    expect(report.sourceUnverified).toBe(1);
    expect(report.imported).toBe(0);
    expect(report.files[0]!.reasons.join("")).toContain("refusing to pick");
  });

  it("legacy `url` sidecar still accepted (backward compat)", () => {
    const dir = stage({
      "001012.htm": realHtml("001012"),
      "001012.htm.meta.json": JSON.stringify({ url: MOBILE_URL("001012") }),
    });
    const { report } = runLocalImport({ inputDir: dir, outputDir: null, academicYear: 115, dryRun: false, dataVersion: "test" });
    expect(report.imported).toBe(1);
  });

  it("query-suffixed real CDP href (?v=1.0) -> verified, query preserved", () => {
    const href = `${DESKTOP_URL("001012")}?v=1.0`;
    const dir = stage(browserMeta("001012", href));
    const { report, records } = runLocalImport({ inputDir: dir, outputDir: null, academicYear: 115, dryRun: false, dataVersion: "test" });
    expect(report.imported).toBe(1);
    expect(records[0]!.detail!.sourceUrl).toBe(href);
  });

  it("E+F. browser-captured 001012/001022 -> dataset verified, normalized, sourceUrl intact", () => {
    const dir = stage({ ...browserMeta("001012", DESKTOP_URL("001012")), ...browserMeta("001022", DESKTOP_URL("001022")) });
    const { dataset, coverage, errors } = runDatasetBuild({ inputDir: dir, outputDir: null, academicYear: 115, dryRun: true, dataVersion: "test" });
    for (const code of ["001012", "001022"]) {
      const e = dataset.entries[`115|001|${code}`]!;
      expect(e.schoolCode).toBe("001");
      expect(e.sourceUrl).toBe(DESKTOP_URL(code));
      expect(e.parserStatus).toBe("success");
      expect(e.normalizationStatus).toBe("success");
    }
    expect(errors.filter((x) => x.status === "source_unverified" || x.status === "validation_error")).toHaveLength(0);
    expect(coverage.parseSuccess + coverage.normalized).toBeGreaterThanOrEqual(2);
    expect(coverage.normalized).toBe(2);
    expect(coverage.validationError).toBe(0);
  });
});
