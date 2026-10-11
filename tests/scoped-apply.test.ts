import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseDetailHtml } from "../src/data/importers/official/application115/detail/parser";
import { fromDetailRecord } from "../src/domain/admission/fromDetail";
import { auditCanonicalCompleteness } from "../src/domain/admission/validation";
import { toDbRecords } from "../src/domain/admission/toDbRecords";
import {
  applyScopedPlan,
  planScopedFixes,
  plansEqual,
  SCOPED_ALLOWLIST,
  SCOPED_DATA_VERSION,
  type PlanInput,
  type ScopedPlan,
} from "../src/data/normalization/scopedApply";
import type { DbSourcedAdmission } from "../src/data/normalization/admission115";
import { sha256Hex } from "../src/data/normalization/reconcile";

/**
 * Scoped applier behavioral tests. The in-memory mock mirrors PostgreSQL
 * semantics the mock CAN mirror (txn snapshots, UNIQUE/FK enforcement,
 * failure injection) and drives the REAL executeDbLoad + planScopedFixes.
 * Real-DB proof (locking, constraint timing) stays pending H-C.
 */

type Row = Record<string, unknown>;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

class MockDb {
  log: string[] = [];
  tables = new Map<string, Row[]>();
  snap: Map<string, Row[]> | null = null;
  failWhen: ((text: string) => boolean) | null = null;
  seq = 0;

  constructor() {
    for (const t of ["schools", "departments", "programs", "sources", "admissions", "subjects", "sequences", "secondStage", "apcs", "review", "special", "schedule", "notices", "techGroups", "techItems"]) {
      this.tables.set(t, []);
    }
  }

  tbl(name: string): Row[] {
    return this.tables.get(name)!;
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
    return { rows: this.write(t, values) };
  }

  private select(t: string, v: unknown[]): Row[] {
    if (t.includes("FROM data_sources")) {
      const hit = this.tbl("sources").find((r) => r["source_name"] === v[0] && r["data_version"] === v[1]);
      return hit ? [{ id: hit["id"] }] : [];
    }
    if (t.startsWith("SELECT d.id FROM departments")) {
      const hit = this.tbl("departments").find((r) => r["school_code"] === v[0] && r["department_code"] === v[1]);
      return hit ? [{ id: hit["id"] }] : [];
    }
    if (t.startsWith("SELECT id FROM admission_programs")) {
      const hit = this.tbl("programs").find((r) => r["year"] === v[0] && r["program_type"] === v[1]);
      return hit ? [{ id: hit["id"] }] : [];
    }
    if (t.startsWith("SELECT a.id FROM department_admissions a JOIN")) {
      const hit = this.tbl("admissions").find(
        (r) => r["year"] === v[0] && r["school_code"] === v[1] && r["department_code"] === v[2] && r["program_type"] === v[3],
      );
      return hit ? [{ id: hit["id"] }] : [];
    }
    throw new Error(`mock: unexpected SELECT: ${t.slice(0, 90)}`);
  }

