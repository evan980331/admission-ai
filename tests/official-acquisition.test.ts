import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pocBatch, runAcquisition } from "../src/data/acquisition/official/application115/acquisition";
import { MAX_BATCH } from "../src/data/acquisition/official/application115/types";
import { sha256Hex } from "../src/data/acquisition/official/application115/cache";
import { validateResponse } from "../src/data/acquisition/official/application115/validator";
import type { FetchMetaImpl } from "../src/data/acquisition/official/application115/client";

const FIX = path.join(__dirname, "fixtures", "official", "application115", "detail");
const htmlOf = (code: string) => fs.readFileSync(path.join(FIX, `115_${code}.htm`), "utf8");
const enc = (s: string) => new TextEncoder().encode(s);

function mockFetch(
  handler: (url: string, n: number) => { status: number; headers?: Record<string, string>; url?: string; body: string } | Error,
): FetchMetaImpl & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const n = calls.length;
    const r = handler(url, n);
    if (r instanceof Error) throw r;
    return {
      status: r.status,
      headers: r.headers ?? { "content-type": "text/html; charset=utf-8" },
      url: r.url ?? url,
      bytes: async () => enc(r.body),
    };
  }) as FetchMetaImpl & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const baseOpts = (extra: Record<string, unknown> = {}) => ({
  academicYear: 115,
  entries: pocBatch(),
  limit: 4,
  refresh: false,
  dryRun: false,
  offline: false,
  delayMs: 0,
  timeoutMs: 5000,
  maxRetries: 2,
  ...extra,
});

const ROBOTS_OK = "User-agent: *\nDisallow: /search\n";
const ROBOTS_NO = "User-agent: *\nDisallow: /\n";

function withRobots(robots: string, pages: Record<string, string>): FetchMetaImpl & { calls: string[] } {
  return mockFetch((url) => {
    if (url.includes("robots.txt")) return { status: 200, body: robots };
    const code = Object.keys(pages).find((c) => url.includes(c));
    if (code) return { status: 200, body: pages[code]! };
    return { status: 404, body: "no" };
  });
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "predicter-acq-"));

describe("robots gate", () => {
  it("1. proceeds when robots allows", async () => {
    const f = withRobots(ROBOTS_OK, { "001012": htmlOf("001012") });
    const { report, blocked } = await runAcquisition({ ...baseOpts(), limit: 1, fetchImpl: f, rawDir: tmp() } as never);
    expect(blocked).toBe(false);
    expect(report.robotsAllowed).toBe(true);
  });
  it("2. blocks everything on Disallow:/ with ROBOTS_BLOCKED", async () => {
    const f = withRobots(ROBOTS_NO, { "001012": htmlOf("001012") });
    const { report, blocked } = await runAcquisition({ ...baseOpts(), limit: 4, fetchImpl: f, rawDir: tmp() } as never);
    expect(blocked).toBe(true);
    expect(report.robotsBlocked).toBe(4);
    expect(report.pages.every((p) => p.status === "robots_blocked")).toBe(true);
    expect(f.calls).toHaveLength(1); // robots only, zero detail requests
  });
});

describe("HTTP outcomes (mocked)", () => {
  it("3. records HTTP 200 success + sha + parse", async () => {
    const f = withRobots(ROBOTS_OK, { "001012": htmlOf("001012") });
    const { report } = await runAcquisition({ ...baseOpts(), limit: 1, fetchImpl: f, rawDir: tmp() } as never);
    const p = report.pages[0]!;
    expect(p.status).toBe("success");
    expect(p.httpStatus).toBe(200);
    expect(p.bytes).toBeGreaterThan(1000);
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.parserStatus).toBe("parsed");
  });
  it("4. records HTTP 404 as invalid (no retry storm)", async () => {
    const f = withRobots(ROBOTS_OK, {});
    const { report } = await runAcquisition({ ...baseOpts(), limit: 1, fetchImpl: f, rawDir: tmp() } as never);
    expect(report.pages[0]!.status).toBe("invalid");
    expect(f.calls.filter((u) => !u.includes("robots")).length).toBe(1);
  });
  it("5. timeout surfaces as failed", async () => {
    const f = mockFetch((url) => {
      if (url.includes("robots.txt")) return { status: 200, body: ROBOTS_OK };
      const e = new Error("aborted");
      e.name = "AbortError";
      return e;
    });
    const { report } = await runAcquisition({ ...baseOpts(), limit: 1, fetchImpl: f, rawDir: tmp() } as never);
    expect(report.pages[0]!.status).toBe("failed");
  });
  it("6. retries 500 then succeeds", async () => {
    const f = withRobots(ROBOTS_OK, { "001012": htmlOf("001012") });
    let n = 0;
    const orig = f;
    const counting = (async (url: string, init?: never) => {
      if (!url.includes("robots") && ++n === 1) return { status: 500, headers: {}, url, bytes: async () => enc("") };
      return orig(url, init);
    }) as unknown as FetchMetaImpl;
    const { report } = await runAcquisition({ ...baseOpts(), limit: 1, fetchImpl: counting, rawDir: tmp() } as never);
    expect(report.pages[0]!.status).toBe("success");
  });
});

