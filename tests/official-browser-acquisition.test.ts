import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBrowserImport } from "../src/data/acquisition/browser/index";
import { assertLoopback } from "../src/data/acquisition/browser/cdp";
import { isCacDetailTabUrl, selectCurrentTab } from "../src/data/acquisition/browser/tabs";
import { validateCapturedPage, validateTabUrl } from "../src/data/acquisition/browser/validate";
import { filenameFor, sha256Hex } from "../src/data/acquisition/browser/capture";
import type { CdpTarget } from "../src/data/acquisition/browser/types";

const FIX = path.join(__dirname, "fixtures", "official", "application115", "detail");
const htmlOf = (code: string) => fs.readFileSync(path.join(FIX, `115_${code}.htm`), "utf8");
const CAC = (code: string) => `https://www.cac.edu.tw/mobile_apply115/colqRy_Apply_8Rfsd57q/html/115_${code}.htm`;

const tab = (url: string, extra: Partial<CdpTarget> = {}): CdpTarget => ({
  id: "A",
  type: "page",
  url,
  title: "t",
  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/A",
  ...extra,
});

const mockHttp = (targets: CdpTarget[]) => async () => ({ status: 200, text: JSON.stringify(targets) });
const mockWs = (html: string, href: string) => async () =>
  JSON.stringify({ html, href, title: "fixture" });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "predicter-browser-"));