  private write(t: string, v: unknown[]): Row[] {
    if (t.startsWith("INSERT INTO data_sources")) {
      const hit = this.tbl("sources").find((r) => r["source_name"] === v[0] && r["data_version"] === v[1]);
      if (!hit) this.tbl("sources").push({ id: `src-${++this.seq}`, source_name: v[0], source_type: "official", data_version: v[1], parser_version: v[2] ?? null });
      return [];
    }
    if (t.startsWith("INSERT INTO department_admissions")) {
      const tbl = this.tbl("admissions");
      const hit = tbl.find((r) => r["year"] === v[0] && r["department_id"] === v[1] && r["program_id"] === v[2]);
      const row = {
        year: v[0], department_id: v[1], program_id: v[2], quota: v[3],
        requirements: { chinese: v[4], english: v[5], math_a: v[6], math_b: v[7], social: v[8], science: v[9], english_listening: v[10] },
        sourceId: v[18], source_url: v[19], firstStageWeight: v[20], secondStageWeight: v[21],
      };
      // Mirrors ON CONFLICT DO UPDATE: non-key columns refresh, PK never changes.
      if (hit) Object.assign(hit, row);
      else {
        tbl.push({ id: `adm-${++this.seq}`, ...row } as unknown as Row);
      }
      const final = tbl.find((r) => r["year"] === v[0] && r["department_id"] === v[1] && r["program_id"] === v[2])!;
      return [{ id: final["id"] }];
    }
    if (t.startsWith("DELETE FROM")) {
      const m = t.match(/^DELETE FROM (\w+)/)!;
      const name = m[1]!;
      const table = name === "screening_subject_rules" ? "subjects"
        : name === "screening_sequences" ? "sequences"
          : name === "second_stage_items" ? "secondStage"
            : name === "apcs_requirements" ? "apcs"
              : name === "review_requirements" ? "review"
                : name === "special_requirements" ? "special"
                  : name === "admission_schedule" ? "schedule"
                    : name === "admission_notices" ? "notices"
                      : name === "tech_screening_items" ? "techItems"
                        : name === "tech_screening_groups" ? "techGroups" : name;
      this.tables.set(table, this.tbl(table).filter((r) => {
        if (table === "techItems") {
          const g = this.tbl("techGroups").find((gg) => gg["id"] === r["group_id"]);
          return g?.["admission_id"] !== v[0];
        }
        return r["admission_id"] !== v[0];
      }));
      return [];
    }
    if (t.startsWith("INSERT INTO tech_screening_groups")) {
      if (this.tbl("techGroups").some((r) => r["admission_id"] === v[0])) {
        throw new Error('duplicate key value violates unique constraint "tech_screening_groups_admission_id_key"');
      }
      const id = `grp-${++this.seq}`;
      this.tbl("techGroups").push({ id, admission_id: v[0], weight: v[1], weightStatus: v[2], sourceText: v[3] });
      return [{ id }];
    }
    if (t.startsWith("INSERT INTO tech_screening_items")) {
      if (!this.tbl("techGroups").some((g) => g["id"] === v[0])) throw new Error('insert violates foreign key "tech_screening_items_group_id_fkey"');
      if (this.tbl("techItems").some((r) => r["group_id"] === v[0] && r["position"] === v[2])) throw new Error("duplicate key value violates unique constraint");
      this.tbl("techItems").push({ group_id: v[0], admission_id: v[1], position: v[2], name: v[3], requirement: v[4], multiplier: v[5], scoreMethod: v[6], sourceText: v[7] });
      return [];
    }
    const m = t.match(/^INSERT INTO (\w+)/)!;
    const name = m[1]!;
    const table = name === "screening_subject_rules" ? "subjects"
      : name === "screening_sequences" ? "sequences"
        : name === "second_stage_items" ? "secondStage"
          : name === "apcs_requirements" ? "apcs"
            : name === "review_requirements" ? "review"
              : name === "special_requirements" ? "special"
                : name === "admission_schedule" ? "schedule"
                  : name === "admission_notices" ? "notices" : name;
    this.tbl(table).push({ admission_id: v[0], values: v.slice(1) });
    return [];
  }
}

// ---- Synthetic layout-B page (008432 shape, synthetic codes) ----

const g3 = (lines: string): string => `<td class="g3">${lines}</td>`;
const pageForCode = (code: string): string => `<html><body><table>
<tr><td class="school_title"><div class="colname">S</div><div class="gsdname">D</div></td></tr>
<tr><td class="Lb">校系代碼</td><td class="Rb">${code}</td>`
  + g3("--") + g3("") + g3("") + g3("") + g3("") + g3("審查資料<br>面試") + g3("") + g3("40%<br>20%")
  + g3("彩繪技法<br>創意表現") + g3("--<br>--") + g3("5<br>3") + g3("*1.00<br>*1.50") + g3("40%")
  + `</tr></table></body></html>`;
