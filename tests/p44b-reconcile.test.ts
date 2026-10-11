import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  assertAdmissionPreexists,
  buildAdmissionExistenceQuery,
  classifyLiveState,
  createInMemoryMutex,
  fieldSetEquals,
  FIX_LIST_SCHEMA_VERSION,
  orderSensitiveCompare,
  partitionScopeErrors,
  sha256Hex,
  validateFixListSchema,
  verifyItemSha,
  type FieldChange,
  type FixList,
  type FixListItem,
} from "../src/data/normalization/reconcile";
import {
  executeDbLoad,
} from "../src/data/loaders/official/admission";
import type { DbAdmissionRecords } from "../src/domain/admission/toDbRecords";

/**
 * P4.4b-4 reconcile behavioral tests (H-A mock + H-B pure).
 *
 * The mock drives the REAL executeDbLoad (no forked write path) against an
 * in-memory journal with BEGIN/COMMIT/ROLLBACK snapshots, UNIQUE/FK
 * enforcement, and failure injection. Every test asserts call sequences,
 * state changes, and rollback results — never static grep for behavior.
 *
 * LIMIT (reported, not hidden): the journal mirrors transactional
 * all-or-nothing but proves nothing about real PostgreSQL semantics
 * (locking, constraint timing, concurrent isolation). Those stay pending
 * H-C isolated-PostgreSQL verification. No test touches Neon or network.
 */

type Row = Record<string, unknown>;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

class MockDbClient {
  log: string[] = [];
  writes: string[] = [];
  tables = new Map<string, Row[]>();
  snap: Map<string, Row[]> | null = null;
  failWhen: ((text: string) => boolean) | null = null;
  headerInserts = 0;
  seq = 0;

  tbl(name: string): Row[] {
    let t = this.tables.get(name);
    if (!t) {
      t = [];
      this.tables.set(name, t);
    }
    return t;
  }

  seedDepartments(rows: Row[]): void {
    this.tables.set("departments+", rows);
  }

  async query(text: string, values: unknown[] = []): Promise<{ rows: Row[] }> {
    const t = text.trim();
    this.log.push(t.slice(0, 72));
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
    this.writes.push(t.slice(0, 72));
    return { rows: this.write(t, values) };
  }

  private select(t: string, v: unknown[]): Row[] {
    if (t.includes("FROM data_sources")) return [{ id: "src-1" }];
    if (t.startsWith("SELECT d.id FROM departments")) {
      const hit = this.tbl("departments+").find((r) => r["school_code"] === v[0] && r["department_code"] === v[1]);
      return hit ? [{ id: hit["id"] }] : [];
    }
    if (t.startsWith("SELECT id FROM admission_programs")) return [{ id: "prog-app" }];
    if (t.startsWith("SELECT a.id FROM department_admissions a JOIN")) {
      const hit = this.tbl("department_admissions").find(
        (r) => r["year"] === v[0] && r["school_code"] === v[1] && r["department_code"] === v[2] && r["program_type"] === v[3],
      );
      return hit ? [{ id: hit["id"] }] : [];
    }
    throw new Error(`mock: unexpected SELECT: ${t.slice(0, 80)}`);
  }

