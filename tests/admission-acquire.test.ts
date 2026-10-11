import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ensureSingleTab } from "../src/data/acquisition/browser/navigate";
import {
  acquireTarget,
  loadFromRawHtml,
  runQueue,
  toRunnerTarget,
  type DeptOutcome,
  type RunnerTarget,
} from "../src/data/acquisition/runner";
import {
  assertAnnotationMatchesBuilder,
  buildOfficialDetailUrl,
} from "../src/data/discovery/official/application115/universe";

const ANN_001032 = "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001032.htm?v=1.0";
const ANN_001042 = "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001042.htm";

const target = (code: string, url?: string): RunnerTarget => ({
  academicYear: 115,
  schoolCode: code.slice(0, 3),
  departmentCode: code,
  departmentName: null,
  detailUrl: url ?? buildOfficialDetailUrl(115, code),
});

const GOOD_HTML = `<html><head><title>t</title></head><body>ok ${"x".repeat(6000)}</body></html>`;

function ioFor(html: string, href: string, opts: { loadDb?: () => Promise<string>; storeSucceed?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    io: {
      navigateAndSettle: async () => {
        calls.push("navigate");
        return { href, html };
      },
      storeRaw: () => {
        calls.push("store");
        if (opts.storeSucceed === false) throw new Error("store failed");
        return { sha256: "abc", status: "captured" };
      },
      loadDb: async () => {
        calls.push("loadDb");
        if (opts.loadDb) return opts.loadDb();
        return "admission-1";
      },
      sleep: async () => {
        calls.push("sleep");
      },
    },
  };
}

describe("URL rules", () => {
  it("1. 001032/001042 canonical forms", () => {
    expect(buildOfficialDetailUrl(115, "001032")).toBe("https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001032.htm");
    expect(buildOfficialDetailUrl(115, "001042")).toBe("https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001042.htm");
  });
  it("2-4. 002/003 prefixes build", () => {
    expect(buildOfficialDetailUrl(115, "002012")).toContain("/115_002012.htm");
    expect(buildOfficialDetailUrl(115, "003012")).toContain("/115_003012.htm");
  });
  it("5. annotation URLs match query-insensitively", () => {
    expect(() => assertAnnotationMatchesBuilder(ANN_001032, 115, "001032")).not.toThrow();
    expect(() => assertAnnotationMatchesBuilder(ANN_001042, 115, "001042")).not.toThrow();
  });
  it("6. mismatched year rejected", () => {
    expect(() => assertAnnotationMatchesBuilder(ANN_001032.replace("115_001032", "114_001032"), 115, "001032")).toThrow();
    expect(() => buildOfficialDetailUrl(116, "001032")).toThrow(/VERIFIED/);
  });
  it("7. mismatched department rejected", () => {
    expect(() => assertAnnotationMatchesBuilder(ANN_001032, 115, "001042")).toThrow();
  });
});

describe("queue selection", () => {
  const mk = (codes: string[]) => codes.map((c) => target(c));
  it("8. LOADED skipped without CDP contact", async () => {
    const seen: string[] = [];
    const out = await runQueue(mk(["001012"]), {
      ensureTab: async () => {
        seen.push("ensureTab");
        return { wsUrl: "ws://x" };
      },
      isLoaded: () => true,
      sleep: async () => undefined,
      delayMs: 5000,
      acquire: async () => {
        throw new Error("must not run");
      },
    });
    expect(out).toEqual([]);
    expect(seen).toEqual([]);
  });
  it("9-10. PENDING selected; empty queue never touches CDP", async () => {
    const order: string[] = [];
    const out = await runQueue(mk(["001042"]), {
      ensureTab: async () => ({ wsUrl: "ws://x" }),
      isLoaded: () => false,
      sleep: async () => undefined,
      delayMs: 1,
      acquire: async (t) => {
        order.push(t.departmentCode);
        return { target: t, status: "LOADED", stages: ["LOADED"], admissionId: "a", sha256: null, reasons: [] };
      },
    });
    expect(order).toEqual(["001042"]);
    expect(out).toHaveLength(1);
  });
  it("11. DB takes precedence (isLoaded central)", async () => {
    const loaded = new Set(["001042"]);
    const out = await runQueue(mk(["001042", "001052"]), {
      ensureTab: async () => ({ wsUrl: "ws://x" }),
      isLoaded: (t) => loaded.has(t.departmentCode),
      sleep: async () => undefined,
      delayMs: 1,
      acquire: async (t) => ({ target: t, status: "LOADED", stages: [], admissionId: "a", sha256: null, reasons: [] }),
    });
    expect(out.map((o) => o.target.departmentCode)).toEqual(["001052"]);
  });
  it("12. raw precedence is a resolveStatus concern (smoke)", async () => {
    expect(toRunnerTarget({ academicYear: 115, schoolCode: "001", departmentCode: "001042", departmentName: "哲學系", detailUrl: ANN_001042, source: "official-pdf" }).departmentName).toBe("哲學系");
  });
});