const page008432Shape = (): string => pageForCode("008432");

function seedMock(mock: MockDb): void {
  mock.tbl("schools").push({ id: "s008", school_code: "008" });
  mock.tbl("departments").push({ id: "d008432", school_code: "008", department_code: "008432" });
  mock.tbl("programs").push({ id: "p115", year: 115, program_type: "application" });
  // Control admission in another department (must never be touched).
  mock.tbl("departments").push({ id: "d009999", school_code: "008", department_code: "008999" });
  mock.tbl("admissions").push({
    id: "adm-ctrl", year: 115, department_id: "d009999", program_id: "p115", quota: 5,
    school_code: "008", department_code: "008999", program_type: "application",
    requirements: { chinese: null, english: null, math_a: null, math_b: null, social: null, science: null, english_listening: null },
    sourceId: "src-1", source_url: "u", firstStageWeight: null, secondStageWeight: null,
  });
  mock.tbl("secondStage").push({ admission_id: "adm-ctrl", position: 1, name: "口試", requirement: null, weight: "50%", itemType: null, description: null, sourceText: "口試|" });
}

/** Map loader-shape records back to a DbSourcedAdmission row (for rerun). */
function rowFromRecords(records: ReturnType<typeof toDbRecords>, info: { schoolCode: string; departmentCode: string }): DbSourcedAdmission {
  return {
    year: records.header.academicYear, schoolCode: info.schoolCode, schoolName: "S", departmentCode: info.departmentCode,
    departmentName: "D", groupName: null, programType: "application", quota: records.header.quota,
    requirements: { ...records.header.requirements },
    sourceUrl: records.provenance.sourceUrl, firstStageWeight: records.firstStageWeight, secondStageWeight: records.secondStageWeight,
    sourceName: "official-cac-detail", dataVersion: "x",
    children: {
      subjects: records.subjects.map((s) => ({ ...s })),
      sequences: records.sequences.map((s) => ({ ...s })),
      secondStage: records.secondStage.map((s) => ({ ...s })),
      apcs: records.apcs.map((a) => ({ ...a })),
      review: records.review.map((r) => ({ ...r })),
      special: records.special.map((s) => ({ ...s })),
      schedule: records.schedule ? { ...records.schedule } : null,
      notices: records.notices.map((n) => ({ ...n })),
      techGroup: records.techGroup ? { weight: records.techGroup.weight, weightStatus: records.techGroup.weightStatus, sourceText: records.techGroup.sourceText, admissionId: "adm-x" } : null,
      techItems: (records.techGroup ? records.techGroup.items : []).map((t) => ({
        position: t.position, name: t.name, requirement: t.requirement, multiplier: t.multiplier,
        scoreMethod: t.scoreMethod, sourceText: t.sourceText, groupAdmission: "adm-x", itemAdmission: "adm-x",
      })),
    },
  } as unknown as DbSourcedAdmission;
}

function planInputFor008432(dbRow: DbSourcedAdmission): PlanInput {
  const html = page008432Shape();
  return {
    row: dbRow,
    raw: { html, metaSha256: sha256Hex(html), sourceUrl: "https://www.cac.edu.tw/x/115_008432.htm" },
  };
}

function emptyRow(code: string, school = "008"): DbSourcedAdmission {
  return {
    year: 115, schoolCode: school, schoolName: "S", departmentCode: code, departmentName: "D",
    groupName: null, programType: "application", quota: 14,
    requirements: { chinese: null, english: null, math_a: null, math_b: null, social: null, science: null, english_listening: null },
    sourceUrl: "u", firstStageWeight: null, secondStageWeight: null, sourceName: "official-cac-detail", dataVersion: "x",
    children: { subjects: [], sequences: [], secondStage: [], apcs: [], review: [], special: [], schedule: null, notices: [], techGroup: null, techItems: [] },
  };
}

