import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseDetailHtml } from "../src/data/importers/official/application115/detail/parser";
import {
  auditCanonicalCompleteness,
  canonicalToLegacyP3Input,
  fromDetailRecord,
  rocToIsoDate,
  toDbRecords,
} from "../src/domain/admission";
import {
  buildChildDelete,
  buildChildInserts,
  buildHeaderUpsert,
  ensureSourceStatements,
  isLoadableDetail,
  lookupStatements,
  recordKey,
} from "../src/data/loaders/official/admission";

const FIX = path.join(__dirname, "fixtures", "official", "application115", "detail");
const read = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8");
const parse = (f: string, code: string) =>
  parseDetailHtml(read(f), {
    sourceUrl: `https://www.cac.edu.tw/mobile_apply115/colqRy_Apply_8Rfsd57q/html/115_${code}.htm`,
    dataVersion: "fixture-manual",
  }).record!;
const canon = (f: string, code: string) => fromDetailRecord(parse(f, code)).canonical;

describe("ROC date conversion", () => {
  it("converts 001012 five dates", () => {
    expect(rocToIsoDate("115.5.6")).toEqual({ date: "2026-05-06", sourceText: "115.5.6" });
    expect(rocToIsoDate("115.3.31")).toEqual({ date: "2026-03-31", sourceText: "115.3.31" });
    expect(rocToIsoDate("115.5.15").date).toBe("2026-05-15");
    expect(rocToIsoDate("115.6.1").date).toBe("2026-06-01");
    expect(rocToIsoDate("115.5.27").date).toBe("2026-05-27");
  });
  it("rejects garbage without guessing", () => {
    for (const bad of ["", "  ", "115/5/6", "115.13.1", "115.2.30", "soon", null]) {
      expect(rocToIsoDate(bad).date).toBeNull();
    }
    expect(rocToIsoDate("115.2.30").sourceText).toBe("115.2.30");
  });
});

describe("001012 canonical preservation", () => {
  const c = canon("115_001012.htm", "001012");
  it("identity + quota", () => {
    expect(c.identity).toMatchObject({ academicYear: 115, schoolCode: "001", departmentCode: "001012", quota: 23, expectedInterviewCount: 69 });
    expect(c.identity.departmentName).toBe("中國文學系");
  });
  it("subject rules with multipliers intact", () => {
    const bySubj = new Map(c.firstStage.subjectRules.map((s) => [s.subject, s]));
    expect(bySubj.get("國文")).toMatchObject({ requirement: "前標", multiplier: 3, scoreMethod: "*1.50", status: "active" });
    expect(bySubj.get("英文")).toMatchObject({ requirement: "均標", multiplier: 6 });
    expect(bySubj.get("社會")).toMatchObject({ requirement: "均標", multiplier: 8 });
    expect(c.firstStage.subjectRules).toHaveLength(5);
    expect(c.firstStage.overallWeight).toBe("40%");
    for (const s of c.firstStage.subjectRules) expect(s.sourceText.length).toBeGreaterThan(0);
  });
  it("second stage keeps scoreless items, weight separate", () => {
    expect(c.secondStage.items).toHaveLength(3);
    expect(c.secondStage.items[0]).toMatchObject({ name: "審查資料", requirement: "70分", weight: "25%" });
    expect(c.secondStage.items[1]).toMatchObject({ name: "語文測驗筆試", requirement: null, weight: "20%" });
    expect(c.secondStage.items[2]).toMatchObject({ name: "寫作筆試", requirement: null, weight: "15%" });
    expect(c.secondStage.overallWeight).toBeNull();
  });
  it("tie-break order + offshore + fee + schedule + notices", () => {
    const tie = c.firstStage.sequences.filter((s) => s.kind === "tie_break");
    expect(tie.map((t) => t.description)).toHaveLength(3);
    expect(tie[0]!.description).toContain("學科能力測驗成績");
    const over = c.firstStage.sequences.filter((s) => s.kind === "over_quota");
    expect(over).toHaveLength(3);
    expect(c.specialRequirements.find((s) => s.kind === "offshore_restriction")?.value).toBe("1名限連江縣");
    expect(c.schedule.applicationFee).toBe(1500);
    expect(c.schedule.materialDeadline).toEqual({ date: "2026-05-06", sourceText: "115.5.6" });
    expect(c.schedule.secondStageDate.date).toBe("2026-05-15");
    expect(c.notices).toHaveLength(4);
  });
  it("review text preserved with J/K restrictions and O/P/Q limits", () => {
    expect(c.reviewRequirements).toHaveLength(1);
    const src = c.reviewRequirements[0]!.sourceText;
    for (const code of ["A", "B", "C", "F", "J", "K", "N", "O", "P", "Q"]) expect(src).toContain(code);
    expect(src).toContain("得獎證明");
    expect(src).toContain("600字以內");
    expect(c.reviewRequirements[0]!.categoryCode).toBeNull();
  });
  it("provenance intact", () => {
    expect(c.provenance).toMatchObject({ source: "official", academicYear: 115, parserVersion: "official-detail-parser-v0.1.0" });
    expect(c.provenance.sourceUrl).toContain("115_001012.htm");
  });
});