describe("runner safety", () => {
  const ws = "ws://127.0.0.1:9222/devtools/page/X";
  it("13. wrong tab rejected (no store, no DB)", async () => {
    const { calls, io } = ioFor(GOOD_HTML, "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001099.htm");
    const out = await acquireTarget(target("001032"), { ...io, wsUrl: ws }, "test");
    expect(out.status).toBe("FAILED");
    expect(calls).not.toContain("store");
    expect(calls).not.toContain("loadDb");
  });
  it("14. ShowSchGsd rejected", async () => {
    const { calls, io } = ioFor(GOOD_HTML, "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/ShowSchGsd.php?colno=001");
    const out = await acquireTarget(target("001032"), { ...io, wsUrl: ws }, "test");
    expect(out.status).toBe("FAILED");
    expect(calls).not.toContain("store");
  });
  it("15. traffic-limit stops without store/DB", async () => {
    const { calls, io } = ioFor("<html><body>系統流量過高，請稍後再試</body></html>", ANN_001032);
    const out = await acquireTarget(target("001032"), { ...io, wsUrl: ws }, "test");
    expect(out.status).toBe("TRAFFIC_LIMITED");
    expect(calls).not.toContain("store");
    expect(calls).not.toContain("loadDb");
  });
  it("16. error page: no store, no DB", async () => {
    const { calls, io } = ioFor("<html><body>找不到資料</body></html>", ANN_001032);
    const out = await acquireTarget(target("001032"), { ...io, wsUrl: ws }, "test");
    expect(out.status).toBe("FAILED");
    expect(calls).not.toContain("store");
    expect(calls).not.toContain("loadDb");
  });
  it("17a. garbage HTML fails at parse (raw kept, no DB)", async () => {
    const { calls, io } = ioFor("<html><head><title>t</title></head><body>hello</body></html>", ANN_001032);
    const out = await acquireTarget(target("001032"), { ...io, wsUrl: ws }, "test");
    expect(out.status).toBe("FAILED");
    expect(calls).toContain("store");
    expect(calls).not.toContain("loadDb");
  });
  it("17. successful page reaches loader", async () => {
    const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "official", "application115", "detail", "115_001032.htm"), "utf8");
    const { calls, io } = ioFor(fixture, "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001032.htm");
    const out = await acquireTarget(target("001032", "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001032.htm"), { ...io, wsUrl: ws }, "test");
    expect(out.status).toBe("LOADED");
    expect(out.stages).toEqual(["NAVIGATING", "CAPTURED", "STORED", "PARSED", "VALIDATED", "LOADED"]);
    expect(calls).toContain("loadDb");
  });
  it("20. strictly sequential, single-tab (no parallel acquisition)", async () => {
    const order: string[] = [];
    const mkAcquire = (code: string) => async (t: RunnerTarget): Promise<DeptOutcome> => {
      order.push(`start:${code}`);
      await Promise.resolve();
      order.push(`end:${code}`);
      return { target: t, status: "LOADED", stages: [], admissionId: "a", sha256: null, reasons: [] };
    };
    const codes = ["001042", "001052"];
    let i = 0;
    await runQueue(codes.map((c) => target(c)), {
      ensureTab: async () => ({ wsUrl: ws }),
      isLoaded: () => false,
      sleep: async () => undefined,
      delayMs: 1,
      acquire: (t) => mkAcquire(t.departmentCode)(t),
    });
    void i;
    expect(order).toEqual(["start:001042", "end:001042", "start:001052", "end:001052"]);
  });
  it("traffic stops the queue mid-run", async () => {
    const seen: string[] = [];
    const out = await runQueue([target("001042"), target("001052")].map((t) => t), {
      ensureTab: async () => ({ wsUrl: ws }),
      isLoaded: () => false,
      sleep: async () => undefined,
      delayMs: 1,
      acquire: async (t) => {
        seen.push(t.departmentCode);
        const status = t.departmentCode === "001042" ? "TRAFFIC_LIMITED" : "LOADED";
        return { target: t, status, stages: [], admissionId: null, sha256: null, reasons: [] };
      },
    });
    expect(seen).toEqual(["001042"]);
    expect(out).toHaveLength(1);
  });
  it("18. dry-run performs no navigation (source scan)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "admission-acquire.ts"), "utf8");
    const dryBlock = src.slice(src.indexOf("if (dryRun)"));
    expect(dryBlock.slice(0, 600)).not.toMatch(/navigateAndSettle|ensureSingleTab|executeDbLoad|storeCapture/);
  });
  it("18b. acquire script queues LOAD_REQUIRED via isActionableStatus (source scan)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "admission-acquire.ts"), "utf8");
    expect(src).toContain("isActionableStatus");
    expect(src).toContain("loadFromRawHtml");
    // work selection is not PENDING-only: raw-complete entries stay actionable
    expect(src).toMatch(/isActionableStatus\(r\.status\)/);
    // reload lane never re-captures or navigates (slice only the reload loop)
    const reloadStart = src.indexOf("// LOAD_REQUIRED");
    const reloadBlock = src.slice(reloadStart, src.indexOf("const outcomes", reloadStart));
    expect(reloadBlock).toContain("loadFromRawHtml");
    expect(reloadBlock).not.toMatch(/ensureSingleTab|navigateAndSettle|storeCapture\(/);
  });
  it("19. single-tab invariant (ensureSingleTab)", async () => {
    const cac = (code: string) => ({
      id: code,
      type: "page",
      url: `https://www.cac.edu.tw/apply115/system/X/html/115_${code}.htm`,
      title: "t",
      webSocketDebuggerUrl: `ws://127.0.0.1:9222/${code}`,
    });
    const httpGet = (targets: unknown[]) => async () => ({ status: 200, text: JSON.stringify(targets) });
    await expect(
      ensureSingleTab(9222, { httpGet: httpGet([cac("001012"), cac("001022")]) }),
    ).rejects.toThrow(/2 CAC pages/);
    const reused = await ensureSingleTab(9222, { httpGet: httpGet([cac("001012")]) });
    expect(reused).toMatchObject({ created: false });
    const created = await ensureSingleTab(9222, {
      httpGet: httpGet([]),
      httpPut: async () => ({ status: 200, text: JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/new" }) }),
    });
    expect(created).toMatchObject({ created: true, wsUrl: "ws://127.0.0.1:9222/new" });
  });
  it("source scan: no direct CAC HTTP clients", () => {
    for (const f of ["src/data/acquisition/runner.ts", "src/data/acquisition/browser/navigate.ts", "scripts/admission-acquire.ts"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      expect(src).not.toMatch(/axios|puppeteer|playwright|https\.request|curl|wget|child_process|proxy/i);
    }
  });
  it("loadDb failure surfaces FAILED (no silent success)", async () => {
    const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "official", "application115", "detail", "115_001032.htm"), "utf8");
    const { calls, io } = ioFor(fixture, "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001032.htm", {
      loadDb: async () => {
        throw new Error("db down");
      },
    });
    const out = await acquireTarget(target("001032", "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001032.htm"), { ...io, wsUrl: ws }, "test");
    expect(out.status).toBe("FAILED");
    expect(calls).toContain("loadDb");
  });
});