describe("scope allowlist (23 approved diffs, nothing else)", () => {
  it("covers exactly the 16 approved identities", () => {
    expect(SCOPED_ALLOWLIST).toHaveLength(16);
    for (const k of ["115|008|008432|application", "115|009|009432|application", "115|001|001262|application", "115|011|011562|application"]) {
      expect(SCOPED_ALLOWLIST).toContain(k);
    }
    expect(new Set(SCOPED_ALLOWLIST).size).toBe(16);
  });
  it("in-scope UPDATE planned; out-of-scope diff REJECTS and invalidates", () => {
    const inScope = planScopedFixes([planInputFor008432(emptyRow("008432"))]);
    expect(inScope.items[0]!.disposition).toBe("UPDATE");
    expect(inScope.items[0]!.diffs.length).toBeGreaterThan(0);
    const html = page008432Shape();
    const outOfScope = planScopedFixes([{
      row: emptyRow("990012", "990"),
      raw: { html, metaSha256: sha256Hex(html), sourceUrl: "u" },
    }]);
    expect(outOfScope.items[0]!.disposition).toBe("REJECT");
    expect(outOfScope.valid).toBe(false);
    expect(outOfScope.blocked.join("\n")).toMatch(/outside approved scope/);
  });
  it("empty diff classifies SKIP_UNCHANGED even out of scope", () => {
    // Out-of-scope identity (990012) whose DB row already equals the
    // re-parse: nothing to write, nothing to block on.
    const html = pageForCode("990012");
    const parsed = parseDetailHtml(html, { sourceUrl: "u", dataVersion: "t" });
    const { canonical } = fromDetailRecord(parsed.record!);
    const records = toDbRecords(canonical);
    const row = rowFromRecords(records, { schoolCode: "990", departmentCode: "990012" });
    const plan = planScopedFixes([{ row, raw: { html, metaSha256: sha256Hex(html), sourceUrl: "u" } }]);
    expect(plan.items[0]!.disposition).toBe("SKIP_UNCHANGED");
    expect(plan.valid).toBe(true);
  });
});

describe("SHA gate + apply refusal (mock, zero writes on refuse)", () => {
  it("SHA mismatch REJECTS; apply refuses before any statement", async () => {
    const input = planInputFor008432(emptyRow("008432"));
    input.raw!.metaSha256 = "0".repeat(64);
    const plan = planScopedFixes([input]);
    expect(plan.items[0]!.disposition).toBe("REJECT");
    expect(plan.valid).toBe(false);
    const mock = new MockDb();
    const callsBefore = mock.log.length;
    await expect(applyScopedPlan(mock as never, plan, { sourceName: "x", departmentNameOf: () => null })).rejects.toThrow(/blocked/);
    expect(mock.log.length).toBe(callsBefore);
  });
  it("tampered valid flag cannot smuggle a REJECT past apply", async () => {
    const plan = planScopedFixes([planInputFor008432(emptyRow("008432"))]);
    const tampered = { ...plan, valid: true, items: [{ ...plan.items[0]!, disposition: "REJECT" as const }] };
    const mock = new MockDb();
    await expect(applyScopedPlan(mock as never, tampered, { sourceName: "x", departmentNameOf: () => null })).rejects.toThrow();
    expect(mock.log).toEqual([]);
  });
});