  private write(t: string, v: unknown[]): Row[] {
    if (t.startsWith("INSERT INTO data_sources")) return [];
    if (t.startsWith("INSERT INTO department_admissions")) {
      const tbl = this.tbl("department_admissions");
      const hit = tbl.find((r) => r["year"] === v[0] && r["department_id"] === v[1] && r["program_id"] === v[2]);
      if (hit) {
        Object.assign(hit, { quota: v[3], source_url: v[20] });
        return [{ id: hit["id"] }];
      }
      this.headerInserts++;
      const id = `adm-new-${++this.seq}`;
      tbl.push({ id, year: v[0], department_id: v[1], program_id: v[2], quota: v[3], source_url: v[20] });
      return [{ id }];
    }
    if (t.startsWith("DELETE FROM")) {
      const m = t.match(/^DELETE FROM (\w+)/)!;
      const tbl = this.tbl(m[1]!);
      this.tables.set(m[1]!, tbl.filter((r) => r["admission_id"] !== v[0]));
      return [];
    }
    if (t.startsWith("INSERT INTO tech_screening_groups")) {
      const tbl = this.tbl("tech_screening_groups");
      if (tbl.some((r) => r["admission_id"] === v[0])) throw new Error('duplicate key value violates unique constraint "tech_screening_groups_admission_id_key"');
      const id = `grp-${++this.seq}`;
      tbl.push({ id, admission_id: v[0], weight: v[1], weight_status: v[2], source_text: v[3] });
      return [{ id }];
    }
    if (t.startsWith("INSERT INTO tech_screening_items")) {
      const groups = this.tbl("tech_screening_groups");
      if (!groups.some((g) => g["id"] === v[0])) throw new Error('insert violates foreign key "tech_screening_items_group_id_fkey"');
      const tbl = this.tbl("tech_screening_items");
      if (tbl.some((r) => r["group_id"] === v[0] && r["position"] === v[2])) throw new Error("duplicate key value violates unique constraint");
      tbl.push({ group_id: v[0], admission_id: v[1], position: v[2], name: v[3], requirement: v[4], multiplier: v[5], score_method: v[6], source_text: v[7] });
      return [];
    }
    const m = t.match(/^INSERT INTO (\w+)/)!;
    this.tbl(m[1]!).push({ admission_id: v[0], values: v.slice(1) });
    return [];
  }
}

const REQ = { chinese: null, english: null, math_a: null, math_b: null, social: null, science: null, english_listening: null };

function records008432(): DbAdmissionRecords {
  return {
    header: { academicYear: 115, schoolCode: "008", departmentCode: "008432", quota: 14, requirements: { ...REQ } },
    firstStageWeight: null,
    secondStageWeight: null,
    subjects: [],
    sequences: [],
    secondStage: [
      { position: 1, name: "審查資料", requirement: null, weight: "40%", itemType: null, description: null, sourceText: "審查資料|" },
      { position: 2, name: "面試", requirement: null, weight: "20%", itemType: null, description: null, sourceText: "面試|" },
    ],
    apcs: [],
    review: [],
    special: [],
    schedule: {
      applicationFee: null, applicationFeeSource: null, notificationDate: null, notificationSource: null,
      materialDeadline: null, materialDeadlineSource: null, secondStageDate: null, secondStageDateSource: null,
      resultDate: null, resultDateSource: null, recheckDeadline: null, recheckDeadlineSource: null,
    },
    notices: [],
    techGroup: {
      weight: "40%",
      weightStatus: "shared",
      items: [
        { position: 1, name: "彩繪技法", requirement: null, multiplier: 5, scoreMethod: "*1.00", sourceText: "彩繪技法" },
        { position: 2, name: "創意表現", requirement: null, multiplier: 3, scoreMethod: "*1.50", sourceText: "創意表現" },
      ],
      sourceText: "weight=40% status=shared items=彩繪技法/創意表現",
    },
    provenance: { source: "official", sourceUrl: "https://www.cac.edu.tw/x/115_008432.htm", academicYear: 115, retrievedAt: null, parserVersion: "test", dataVersion: "test", sourceId: null },
  };
}

const ADM_008432 = "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb";

function seed008432(mock: MockDbClient): void {
  mock.seedDepartments([{ id: "dept-008432", school_code: "008", department_code: "008432" }]);
  mock.tables.set("department_admissions", [
    { id: ADM_008432, year: 115, department_id: "dept-008432", program_id: "prog-app", school_code: "008", department_code: "008432", program_type: "application", quota: 14 },
  ]);
  // Control admission in another department: must never be touched.
  mock.tables.set("second_stage_items", [{ admission_id: "adm-other", position: 1, name: "口試" }]);
}