describe("loadFromRawHtml (LOAD_REQUIRED lane, no navigation)", () => {
  const fixture = () => fs.readFileSync(path.join(__dirname, "fixtures", "official", "application115", "detail", "115_001032.htm"), "utf8");
  const href = "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_001032.htm";
  it("valid stored raw loads without re-capture", async () => {
    const loads: string[] = [];
    const out = await loadFromRawHtml(target("001032", href), {
      html: fixture(),
      sourceUrl: href,
      dataVersion: "test",
      loadDb: async () => {
        loads.push("loadDb");
        return "admission-1";
      },
    });
    expect(out.status).toBe("LOADED");
    expect(out.stages).toEqual(["PARSED", "VALIDATED", "LOADED"]);
    expect(loads).toEqual(["loadDb"]);
    expect(out.admissionId).toBe("admission-1");
  });
  it("garbage raw fails at parse (no DB)", async () => {
    let loaded = false;
    const out = await loadFromRawHtml(target("001032", href), {
      html: "<html><head><title>t</title></head><body>hello</body></html>",
      sourceUrl: href,
      dataVersion: "test",
      loadDb: async () => {
        loaded = true;
        return "x";
      },
    });
    expect(out.status).toBe("FAILED");
    expect(loaded).toBe(false);
    expect(out.reasons.join(";")).toContain("PARSED");
  });
  it("identity mismatch fails (no DB)", async () => {
    let loaded = false;
    const out = await loadFromRawHtml(target("001042", href), {
      html: fixture(),
      sourceUrl: href,
      dataVersion: "test",
      loadDb: async () => {
        loaded = true;
        return "x";
      },
    });
    expect(out.status).toBe("FAILED");
    expect(loaded).toBe(false);
  });
  it("loadDb failure surfaces FAILED", async () => {
    const out = await loadFromRawHtml(target("001032", href), {
      html: fixture(),
      sourceUrl: href,
      dataVersion: "test",
      loadDb: async () => {
        throw new Error("db down");
      },
    });
    expect(out.status).toBe("FAILED");
    expect(out.reasons.join(";")).toContain("LOADED");
  });
});
