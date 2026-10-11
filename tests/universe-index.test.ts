import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCacDetailTabUrl } from "../src/data/acquisition/browser/tabs";
import { isCacApplicationIndexUrl, isCacSchoolTabUrl, isErrorPageHtml, isTrafficLimitedHtml, matchDepartmentTab, storeUniverseIndex } from "../src/data/acquisition/browser/universe";
import { assertPdfOrder, buildAcquisitionTask, firstPending, PDF_001_ORDER } from "../src/data/discovery/official/application115/pdf-inventory";
import { buildOfficialDetailUrl, buildSchoolIndex, parseTotalGsdShow } from "../src/data/discovery/official/application115/universe";

const TOTAL = "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/TotalGsdShow.htm";
const SCHOOL = "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/ShowSchGsd.php?colno=001";
const DESKTOP_DETAIL = "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001012.htm?v=1.0";
const MOBILE_DETAIL = "https://www.cac.edu.tw/mobile_apply115/colqRy_Apply_8Rfsd57q/html/115_001012.htm";

/** Synthetic TotalGsdShow-shaped HTML (test-only, mirrors observed structure). */
const SYNTHETIC = `<html><head><title>t</title></head><body><table>
<tr><td><a href="ShowSchGsd.php?colno=001&colname=x">(001)國立臺灣大學 -73系(組)</a></td></tr>
<tr><td><a href="ShowSchGsd.php?colno=002">(002)國立臺灣師範大學 -58系(組)</a></td></tr>
<tr><td><a href="ShowSchGsd.php?colno=002">(002)重複列</a></td></tr>
<tr><td><a href="ShowSchGsd.php?colno=XX">(XX)壞列</a></td></tr>
<tr><td><a href="https://evil.example.com/ShowSchGsd.php?colno=003">站外</a></td></tr>
</table></body></html>`;

describe("index URL gate (independent of detail gate)", () => {
  it("accepts TotalGsdShow", () => {
    expect(isCacApplicationIndexUrl(TOTAL)).toEqual({ kind: "total", schoolCode: null });
  });
  it("accepts ShowSchGsd with 3-digit colno", () => {
    expect(isCacApplicationIndexUrl(SCHOOL)).toEqual({ kind: "school", schoolCode: "001" });
    expect(isCacApplicationIndexUrl(`${SCHOOL}&colname=%E5%9C%8B`)).toEqual({ kind: "school", schoolCode: "001" });
  });
  it("rejects detail pages (both trees), mobile, evil hosts, bad colno", () => {
    expect(isCacApplicationIndexUrl(DESKTOP_DETAIL)).toBeNull();
    expect(isCacApplicationIndexUrl(MOBILE_DETAIL)).toBeNull();
    expect(isCacApplicationIndexUrl("https://evil.example.com/apply115/system/TotalGsdShow.htm")).toBeNull();
    expect(isCacApplicationIndexUrl("https://www.cac.edu.tw/apply115/system/ShowSchGsd.php?colno=1")).toBeNull();
    expect(isCacApplicationIndexUrl("https://www.cac.edu.tw/apply115/system/ShowSchGsd.php")).toBeNull();
    expect(isCacApplicationIndexUrl("javascript:alert(1)")).toBeNull();
  });
  it("detail gate untouched: still rejects index pages", () => {
    expect(isCacDetailTabUrl(TOTAL)).toBe(false);
    expect(isCacDetailTabUrl(SCHOOL)).toBe(false);
  });
});

describe("parseTotalGsdShow", () => {
  it("extracts schools by official colno, keeps query verbatim", () => {
    const r = parseTotalGsdShow(SYNTHETIC, TOTAL);
    expect(r.schools.map((s) => s.schoolCode)).toEqual(["001", "002"]);
    expect(r.schools[0]).toMatchObject({ schoolName: "國立臺灣大學", listedDepartmentCount: 73 });
    expect(r.schools[0]!.schoolUrl).toBe("https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/ShowSchGsd.php?colno=001&colname=x");
    expect(r.duplicateCodes).toEqual(["002"]);
    expect(r.failures.length).toBeGreaterThan(0);
  });
  it("schoolCode comes from colno, never guessed", () => {
    const r = parseTotalGsdShow(`<html><body><a href="ShowSchGsd.php?colno=007">(007)高雄醫學大學 -32系(組)</a></body></html>`, TOTAL);
    expect(r.schools[0]!.schoolCode).toBe("007");
    expect(r.failures).toHaveLength(0);
  });
  it("buildSchoolIndex carries provenance", () => {
    const r = parseTotalGsdShow(SYNTHETIC, TOTAL);
    const idx = buildSchoolIndex(r, { sourceUrl: TOTAL, retrievedAt: "2026-10-05T00:00:00.000Z", sha256: "abc" });
    expect(idx).toMatchObject({ academicYear: 115, source: "official-cac", sourceUrl: TOTAL });
    expect(idx.schools).toHaveLength(2);
  });
});