describe("browser acquisition", () => {
  it("1. CAC official URL accepted", () => {
    expect(isCacDetailTabUrl(CAC("001012"))).toBe(true);
    expect(validateTabUrl(CAC("001012")).ok).toBe(true);
  });
  it("2. non-CAC rejected (google/UTW/github)", () => {
    for (const u of [
      "https://www.google.com/search?q=x",
      "https://university-tw.ldkrsi.men/caac/001/001012",
      "https://github.com/evan980331/predicter",
      "https://www.cac.edu.tw/index.html",
    ]) {
      expect(isCacDetailTabUrl(u)).toBe(false);
    }
  });
  it("3. wrong year rejected", () => {
    expect(isCacDetailTabUrl("https://www.cac.edu.tw/mobile_apply115/x/html/114_001012.htm")).toBe(false);
  });
  it("4. non-detail / javascript: / blank rejected", () => {
    expect(validateTabUrl("https://www.cac.edu.tw/apply115/query.php").ok).toBe(false);
    expect(validateTabUrl("javascript:alert(1)").ok).toBe(false);
    expect(validateTabUrl("about:blank").ok).toBe(false);
    expect(validateTabUrl("data:text/html,x").ok).toBe(false);
  });
  it("5. department code extraction via full flow", async () => {
    const dir = tmp();
    const r = await runBrowserImport({
      port: 9222,
      rawDir: dir,
      httpGet: mockHttp([tab(CAC("001012"))]),
      wsEvaluate: mockWs(htmlOf("001012"), CAC("001012")),
    });
    expect(r.departmentCode).toBe("001012");
    expect(r.schoolCode).toBe("001");
  });
  it("6. CDP tab filtering (one CAC tab; zero/multi refused)", () => {
    expect(selectCurrentTab([tab("https://example.com/")])).toEqual({
      error: expect.stringContaining("no CAC"),
    });
    expect(selectCurrentTab([tab(CAC("001012")), tab(CAC("001022"))])).toEqual({
      error: expect.stringContaining("exactly one"),
    });
    const ok = selectCurrentTab([{ ...tab("https://example.com/"), id: "X", webSocketDebuggerUrl: "" }, tab(CAC("001012"))]);
    expect("target" in ok).toBe(true);
  });
  it("7. outerHTML capture is full document", async () => {
    const dir = tmp();
    const r = await runBrowserImport({
      port: 9222,
      rawDir: dir,
      httpGet: mockHttp([tab(CAC("001012"))]),
      wsEvaluate: mockWs(htmlOf("001012"), CAC("001012")),
    });
    expect(r.htmlBytes).toBeGreaterThan(20000);
    expect(r.captureStatus).toBe("captured");
  });
  it("8. SHA-256 stable", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(filenameFor("001012")).toBe("115_001012.htm");
  });
  it("9. duplicate handling (already_captured, file untouched)", async () => {
    const dir = tmp();
    const run = () =>
      runBrowserImport({ port: 9222, rawDir: dir, httpGet: mockHttp([tab(CAC("001012"))]), wsEvaluate: mockWs(htmlOf("001012"), CAC("001012")) });
    const a = await run();
    const mtime = fs.statSync(path.join(dir, "115_001012.htm")).mtimeMs;
    const b = await run();
    expect(a.captureStatus).toBe("captured");
    expect(b.captureStatus).toBe("already_captured");
    expect(fs.statSync(path.join(dir, "115_001012.htm")).mtimeMs).toBe(mtime);
  });
  it("10. content_changed versions old file, never silent overwrite", async () => {
    const dir = tmp();
    const html2 = htmlOf("001012").replace("招生名額", "招生名額X");
    await runBrowserImport({ port: 9222, rawDir: dir, httpGet: mockHttp([tab(CAC("001012"))]), wsEvaluate: mockWs(htmlOf("001012"), CAC("001012")) });
    const r = await runBrowserImport({ port: 9222, rawDir: dir, httpGet: mockHttp([tab(CAC("001012"))]), wsEvaluate: mockWs(html2, CAC("001012")) });
    expect(r.captureStatus).toBe("content_changed");
    const files = fs.readdirSync(dir);
    expect(files.some((f) => /^115_001012\.[0-9a-f]{8}\.htm$/.test(f))).toBe(true);
    expect(files).toContain("115_001012.htm");
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "115_001012.htm.meta.json"), "utf8"));
    expect(meta.previousSha256).toBeTruthy();
  });
  it("11. unparseable page -> parse_error but raw kept", async () => {
    const dir = tmp();
    // Passes content markers, but has no #BASIC section: P3.7 yields no record.
    const bad =
      "<html><head><title>x</title></head><body>校系代碼 招生名額 基本資料及時程" +
      "<table><tr><td>note</td></tr></table>" +
      `<p>${"filler text ".repeat(60)}</p></body></html>`;
    const r = await runBrowserImport({
      port: 9222,
      rawDir: dir,
      httpGet: mockHttp([tab(CAC("001012"))]),
      wsEvaluate: mockWs(bad, CAC("001012")),
    });
    expect(r.captureStatus).toBe("parse_error");
    expect(fs.existsSync(path.join(dir, "115_001012.htm"))).toBe(true);
  });
  it("12. zero external network (loopback only)", () => {
    expect(() => assertLoopback("http://127.0.0.1:9222/json")).not.toThrow();
    for (const u of ["https://www.cac.edu.tw/x", "https://example.com/", "wss://evil.example.com/y", "javascript:alert(1)"]) {
      expect(() => assertLoopback(u)).toThrow();
    }
    for (const f of [
      "src/data/acquisition/browser/cdp.ts",
      "src/data/acquisition/browser/tabs.ts",
      "src/data/acquisition/browser/validate.ts",
      "src/data/acquisition/browser/capture.ts",
      "src/data/acquisition/browser/index.ts",
      "scripts/import-official-browser.ts",
    ]) {
      const src = fs.readFileSync(f, "utf8");
      // No crawler libs, no shell-out fetchers, no server-side HTTP clients.
      expect(src).not.toMatch(/axios|puppeteer|playwright|curl|wget|https\.get|http\.get|child_process/i);
      // Every hard-coded URL literal must be loopback (template placeholders
      // like ${port} normalized first); CAC appears only as hostname compare.
      const normalized = src.replace(/\$\{[^}]+\}/g, "0");
      const urls = [...normalized.matchAll(/https?:\/\/[^\s"'`]+/gi)].map((m) => m[0]);
      for (const u of urls) {
        expect(u).toMatch(/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//);
      }
    }
  });
  it("13. no cookie/header persistence in meta", async () => {
    const dir = tmp();
    await runBrowserImport({ port: 9222, rawDir: dir, httpGet: mockHttp([tab(CAC("001012"))]), wsEvaluate: mockWs(htmlOf("001012"), CAC("001012")) });
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "115_001012.htm.meta.json"), "utf8"));
    expect(Object.keys(meta).sort()).toEqual(
      ["academicYear", "acquisitionMethod", "browserPort", "capturedAt", "departmentCode", "parserVersion", "previousSha256", "schoolCode", "sha256", "sourceType", "sourceUrl", "status"].sort(),
    );
  });
  it("14. P3.7 integration (quota/requirements parsed)", async () => {
    const dir = tmp();
    const r = await runBrowserImport({
      port: 9222,
      rawDir: dir,
      httpGet: mockHttp([tab(CAC("001592"))]),
      wsEvaluate: mockWs(htmlOf("001592"), CAC("001592")),
    });
    expect(r.captureStatus).toBe("captured");
    expect(r.parserStatus).toBe("success");
    expect(r.departmentName).toContain("APCS");
  });
  it("15. P3.11 integration (captured file imports clean)", async () => {
    const dir = tmp();
    await runBrowserImport({ port: 9222, rawDir: dir, httpGet: mockHttp([tab(CAC("001012"))]), wsEvaluate: mockWs(htmlOf("001012"), CAC("001012")) });
    const { runLocalImport } = await import("../src/data/importers/official/application115/local/index");
    const out = runLocalImport({ inputDir: dir, outputDir: null, academicYear: 115, dryRun: false, dataVersion: "test" });
    expect(out.report.files.filter((f) => f.path.endsWith("115_001012.htm")).length).toBe(1);
  });
  it("validateCapturedPage rejects non-detail content", () => {
    expect(validateCapturedPage({ tabUrl: CAC("001012"), tabTitle: "t", outerHtml: "<html><body>hi</body></html>" }).ok).toBe(false);
  });
});
