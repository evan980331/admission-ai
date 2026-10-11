import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildScopedCleanup,
  hcExecutionPlan,
  HC_LIVE_CASES,
  isLoopback,
  parseDbTarget,
  preflightConfig,
  preflightHcCommand,
  readTestDatabaseUrl,
  verifyDbName,
  verifyLiveTarget,
} from "../src/data/testing/testGuard";
import { classifyLiveState } from "../src/data/normalization/reconcile";

/**
 * P4.4b-7 isolation-guard regression tests. ZERO database connections:
 * every live-shaped check uses injected mock queries. Fail-closed is
 * asserted behaviorally, never by grep.
 */

const LOOP = "postgresql://hc:LOCALONLY@127.0.0.1:55433/admission_hc";
const PROD = "postgresql://user:SECRET@ep-prod-1.neon.tech/neondb";

const E = (v: Record<string, string>): NodeJS.ProcessEnv => v as unknown as NodeJS.ProcessEnv;

describe("TEST_DATABASE_URL discipline", () => {
  it("missing variable refuses (never falls back to DATABASE_URL)", () => {
    expect(() => readTestDatabaseUrl(E({ DATABASE_URL: PROD }))).toThrow(/TEST_DATABASE_URL is not set/);
    expect(() => readTestDatabaseUrl(E({ TEST_DATABASE_URL: "" }))).toThrow(/TEST_DATABASE_URL is not set/);
    expect(readTestDatabaseUrl(E({ TEST_DATABASE_URL: LOOP }))).toBe(LOOP);
  });
  it("unparseable or non-postgres URLs refuse", () => {
    expect(() => preflightConfig(E({ TEST_DATABASE_URL: "not-a-url" }))).toThrow(/unparseable/);
    expect(() => preflightConfig(E({ TEST_DATABASE_URL: "https://example.com/db" }))).toThrow(/unparseable/);
  });
  it("production target refuses (same host+dbname, or same dbname)", () => {
    expect(() =>
      preflightConfig(E({ TEST_DATABASE_URL: PROD, DATABASE_URL: PROD })),
    ).toThrow(/production database/);
    expect(() =>
      preflightConfig(E({ TEST_DATABASE_URL: "postgresql://hc:x@127.0.0.1:55433/neondb", DATABASE_URL: PROD })),
    ).toThrow(/matches production dbname/);
  });
  it("unknown production + non-loopback target refuses (isolation unverifiable)", () => {
    expect(() =>
      preflightConfig(E({ TEST_DATABASE_URL: "postgresql://hc:x@db.example.com/hc" })),
    ).toThrow(/not loopback/);
  });
  it("loopback target with unknown production passes preflight (sentinel still required)", () => {
    const r = preflightConfig(E({ TEST_DATABASE_URL: LOOP }));
    expect(r.target).toEqual({ host: "127.0.0.1", dbName: "admission_hc" });
    expect(r.needsLiveSentinel).toBe(true);
    expect(isLoopback("LOCALHOST")).toBe(true);
    expect(parseDbTarget(LOOP)).toEqual({ host: "127.0.0.1", dbName: "admission_hc" });
  });
});

describe("live-target sentinel (mock queries, zero connections)", () => {
  const okQuery = async (text: string) => {
    if (text.includes("current_database")) return { rows: [{ db: "admission_hc" }] };
    return { rows: [{ token: "hc-token-1" }] };
  };
  it("wrong database name refuses", async () => {
    const q = async (text: string) => (text.includes("current_database") ? { rows: [{ db: "neondb" }] } : { rows: [{ token: "hc-token-1" }] });
    await expect(verifyLiveTarget(q, { dbName: "admission_hc", guardToken: "hc-token-1" })).rejects.toThrow(/not the expected test database/);
  });
  it("absent sentinel table refuses", async () => {
    const q = async (text: string) => {
      if (text.includes("current_database")) return { rows: [{ db: "admission_hc" }] };
      throw new Error("relation __hc_guard does not exist");
    };
    await expect(verifyLiveTarget(q, { dbName: "admission_hc", guardToken: "hc-token-1" })).rejects.toThrow(/sentinel table/);
  });
  it("token mismatch refuses", async () => {
    const q = async (text: string) => {
      if (text.includes("current_database")) return { rows: [{ db: "admission_hc" }] };
      return { rows: [{ token: "wrong" }] };
    };
    await expect(verifyLiveTarget(q, { dbName: "admission_hc", guardToken: "hc-token-1" })).rejects.toThrow(/sentinel token mismatch/);
  });
  it("matching dbname + token passes", async () => {
    await expect(verifyLiveTarget(okQuery, { dbName: "admission_hc", guardToken: "hc-token-1" })).resolves.toBeUndefined();
  });
});