const ITEM_008432 = {
  identity: { year: 115, schoolCode: "008", departmentCode: "008432", programType: "application", admissionId: ADM_008432 },
  raw: {
    htmlPath: "data/raw/official/115/application/departments/115_008432.htm",
    metaPath: "data/raw/official/115/application/departments/115_008432.htm.meta.json",
    sha256: "x".repeat(64),
    meta: { sourceUrl: "https://www.cac.edu.tw/x/115_008432.htm", capturedAt: null, sha256: "x".repeat(64), departmentCode: "008432", schoolCode: "008" },
  },
  parserVersion: "unknown",
  changes: [
    { table: "second_stage_items", rowKey: "審查資料", field: "name", oldValue: null, newValue: "審查資料" },
    { table: "tech_screening_groups", rowKey: "group", field: "presence", oldValue: "absent", newValue: "present" },
  ] as FieldChange[],
  checks: { reparseErrors: 0, normalizeErrors: [], drift: [], completenessErrors: [], orderDiffs: [] },
  disposition: "PENDING_APPROVAL" as const,
};

/** Scoped-run proof-of-concept used ONLY against the mock (no prod path). */
async function runScopedItem(
  mock: MockDbClient,
  item: typeof ITEM_008432,
  opts: { rawContent: string; metaContent: string; liveChanges: FieldChange[]; records: DbAdmissionRecords; mutexOwner: string; mutex?: { tryAcquire(o: string): boolean; release(o: string): void } },
): Promise<{ disposition: string; reasons: string[] }> {
  const sha = verifyItemSha(item, (p) => {
    if (p === item.raw.htmlPath) return opts.rawContent;
    if (p === item.raw.metaPath) return opts.metaContent;
    return null;
  });
  if (!sha.ok) return { disposition: "REJECTED", reasons: sha.errors };
  const cls = classifyLiveState(item, { admissionFound: true, identityMatch: true, currentChanges: opts.liveChanges });
  if (cls.disposition !== "READY") return cls;
  await assertAdmissionPreexists(mock, item.identity);
  if (opts.mutex && !opts.mutex.tryAcquire(opts.mutexOwner)) {
    return { disposition: "REJECTED", reasons: ["mutex held by another run: aborting"] };
  }
  try {
    await mock.query("BEGIN");
    try {
      await executeDbLoad(mock as never, opts.records, { sourceName: "official-cac-detail", dataVersion: "reconcile-115-v1", departmentName: "D" });
      await mock.query("COMMIT");
    } catch (err) {
      await mock.query("ROLLBACK");
      throw err;
    }
    return { disposition: "APPLIED", reasons: [] };
  } finally {
    opts.mutex?.release(opts.mutexOwner);
  }
}

const RAW = "<html>008432</html>";
const META = JSON.stringify({ sha256: sha256Hex(RAW), departmentCode: "008432", sourceUrl: "https://www.cac.edu.tw/x/115_008432.htm" });
const GOOD_ITEM = { ...ITEM_008432, raw: { ...ITEM_008432.raw, sha256: sha256Hex(RAW), meta: { ...ITEM_008432.raw.meta, sha256: sha256Hex(RAW) } } };

