import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildHcSeedFixtures,
  HC_CONTROL_DEPT,
  HC_REQUIRED_TABLES,
  HC_SCHOOL_CODE,
  HC_TARGET_DEPT,
  seedTestDb,
} from "../src/data/testing/hcSeed";

/**
 * P4.4b-11 seed regression tests. No PostgreSQL, Docker, network, or
 * secrets: a scripted in-memory client asserts statement shapes, order,
 * transaction behavior, and refusal paths. Real pg.Client is never built.
 */

type Row = Record<string, unknown>;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

class SeedMock {
  log: string[] = [];
  writes: string[] = [];
  tables = new Map<string, Row[]>();
  snap: Map<string, Row[]> | null = null;
  failWhen: ((text: string) => boolean) | null = null;

  constructor(withSchema = true) {
    if (withSchema) {
      this.tables.set("__schema__", HC_REQUIRED_TABLES.map((t) => ({ table_name: t })));
    }
    this.tables.set("schools", []);
    this.tables.set("departments", []);
    this.tables.set("admission_programs", []);
    this.tables.set("data_sources", []);
    this.tables.set("department_admissions", []);
    this.tables.set("second_stage_items", []);
    this.tables.set("__hc_guard", []);
  }

  async query(text: string, values: unknown[] = []): Promise<{ rows: Row[] }> {
    const t = text.trim();
    this.log.push(t.slice(0, 80));
    if (this.failWhen?.(t)) throw new Error(`injected failure: ${t.slice(0, 60)}`);
    if (t === "BEGIN") {
      this.snap = new Map([...this.tables].map(([k, v]) => [k, clone(v)]));
      return { rows: [] };
    }
    if (t === "COMMIT") {
      this.snap = null;
      return { rows: [] };
    }
    if (t === "ROLLBACK") {
      if (this.snap) {
        this.tables = this.snap;
        this.snap = null;
      }
      return { rows: [] };
    }
    if (t.startsWith("SELECT")) return { rows: this.select(t, values) };
    this.writes.push(t.slice(0, 80));
    return { rows: this.write(t, values) };
  }

  private one(table: string, pred: (r: Row) => boolean): Row[] {
    return this.tables.get(table)!.filter(pred);
  }

  private select(t: string, v: unknown[]): Row[] {
    if (t.includes("information_schema")) return this.tables.get("__schema__") ?? [];
    if (t.startsWith("SELECT token FROM __hc_guard")) return this.one("__hc_guard", (r) => r["id"] === v[0]);
    if (t.startsWith("SELECT COUNT(*)")) {
      const m = t.match(/FROM (\w+)/)!;
      return [{ c: this.tables.get(m[1]!)!.length }];
    }
    if (t.startsWith("SELECT id, school_code, name FROM schools")) return this.one("schools", (r) => r["school_code"] === v[0]);
    if (t.includes("FROM departments d JOIN schools")) {
      return this.one("departments", (r) => r["school_code"] === v[0] && r["department_code"] === v[1]);
    }
    if (t.startsWith("SELECT id, year, program_type, name FROM admission_programs")) {
      return this.one("admission_programs", (r) => r["year"] === v[0] && r["program_type"] === v[1]);
    }
    if (t.startsWith("SELECT id, source_name")) return this.one("data_sources", (r) => r["source_name"] === v[0] && r["data_version"] === v[1]);
    // NOTE: second_stage SELECT contains a department_admissions subquery,
    // so its prefix must be matched BEFORE the generic admissions branch.
    if (t.startsWith("SELECT position, name, weight FROM second_stage_items")) {
      return this.one("second_stage_items", (r) => r["school_code"] === v[0] && r["department_code"] === v[1] && r["year"] === v[2] && r["position"] === v[3]);
    }
    if (t.includes("FROM department_admissions a JOIN departments")) {
      return this.one("department_admissions", (r) => r["school_code"] === v[0] && r["department_code"] === v[1] && r["year"] === v[2]);
    }
    throw new Error(`mock: unexpected SELECT: ${t.slice(0, 90)}`);
  }

