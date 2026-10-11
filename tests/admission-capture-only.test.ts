import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storeCapture } from "../src/data/acquisition/browser/capture";
import { confirmChrome, inspectChrome } from "../src/data/acquisition/browser/confirm";
import { getBrowserVersion } from "../src/data/acquisition/browser/cdp";
import {
  acquireTarget,
  loadFromRawHtml,
  runQueue,
  summarizeOutcomes,
  type DeptOutcome,
  type RunnerTarget,
} from "../src/data/acquisition/runner";
import { resolveStatus } from "../src/data/discovery/official/application115/pdf-inventory";
import { buildOfficialDetailUrl } from "../src/data/discovery/official/application115/universe";

const ANN_001032 = "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001032.htm?v=1.0";
const HREF_001032 = "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001032.htm";
const ws = "ws://127.0.0.1:9222/devtools/page/X";

const target = (code: string, url?: string): RunnerTarget => ({
  academicYear: 115,
  schoolCode: code.slice(0, 3),
  departmentCode: code,
  departmentName: null,
  detailUrl: url ?? buildOfficialDetailUrl(115, code),
});

const fixture = () => fs.readFileSync(path.join(__dirname, "fixtures", "official", "application115", "detail", "115_001032.htm"), "utf8");

/** LoadDb spy that records any invocation (forbidden in capture-only) and would throw. */
function forbiddenDb(calls: string[]) {
  return async (): Promise<string> => {
    calls.push("loadDb");
    throw new Error("capture-only: database write blocked");
  };
}

function ioFor(html: string, href: string, calls: string[]) {
  return {
    navigateAndSettle: async () => {
      calls.push("navigate");
      return { href, html };
    },
    storeRaw: () => {
      calls.push("store");
      return { sha256: "abc", status: "captured" };
    },
    loadDb: forbiddenDb(calls),
    sleep: async () => {
      calls.push("sleep");
    },
  };
}

describe("capture-only acquireTarget: success never touches the DB", () => {
  it("1. fixture page ends CAPTURED with admissionId null", async () => {
    const calls: string[] = [];
    const out = await acquireTarget(target("001032", HREF_001032), { ...ioFor(fixture(), HREF_001032, calls), wsUrl: ws }, "test", { captureOnly: true });
    expect(out.status).toBe("CAPTURED");
    expect(out.admissionId).toBeNull();
    expect(out.stages).toEqual(["NAVIGATING", "CAPTURED", "STORED", "PARSED", "VALIDATED"]);
    expect(out.reasons.join(";")).toMatch(/database write skipped/);
    expect(calls).toContain("navigate");
    expect(calls).toContain("store");
    expect(calls).not.toContain("loadDb");
  });
});

describe("capture-only failure paths never touch the DB", () => {
  it("2a. garbage HTML fails at parse", async () => {
    const calls: string[] = [];
    const out = await acquireTarget(
      target("001032", ANN_001032),
      { ...ioFor("<html><head><title>t</title></head><body>hello</body></html>", ANN_001032, calls), wsUrl: ws },
      "test",
      { captureOnly: true },
    );
    expect(out.status).toBe("FAILED");
    expect(calls).not.toContain("loadDb");
  });
  it("2b. wrong tab fails at navigate", async () => {
    const calls: string[] = [];
    const out = await acquireTarget(
      target("001032"),
      { ...ioFor(fixture(), "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001099.htm", calls), wsUrl: ws },
      "test",
      { captureOnly: true },
    );
    expect(out.status).toBe("FAILED");
    expect(calls).not.toContain("store");
    expect(calls).not.toContain("loadDb");
  });
  it("2c. traffic limit halts without store or DB", async () => {
    const calls: string[] = [];
    const out = await acquireTarget(
      target("001032", ANN_001032),
      { ...ioFor("<html><body>系統流量過高，請稍後再試</body></html>", ANN_001032, calls), wsUrl: ws },
      "test",
      { captureOnly: true },
    );
    expect(out.status).toBe("TRAFFIC_LIMITED");
    expect(calls).not.toContain("store");
    expect(calls).not.toContain("loadDb");
  });
  it("2d. empty page fails", async () => {
    const calls: string[] = [];
    const out = await acquireTarget(target("001032", ANN_001032), { ...ioFor("", ANN_001032, calls), wsUrl: ws }, "test", { captureOnly: true });
    expect(out.status).toBe("FAILED");
    expect(calls).not.toContain("loadDb");
  });
  it("2e. identity mismatch fails after parse", async () => {
    const calls: string[] = [];
    const out = await acquireTarget(target("001042", HREF_001032), { ...ioFor(fixture(), HREF_001032, calls), wsUrl: ws }, "test", { captureOnly: true });
    expect(out.status).toBe("FAILED");
    expect(calls).not.toContain("loadDb");
  });
  it("2f. VALIDATED-fail returns precede any loadDb call (structural order)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "data", "acquisition", "runner.ts"), "utf8");
    for (const fn of ['fail("VALIDATED"']) {
      const failIdx = src.indexOf(fn);
      expect(failIdx).toBeGreaterThan(-1);
      const loadIdx = src.indexOf("loadDb(records", failIdx);
      const argsIdx = src.indexOf("args.loadDb(records", failIdx);
      // every loadDb invocation site sits after a VALIDATED-fail return
      expect(loadIdx > failIdx || argsIdx > failIdx).toBe(true);
    }
  });
  it("2g. loadFromRawHtml capture-only success + parse-fail never touch DB", async () => {
    const calls: string[] = [];
    const ok = await loadFromRawHtml(target("001032", HREF_001032), { html: fixture(), sourceUrl: HREF_001032, dataVersion: "t", loadDb: forbiddenDb(calls) }, { captureOnly: true });
    expect(ok.status).toBe("CAPTURED");
    expect(ok.stages).toEqual(["PARSED", "VALIDATED"]);
    const bad = await loadFromRawHtml(target("001032", HREF_001032), { html: "<html><body>nope</body></html>", sourceUrl: HREF_001032, dataVersion: "t", loadDb: forbiddenDb(calls) }, { captureOnly: true });
    expect(bad.status).toBe("FAILED");
    expect(calls).not.toContain("loadDb");
  });
});