describe("scoped cleanup builder (pure, never executes)", () => {
  it("rejects protected tables, empty and oversized scopes", () => {
    for (const t of ["departments", "schools", "department_admissions", "data_sources", "schema_migrations", "mystery"]) {
      expect(() => buildScopedCleanup(t, ["a"])).toThrow(/not cleanable/);
    }
    expect(() => buildScopedCleanup("second_stage_items", [])).toThrow(/empty cleanup scope/);
    expect(() => buildScopedCleanup("second_stage_items", Array.from({ length: 201 }, (_, i) => `a${i}`))).toThrow(/too large/);
  });
  it("emits explicit IN-list deletes for cleanable tables only", () => {
    const stmts = buildScopedCleanup("tech_screening_items", ["a1", "a2"]);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]!.text).toBe("DELETE FROM tech_screening_items WHERE admission_id IN ($1,$2)");
    expect(stmts[0]!.values).toEqual(["a1", "a2"]);
  });
});

describe("H-C/default test isolation wiring", () => {
  it("default vitest config excludes *.hc.test.ts", () => {
    const cfg = fs.readFileSync(path.join(__dirname, "..", "vitest.config.ts"), "utf8");
    expect(cfg).toMatch(/\.hc\.test\.ts/);
    expect(cfg).toMatch(/exclude/);
  });
  it("dedicated hc config includes only hc files", () => {
    const cfg = fs.readFileSync(path.join(__dirname, "..", "vitest.hc.config.ts"), "utf8");
    expect(cfg).toMatch(/\.hc\.test\.ts/);
  });
  it("test:hc command exists and fronts the preflight guard", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:hc"]).toContain("test-hc-preflight");
    const cli = fs.readFileSync(path.join(__dirname, "..", "scripts", "test-hc-preflight.ts"), "utf8");
    expect(cli).toContain("preflightHcCommand(process.env)");
    expect(cli).toContain("process.exit(2)");
    // The CLI prints host/dbname only — the full URL (with password) never appears in output code.
    expect(cli).not.toMatch(/console\.log\([^)]*TEST_DATABASE_URL/);
  });
  it("preflightHcCommand resolves loopback descriptor or throws", () => {
    expect(preflightHcCommand(E({ TEST_DATABASE_URL: LOOP }))).toEqual({ host: "127.0.0.1", dbName: "admission_hc" });
    expect(() => preflightHcCommand(E({}))).toThrow(/TEST_DATABASE_URL is not set/);
  });
});

describe("H-C execution plan states (automation, not convention)", () => {
  it("BLOCKED without HC_LIVE with the full NOT RUN manifest", () => {
    const env = { TEST_DATABASE_URL: LOOP } as unknown as NodeJS.ProcessEnv;
    const plan = hcExecutionPlan(env);
    expect(plan.mode).toBe("BLOCKED");
    expect(plan.reason).toMatch(/HC_LIVE/);
    expect(plan.notRun).toEqual([...HC_LIVE_CASES]);
    expect(plan.notRun).toHaveLength(12);
  });
  it("BLOCKED with HC_LIVE but no TEST_DATABASE_URL", () => {
    const plan = hcExecutionPlan({ HC_LIVE: "1" } as unknown as NodeJS.ProcessEnv);
    expect(plan.mode).toBe("BLOCKED");
    expect(plan.notRun).toHaveLength(12);
  });
  it("LIVE only with HC_LIVE=1 and passing preflight", () => {
    const plan = hcExecutionPlan({ HC_LIVE: "1", TEST_DATABASE_URL: LOOP } as unknown as NodeJS.ProcessEnv);
    expect(plan.mode).toBe("LIVE");
    expect(plan.notRun).toEqual([]);
  });
  it("verifyDbName re-checks post-connect name or throws", async () => {
    const ok = async () => ({ rows: [{ db: "admission_hc" }] });
    await expect(verifyDbName(ok, "admission_hc")).resolves.toBeUndefined();
    const wrong = async () => ({ rows: [{ db: "neondb" }] });
    await expect(verifyDbName(wrong, "admission_hc")).rejects.toThrow(/not the expected test database/);
  });
  it("test:hc prints the plan (status automation, not docs)", () => {
    const cli = fs.readFileSync(path.join(__dirname, "..", "scripts", "test-hc-preflight.ts"), "utf8");
    expect(cli).toContain("hcExecutionPlan(process.env)");
    expect(cli).toContain("H-C NOT RUN");
    expect(cli.indexOf("preflightHcCommand(process.env)")).toBeLessThan(cli.indexOf('spawnSync("npx"'));
  });
});

describe("existing guards unaffected", () => {
  it("reconcile mock classification still fail-closes", () => {
    const item = {
      identity: { year: 115, schoolCode: "008", departmentCode: "008432", programType: "application", admissionId: "a" },
      raw: { htmlPath: "h", metaPath: "m", sha256: "s", meta: { sourceUrl: "u", capturedAt: null, sha256: "s", departmentCode: "008432", schoolCode: "008" } },
      parserVersion: "unknown",
      changes: [{ table: "t", rowKey: "r", field: "f", oldValue: null, newValue: 1 }],
      checks: { reparseErrors: 0, normalizeErrors: [], drift: [], completenessErrors: [], orderDiffs: [] },
      disposition: "PENDING_APPROVAL" as const,
    };
    expect(classifyLiveState(item, { admissionFound: false, identityMatch: false, currentChanges: [] }).disposition).toBe("REJECTED");
  });
  it("general --import gate text unchanged", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "normalize-admission-115.ts"), "utf8");
    expect(src).toContain("IMPORT BLOCKED");
    expect(src).toContain("if (errors.length > 0)");
  });
});

