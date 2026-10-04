import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDatasetBuild } from "../src/data/dataset/official/application115/index";
import { identityKey } from "../src/data/dataset/official/application115/dataset";

const P37 = path.join(__dirname, "fixtures", "official", "application115", "detail");
const URL = (code: string) => `https://www.cac.edu.tw/mobile_apply115/colqRy_Apply_8Rfsd57q/html/115_${code}.htm`;
const realHtml = (code: string) => fs.readFileSync(path.join(P37, `115_${code}.htm`), "utf8");

function stage(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-dataset-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const withMeta = (code: string, html?: string) => ({
  [`${code}.htm`]: html ?? realHtml(code),
  [`${code}.htm.meta.json`]: JSON.stringify({ url: URL(code) }),
});

const build = (dir: string, extra: Record<string, unknown> = {}) =>
  runDatasetBuild({ inputDir: dir, outputDir: null, academicYear: 115, dryRun: true, dataVersion: "test", ...extra });

describe("official dataset build", () => {
  it("identity keys are year|school|dept", () => {
    expect(identityKey(115, "001", "001012")).toBe("115|001|001012");
  });

  it("1-2. normal 001012 + APCS 001592 with provenance", () => {
    const dir = stage({ ...withMeta("001012"), ...withMeta("001592") });
    const { dataset, coverage } = build(dir);
    expect(Object.keys(dataset.entries)).toHaveLength(2);
    const e = dataset.entries["115|001|001012"]!;
    expect(e.schoolCode).toBe("001");
    expect(e.sourceUrl).toBe(URL("001012"));
    expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(e.parserVersion).toBe("official-detail-parser-v0.1.0");
    // dataVersion flows from the P3.7/P3.11 parse layer ("local-import"),
    // not from the dataset build option (which tags canonical inputs).
    expect(e.dataVersion).toBe("local-import");
    expect(coverage.normalized).toBe(2);
  });

  it("3. duplicate identical HTML merges to one entry", () => {
    const html = realHtml("001012");
    const dir = stage({
      "a.htm": html,
      "a.htm.meta.json": JSON.stringify({ url: URL("001012") }),
      "b.htm": html,
      "b.htm.meta.json": JSON.stringify({ url: URL("001012") }),
    });
    const { dataset, coverage } = build(dir);
    expect(Object.keys(dataset.entries)).toHaveLength(1);
    expect(coverage.normalized).toBe(1);
  });

  it("4. changed HTML same identity versions, never silent", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-dsout-"));
    const dir = stage(withMeta("001012"));
    const first = runDatasetBuild({ inputDir: dir, outputDir: out, academicYear: 115, dryRun: false, dataVersion: "t1" });
    expect(first.coverage.captured).toBe(1);
    fs.writeFileSync(path.join(dir, "001012.htm"), realHtml("001012").replace("招生名額", "招生名額X"));
    const second = runDatasetBuild({ inputDir: dir, outputDir: out, academicYear: 115, dryRun: false, dataVersion: "t2" });
    expect(second.coverage.contentChanged).toBe(1);
    expect(second.coverage.unchanged).toBe(0);
    const e = second.dataset.entries["115|001|001012"]!;
    expect(e.history.length).toBe(1);
    expect(e.history[0]!.status).toBe("superseded");
    // Rerun without changes -> unchanged, previous success intact.
    const third = runDatasetBuild({ inputDir: dir, outputDir: out, academicYear: 115, dryRun: false, dataVersion: "t3" });
    expect(third.coverage.unchanged).toBe(1);
    expect(third.dataset.entries["115|001|001012"]!.sha256).toBe(e.sha256);
  });

  it("5. parse error retains error info, no canonical", () => {
    const dir = stage({ "bad.htm": "<html><body>校系代碼 招生名額 基本資料及時程" + "x".repeat(600) + "</body></html>" });
    const { dataset, coverage, errors } = build(dir);
    // Unidentified files never become entries, but must surface in errors.
    expect(errors.length).toBeGreaterThan(0);
    expect(Object.keys(dataset.entries)).toHaveLength(0);
    expect(coverage.totalDepartments).toBe(0);
  });

  it("6. missing meta parses but stays source_unverified", () => {
    const dir = stage({ "115_001012.htm": realHtml("001012") });
    const { dataset, coverage } = build(dir);
    const e = dataset.entries["115|001|001012"]!;
    expect(e.status).toBe("source_unverified");
    expect(e.sourceUrl).toBeNull();
    expect(coverage.validationError).toBe(1);
  });

  it("7. wrong year filename is skipped with reason, not guessed", () => {
    const dir = stage({
      "114_001012.htm": realHtml("001012"),
      "114_001012.htm.meta.json": JSON.stringify({ url: URL("001012").replace("/115_", "/114_") }),
    });
    const { coverage, buildReport } = build(dir);
    // 114 URL fails the 115 policy -> source_unverified, never imported as 115.
    expect(coverage.normalized).toBe(0);
    expect(buildReport.errors).toBeGreaterThan(0);
  });

  it("8. malformed filename is reported, not guessed", () => {
    const dir = stage({ "random-name.htm": "<html><body>hello</body></html>" });
    const { coverage, errors } = build(dir);
    expect(errors.length).toBeGreaterThan(0);
    expect(coverage.normalized).toBe(0);
  });

  it("9. normalization error retains parsed record without canonical", () => {
    // Two different files, same identity, different content -> second errors.
    const dir = stage({
      "a.htm": realHtml("001012"),
      "b.htm": realHtml("001012").replace("中國文學系", "中國文學系X"),
    });
    // No metas -> both source_unverified; second same-identity file errors.
    const { coverage, errors } = build(dir);
    expect(coverage.validationError).toBe(1);
    expect(errors.some((e) => e.reasons.join("").includes("duplicate identity"))).toBe(true);
  });

  it("10. mixed success/error batch", () => {
    const dir = stage({
      ...withMeta("001012"),
      ...withMeta("001592"),
      "bad.htm": "garbage {{{{",
    });
    const { dataset, coverage, errors } = build(dir);
    expect(Object.keys(dataset.entries)).toHaveLength(2);
    expect(coverage.normalized).toBe(2);
    // The garbage file surfaces via dataset errors (P3.11 file failure propagated).
    expect(errors.length).toBeGreaterThan(0);
  });

  it("universe codes without files become missing (never invented)", () => {
    const dir = stage(withMeta("001012"));
    const { coverage } = build(dir, {
      universePath: undefined,
    } as never);
    expect(coverage.missing).toBe(0);
    // With an explicit universe file:
    const uni = path.join(dir, "universe.json");
    fs.writeFileSync(
      uni,
      JSON.stringify({ departments: [{ schoolCode: "001", schoolName: null, departmentCode: "001012", departmentName: null, detailUrl: URL("001012") }, { schoolCode: "001", schoolName: null, departmentCode: "001999", departmentName: null, detailUrl: null }] }),
    );
    const second = runDatasetBuild({ inputDir: dir, outputDir: null, academicYear: 115, dryRun: true, universePath: uni });
    expect(second.coverage.totalDepartments).toBe(2);
    expect(second.coverage.missing).toBe(1);
  });

  it("no-network boundary (module sources contain no fetchers)", () => {
    for (const f of [
      "src/data/dataset/official/application115/types.ts",
      "src/data/dataset/official/application115/dataset.ts",
      "src/data/dataset/official/application115/index.ts",
      "scripts/build-official-dataset.ts",
    ]) {
      const src = fs.readFileSync(f, "utf8");
      expect(src).not.toMatch(/axios|puppeteer|playwright|curl|wget|https\.get|http\.get|child_process/i);
      expect(src).not.toMatch(/fetch\(/);
    }
    const orig = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      throw new Error("network touched");
    }) as unknown as typeof fetch;
    try {
      const dir = stage(withMeta("001012"));
      runDatasetBuild({ inputDir: dir, outputDir: null, academicYear: 115, dryRun: true });
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("P3.7 integration: detail fields flow into dataset", () => {
    const dir = stage(withMeta("001022"));
    const { dataset } = build(dir);
    const e = dataset.entries["115|001|001022"]!;
    expect((e.detail as { quota: number }).quota).toBe(43);
    expect((e.canonical as { quota: number }).quota).toBe(43);
  });

  it("P3.11 integration: report + records shape reused", () => {
    const dir = stage(withMeta("001012"));
    const { localReport } = build(dir) as unknown as { localReport: { imported: number } };
    expect(localReport.imported).toBe(1);
  });

  it("carry-forward: removed files do not erase earlier success", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-dsout-"));
    const dir = stage({ ...withMeta("001012"), ...withMeta("001592") });
    runDatasetBuild({ inputDir: dir, outputDir: out, academicYear: 115, dryRun: false });
    fs.rmSync(path.join(dir, "001592.htm"));
    fs.rmSync(path.join(dir, "001592.htm.meta.json"));
    const second = runDatasetBuild({ inputDir: dir, outputDir: out, academicYear: 115, dryRun: false });
    expect(Object.keys(second.dataset.entries)).toHaveLength(2);
    // 001592 is carried, NOT unchanged; 001012 stays unchanged.
    expect(second.coverage.carried).toBe(1);
    expect(second.coverage.unchanged).toBe(1);
    // The carried row is excluded; the current row still counts as normalized.
    expect(second.coverage.normalized).toBe(1);
  });

  describe("carried semantics (A-F)", () => {
    const two = () => stage({ ...withMeta("001012"), ...withMeta("001592") });
    const runOut = (dir: string, out: string, extra: Record<string, unknown> = {}) =>
      runDatasetBuild({ inputDir: dir, outputDir: out, academicYear: 115, dryRun: false, ...extra });

    it("A. Run1 source exists -> captured", () => {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-dsA-"));
      const r = runOut(two(), out);
      expect(r.coverage.captured).toBe(2);
      expect(r.coverage.carried).toBe(0);
    });

    it("B. Run2 same hash -> unchanged (not carried)", () => {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-dsB-"));
      const dir = two();
      runOut(dir, out);
      const r = runOut(dir, out);
      expect(r.coverage.unchanged).toBe(2);
      expect(r.coverage.carried).toBe(0);
      // Steady rows are both unchanged (currency) and normalized (processing).
      expect(r.coverage.normalized).toBe(2);
    });

    it("C. Run3 source removed -> carried", () => {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-dsC-"));
      const dir = two();
      runOut(dir, out);
      fs.rmSync(path.join(dir, "001592.htm"));
      fs.rmSync(path.join(dir, "001592.htm.meta.json"));
      const r = runOut(dir, out);
      const carried = r.coverage.rows.filter((x) => x.status === "carried");
      expect(carried.map((x) => x.departmentCode)).toEqual(["001592"]);
      expect(r.coverage.carried).toBe(1);
    });

    it("D. carried entry keeps old canonical + provenance, history untouched", () => {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-dsD-"));
      const dir = two();
      const first = runOut(dir, out);
      const before = first.dataset.entries["115|001|001592"]!;
      fs.rmSync(path.join(dir, "001592.htm"));
      fs.rmSync(path.join(dir, "001592.htm.meta.json"));
      const second = runOut(dir, out);
      const e = second.dataset.entries["115|001|001592"]!;
      expect(e.canonical).toEqual(before.canonical);
      expect(e.sourceUrl).toBe(before.sourceUrl);
      expect(e.sha256).toBe(before.sha256);
      expect(e.lastCapturedAt).toBe(before.lastCapturedAt);
      expect(e.history).toEqual(before.history);
    });

    it("E. carried excluded from unchanged/normalized", () => {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-dsE-"));
      const dir = two();
      runOut(dir, out);
      fs.rmSync(path.join(dir, "001592.htm"));
      fs.rmSync(path.join(dir, "001592.htm.meta.json"));
      const r = runOut(dir, out);
      expect(r.coverage.unchanged).toBe(1);
      // Only the current row counts; the carried row is excluded.
      expect(r.coverage.normalized).toBe(1);
      expect(r.coverage.carried).toBe(1);
    });

    it("F. universe reflects missing current source", () => {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-dsF-"));
      const dir = two();
      const uni = path.join(dir, "universe.json");
      const uniRows = [
        { schoolCode: "001", schoolName: null, departmentCode: "001012", departmentName: null, detailUrl: null },
        { schoolCode: "001", schoolName: null, departmentCode: "001592", departmentName: null, detailUrl: null },
        { schoolCode: "001", schoolName: null, departmentCode: "001999", departmentName: null, detailUrl: null },
      ];
      fs.writeFileSync(uni, JSON.stringify({ departments: uniRows }));
      runOut(dir, out, { universePath: uni });
      fs.rmSync(path.join(dir, "001592.htm"));
      fs.rmSync(path.join(dir, "001592.htm.meta.json"));
      const r = runDatasetBuild({ inputDir: dir, outputDir: out, academicYear: 115, dryRun: false, universePath: uni });
      expect(r.coverage.totalDepartments).toBe(3);
      // 001999 absent entirely + 001592 carried (no current source) => missing 2.
      expect(r.coverage.missing).toBe(2);
      expect(r.coverage.carried).toBe(1);
      expect(r.coverage.unchanged).toBe(1);
    });
  });
});
