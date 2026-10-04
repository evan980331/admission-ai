import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchText } from "../src/data/crawlers/official/application115/client";
import {
  readIfCached,
  totalPath,
  writeRaw,
} from "../src/data/crawlers/official/application115/cache";
import { Pacer } from "../src/data/crawlers/official/application115/rate-limit";
import { evaluateRobots } from "../src/data/crawlers/official/application115/robots";
import { runCrawl } from "../src/data/crawlers/official/application115/index";
import type { FetchImpl } from "../src/data/crawlers/official/application115/types";

const FIX = path.join(__dirname, "fixtures", "application115", "crawler");

function stubFetch(handler: (url: string) => { status: number; body: string }): FetchImpl & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const r = handler(url);
    return { status: r.status, text: async () => r.body };
  }) as FetchImpl & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("cache", () => {
  it("serves written files and respects --force", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-cache-"));
    const p = totalPath(tmp);
    expect(readIfCached(p, false)).toBeNull();
    writeRaw(p, "<html>cached</html>");
    expect(readIfCached(p, false)).toBe("<html>cached</html>");
    expect(readIfCached(p, true)).toBeNull();
  });
});

describe("rate limit", () => {
  it("enforces delay between gated calls, sequentially", async () => {
    const pacer = new Pacer(50);
    const t0 = Date.now();
    await pacer.pace();
    await pacer.pace();
    await pacer.pace();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
  });

  it("serializes concurrent pace() calls", async () => {
    const pacer = new Pacer(30);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map(async (n) => {
        await pacer.pace();
        order.push(n);
      }),
    );
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("client", () => {
  it("retries 500 then succeeds within the retry budget", async () => {
    let n = 0;
    const f = stubFetch(() => (++n === 1 ? { status: 500, body: "err" } : { status: 200, body: "ok" }));
    await expect(fetchText("https://www.cac.edu.tw/x", { fetchImpl: f, maxRetries: 2 })).resolves.toBe("ok");
    expect(f.calls.length).toBe(2);
  });

  it("does not retry 404", async () => {
    const f = stubFetch(() => ({ status: 404, body: "no" }));
    await expect(fetchText("https://www.cac.edu.tw/x", { fetchImpl: f, maxRetries: 2 })).rejects.toThrow();
    expect(f.calls.length).toBe(1);
  });
});

describe("robots handling", () => {
  it("refuses batch mode on `Disallow: /`", () => {
    const v = evaluateRobots("User-agent: *\nDisallow: /\n");
    expect(v.allowed).toBe(false);
  });

  it("fails closed on missing robots.txt", () => {
    expect(evaluateRobots(null).allowed).toBe(false);
    expect(evaluateRobots("").allowed).toBe(false);
  });

  it("live run stops after robots check without further requests", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-robots-"));
    const f = stubFetch((url) => {
      if (url.includes("robots.txt")) return { status: 200, body: "User-agent: *\nDisallow: /\n" };
      return { status: 200, body: "<html>SHOULD-NEVER-BE-FETCHED</html>" };
    });
    const { report, blocked } = await runCrawl({
      year: 115,
      dryRun: false,
      limitSchools: 3,
      force: true,
      includeDepartments: false,
      offline: false,
      delayMs: 0,
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: f,
      outDir: path.join(tmp, "out"),
      rawDir: path.join(tmp, "raw"),
    });
    expect(blocked).toBe(true);
    expect(report.robots_allowed).toBe(false);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toContain("robots.txt");
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, "out", "crawl-report.json"), "utf8"));
    expect(saved.robots_allowed).toBe(false);
  });
});

describe("dry-run (no batch requests)", () => {
  it("builds indexes from local input with zero website requests", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "predicter-dry-"));
    const f = stubFetch(() => ({ status: 200, body: "SHOULD-NEVER-BE-FETCHED" }));
    const { report, blocked } = await runCrawl({
      year: 115,
      dryRun: true,
      limitSchools: 3,
      force: false,
      includeDepartments: false,
      offline: true, // not even the robots request
      inputTotalHtml: path.join(FIX, "total.html"),
      delayMs: 0,
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: f,
      outDir: path.join(tmp, "out"),
      rawDir: path.join(tmp, "raw"),
    });
    expect(blocked).toBe(false);
    expect(f.calls).toHaveLength(0);
    expect(report.dry_run).toBe(true);
    expect(report.schools_found).toBe(3);
    expect(report.files_downloaded).toBe(0);
    expect(fs.existsSync(path.join(tmp, "out", "crawl-report.json"))).toBe(true);
  });
});