describe("response validation", () => {
  it("7. rejects non-HTML content type", () => {
    const r = validateResponse({
      requestCode: "001012",
      finalUrl: "https://www.cac.edu.tw/mobile_apply115/x/html/115_001012.htm",
      status: 200,
      headers: { "content-type": "application/pdf" },
      bodyBytes: 100,
      bodyTextSample: "校系代碼 招生名額 基本資料及時程",
    });
    expect(r.ok).toBe(false);
  });
  it("8. rejects redirect to third party", () => {
    const r = validateResponse({
      requestCode: "001012",
      finalUrl: "https://evil.example.com/115_001012.htm",
      status: 200,
      headers: { "content-type": "text/html" },
      bodyBytes: 100,
      bodyTextSample: "校系代碼 招生名額",
    });
    expect(r.ok).toBe(false);
  });
});

describe("cache", () => {
  it("9. cache hit skips HTTP and still parses", async () => {
    const dir = tmp();
    const f = withRobots(ROBOTS_OK, { "001012": htmlOf("001012") });
    await runAcquisition({ ...baseOpts(), limit: 1, fetchImpl: f, rawDir: dir } as never);
    const callsAfterFirst = f.calls.length;
    const { report } = await runAcquisition({ ...baseOpts(), limit: 1, fetchImpl: f, rawDir: dir } as never);
    expect(f.calls.length).toBe(callsAfterFirst); // zero new requests (robots also cached)
    expect(report.pages[0]!.status).toBe("cached");
    expect(report.pages[0]!.parserStatus).toBe("parsed");
  });
  it("10. cache miss downloads", async () => {
    const f = withRobots(ROBOTS_OK, { "001012": htmlOf("001012") });
    const { report } = await runAcquisition({ ...baseOpts(), limit: 1, fetchImpl: f, rawDir: tmp() } as never);
    expect(report.pages[0]!.cacheHit).toBe(false);
    expect(report.pages[0]!.status).toBe("success");
  });
  it("11. sha256 is stable and honest", () => {
    expect(sha256Hex(enc("abc"))).toBe(sha256Hex(enc("abc")));
    expect(sha256Hex(enc("abc"))).not.toBe(sha256Hex(enc("abd")));
  });
});

describe("batch policy + integration", () => {
  it("12. limit > 10 throws", async () => {
    await expect(runAcquisition({ ...baseOpts(), limit: 11 } as never)).rejects.toThrow("exceeds PoC cap");
    expect(MAX_BATCH).toBe(10);
  });
  it("13. manifest-only selection (unknown codes never enter)", async () => {
    const f = withRobots(ROBOTS_OK, {});
    const { report } = await runAcquisition({
      ...baseOpts(),
      entries: [
        { schoolCode: "001", schoolName: "s", schoolPageUrl: "https://www.cac.edu.tw/x", departmentCode: "999999", departmentName: " invent", detailUrl: "https://evil.example.com/x" },
      ],
      limit: 4,
      fetchImpl: f,
      rawDir: tmp(),
    } as never);
    expect(report.requested).toBe(0);
    expect(report.manifestErrors.length).toBeGreaterThan(0);
  });
  it("14. P3.7 integration: 001592 APCS parses from acquired HTML", async () => {
    const f = withRobots(ROBOTS_OK, { "001592": htmlOf("001592") });
    const { parsed } = await runAcquisition({
      ...baseOpts(),
      entries: pocBatch().filter((e) => e.departmentCode === "001592"),
      limit: 1,
      fetchImpl: f,
      rawDir: tmp(),
    } as never);
    const rec = parsed.get("001592") as { apcs: { items: unknown[] } | null; quota: number };
    expect(rec.quota).toBe(4);
    expect(rec.apcs!.items).toHaveLength(2);
  });
  it("15. failed acquisitions stay failed in the report", async () => {
    const f = mockFetch((url) => {
      if (url.includes("robots.txt")) return { status: 200, body: ROBOTS_OK };
      const e = new Error("socket hang up");
      return e;
    });
    const { report } = await runAcquisition({ ...baseOpts(), limit: 2, fetchImpl: f, rawDir: tmp() } as never);
    expect(report.failed).toBe(2);
    expect(report.pages.every((p) => p.errors.length > 0)).toBe(true);
  });
});
