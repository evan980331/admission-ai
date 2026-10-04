import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  manifestEntryToDetailInput,
  totalHtmlToManifestInput,
} from "../src/data/discovery/official/application115/index";
import { validateDetailUrl } from "../src/data/discovery/official/application115/validator";
import { parseDetailHtml } from "../src/data/importers/official/application115/detail/parser";

const NEW = path.join(__dirname, "fixtures", "official", "application115", "discovery");
const P25 = path.join(__dirname, "fixtures", "application115", "crawler");
const read = (p: string) => fs.readFileSync(p, "utf8");
const TOTAL_URL = "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/TotalGsdShow.htm";

function buildMini() {
  return totalHtmlToManifestInput(
    read(path.join(NEW, "total-mini.html")),
    new Map([
      ["001", { html: read(path.join(P25, "school-001.html")), url: `${TOTAL_URL.replace("TotalGsdShow.htm", "ShowSchGsd.php?colno=001")}` }],
      ["002", { html: read(path.join(NEW, "school-002-mini.html")), url: "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/ShowSchGsd.php?colno=002" }],
    ]),
    { academicYear: 115, totalUrl: TOTAL_URL, discoveredAt: "2026-01-01T00:00:00.000Z" },
  );
}

describe("school discovery (reuses P2.5 parser)", () => {
  it("finds schools with canonical absolute urls", () => {
    const { schools, report } = buildMini();
    expect(schools).toHaveLength(2);
    expect(schools[0]).toMatchObject({ schoolCode: "001", academicYear: 115 });
    expect(schools[0]!.schoolPageUrl).toContain("ShowSchGsd.php?colno=001");
    expect(schools[0]!.sourceType).toBe("official");
    expect(report.schoolsFound).toBe(2);
  });
});

describe("department discovery + provenance", () => {
  it("entries carry provenance and discovered status", () => {
    const { entries } = buildMini();
    const e = entries.find((x) => x.departmentCode === "001012")!;
    expect(e).toMatchObject({
      academicYear: 115,
      schoolCode: "001",
      sourceType: "official",
      status: "discovered",
      discoveredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(e.detailUrl).toContain("115_001012.htm");
  });
});

describe("URL canonicalization + validation", () => {
  it("resolves relative hrefs against the school page", () => {
    const { entries } = buildMini();
    const e = entries.find((x) => x.departmentCode === "002001")!;
    expect(e.urlValidation.valid).toBe(true);
    expect(e.detailUrl.startsWith("https://www.cac.edu.tw/")).toBe(true);
  });
  it("rejects javascript:, off-domain, out-of-scope, bad year", () => {
    expect(validateDetailUrl("javascript:alert(1)", TOTAL_URL).valid).toBe(false);
    expect(validateDetailUrl("https://evil.example.com/115_002001.htm", TOTAL_URL).valid).toBe(false);
    expect(validateDetailUrl("https://www.cac.edu.tw/other/115_002001.htm", TOTAL_URL).valid).toBe(false);
    expect(validateDetailUrl("https://www.cac.edu.tw/mobile_apply115/x/html/114_002001.htm", TOTAL_URL).valid).toBe(false);
    expect(validateDetailUrl("", TOTAL_URL).valid).toBe(false);
    expect(validateDetailUrl("https://www.cac.edu.tw/mobile_apply115/x/html/115_002001.htm", TOTAL_URL)).toMatchObject({ valid: true });
  });
});

describe("duplicate + consistency detection", () => {
  it("flags prefix mismatch and empty names via adapter", () => {
    const { report } = buildMini();
    const checks = report.issues.map((i) => i.check);
    expect(checks).toContain("code-prefix");
    expect(checks).toContain("dept-name");
    // P2.5 dedupes exact duplicates with its own error (surfaced, not silent).
    expect(checks.some((c) => c.startsWith("p25:"))).toBe(true);
  });
  it("flags duplicate codes/urls at builder level (defense in depth)", async () => {
    const { buildManifest } = await import("../src/data/discovery/official/application115/normalizer");
    const dup = { school_code: "002", department_code: "002001", department_name: "A", url: "https://www.cac.edu.tw/mobile_apply115/c/html/115_002001.htm" };
    const r = buildManifest(
      [{ school_code: "002", school_name: "S", school_url: `${TOTAL_URL.replace("TotalGsdShow.htm", "ShowSchGsd.php?colno=002")}` }],
      new Map([["002", [dup, { ...dup }]]]),
      { academicYear: 115, totalUrl: TOTAL_URL, discoveredAt: "2026-01-01T00:00:00.000Z" },
    );
    const checks = r.report.issues.map((i) => i.check);
    expect(checks).toContain("dept-unique");
    expect(checks).toContain("url-unique");
    expect(r.report.errors).toBeGreaterThan(0);
  });
  it("off-domain links never enter the manifest", () => {
    const { entries } = buildMini();
    expect(entries.every((e) => !e.detailUrl.includes("evil.example.com"))).toBe(true);
  });
});

describe("academic year validation", () => {
  it("pins every entry to 115", () => {
    const { entries } = buildMini();
    expect(entries.every((e) => e.academicYear === 115)).toBe(true);
  });
});

describe("P2.5 -> P3.8 adapter", () => {
  it("reuses P2.5 fixtures without copying logic", () => {
    const { entries, report } = totalHtmlToManifestInput(
      read(path.join(P25, "total.html")),
      new Map([
        ["001", { html: read(path.join(P25, "school-001.html")), url: "https://www.cac.edu.tw/x/ShowSchGsd.php?colno=001" }],
        ["002", { html: read(path.join(P25, "school-dup.html")), url: "https://www.cac.edu.tw/x/ShowSchGsd.php?colno=002" }],
      ]),
      { academicYear: 115, totalUrl: TOTAL_URL, discoveredAt: "2026-01-01T00:00:00.000Z" },
    );
    expect(entries.length).toBeGreaterThan(0);
    // P2.5 parser findings flow through with p25: prefix (dup fixture proves it).
    expect(report.issues.some((i) => i.check.startsWith("p25:") && i.detail.includes("duplicate"))).toBe(true);
  });
});

describe("manifest -> P3.7 detail compatibility", () => {
  it("entry detailUrl maps to a P3.7-parseable input", () => {
    const { entries } = buildMini();
    const e = entries.find((x) => x.departmentCode === "001012")!;
    const input = manifestEntryToDetailInput(e);
    expect(input).toMatchObject({ departmentCode: "001012", expectedFilename: "115_001012.htm" });
    // The real P3.7 fixture parses under the same filename convention.
    const real = fs.readFileSync(path.join(__dirname, "fixtures", "official", "application115", "detail", "115_001012.htm"), "utf8");
    const parsed = parseDetailHtml(real, { sourceUrl: input!.sourceUrl });
    expect(parsed.record!.departmentCode).toBe(input!.departmentCode);
    expect(parsed.record!.sourceUrl).toBe(input!.sourceUrl);
  });
  it("invalid entries yield null detail input", () => {
    expect(
      manifestEntryToDetailInput({
        academicYear: 115,
        schoolCode: "002",
        schoolName: "x",
        schoolPageUrl: "https://www.cac.edu.tw/x",
        departmentCode: "002003",
        departmentName: "x",
        detailUrl: "https://evil.example.com/115_002003.htm",
        sourceUrl: "https://www.cac.edu.tw/x",
        sourceType: "official",
        discoveredAt: "2026-01-01T00:00:00.000Z",
        status: "discovered",
        urlValidation: { valid: false, reason: "non-official host", canonicalUrl: null },
      }),
    ).toBeNull();
  });
});