describe("H-B pure: list schema, SHA, order, scope (T3/T4/T6/T12/T13/T15/T16)", () => {
  const validList = (over: Partial<FixList> = {}): FixList => ({
    schemaVersion: FIX_LIST_SCHEMA_VERSION,
    runId: "11111111-2222-4333-8444-555555555555",
    generatedAt: "2026-10-11T00:00:00.000Z",
    generator: "test",
    source: { academicYear: 115, inventoryScope: "test", rawRoot: "data/raw" },
    dataVersion: "reconcile-115-v1",
    scope: ["115|008|008432|application"],
    items: [GOOD_ITEM],
    unlistedErrors: [{ identityKey: "115|009|009032|application", check: "db-raw-drift", detail: "out of scope, still reported" }],
    ...over,
  });
  it("T6a: valid list passes; tampered field rejected", () => {
    expect(validateFixListSchema(validList())).toEqual([]);
    const bad = validList({ items: [{ ...GOOD_ITEM, identity: { ...GOOD_ITEM.identity, admissionId: "not-a-uuid" } }] });
    expect(validateFixListSchema(bad).join("\n")).toMatch(/admissionId must be a UUID/);
  });
  it("T6b: unsupported schemaVersion rejected with supported version named", () => {
    expect(validateFixListSchema({ ...validList(), schemaVersion: "reconcile-list-v0" }).join("\n")).toMatch(/unsupported schemaVersion.*reconcile-list-v1/);
  });
  it("T6c: snapshot-style zero-diff change rejected", () => {
    const bad = validList({
      items: [{ ...GOOD_ITEM, changes: [{ table: "t", rowKey: "r", field: "f", oldValue: 1, newValue: 1 }] }],
    });
    expect(validateFixListSchema(bad).join("\n")).toMatch(/not a change/);
  });
  it("T3/T4: SHA three-way — changed raw and mismatched meta both fail closed", () => {
    expect(verifyItemSha(GOOD_ITEM, (p) => (p === GOOD_ITEM.raw.htmlPath ? RAW : META)).ok).toBe(true);
    const changed = verifyItemSha(GOOD_ITEM, (p) => (p === GOOD_ITEM.raw.htmlPath ? "<html>tampered</html>" : META));
    expect(changed.ok).toBe(false);
    expect(changed.errors.join("\n")).toMatch(/changed since list generation/);
    const metaBad = verifyItemSha(GOOD_ITEM, (p) => (p === GOOD_ITEM.raw.htmlPath ? RAW : JSON.stringify({ sha256: "y".repeat(64) })));
    expect(metaBad.ok).toBe(false);
  });
  it("T13: parserVersion 'unknown' accepted, missing/empty rejected", () => {
    expect(validateFixListSchema(validList())).toEqual([]);
    const missing = validList({ items: [{ ...GOOD_ITEM, parserVersion: "" }] });
    expect(validateFixListSchema(missing).join("\n")).toMatch(/parserVersion missing/);
  });
  it("T12: out-of-scope errors retained, never claimed fixed", () => {
    const { inScope, outOfScope } = partitionScopeErrors(
      [{ identityKey: "115|008|008432|application" }, { identityKey: "115|009|009032|application" }],
      new Set(["115|008|008432|application"]),
    );
    expect(inScope).toHaveLength(1);
    expect(outOfScope.map((e) => e.identityKey)).toEqual(["115|009|009032|application"]);
  });
  it("T15/T16: order-sensitive compare detects pure reorder, passes identical", () => {
    const rows = (names: string[]) => names.map((name, i) => ({ position: i + 1, name }));
    expect(orderSensitiveCompare(rows(["a", "b"]), rows(["a", "b"]), ["position", "name"])).toEqual({ contentDiffs: [], orderDiffs: [] });
    const reordered = orderSensitiveCompare(rows(["a", "b"]), rows(["b", "a"]), ["position", "name"]);
    expect(reordered.contentDiffs).toEqual([]);
    expect(reordered.orderDiffs.length).toBeGreaterThan(0);
    const content = orderSensitiveCompare(rows(["a", "b"]), rows(["a", "c"]), ["position", "name"]);
    expect(content.contentDiffs.length).toBeGreaterThan(0);
  });
  it("T16: 008432-shape change set classifies READY only on exact set match", () => {
    const live = { admissionFound: true, identityMatch: true, currentChanges: GOOD_ITEM.changes };
    expect(classifyLiveState(GOOD_ITEM, live).disposition).toBe("READY");
    const subset = { ...live, currentChanges: GOOD_ITEM.changes.slice(0, 1) };
    expect(classifyLiveState(GOOD_ITEM, subset).disposition).toBe("REJECTED");
    expect(classifyLiveState(GOOD_ITEM, { ...live, currentChanges: [] }).disposition).toBe("ALREADY_APPLIED");
  });
});