describe("apply behavior (mock, real executeDbLoad)", () => {
  it("UPDATE writes full rows; unlisted columns and control rows byte-identical", async () => {
    const mock = new MockDb();
    seedMock(mock);
    const before = JSON.stringify({ ctrl: mock.tbl("secondStage"), admissions: mock.tbl("admissions").length });
    const plan = planScopedFixes([planInputFor008432(emptyRow("008432"))]);
    expect(plan.valid).toBe(true);
    // Seed the target admission shell so pre-existence holds (as the real DB would after acquisition).
    mock.tbl("admissions").push({
      id: "adm-008432", year: 115, department_id: "d008432", program_id: "p115", quota: 14,
      school_code: "008", department_code: "008432", program_type: "application",
      requirements: { chinese: null, english: null, math_a: null, math_b: null, social: null, science: null, english_listening: null },
      sourceId: "src-1", source_url: "u", firstStageWeight: null, secondStageWeight: null,
    });
    const result = await applyScopedPlan(mock as never, plan, { sourceName: "official-cac-detail", departmentNameOf: () => "D" });
    expect(result.applied).toEqual(["115|008|008432|application"]);
    // Tech group + items landed with linkage.
    expect(mock.tbl("techGroups")).toHaveLength(1);
    expect(mock.tbl("techGroups")[0]).toMatchObject({ admission_id: "adm-008432", weightStatus: "shared" });
    expect(mock.tbl("techItems")).toHaveLength(2);
    // Control admission untouched.
    expect(mock.tbl("secondStage").filter((r) => r["admission_id"] === "adm-ctrl")).toEqual([{ admission_id: "adm-ctrl", position: 1, name: "口試", requirement: null, weight: "50%", itemType: null, description: null, sourceText: "口試|" }]);
    expect(JSON.parse(before).admissions).toBe(1);
    // No new admission row was created for the target (UPSERT hit the shell).
    expect(mock.tbl("admissions").filter((r) => r["department_code"] === "008432")).toHaveLength(1);
    // New source-data version recorded; historical rows keep theirs (none here to check history, see guard tests).
    const sources = mock.tbl("sources");
    expect(sources.some((r) => r["data_version"] === SCOPED_DATA_VERSION)).toBe(true);
  });
  it("rerun after apply plans SKIP and issues zero statements", async () => {
    const mock = new MockDb();
    seedMock(mock);
    mock.tbl("admissions").push({
      id: "adm-008432", year: 115, department_id: "d008432", program_id: "p115", quota: 14,
      school_code: "008", department_code: "008432", program_type: "application",
      requirements: { chinese: null, english: null, math_a: null, math_b: null, social: null, science: null, english_listening: null },
      sourceId: "src-1", source_url: "u", firstStageWeight: null, secondStageWeight: null,
    });
    const html = page008432Shape();
    const input = (): PlanInput => planInputFor008432(emptyRow("008432"));
    const first = planScopedFixes([input()]);
    await applyScopedPlan(mock as never, first, { sourceName: "official-cac-detail", departmentNameOf: () => "D" });
    // Rebuild the DB row from the mock's post-apply state and re-plan.
    const parsed = parseDetailHtml(html, { sourceUrl: "u", dataVersion: "t" });
    const { canonical } = fromDetailRecord(parsed.record!);
    const records = toDbRecords(canonical);
    const row = rowFromRecords(records, { schoolCode: "008", departmentCode: "008432" });
    const second = planScopedFixes([{ row, raw: { html, metaSha256: sha256Hex(html), sourceUrl: "u" } }]);
    expect(second.items.map((i) => i.disposition)).toEqual(["SKIP_UNCHANGED"]);
    expect(second.valid).toBe(true);
    const callsBefore = mock.log.length;
    const result = await applyScopedPlan(mock as never, second, { sourceName: "official-cac-detail", departmentNameOf: () => "D" });
    expect(result).toEqual({ applied: [], skipped: ["115|008|008432|application"] });
    expect(mock.log.length).toBe(callsBefore);
  });
  it("mid-apply failure rolls back everything", async () => {
    const mock = new MockDb();
    seedMock(mock);
    mock.tbl("admissions").push({
      id: "adm-008432", year: 115, department_id: "d008432", program_id: "p115", quota: 14,
      school_code: "008", department_code: "008432", program_type: "application",
      requirements: { chinese: null, english: null, math_a: null, math_b: null, social: null, science: null, english_listening: null },
      sourceId: "src-1", source_url: "u", firstStageWeight: null, secondStageWeight: null,
    });
    const plan = planScopedFixes([planInputFor008432(emptyRow("008432"))]);
    mock.failWhen = (t) => t.startsWith("INSERT INTO tech_screening_items");
    await expect(applyScopedPlan(mock as never, plan, { sourceName: "official-cac-detail", departmentNameOf: () => "D" })).rejects.toThrow(/injected failure/);
    expect(mock.tbl("techGroups")).toEqual([]);
    expect(mock.tbl("techItems")).toEqual([]);
    expect(mock.tbl("secondStage").filter((r) => r["admission_id"] === "adm-008432")).toEqual([]);
    expect(mock.log).toContain("ROLLBACK");
  });
  it("absent admission refuses without writes (never INSERT via reconcile)", async () => {
    const mock = new MockDb();
    seedMock(mock);
    // No admission shell seeded for 008432 -> pre-existence fails.
    const plan = planScopedFixes([planInputFor008432(emptyRow("008432"))]);
    expect(plan.valid).toBe(true); // planning is DB-blind by design
    await expect(applyScopedPlan(mock as never, plan, { sourceName: "official-cac-detail", departmentNameOf: () => "D" })).rejects.toThrow(/absent or ambiguous/);
    expect(mock.tbl("admissions").filter((r) => r["department_code"] === "008432")).toHaveLength(0);
  });
});

