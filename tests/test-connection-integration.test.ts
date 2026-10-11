import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildSentinelSeedStatements,
  establishTestConnection,
  resolveTestConnectionString,
  SENTINEL_ID,
  SENTINEL_TABLE,
  validateSeedSpec,
} from "../src/data/testing/testGuard";
import { classifyLiveState } from "../src/data/normalization/reconcile";

/**
 * P4.4b-9 connection-integration regression tests. No database connections:
 * factories and queries are injected mocks; the only file reads are local
 * sources. Real pg.Client is never constructed.
 */

const LOOP = "postgresql://hc:LOCALONLY@127.0.0.1:55433/admission_hc";
const E = (v: Record<string, string>): NodeJS.ProcessEnv => v as unknown as NodeJS.ProcessEnv;

const mockQueryFor = (db: string, token: string | null) => async (text: string) => {
  if (text.includes("current_database")) return { rows: [{ db }] };
  if (token === null) throw new Error("relation __hc_guard does not exist");
  return { rows: [{ token }] };
};

describe("resolveTestConnectionString (no client, no fallback)", () => {
  it("missing TEST_DATABASE_URL refuses", () => {
    expect(() => resolveTestConnectionString(E({}))).toThrow(/TEST_DATABASE_URL is not set/);
  });
  it("DATABASE_URL-only env refuses (no fallback)", () => {
    expect(() => resolveTestConnectionString(E({ DATABASE_URL: "postgresql://u:p@h/db" }))).toThrow(/TEST_DATABASE_URL is not set/);
  });
  it("returns the TEST string verbatim with its descriptor", () => {
    const r = resolveTestConnectionString(E({ TEST_DATABASE_URL: LOOP }));
    expect(r.connectionString).toBe(LOOP);
    expect(r.target).toEqual({ host: "127.0.0.1", dbName: "admission_hc" });
  });
});

describe("establishTestConnection guard-first ordering (mock factory)", () => {
  it("guard failure means the factory is never called", async () => {
    let calls = 0;
    const factory = () => {
      calls++;
      return { query: mockQueryFor("admission_hc", "tok") };
    };
    await expect(establishTestConnection(E({}), factory, "tok")).rejects.toThrow(/TEST_DATABASE_URL is not set/);
    expect(calls).toBe(0);
  });
  it("sentinel mismatch aborts after factory creation but before any write", async () => {
    const seen: string[] = [];
    const factory = (cs: string) => {
      expect(cs).toBe(LOOP);
      return {
        query: async (text: string) => {
          seen.push(text);
          return mockQueryFor("admission_hc", "wrong-token")(text);
        },
      };
    };
    await expect(
      establishTestConnection(E({ TEST_DATABASE_URL: LOOP }), factory, "tok"),
    ).rejects.toThrow(/sentinel token mismatch/);
    expect(seen.some((t) => /^(INSERT|UPDATE|DELETE|CREATE|DROP|TRUNCATE)/i.test(t.trim()))).toBe(false);
  });
  it("matching sentinel hands over client + target", async () => {
    const factory = () => ({ query: mockQueryFor("admission_hc", "tok") });
    const r = await establishTestConnection(E({ TEST_DATABASE_URL: LOOP }), factory, "tok");
    expect(r.target).toEqual({ host: "127.0.0.1", dbName: "admission_hc" });
    expect(typeof r.client.query).toBe("function");
  });
});

describe("sentinel seed contract (pure builders, never executed)", () => {
  it("creates the sentinel idempotently without destructive statements", () => {
    const stmts = buildSentinelSeedStatements("a-16-char-token-00");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.text).toContain(`CREATE TABLE IF NOT EXISTS ${SENTINEL_TABLE}`);
    expect(stmts[1]!.text).toContain(`INSERT INTO ${SENTINEL_TABLE}`);
    expect(stmts[1]!.text).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
    expect(stmts[1]!.values).toEqual([SENTINEL_ID, "a-16-char-token-00"]);
    const all = stmts.map((s) => s.text).join("\n");
    expect(all).not.toMatch(/TRUNCATE|DELETE FROM|DROP TABLE|DATABASE_URL/);
  });
  it("weak tokens refused", () => {
    expect(() => buildSentinelSeedStatements("short")).toThrow(/non-trivial/);
  });
  it("production code never references the sentinel table", () => {
    for (const f of [
      "src/data/loaders/official/admission.ts",
      "src/data/importers/official/application115/index.ts",
      "scripts/normalize-admission-115.ts",
      "db/migrations/006_tech_screening.sql",
    ]) {
      const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      expect(src).not.toContain(SENTINEL_TABLE);
    }
  });
});

describe("dedicated seed spec (synthetic only)", () => {
  const good = { source: "synthetic", departments: [{ schoolCode: "990", departmentCode: "990012" }], guardToken: "a-16-char-token-00" };
  it("accepts synthetic 9xxxxx departments", () => {
    expect(validateSeedSpec(good)).toEqual([]);
  });
  it("rejects prod copies and official inventory codes", () => {
    expect(validateSeedSpec({ ...good, source: "prod-copy" }).join("\n")).toMatch(/literal "synthetic"/);
    expect(validateSeedSpec({ ...good, departments: [{ schoolCode: "008", departmentCode: "008432" }] }).join("\n")).toMatch(/synthetic 9xxxxx/);
    expect(validateSeedSpec({ ...good, departments: [] }).join("\n")).toMatch(/non-empty/);
    expect(validateSeedSpec({ ...good, guardToken: "x" }).join("\n")).toMatch(/non-trivial/);
  });
});

describe("production paths unchanged (no TEST_DATABASE_URL leakage)", () => {
  it("loader has no env access (fully injected DbClient)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "data", "loaders", "official", "admission.ts"), "utf8");
    expect(src).not.toMatch(/process\.env|TEST_DATABASE_URL|DATABASE_URL/);
  });
  it("importer keeps opts.databaseUrl ?? DATABASE_URL and never reads TEST_DATABASE_URL", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "data", "importers", "official", "application115", "index.ts"), "utf8");
    expect(src).toContain("opts.databaseUrl ?? process.env.DATABASE_URL");
    expect(src).not.toContain("TEST_DATABASE_URL");
  });
  it("reconcile mock classification + --import gate unaffected", () => {
    const item = {
      identity: { year: 115, schoolCode: "008", departmentCode: "008432", programType: "application", admissionId: "a" },
      raw: { htmlPath: "h", metaPath: "m", sha256: "s", meta: { sourceUrl: "u", capturedAt: null, sha256: "s", departmentCode: "008432", schoolCode: "008" } },
      parserVersion: "unknown",
      changes: [{ table: "t", rowKey: "r", field: "f", oldValue: null, newValue: 1 }],
      checks: { reparseErrors: 0, normalizeErrors: [], drift: [], completenessErrors: [], orderDiffs: [] },
      disposition: "PENDING_APPROVAL" as const,
    };
    expect(classifyLiveState(item, { admissionFound: true, identityMatch: true, currentChanges: item.changes }).disposition).toBe("READY");
    const gate = fs.readFileSync(path.join(__dirname, "..", "scripts", "normalize-admission-115.ts"), "utf8");
    expect(gate).toContain("IMPORT BLOCKED");
  });
});