describe("isCacSchoolTabUrl (scan mode)", () => {
  const SCHOOL_001 = "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/ShowSchGsd.php?colno=001";
  it("1. accepts legal 001 URL", () => {
    expect(isCacSchoolTabUrl(SCHOOL_001)).toBe("001");
    expect(isCacSchoolTabUrl(`${SCHOOL_001}&colname=x`)).toBe("001");
  });
  it("2. rejects non-CAC host", () => {
    expect(isCacSchoolTabUrl("https://evil.example.com/apply115/system/ShowSchGsd.php?colno=001")).toBeNull();
  });
  it("3. rejects non-ShowSchGsd path", () => {
    expect(isCacSchoolTabUrl(TOTAL)).toBeNull();
    expect(isCacSchoolTabUrl(DESKTOP_DETAIL)).toBeNull();
  });
  it("4. rejects missing/bad colno", () => {
    expect(isCacSchoolTabUrl("https://www.cac.edu.tw/apply115/system/ShowSchGsd.php")).toBeNull();
    expect(isCacSchoolTabUrl("https://www.cac.edu.tw/apply115/system/ShowSchGsd.php?colno=1")).toBeNull();
  });
  it("5. 001012 detail URL never matches school gate", () => {
    expect(isCacSchoolTabUrl("https://www.cac.edu.tw/mobile_apply115/colqRy_Apply_8Rfsd57q/html/115_001012.htm")).toBeNull();
    expect(isCacSchoolTabUrl(DESKTOP_DETAIL)).toBeNull();
  });
  it("6. detail gate behavior unchanged", () => {
    expect(isCacDetailTabUrl("https://www.cac.edu.tw/mobile_apply115/colqRy_Apply_8Rfsd57q/html/115_001012.htm")).toBe(true);
    expect(isCacDetailTabUrl(SCHOOL_001)).toBe(false);
  });
  it("7-8. traffic marker + user-opened-only principle", () => {
    expect(isTrafficLimitedHtml("<html><body>系統流量過高，請稍後再試</body></html>")).toBe(true);
    expect(isTrafficLimitedHtml("<html><body>中國文學系(001012)</body></html>")).toBe(false);
  });
});

describe("storeUniverseIndex", () => {
  it("stores html+meta, refuses overwrite", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-univ-"));
    const first = storeUniverseIndex({ universeDir: dir, sourceUrl: TOTAL, outerHtml: "<html></html>" });
    expect(first.meta).toMatchObject({ academicYear: 115, sourceType: "official-cac-universe", sourceUrl: TOTAL, captureMethod: "browser-cdp" });
    expect(first.meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => storeUniverseIndex({ universeDir: dir, sourceUrl: TOTAL, outerHtml: "<html></html>" })).toThrow(/refusing to overwrite/);
  });
});

describe("buildOfficialDetailUrl (desktop, candidate-only)", () => {
  it("builds the verified 001012 canonical form (no query emitted)", () => {
    expect(buildOfficialDetailUrl(115, "001012")).toBe(
      "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001012.htm",
    );
  });
  it("matches the existing 001012 success URL modulo ?v=1.0", () => {
    const existing = "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001012.htm?v=1.0";
    expect(buildOfficialDetailUrl(115, "001012")).toBe(existing.split("?")[0]);
  });
  it("rejects bad year/code, never guesses", () => {
    expect(() => buildOfficialDetailUrl(99, "001012")).toThrow();
    expect(() => buildOfficialDetailUrl(115, "1012")).toThrow();
    expect(() => buildOfficialDetailUrl(115, "ABCDEF")).toThrow();
  });
  it("verify script performs no network (source scan)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "verify-pdf-detail-url.ts"), "utf8");
    expect(src).not.toMatch(/fetch\(|axios|https?\.get|child_process|curl|page\.goto|newPage/i);
  });
});

describe("PDF acquisition tasks (single-sample queue)", () => {
  it("PDF order list guards its own shape", () => {
    expect(() => assertPdfOrder(PDF_001_ORDER)).not.toThrow();
    expect(PDF_001_ORDER.length).toBe(73);
    expect(() => assertPdfOrder([])).toThrow();
    expect(() => assertPdfOrder(["001012", "001012"])).toThrow();
  });
  it("buildAcquisitionTask derives school + candidate URL, status PENDING", () => {
    const t = buildAcquisitionTask({ academicYear: 115, departmentCode: "001032", departmentName: "歷史學系" });
    expect(t).toMatchObject({ academicYear: 115, schoolCode: "001", departmentCode: "001032", source: "official-pdf", status: "PENDING" });
    expect(t.url).toBe("https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001032.htm");
  });
  it("firstPending skips captured raws in PDF order", () => {
    expect(firstPending(PDF_001_ORDER, new Set(["001012", "001022"]))).toBe("001032");
    expect(firstPending(PDF_001_ORDER, new Set(PDF_001_ORDER))).toBeNull();
  });
  it("matchDepartmentTab matches exact code, query-insensitive", () => {
    const pages = [
      { url: "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001032.htm", ws: 1 },
      { url: "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001012.htm?v=1.0", ws: 2 },
      { url: "https://evil.example.com/apply115/system/html/115_001032.htm", ws: 3 },
    ];
    const hit = matchDepartmentTab(pages, 115, "001032");
    expect(hit.map((p) => p.ws)).toEqual([1]);
    expect(matchDepartmentTab(pages, 115, "001099")).toEqual([]);
    expect(matchDepartmentTab(pages, 115, "1032")).toEqual([]);
  });
  it("isErrorPageHtml catches traffic/error pages", () => {
    expect(isErrorPageHtml("系統流量過高")).toBe(true);
    expect(isErrorPageHtml("找不到資料")).toBe(true);
    expect(isErrorPageHtml("中國文學系(001012)")).toBe(false);
  });
});