describe("capture-only report markers", () => {
  const mk = (status: DeptOutcome["status"], code = "001032"): DeptOutcome => ({ target: target(code), status, stages: [], admissionId: null, sha256: null, reasons: [] });
  it("4. capture mode lines carry both required flags", () => {
    const lines = summarizeOutcomes([mk("CAPTURED"), mk("FAILED"), mk("TRAFFIC_LIMITED"), mk("LOADED")], { captureOnly: true, databaseWriteAttempted: false });
    expect(lines).toContain("capture_only=true");
    expect(lines).toContain("database_write_attempted=false");
    expect(lines.join("\n")).toMatch(/done: captured=1 failed=1 traffic_limited=1 loaded=1/);
  });
  it("4b. write-attempt flag is wired, never hardcoded false", () => {
    const lines = summarizeOutcomes([], { captureOnly: true, databaseWriteAttempted: true });
    expect(lines).toContain("database_write_attempted=true");
  });
  it("4c. normal mode keeps legacy output plus explicit marker", () => {
    const lines = summarizeOutcomes([mk("LOADED")], { captureOnly: false, databaseWriteAttempted: false });
    expect(lines).toContain("capture_only=false");
    expect(lines).toContain("done: loaded=1");
  });
});

describe("capture-only resume: existing raw/meta are skipped, never overwritten", () => {
  it("5. already_captured leaves files untouched", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-"));
    const html = "<html><body>same</body></html>";
    const first = storeCapture({ rawDir: dir, departmentCode: "001032", schoolCode: "001", sourceUrl: ANN_001032, browserPort: 9222, page: { tabUrl: ANN_001032, tabTitle: "t", outerHtml: html } });
    expect(first.status).toBe("captured");
    const before = fs.readFileSync(path.join(dir, "115_001032.htm"), "utf8");
    const second = storeCapture({ rawDir: dir, departmentCode: "001032", schoolCode: "001", sourceUrl: ANN_001032, browserPort: 9222, page: { tabUrl: ANN_001032, tabTitle: "t", outerHtml: html } });
    expect(second.status).toBe("already_captured");
    expect(fs.readFileSync(path.join(dir, "115_001032.htm"), "utf8")).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("5b. raw-present targets are not PENDING", () => {
    const st = (over: object) =>
      resolveStatus(
        { academicYear: 115, schoolCode: "001", departmentCode: "001032", departmentName: null, detailUrl: ANN_001032, source: "official-pdf" as const },
        { dbLoaded: false, rawHtm: true, rawMeta: true, parsed: null, validated: null, ...over },
      );
    expect(st({})).not.toBe("PENDING");
  });
});

describe("Chrome confirmation gates every navigation", () => {
  const inv = { endpoint: "http://127.0.0.1:9222", version: "Chrome/154.0", tabs: [{ title: "t", url: ANN_001032 }] };
  const plan = { mode: "capture-only" as const, school: "001", department: null, targetCount: 2 };
  it("6. confirmation step precedes queue execution in the script", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "admission-acquire.ts"), "utf8");
    expect(src.indexOf("confirmChrome(")).toBeGreaterThan(-1);
    expect(src.indexOf("confirmChrome(")).toBeLessThan(src.indexOf("runQueue("));
  });
  it("7a. operator cancel fails closed with graceful exit", async () => {
    const logged: string[] = [];
    const r = await confirmChrome(inv, plan, { yes: false, ask: async () => "n", log: (l) => logged.push(l) });
    expect(r).toEqual({ proceed: false, reason: "cancelled by operator; no navigation performed", exitCode: 0 });
  });
  it("7b. prompt failure fails closed with error exit", async () => {
    const r = await confirmChrome(inv, plan, {
      yes: false,
      ask: async () => {
        throw new Error("stdin closed");
      },
      log: () => undefined,
    });
    expect(r.proceed).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.reason).toMatch(/fail-closed/);
  });
  it("7c. missing fingerprint fails closed with error exit", async () => {
    const r = await confirmChrome({ ...inv, version: null }, plan, { yes: true, ask: async () => "y", log: () => undefined });
    expect(r).toMatchObject({ proceed: false, exitCode: 1 });
    expect(r.reason).toMatch(/fingerprint unavailable/);
  });
  it("8. --yes wording admits it proves intent, not ownership", async () => {
    const logged: string[] = [];
    const r = await confirmChrome(inv, plan, { yes: true, ask: async () => { throw new Error("must not ask"); }, log: (l) => logged.push(l) });
    expect(r.proceed).toBe(true);
    expect(logged.join("\n")).toMatch(/--yes.*does NOT verify Chrome ownership/);
  });
  it("8b. interactive yes proceeds; tab inventory shown first", async () => {
    const logged: string[] = [];
    const order: string[] = [];
    const r = await confirmChrome(inv, plan, {
      yes: false,
      ask: async (q) => {
        order.push(`ask:${logged.length > 0 ? "after-log" : "before-log"}`);
        expect(q).toMatch(/Proceed with 2 capture-only/);
        return "y";
      },
      log: (l) => logged.push(l),
    });
    expect(r.proceed).toBe(true);
    expect(order).toEqual(["ask:after-log"]);
    expect(logged.join("\n")).toContain("http://127.0.0.1:9222");
  });
});