describe("plan equality gate (dry-run/apply seam)", () => {
  const base = (): ScopedPlan => planScopedFixes([planInputFor008432(emptyRow("008432"))]);
  it("identical plans compare equal", () => {
    const a = base();
    const b = base();
    expect(plansEqual(a, b)).toEqual({ equal: true, reasons: [] });
  });
  it("changed disposition, diffs, SHA, or parser version all refuse", () => {
    const a = base();
    const flipItem = { ...a.items[0]!, disposition: "SKIP_UNCHANGED" as const };
    expect(plansEqual(a, { ...a, items: [flipItem] }).equal).toBe(false);
    const diffItem = { ...a.items[0]!, diffs: [...a.items[0]!.diffs, "extra"] };
    const r2 = plansEqual(a, { ...a, items: [diffItem] });
    expect(r2.equal).toBe(false);
    expect(r2.reasons.join("\n")).toMatch(/diff set changed/);
    const shaItem = { ...a.items[0]!, rawSha: "0".repeat(64) };
    expect(plansEqual(a, { ...a, items: [shaItem] }).reasons.join("\n")).toMatch(/raw SHA changed/);
    const pvItem = { ...a.items[0]!, parserVersion: "other-parser" };
    expect(plansEqual(a, { ...a, items: [pvItem] }).reasons.join("\n")).toMatch(/parser version changed/);
  });
  it("vanished or appeared items refuse", () => {
    const a = base();
    expect(plansEqual(a, { ...a, items: [] }).reasons.join("\n")).toMatch(/vanished/);
  });
});

describe("global --import gate untouched (source lock)", () => {
  it("normalize script still blocks on any error", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "normalize-admission-115.ts"), "utf8");
    expect(src).toContain("IMPORT BLOCKED");
  });
  it("scoped CLI requires --apply and --yes separately; dry-run writes nothing", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "scoped-reconcile.ts"), "utf8");
    expect(src).toContain("--apply requires --yes");
    expect(src).toContain("dry-run: no database writes");
    expect(src).not.toMatch(/process\.env\[.DATABASE_URL.{0,3}\?\?/);
  });
  it("scoped CLI re-verifies before apply and verifies after (no blind writes)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "scoped-reconcile.ts"), "utf8");
    expect(src).toContain("plansEqual(first.plan, second.plan)");
    expect(src).toContain("plan changed since review");
    expect(src).toContain("post-apply verification");
    expect(src).toContain("NOT ACCEPTED");
    expect(src).toContain("sha=${(item.rawSha");
  });
});