  private write(t: string, v: unknown[]): Row[] {
    if (t.startsWith("CREATE TABLE IF NOT EXISTS __hc_guard")) return [];
    if (t.startsWith("INSERT INTO schools")) {
      this.tables.get("schools")!.push({ id: v[0], school_code: v[1], name: v[2] });
      return [];
    }
    if (t.startsWith("INSERT INTO departments")) {
      this.tables.get("departments")!.push({ id: v[0], school_code: v[3], department_code: v[1], name: v[2] });
      return [];
    }
    if (t.startsWith("INSERT INTO admission_programs")) {
      this.tables.get("admission_programs")!.push({ id: v[0], year: v[1], program_type: v[2], name: v[3] });
      return [];
    }
    if (t.startsWith("INSERT INTO data_sources")) {
      this.tables.get("data_sources")!.push({ id: v[0], source_name: v[1], source_type: v[2], data_version: v[3], parser_version: v[4] });
      return [];
    }
    if (t.startsWith("INSERT INTO department_admissions")) {
      this.tables.get("department_admissions")!.push({ id: v[0], year: v[1], quota: v[2], school_code: v[3], department_code: v[4] });
      return [];
    }
    if (t.startsWith("INSERT INTO second_stage_items")) {
      this.tables.get("second_stage_items")!.push({ school_code: v[4], department_code: v[5], year: v[6], position: v[0], name: v[1], weight: v[2] });
      return [];
    }
    if (t.startsWith("INSERT INTO __hc_guard")) {
      const tbl = this.tables.get("__hc_guard")!;
      if (tbl.some((r) => r["id"] === v[0])) return [];
      tbl.push({ id: v[0], token: v[1] });
      return [];
    }
    throw new Error(`mock: unexpected write: ${t.slice(0, 90)}`);
  }
}

const TOKEN = "test-token-16-chars-00";

describe("fixtures: deterministic, synthetic, schema-valid", () => {
  it("byte-identical across builds; no time/randomness", () => {
    expect(buildHcSeedFixtures()).toEqual(buildHcSeedFixtures());
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "data", "testing", "hcSeed.ts"), "utf8");
    expect(src).not.toMatch(/Date\.now|Math\.random|fetch\(|process\.env/);
  });
  it("synthetic namespace only (990 school, 9xxxxx depts, fixed names)", () => {
    const f = buildHcSeedFixtures();
    expect(f.school.school_code).toBe(HC_SCHOOL_CODE);
    expect([HC_TARGET_DEPT, HC_CONTROL_DEPT].every((c) => /^9\d{5}$/.test(c))).toBe(true);
    for (const d of f.departments) {
      expect(d.department_code.startsWith(d.schoolCode)).toBe(true);
      expect(d.name).toMatch(/合成測試/);
    }
    expect(f.school.name).toMatch(/合成測試/);
    for (const a of f.admissions) {
      expect(a.year).toBe(115);
      expect(Number.isInteger(a.quota) && (a.quota as number) >= 0).toBe(true);
    }
    expect(f.source.source_type).toBe("research_only");
  });
  it("no official codes, no personal data", () => {
    const f = buildHcSeedFixtures();
    const official = ["001", "002", "003", "004", "005", "006", "007", "008", "009", "011"];
    expect(official).not.toContain(f.school.school_code);
    const text = JSON.stringify(f);
    expect(text).not.toMatch(/008432|009432|001032/);
    expect(text).not.toMatch(/身分證|電話|地址|email/i);
  });
});

describe("seeder guards (mock, zero real connections)", () => {
  it("missing tables refuse before any write (no auto-migration)", async () => {
    const mock = new SeedMock(false);
    await expect(seedTestDb(mock, buildHcSeedFixtures(), TOKEN)).rejects.toThrow(/required table missing/);
    expect(mock.writes).toEqual([]);
  });
  it("sentinel absent on non-empty unknown DB refuses with zero writes", async () => {
    const mock = new SeedMock();
    mock.tables.get("department_admissions")!.push({ id: "x", school_code: "001", department_code: "001012", year: 115 });
    await expect(seedTestDb(mock, buildHcSeedFixtures(), TOKEN)).rejects.toThrow(/non-empty database/);
    expect(mock.writes).toEqual([]);
  });
  it("sentinel token mismatch refuses with zero writes", async () => {
    const mock = new SeedMock();
    mock.tables.get("__hc_guard")!.push({ id: "hc", token: "other-token-00000000" });
    await expect(seedTestDb(mock, buildHcSeedFixtures(), TOKEN)).rejects.toThrow(/sentinel token mismatch/);
    expect(mock.writes).toEqual([]);
  });
  it("emits no migration DDL/DROP/TRUNCATE/DELETE and no 006 auto-run", async () => {
    const mock = new SeedMock();
    await seedTestDb(mock, buildHcSeedFixtures(), TOKEN);
    const all = mock.log.filter((l) => !l.startsWith("CREATE TABLE IF NOT EXISTS __hc_guard")).join("\n");
    expect(all).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP|TRUNCATE|DELETE FROM/);
  });
});