describe("loader parserVersion plumbing (history preserved, mock)", () => {
  type Row = Record<string, unknown>;
  const makeMock = (sources: Row[]) => {
    const tables = new Map<string, Row[]>([
      ["data_sources", sources.map((r) => ({ ...r }))],
      ["departments", [{ id: "d1" }]],
      ["admission_programs", [{ id: "p1" }]],
      ["department_admissions", []],
    ]);
    return {
      tables,
      writes: [] as string[],
      async query(text: string, values: unknown[] = []): Promise<{ rows: Row[] }> {
        const t = text.trim();
        if (t === "BEGIN" || t === "COMMIT" || t === "ROLLBACK") return { rows: [] };
        if (t.startsWith("SELECT")) {
          if (t.includes("FROM data_sources")) {
            const hit = tables.get("data_sources")!.find((r) => r["source_name"] === values[0] && r["data_version"] === values[1]);
            return { rows: hit ? [{ id: hit["id"] }] : [] };
          }
          return { rows: [{ id: "x" }] };
        }
        this.writes.push(t.slice(0, 60));
        if (t.startsWith("INSERT INTO data_sources")) {
          // Mirror ON CONFLICT (source_name, data_version) DO NOTHING.
          const exists = tables.get("data_sources")!.some((r) => r["source_name"] === values[0] && r["data_version"] === values[1]);
          if (!exists) {
            tables.get("data_sources")!.push({ id: "src-new", source_name: values[0], source_type: "official", data_version: values[1], parser_version: values[2] ?? null });
          }
          return { rows: [] };
        }
        if (t.startsWith("INSERT INTO department_admissions")) return { rows: [{ id: "adm-1" }] };
        return { rows: [] };
      },
    };
  };
  const minimalRecords = () => ({
    header: { academicYear: 115, schoolCode: "990", departmentCode: "990012", quota: 7, requirements: { chinese: null, english: null, math_a: null, math_b: null, social: null, science: null, english_listening: null } },
    firstStageWeight: null, secondStageWeight: null, subjects: [], sequences: [], secondStage: [], apcs: [], review: [], special: [],
    schedule: { applicationFee: null, applicationFeeSource: null, notificationDate: null, notificationSource: null, materialDeadline: null, materialDeadlineSource: null, secondStageDate: null, secondStageDateSource: null, resultDate: null, resultDateSource: null, recheckDeadline: null, recheckDeadlineSource: null },
    notices: [], techGroup: null,
    provenance: { source: "official", sourceUrl: "u", academicYear: 115, retrievedAt: null, parserVersion: "v", dataVersion: "v", sourceId: null },
  });
  it("omitted version keeps the exact legacy statements", async () => {
    const { ensureSourceStatements, executeDbLoad } = await import("../src/data/loaders/official/admission");
    const stmts = ensureSourceStatements("s", "v");
    expect(stmts[0]!.text).toBe(
      "INSERT INTO data_sources (source_name, source_type, data_version) VALUES ($1, 'official', $2) ON CONFLICT (source_name, data_version) DO NOTHING",
    );
    const mock = makeMock([]);
    await mock.query("BEGIN");
    await executeDbLoad(mock as never, minimalRecords() as never, { sourceName: "s", dataVersion: "v", departmentName: "D" });
    await mock.query("COMMIT");
    expect(mock.tables.get("data_sources")).toEqual([{ id: "src-new", source_name: "s", source_type: "official", data_version: "v", parser_version: null }]);
  });
  it("provided version lands on new rows; existing rows keep history (DO NOTHING)", async () => {
    const { ensureSourceStatements, executeDbLoad } = await import("../src/data/loaders/official/admission");
    expect(ensureSourceStatements("s", "v", "pv-1")[0]!.text).toContain("parser_version");
    const mock = makeMock([{ id: "src-old", source_name: "s", source_type: "official", data_version: "v", parser_version: null }]);
    await mock.query("BEGIN");
    await executeDbLoad(mock as never, minimalRecords() as never, { sourceName: "s", dataVersion: "v", departmentName: "D", parserVersion: "pv-1" });
    await mock.query("COMMIT");
    // Pre-existing historical row untouched (NULL preserved, not backfilled).
    expect(mock.tables.get("data_sources")).toEqual([{ id: "src-old", source_name: "s", source_type: "official", data_version: "v", parser_version: null }]);
    const fresh = makeMock([]);
    await fresh.query("BEGIN");
    await executeDbLoad(fresh as never, minimalRecords() as never, { sourceName: "s", dataVersion: "v", departmentName: "D", parserVersion: "pv-1" });
    await fresh.query("COMMIT");
    expect(fresh.tables.get("data_sources")).toEqual([{ id: "src-new", source_name: "s", source_type: "official", data_version: "v", parser_version: "pv-1" }]);
  });
});