describe("001022 canonical preservation", () => {
  const c = canon("115_001022.htm", "001022");
  it("6 subjects incl. listening A, weight, stage2, tie-break", () => {
    expect(c.identity.quota).toBe(43);
    expect(c.firstStage.subjectRules).toHaveLength(6);
    expect(c.firstStage.subjectRules.find((s) => s.subject === "英聽")).toMatchObject({ requirement: "A級" });
    expect(c.firstStage.overallWeight).toBe("20%");
    expect(c.secondStage.items.map((s) => s.name)).toEqual(["審查資料", "英文作文筆試", "英語口試測驗"]);
    expect(c.firstStage.sequences.filter((s) => s.kind === "over_quota")).toHaveLength(4);
    expect(c.firstStage.sequences.filter((s) => s.kind === "tie_break").map((t) => t.description)).toContain("四、英語口試測驗");
  });
  it("listening mirror matches 英聽 rule", () => {
    expect(c.specialRequirements.find((s) => s.kind === "english_listening")?.value).toBe("A級");
  });
});

describe("001592 APCS canonical preservation", () => {
  const c = canon("115_001592.htm", "001592");
  it("apcs rows + note, 3 subjects", () => {
    expect(c.firstStage.subjectRules.map((s) => s.subject)).toEqual(["英文", "數學A", "自然"]);
    expect(c.apcs).toHaveLength(2);
    expect(c.apcs![1]).toMatchObject({ subject: "程式設計實作題", requirement: "4級", multiplier: 5 });
    expect(c.apcsNote).toContain("APCS");
  });
});

describe("data-loss guard", () => {
  for (const [f, code] of [["115_001012.htm", "001012"], ["115_001022.htm", "001022"], ["115_001592.htm", "001592"]] as const) {
    it(`${code}: no silent loss (errors=0)`, () => {
      const record = parse(f, code);
      const { canonical } = fromDetailRecord(record);
      const errs = auditCanonicalCompleteness(record, canonical).filter((i) => i.level === "error");
      expect(errs).toEqual([]);
    });
  }
  it("interview gap stays a visible warning, not a silent drop", () => {
    const record = parse("115_001012.htm", "001012");
    const { canonical } = fromDetailRecord(record);
    const warns = auditCanonicalCompleteness(record, canonical).filter((i) => i.level === "warning");
    expect(warns.some((w) => w.check === "interview")).toBe(true);
  });
  it("field inventory fails loudly on unknown DetailRecord fields", () => {
    const record = { ...parse("115_001012.htm", "001012"), futureField: 1 } as never;
    const { canonical } = fromDetailRecord(parse("115_001012.htm", "001012"));
    const errs = auditCanonicalCompleteness(record, canonical).filter((i) => i.level === "error");
    expect(errs.some((e) => e.check === "inventory")).toBe(true);
  });
});

describe("legacy adapter direction", () => {
  it("canonical -> quota-only P3Input, carrying no subject detail", () => {
    const legacy = canonicalToLegacyP3Input(canon("115_001012.htm", "001012"));
    expect(legacy).toMatchObject({ schoolCode: "001", departmentCode: "001012", quota: 23, admitted: null });
    expect("subjectRequirements" in legacy).toBe(false);
    expect("secondStageItems" in legacy).toBe(false);
  });
});