describe("seeder behavior (mock transaction journal)", () => {
  it("fresh seed inserts all fixture rows in one transaction", async () => {
    const mock = new SeedMock();
    const summary = await seedTestDb(mock, buildHcSeedFixtures(), TOKEN);
    expect(mock.tables.get("schools")).toHaveLength(1);
    expect(mock.tables.get("departments")).toHaveLength(2);
    expect(mock.tables.get("department_admissions")).toHaveLength(2);
    expect(mock.tables.get("second_stage_items")).toHaveLength(3);
    expect(mock.tables.get("__hc_guard")).toHaveLength(1);
    expect(summary.inserted["schools"]).toBe(1);
    expect(mock.log[0]).toBe("BEGIN");
    expect(mock.log[mock.log.length - 1]).toBe("COMMIT");
  });
  it("identical rerun skips everything with zero writes", async () => {
    const mock = new SeedMock();
    await seedTestDb(mock, buildHcSeedFixtures(), TOKEN);
    mock.writes = [];
    const summary = await seedTestDb(mock, buildHcSeedFixtures(), TOKEN);
    expect(mock.writes).toEqual([]);
    expect(Object.values(summary.skippedIdentical).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(summary.inserted && Object.keys(summary.inserted)).toHaveLength(0);
  });
  it("conflicting content refuses without overwriting", async () => {
    const mock = new SeedMock();
    await seedTestDb(mock, buildHcSeedFixtures(), TOKEN);
    mock.tables.get("departments")!.find((r) => r["department_code"] === HC_TARGET_DEPT)!["name"] = "竄改名稱";
    await expect(seedTestDb(mock, buildHcSeedFixtures(), TOKEN)).rejects.toThrow(/conflicting departments row/);
    expect(mock.tables.get("departments")!.find((r) => r["department_code"] === HC_TARGET_DEPT)!["name"]).toBe("竄改名稱");
  });
  it("mid-seed failure rolls back fully", async () => {
    const mock = new SeedMock();
    mock.failWhen = (t) => t.startsWith("INSERT INTO department_admissions");
    await expect(seedTestDb(mock, buildHcSeedFixtures(), TOKEN)).rejects.toThrow(/injected failure/);
    expect(mock.tables.get("schools")).toEqual([]);
    expect(mock.tables.get("departments")).toEqual([]);
    expect(mock.tables.get("__hc_guard")).toEqual([]);
    expect(mock.log).toContain("ROLLBACK");
  });
});

describe("scope and regression locks", () => {
  it("seed touches only synthetic 990 rows (control + target)", () => {
    const f = buildHcSeedFixtures();
    const codes = [f.school.school_code, ...f.departments.map((d) => d.department_code), ...f.admissions.map((a) => a.departmentCode)];
    for (const c of codes) expect(c.startsWith("990")).toBe(true);
  });
  it("reconcile mock classification + --import gate unaffected", async () => {
    const mock = new SeedMock();
    await seedTestDb(mock, buildHcSeedFixtures(), TOKEN);
    expect(mock.tables.get("department_admissions")).toHaveLength(2);
    const gate = fs.readFileSync(path.join(__dirname, "..", "scripts", "normalize-admission-115.ts"), "utf8");
    expect(gate).toContain("IMPORT BLOCKED");
  });
  it("seed script fronts the TEST guard with guard-first execution (source lock)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "seed-test-db.ts"), "utf8");
    expect(src).toContain("preflightHcCommand(process.env)");
    // Guard-first establishment (never a direct unguarded client).
    expect(src).toContain("establishTestConnection(");
    // Never READS the production variable (naming it in a never-comment is fine).
    expect(src).not.toMatch(/process\.env\[.DATABASE_URL|env\[.DATABASE_URL/);
  });
});