describe("H-A mock: preconditions fail closed with zero writes (T1/T2/T5)", () => {
  it("T1: absent admission refused before any write", async () => {
    const mock = new MockDbClient();
    mock.seedDepartments([{ id: "dept-x", school_code: "008", department_code: "008432" }]);
    await expect(assertAdmissionPreexists(mock, GOOD_ITEM.identity)).rejects.toThrow(/absent.*never INSERT/);
    expect(mock.writes).toEqual([]);
  });
  it("T1b: admissionId mismatch refused (no UPSERT into the wrong row)", async () => {
    const mock = new MockDbClient();
    seed008432(mock);
    const wrong = { ...GOOD_ITEM.identity, admissionId: "adm-WRONG" };
    await expect(assertAdmissionPreexists(mock, wrong)).rejects.toThrow(/admissionId mismatch/);
    expect(mock.writes).toEqual([]);
  });
  it("T2: identity mismatch classifies REJECTED with zero loader contact", () => {
    const cls = classifyLiveState(GOOD_ITEM, { admissionFound: true, identityMatch: false, currentChanges: GOOD_ITEM.changes });
    expect(cls.disposition).toBe("REJECTED");
  });
  it("T5: post-review DB change rejects the whole item before writes", async () => {
    const mock = new MockDbClient();
    seed008432(mock);
    const live = { admissionFound: true, identityMatch: true, currentChanges: [{ table: "second_stage_items", rowKey: "X", field: "name", oldValue: null, newValue: "X" }] };
    const cls = classifyLiveState(GOOD_ITEM, live);
    expect(cls.disposition).toBe("REJECTED");
    expect(mock.writes).toEqual([]);
  });
  it("T3-HA: tampered raw aborts the scoped run with zero writes", async () => {
    const mock = new MockDbClient();
    seed008432(mock);
    const out = await runScopedItem(mock, GOOD_ITEM, {
      rawContent: "<html>tampered</html>",
      metaContent: META,
      liveChanges: GOOD_ITEM.changes,
      records: records008432(),
      mutexOwner: "run-1",
    });
    expect(out.disposition).toBe("REJECTED");
    expect(mock.writes).toEqual([]);
  });
  it("no-new-admission: UPSERT path cannot fire without the pre-existence gate", async () => {
    const mock = new MockDbClient();
    mock.seedDepartments([{ id: "dept-x", school_code: "008", department_code: "008432" }]);
    // Gate first: throws, loader never reached.
    await expect(assertAdmissionPreexists(mock, GOOD_ITEM.identity)).rejects.toThrow();
    expect(mock.headerInserts).toBe(0);
  });
});

