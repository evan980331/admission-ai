import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCacDetailTabUrl } from "../src/data/acquisition/browser/tabs";
import { isCacApplicationIndexUrl, storeUniverseIndex } from "../src/data/acquisition/browser/universe";
import { buildSchoolIndex, parseTotalGsdShow } from "../src/data/discovery/official/application115/universe";

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

describe("storeUniverseIndex", () => {
  it("stores html+meta, refuses overwrite", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-univ-"));
    const first = storeUniverseIndex({ universeDir: dir, sourceUrl: TOTAL, outerHtml: "<html></html>" });
    expect(first.meta).toMatchObject({ academicYear: 115, sourceType: "official-cac-universe", sourceUrl: TOTAL, captureMethod: "browser-cdp" });
    expect(first.meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => storeUniverseIndex({ universeDir: dir, sourceUrl: TOTAL, outerHtml: "<html></html>" })).toThrow(/refusing to overwrite/);
  });
});
