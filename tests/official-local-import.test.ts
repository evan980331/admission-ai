import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runLocalImport } from "../src/data/importers/official/application115/local/index";
import { discoverHtmlFiles } from "../src/data/importers/official/application115/local/discover";

const P37 = path.join(__dirname, "fixtures", "official", "application115", "detail");
const OFFICIAL_URL = (code: string) =>
  `https://www.cac.edu.tw/mobile_apply115/colqRy_Apply_8Rfsd57q/html/115_${code}.htm`;

function stage(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-local-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const realHtml = (code: string) => fs.readFileSync(path.join(P37, `115_${code}.htm`), "utf8");
const withMeta = (code: string) => ({
  [`${code}.htm`]: realHtml(code),
  [`${code}.htm.meta.json`]: JSON.stringify({ url: OFFICIAL_URL(code), retrievedAt: "2026-01-01", httpStatus: 200 }),
});

const run = (dir: string, extra: Record<string, unknown> = {}) =>
  runLocalImport({ inputDir: dir, outputDir: null, academicYear: 115, dryRun: false, dataVersion: "test", ...extra });

describe("official local import", () => {
  it("recursive discovery + html filtering (skips pdf/json/meta)", () => {
    const dir = stage({ "a/b/c.htm": "<html></html>", "d.HTML": "<html></html>", "e.pdf": "%PDF", "f.json": "{}", "g.htm.meta.json": "{}" });
    const { files, skipped } = discoverHtmlFiles(dir);
    expect(files.map((f) => path.basename(f.path)).sort()).toEqual(["c.htm", "d.HTML"]);
    expect(skipped.length).toBe(3);
  });

  it("imports known official HTML 001012 (identity+source+quota)", () => {
    const dir = stage(withMeta("001012"));
    const { report, records } = run(dir);
    expect(report.imported).toBe(1);
    const r = records[0]!;
    expect(r.status).toBe("imported");
    expect(r.detail!.departmentCode).toBe("001012");
    expect(r.detail!.quota).toBe(23);
    expect(r.p2Row!.chinese_requirement).toBe("前標");
    expect(r.canonical).toMatchObject({ schoolCode: "001", departmentCode: "001012", quota: 23 });
  });

  it("imports APCS 001592 with apcs preserved", () => {
    const dir = stage(withMeta("001592"));
    const { records } = run(dir);
    expect(records[0]!.detail!.apcs!.items).toHaveLength(2);
    expect(records[0]!.status).toBe("imported");
  });

  it("unidentifiable html -> unidentified, no normalized data", () => {
    const dir = stage({ "mystery.htm": "<html><body><p>no codes here</p></body></html>" });
    const { report, records } = run(dir);
    expect(report.unidentified).toBe(1);
    expect(records).toHaveLength(0);
    expect(report.files[0]!.status).toBe("unidentified");
  });

  it("non-official meta hostname -> source_unverified", () => {
    const dir = stage({
      "x.htm": realHtml("001012"),
      "x.htm.meta.json": JSON.stringify({ url: "https://evil.example.com/115_001012.htm" }),
    });
    const { report } = run(dir);
    expect(report.sourceUnverified).toBe(1);
    expect(report.imported).toBe(0);
  });

  it("meta/html code mismatch -> source_unverified", () => {
    const dir = stage({
      "y.htm": realHtml("001012"),
      "y.htm.meta.json": JSON.stringify({ url: OFFICIAL_URL("001022") }),
    });
    const { report } = run(dir);
    expect(report.sourceUnverified).toBe(1);
    expect(report.files[0]!.reasons.join("")).toContain("001022");
  });

  it("missing meta -> source_unverified (never guessed)", () => {
    const dir = stage({ "115_001012.htm": realHtml("001012") });
    const { report } = run(dir);
    expect(report.sourceUnverified).toBe(1);
    expect(report.imported).toBe(0);
  });

  it("duplicate content -> already_imported via hash", () => {
    const html = realHtml("001012");
    const dir = stage({
      "a.htm": html,
      "a.htm.meta.json": JSON.stringify({ url: OFFICIAL_URL("001012") }),
      "sub/b.htm": html,
      "sub/b.htm.meta.json": JSON.stringify({ url: OFFICIAL_URL("001012") }),
    });
    const { report, records } = run(dir);
    expect(report.duplicates).toBe(1);
    expect(report.imported).toBe(1);
    expect(records.filter((r) => r.status === "imported")).toHaveLength(1);
  });

  it("idempotent reruns agree (counts stable)", () => {
    const dir = stage({ ...withMeta("001012"), ...withMeta("001592") });
    const a = run(dir).report;
    const b = run(dir).report;
    for (const k of ["discovered", "imported", "duplicates", "unidentified", "sourceUnverified", "parserErrors", "normalizationErrors"] as const) {
      expect(b[k]).toBe(a[k]);
    }
  });

  it("garbage .htm -> invalid_html", () => {
    const dir = stage({ "junk.htm": "this is definitely not html at all {{{{" });
    const { report } = run(dir);
    expect(report.parserErrors).toBeGreaterThan(0);
  });

  it("zero-network guarantee (fetch throws if touched)", () => {
    const dir = stage(withMeta("001012"));
    const orig = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      throw new Error("network touched");
    }) as unknown as typeof fetch;
    try {
      const { report } = run(dir);
      expect(report.imported).toBe(1);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = orig;
    }
    const banned = /fetch\(|axios|https\.get|http\.get|curl|wget|puppeteer|playwright|child_process/i;
    for (const f of [
      "src/data/importers/official/application115/local/types.ts",
      "src/data/importers/official/application115/local/discover.ts",
      "src/data/importers/official/application115/local/identify.ts",
      "src/data/importers/official/application115/local/validator.ts",
      "src/data/importers/official/application115/local/importer.ts",
      "src/data/importers/official/application115/local/report.ts",
      "src/data/importers/official/application115/local/index.ts",
      "scripts/import-official-local.ts",
    ]) {
      expect(fs.readFileSync(f, "utf8")).not.toMatch(banned);
    }
  });

  it("report generation lists every failure with reasons", () => {
    const dir = stage({ "bad.htm": "nope {{{", "u.htm": "<html><body>x</body></html>" });
    const { report } = run(dir);
    expect(report.files.length).toBe(2);
    expect(report.files.every((f) => f.reasons.length > 0 || f.status === "imported")).toBe(true);
  });
});