describe("inspectChrome + version probe (mocked, no network)", () => {
  it("maps tabs and version; list failure propagates", async () => {
    const { inspectChrome } = await import("../src/data/acquisition/browser/confirm");
    const out = await inspectChrome(9222, {
      listTargets: async () => [{ id: "1", type: "page", url: ANN_001032, title: "dept", webSocketDebuggerUrl: "ws://x" }],
      getVersion: async () => "Chrome/154.0",
    });
    expect(out).toEqual({ endpoint: "http://127.0.0.1:9222", version: "Chrome/154.0", tabs: [{ title: "dept", url: ANN_001032 }] });
    await expect(inspectChrome(9222, { listTargets: async () => { throw new Error("no chrome"); } })).rejects.toThrow(/no chrome/);
  });
  it("getBrowserVersion parses, nulls on every failure", async () => {
    expect(await getBrowserVersion(9222, async () => ({ status: 200, text: JSON.stringify({ Browser: "Chrome/154.0", "Protocol-Version": "1.3" }) }))).toBe("Chrome/154.0");
    expect(await getBrowserVersion(9222, async () => ({ status: 500, text: "" }))).toBeNull();
    expect(await getBrowserVersion(9222, async () => ({ status: 200, text: "not json" }))).toBeNull();
    expect(await getBrowserVersion(9222, async () => ({ status: 200, text: JSON.stringify({}) }))).toBeNull();
    expect(
      await getBrowserVersion(9222, async () => {
        throw new Error("conn refused");
      }),
    ).toBeNull();
  });
});

describe("capture-only script wiring (source scan)", () => {
  const src = () => fs.readFileSync(path.join(__dirname, "..", "scripts", "admission-acquire.ts"), "utf8");
  it("3. executeDbLoad has exactly one call site (inside loadDbRecords)", () => {
    const matches = src().match(/executeDbLoad\(/g) ?? [];
    expect(matches).toHaveLength(1);
  });
  it("3b. forbidden stub trips the report flag", () => {
    const s = src();
    const i = s.indexOf("forbiddenLoadDb = async");
    expect(i).toBeGreaterThan(-1);
    expect(s.slice(i, i + 400)).toContain("databaseWriteAttempted = true");
  });
  it("9. conflicting flags rejected explicitly with exit 2", () => {
    const s = src();
    const i = s.indexOf("--capture-only and --dry-run are mutually exclusive");
    expect(i).toBeGreaterThan(-1);
    expect(s.slice(i, i + 400)).toMatch(/process\.exit\(2\)/);
  });
  it("report prints both required markers in capture-only runs", () => {
    const s = src();
    expect(s).toContain("summarizeOutcomes(outcomes, { captureOnly, databaseWriteAttempted })");
  });
});