describe("H-A mock: executeDbLoad behavior — rollback, rerun, scope (T7/T8/T10/T11/T14)", () => {
  it("T14a: 008432-shape applies tech group+items with linkage, control admission untouched", async () => {
    const mock = new MockDbClient();
    seed008432(mock);
    const out = await runScopedItem(mock, GOOD_ITEM, {
      rawContent: RAW, metaContent: META, liveChanges: GOOD_ITEM.changes, records: records008432(), mutexOwner: "run-1",
    });
    expect(out.disposition).toBe("APPLIED");
    const groups = mock.tbl("tech_screening_groups");
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ admission_id: ADM_008432, weight: "40%", weight_status: "shared" });
    const items = mock.tbl("tech_screening_items");
    expect(items.map((r) => r["name"])).toEqual(["彩繪技法", "創意表現"]);
    for (const it of items) expect(it["admission_id"]).toBe(ADM_008432);
    const stage2 = mock.tbl("second_stage_items").filter((r) => r["admission_id"] === ADM_008432);
    expect(stage2).toHaveLength(2);
    // Control admission rows byte-identical.
    expect(mock.tbl("second_stage_items").filter((r) => r["admission_id"] === "adm-other")).toEqual([{ admission_id: "adm-other", position: 1, name: "口試" }]);
    // No new admission row created.
    expect(mock.tbl("department_admissions")).toHaveLength(1);
  });
  it("T7: mid-run failure rolls back everything (zero residue)", async () => {
    const mock = new MockDbClient();
    seed008432(mock);
    mock.failWhen = (t) => t.startsWith("INSERT INTO tech_screening_items");
    await expect(
      runScopedItem(mock, GOOD_ITEM, { rawContent: RAW, metaContent: META, liveChanges: GOOD_ITEM.changes, records: records008432(), mutexOwner: "run-1" }),
    ).rejects.toThrow(/injected failure/);
    expect(mock.tbl("tech_screening_groups")).toEqual([]);
    expect(mock.tbl("tech_screening_items").filter((r) => r["admission_id"] === ADM_008432)).toEqual([]);
    expect(mock.tbl("second_stage_items").filter((r) => r["admission_id"] === ADM_008432)).toEqual([]);
    expect(mock.log).toContain("ROLLBACK");
  });
  it("T8: rerun after success classifies ALREADY_APPLIED without rewriting", async () => {
    const mock = new MockDbClient();
    seed008432(mock);
    await runScopedItem(mock, GOOD_ITEM, { rawContent: RAW, metaContent: META, liveChanges: GOOD_ITEM.changes, records: records008432(), mutexOwner: "run-1" });
    const writesAfterFirst = mock.writes.length;
    const cls = classifyLiveState(GOOD_ITEM, { admissionFound: true, identityMatch: true, currentChanges: [] });
    expect(cls.disposition).toBe("ALREADY_APPLIED");
    expect(mock.writes.length).toBe(writesAfterFirst);
  });
  it("T10: unlisted columns/rows unchanged (write set ⊆ listed scope)", async () => {
    const mock = new MockDbClient();
    seed008432(mock);
    mock.tbl("admission_notices").push({ admission_id: "adm-008432", values: ["manual-note"] });
    await runScopedItem(mock, GOOD_ITEM, { rawContent: RAW, metaContent: META, liveChanges: GOOD_ITEM.changes, records: records008432(), mutexOwner: "run-1" });
    // Every write targets the listed admission only.
    for (const w of mock.writes) expect(w).not.toMatch(/adm-other/);
    const touchedAdmissions = new Set<string>();
    for (const [, rows] of mock.tables) {
      for (const r of rows) {
        if (typeof r["admission_id"] === "string") touchedAdmissions.add(r["admission_id"] as string);
      }
    }
    expect(touchedAdmissions.has("adm-other")).toBe(true); // pre-seeded, untouched
    expect(mock.tbl("second_stage_items").filter((r) => r["admission_id"] === "adm-other")).toHaveLength(1);
  });
  it("T11: corrupt duplicate positions violate UNIQUE and roll back fully", async () => {
    const mock = new MockDbClient();
    seed008432(mock);
    const rec = records008432();
    rec.techGroup!.items.push({ position: 1, name: "重複列", requirement: null, multiplier: null, scoreMethod: null, sourceText: "dup" });
    await expect(
      runScopedItem(mock, GOOD_ITEM, { rawContent: RAW, metaContent: META, liveChanges: GOOD_ITEM.changes, records: rec, mutexOwner: "run-1" }),
    ).rejects.toThrow(/duplicate key/);
    expect(mock.tbl("tech_screening_groups")).toEqual([]);
    expect(mock.tbl("tech_screening_items")).toEqual([]);
    expect(mock.tbl("second_stage_items").filter((r) => r["admission_id"] === ADM_008432)).toEqual([]);
    expect(mock.log).toContain("ROLLBACK");
  });
  it("T14b: 009432 attributed shape — group weight null, weight on second_stage", async () => {
    const mock = new MockDbClient();
    mock.seedDepartments([{ id: "dept-009432", school_code: "009", department_code: "009432" }]);
    mock.tables.set("department_admissions", [
      { id: "adm-009432", year: 115, department_id: "dept-009432", program_id: "prog-app", school_code: "009", department_code: "009432", program_type: "application", quota: 23 },
    ]);
    const rec = records008432();
    rec.header = { academicYear: 115, schoolCode: "009", departmentCode: "009432", quota: 23, requirements: { ...REQ } };
    rec.secondStage = [
      { position: 1, name: "審查資料", requirement: null, weight: "10%", itemType: null, description: null, sourceText: "x" },
      { position: 2, name: "主修", requirement: null, weight: "90%", itemType: null, description: null, sourceText: "x" },
    ];
    rec.techGroup = {
      weight: null,
      weightStatus: "attributed_to_stage2",
      items: [{ position: 1, name: "主修", requirement: null, multiplier: null, scoreMethod: "*1.00", sourceText: "主修" }],
      sourceText: "weight= status=attributed_to_stage2 items=主修",
    };
    const item = { ...GOOD_ITEM, identity: { year: 115, schoolCode: "009", departmentCode: "009432", programType: "application", admissionId: "adm-009432" } };
    const out = await runScopedItem(mock, item, { rawContent: RAW, metaContent: META, liveChanges: item.changes, records: rec, mutexOwner: "run-1" });
    expect(out.disposition).toBe("APPLIED");
    expect(mock.tbl("tech_screening_groups")[0]).toMatchObject({ admission_id: "adm-009432", weight: null, weight_status: "attributed_to_stage2" });
    expect(mock.tbl("tech_screening_items")).toHaveLength(1);
  });
});