describe("toDbRecords", () => {
  const db = toDbRecords(canon("115_001012.htm", "001012"));
  it("header keeps legacy requirement columns incl. listening", () => {
    expect(db.header.requirements).toMatchObject({ chinese: "前標", english: "均標", social: "均標", english_listening: null });
    expect(db.header.quota).toBe(23);
  });
  it("all child sets populated, provenance passed through", () => {
    expect(db.subjects).toHaveLength(5);
    expect(db.sequences).toHaveLength(6);
    expect(db.secondStage).toHaveLength(3);
    expect(db.apcs).toHaveLength(0);
    expect(db.review).toHaveLength(1);
    expect(db.special.find((s) => s.kind === "offshore_restriction")?.value).toBe("1名限連江縣");
    expect(db.schedule.resultDate).toBe("2026-06-01");
    expect(db.notices).toHaveLength(4);
    expect(db.provenance.sourceUrl).toContain("115_001012.htm");
  });
});

describe("loader statement builders (pure, no DB)", () => {
  const db = toDbRecords(canon("115_001022.htm", "001022"));
  const lookups = { departmentId: "d1", programId: "p1", sourceId: "s1" };
  it("lookups resolve FKs by codes", () => {
    const stmts = lookupStatements(db);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.text).toContain("schools");
    expect(stmts[0]!.values).toEqual(["001", "001022"]);
  });
  it("source ensure is idempotent upsert + select", () => {
    const stmts = ensureSourceStatements("official-cac-detail", "v1");
    expect(stmts[0]!.text).toContain("ON CONFLICT (source_name, data_version) DO NOTHING");
    expect(stmts).toHaveLength(2);
  });
  it("header upsert conflicts on identity, returns id, keeps ratios null", () => {
    const s = buildHeaderUpsert(db, lookups);
    expect(s.text).toContain("ON CONFLICT (year, department_id, program_id) DO UPDATE");
    expect(s.text).toContain("RETURNING id");
    expect(s.values).toHaveLength(19);
    expect(s.values.slice(11, 17)).toEqual([null, null, null, null, null, null]);
    expect(s.values[3]).toBe(43);
  });
  it("children delete covers all 8 tables; inserts match record counts", () => {
    const dels = buildChildDelete("a1");
    expect(dels).toHaveLength(8);
    expect(dels.map((d) => d.text)).toContain("DELETE FROM admission_schedule WHERE admission_id = $1");
    const ins = buildChildInserts("a1", db);
    const expected = db.subjects.length + db.sequences.length + db.secondStage.length + db.apcs.length + db.review.length + db.special.length + 1 + db.notices.length;
    expect(ins).toHaveLength(expected);
    expect(ins.every((s) => s.values[0] === "a1")).toBe(true);
  });
  it("plan is deterministic (idempotent)", () => {
    const again = toDbRecords(canon("115_001022.htm", "001022"));
    expect(JSON.stringify(buildChildInserts("a1", again))).toBe(JSON.stringify(buildChildInserts("a1", db)));
    expect(recordKey(db)).toBe("115|001|001022");
  });
  it("isLoadableDetail rejects junk, accepts real detail", () => {
    expect(isLoadableDetail(null)).toBe(false);
    expect(isLoadableDetail({})).toBe(false);
    expect(isLoadableDetail({ academicYear: 115, schoolCode: "", departmentCode: "001022" })).toBe(false);
  });
});

describe("003 migration (static, offline)", () => {
  const dir = path.join(__dirname, "..", "db", "migrations");
  const sql003 = fs.readFileSync(path.join(dir, "003_admission_detail.sql"), "utf8");
  const tables = [
    "screening_subject_rules",
    "screening_sequences",
    "second_stage_items",
    "apcs_requirements",
    "review_requirements",
    "special_requirements",
    "admission_schedule",
    "admission_notices",
  ];
  it("creates 8 detail tables, re-runnable, FK-chained to department_admissions", () => {
    for (const t of tables) {
      expect(sql003).toContain(`CREATE TABLE IF NOT EXISTS ${t} (`);
      const block = sql003.slice(sql003.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`));
      expect(block.slice(0, 2500)).toContain("REFERENCES department_admissions (id)");
    }
  });
  it("non-destructive: no drops, 001/002 untouched", () => {
    expect(sql003).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    const sql001 = fs.readFileSync(path.join(dir, "001_initial_schema.sql"), "utf8");
    const sql002 = fs.readFileSync(path.join(dir, "002_student_preferences.sql"), "utf8");
    for (const t of tables) {
      expect(sql001).not.toContain(t);
      expect(sql002).not.toContain(t);
    }
    // backward compat: legacy ratio columns stay in 001 (deprecated-in-practice, not dropped)
    expect(sql001).toContain("screening_ratio_1");
  });
});