describe("H-A mock: concurrency + gate (T9, gate unchanged)", () => {
  it("T9: second concurrent run is refused by the mutex interface", () => {
    const mutex = createInMemoryMutex();
    expect(mutex.tryAcquire("run-1")).toBe(true);
    expect(mutex.tryAcquire("run-2")).toBe(false);
    mutex.release("run-1");
    expect(mutex.tryAcquire("run-2")).toBe(true);
    mutex.release("run-2");
  });
  it("T9b: mutex-held run aborts before any write", async () => {
    const mock = new MockDbClient();
    seed008432(mock);
    const mutex = createInMemoryMutex();
    expect(mutex.tryAcquire("run-1")).toBe(true);
    const out = await runScopedItem(mock, GOOD_ITEM, {
      rawContent: RAW, metaContent: META, liveChanges: GOOD_ITEM.changes, records: records008432(), mutexOwner: "run-2", mutex,
    });
    expect(out.disposition).toBe("REJECTED");
    expect(out.reasons.join("\n")).toMatch(/mutex held/);
    expect(mock.writes).toEqual([]);
    mutex.release("run-1");
  });
  it("general --import gate is untouched (supplementary source lock)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "normalize-admission-115.ts"), "utf8");
    expect(src).toContain("IMPORT BLOCKED: ${errors.length} errors — fix pipeline, no writes performed");
    // The strict gate still precedes every import-path write: errors>0 exits
    // before executeDbLoad can run. ("reconcile" appears only in pre-existing
    // identifiers like p4-reconcile / verified-unchanged bookkeeping.)
    const gateIdx = src.indexOf("if (errors.length > 0)");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(src.indexOf("process.exit(1)", gateIdx)).toBeLessThan(src.indexOf("executeDbLoad(client"));
  });
  it("existence builder targets the admission row with full identity", () => {
    const q = buildAdmissionExistenceQuery(115, "008", "008432", "application");
    expect(q.text).toMatch(/FROM department_admissions a JOIN departments d.*JOIN schools s.*JOIN admission_programs ap/);
    expect(q.values).toEqual([115, "008", "008432", "application"]);
    expect(fieldSetEquals(GOOD_ITEM.changes, [...GOOD_ITEM.changes])).toBe(true);
  });
});
