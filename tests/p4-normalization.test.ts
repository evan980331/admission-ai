import { describe, expect, it } from "vitest";
import {
  P4_EXPECTED_COUNTS,
  P4_OFFICIAL_SCHOOL_CODES,
  corroborateTechRow,
  diffDbRecords,
  findDroppedGsatCells,
  identityKey,
  normalizeBatch,
  normalizeDbAdmission,
  p4ExpectedTotal,
  summarizeCorroboration,
  type DbSourcedAdmission,
  type TechCorroboration,
} from "../src/data/normalization/admission115";
import type { DbAdmissionRecords } from "../src/domain/admission/toDbRecords";

function validRow(over: Partial<DbSourcedAdmission> = {}): DbSourcedAdmission {
  return {
    year: 115,
    schoolCode: "003",
    schoolName: "國立中興大學",
    departmentCode: "003112",
    departmentName: "應用經濟學系",
    groupName: null,
    programType: "application",
    quota: 18,
    requirements: { chinese: "前標", english: "前標", math_a: null, math_b: "均標", social: null, science: null, english_listening: null },
    sourceUrl: "https://www.cac.edu.tw/apply115/system/X/html/115_003112.htm",
    firstStageWeight: null,
    secondStageWeight: "100%",
    sourceName: "official-cac-detail",
    dataVersion: "acquire-runner",
    children: {
      subjects: [
        { position: 1, subject: "國文", requirement: "前標", multiplier: 1, scoreMethod: null, status: "active", sourceText: "前標" },
      ],
      sequences: [
        { kind: "over_quota", position: 1, subjects: null, description: "國英數B", sourceText: "國英數B" },
      ],
      secondStage: [
        { position: 1, name: "審查資料", requirement: null, weight: "50%", itemType: null, description: null, sourceText: "審查資料" },
      ],
      apcs: [],
      review: [
        { position: 1, categoryCode: null, categoryName: "修課紀錄", required: "必備", minimumCount: null, maximumCount: null, description: null, restriction: null, sourceText: "修課紀錄" },
      ],
      special: [
        { kind: "gender_restriction", value: null, sourceText: "無" },
      ],
      schedule: { applicationFee: 800, applicationFeeSource: "800", notificationDate: "2026-03-31", notificationSource: "3/31", materialDeadline: null, materialDeadlineSource: null, secondStageDate: null, secondStageDateSource: null, resultDate: null, resultDateSource: null, recheckDeadline: null, recheckDeadlineSource: null },
      notices: [
        { position: 1, type: "other", text: "備註", sourceText: "備註" },
      ],
      techGroup: null,
      techItems: [],
    },
    ...over,
  };
}

function techRow(): DbSourcedAdmission {
  const row = validRow({ schoolCode: "008", schoolName: "中原大學", departmentCode: "008432", departmentName: "商業設計學系產品設計組甲類", sourceUrl: "https://www.cac.edu.tw/apply115/system/X/html/115_008432.htm" });
  row.children.subjects = [];
  row.children.techGroup = { weight: "40%", weightStatus: "shared", sourceText: "weight=40% status=shared items=彩繪技法/創意表現", admissionId: "a1" };
  row.children.techItems = [
    { position: 1, name: "彩繪技法", requirement: null, multiplier: 5, scoreMethod: "*1.00", sourceText: "彩繪技法|--|5|*1.00", groupAdmission: "a1", itemAdmission: "a1" },
    { position: 2, name: "創意表現", requirement: null, multiplier: 3, scoreMethod: "*1.50", sourceText: "創意表現|--|3|*1.50", groupAdmission: "a1", itemAdmission: "a1" },
  ];
  return row;
}

describe("P4 normalizeDbAdmission", () => {
  it("1. normal admission normalizes with identity key + counts", () => {
    const { normalized, issues } = normalizeDbAdmission(validRow());
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(normalized?.identityKey).toBe("115|003|003112|application");
    expect(normalized?.quota).toBe(18);
    expect(normalized?.childCounts.subjects).toBe(1);
    expect(normalized?.childCounts.schedule).toBe(1);
  });
  it("2. quota: null/negative/non-integer error; zero ok", () => {
    expect(normalizeDbAdmission(validRow({ quota: null })).issues.some((i) => i.check === "quota" && i.level === "error")).toBe(true);
    expect(normalizeDbAdmission(validRow({ quota: -1 })).issues.some((i) => i.check === "quota")).toBe(true);
    expect(normalizeDbAdmission(validRow({ quota: 1.5 })).issues.some((i) => i.check === "quota")).toBe(true);
    expect(normalizeDbAdmission(validRow({ quota: 0 })).normalized?.quota).toBe(0);
  });
  it("3. department code: bad format + school mismatch error", () => {
    expect(normalizeDbAdmission(validRow({ departmentCode: "3112" })).issues.some((i) => i.check === "department-code")).toBe(true);
    expect(normalizeDbAdmission(validRow({ departmentCode: "001012" })).issues.some((i) => i.check === "code-mismatch")).toBe(true);
  });
  it("4. school code: bad format error", () => {
    expect(normalizeDbAdmission(validRow({ schoolCode: "03" })).issues.some((i) => i.check === "school-code")).toBe(true);
  });
  it("5. year: non-115 error", () => {
    expect(normalizeDbAdmission(validRow({ year: 114 })).issues.some((i) => i.check === "year")).toBe(true);
  });
  it("6. source_url + provenance retained", () => {
    const { normalized } = normalizeDbAdmission(validRow());
    expect(normalized?.provenance.sourceUrl).toBe("https://www.cac.edu.tw/apply115/system/X/html/115_003112.htm");
    expect(normalized?.provenance.sourceName).toBe("official-cac-detail");
    expect(normalizeDbAdmission(validRow({ sourceUrl: null })).issues.some((i) => i.check === "source-url")).toBe(true);
  });
  it("7. optional children: apcs/tie-break absent is warning-only", () => {
    const { normalized, issues } = normalizeDbAdmission(validRow());
    expect(normalized).not.toBeNull();
    expect(issues.some((i) => i.check === "apcs-absent" && i.level === "warning")).toBe(true);
    expect(issues.some((i) => i.level === "error")).toBe(false);
  });
  it("8. APCS data counted when present", () => {
    const row = validRow();
    row.children.apcs.push({ position: 1, subject: "程式設計", requirement: "4級分", multiplier: 1, note: null, sourceText: "程式設計" });
    const { normalized, issues } = normalizeDbAdmission(row);
    expect(normalized?.childCounts.apcs).toBe(1);
    expect(issues.some((i) => i.check === "apcs-absent")).toBe(false);
  });
  it("9. second-stage items counted", () => {
    const { normalized } = normalizeDbAdmission(validRow());
    expect(normalized?.childCounts.secondStage).toBe(1);
  });
  it("10. schedule missing / notices empty are errors", () => {
    const noSched = validRow();
    noSched.children.schedule = null;
    expect(normalizeDbAdmission(noSched).issues.some((i) => i.check === "schedule" && i.level === "error")).toBe(true);
    const noNotices = validRow();
    noNotices.children.notices = [];
    expect(normalizeDbAdmission(noNotices).issues.some((i) => i.check === "notices")).toBe(true);
  });
  it("13. missing required field (department name) errors", () => {
    expect(normalizeDbAdmission(validRow({ departmentName: "" })).issues.some((i) => i.check === "department-name")).toBe(true);
  });
  it("14+17. idempotent and never mutates source input", () => {
    const row = validRow();
    const before = JSON.stringify(row);
    const first = normalizeDbAdmission(row);
    const second = normalizeDbAdmission(row);
    expect(JSON.stringify(row)).toBe(before);
    expect(second).toEqual(first);
  });
});

describe("P4 normalizeBatch", () => {
  it("11. duplicate identity keys detected", () => {
    const { summary, issues } = normalizeBatch([validRow(), validRow()]);
    expect(summary.duplicateKeys).toEqual(["115|003|003112|application"]);
    expect(issues.some((i) => i.check === "duplicate-key" && i.level === "error")).toBe(true);
  });
  it("15+16. distinct schools never merge; batch deterministic", () => {
    const a = validRow();
    const b = validRow({ schoolCode: "001", departmentCode: "001012", departmentName: "中國文學系", schoolName: "國立臺灣大學" });
    const r1 = normalizeBatch([a, b]);
    const r2 = normalizeBatch([a, b]);
    expect(r1.summary.normalized).toBe(2);
    expect(r1.records.map((r) => r.identityKey).sort()).toEqual(["115|001|001012|application", "115|003|003112|application"]);
    expect(r2).toEqual(r1);
    expect(identityKey(115, "001", "001012", "application")).not.toBe(identityKey(115, "003", "003112", "application"));
  });
  it("12. malformed input surfaces errors, never silent success", () => {
    const bad = validRow({ year: Number.NaN, quota: null, children: { subjects: [], sequences: [], secondStage: [], apcs: [], review: [], special: [], schedule: null, notices: [], techGroup: null, techItems: [] } });
    const { normalized, issues } = normalizeDbAdmission(bad);
    expect(normalized).toBeNull();
    expect(issues.filter((i) => i.level === "error").length).toBeGreaterThan(0);
  });
});

describe("P4 diffDbRecords", () => {
  function expectedFrom(row: DbSourcedAdmission): DbAdmissionRecords {
    return {
      header: {
        academicYear: row.year, schoolCode: row.schoolCode, departmentCode: row.departmentCode,
        quota: row.quota, requirements: { ...row.requirements },
      },
      firstStageWeight: row.firstStageWeight,
      secondStageWeight: row.secondStageWeight,
      subjects: row.children.subjects.map((s) => ({ ...s, multiplier: s.multiplier as number | null })),
      sequences: row.children.sequences.map((s) => ({ ...s })),
      secondStage: row.children.secondStage.map((s) => ({ ...s })),
      apcs: row.children.apcs.map((s) => ({ ...s, multiplier: s.multiplier as number | null })),
      review: row.children.review.map((s) => ({ ...s, minimumCount: null, maximumCount: null })),
      special: row.children.special.map((s) => ({ ...s })),
      schedule: { ...(row.children.schedule as unknown as DbAdmissionRecords["schedule"]) },
      notices: row.children.notices.map((s) => ({ ...s })),
      techGroup: null,
      provenance: { sourceUrl: row.sourceUrl as string } as DbAdmissionRecords["provenance"],
    };
  }
  it("identical records diff empty (re-run writes nothing)", () => {
    const row = validRow();
    expect(diffDbRecords("k", expectedFrom(row), row)).toEqual([]);
  });
  it("drifted quota / missing child detected", () => {
    const row = validRow();
    const exp = expectedFrom(row);
    exp.header.quota = 99;
    const d = diffDbRecords("k", exp, row);
    expect(d.some((x) => x.includes("header.quota"))).toBe(true);
  });
  it("pg NUMERIC-as-string and DATE-as-Date tolerated", () => {
    const row = validRow();
    const exp = expectedFrom(row);
    exp.subjects[0]!.multiplier = 1;
    const stored = validRow();
    stored.children.subjects[0]!.multiplier = "1.0";
    stored.children.schedule = { ...stored.children.schedule!, notificationDate: new Date("2026-03-31T00:00:00") } as typeof stored.children.schedule;
    expect(diffDbRecords("k", exp, stored)).toEqual([]);
  });
});

describe("P4.1 full-library expectations (496, no 010)", () => {
  it("per-school counts match the official inventory; total derived as 496", () => {
    expect(P4_EXPECTED_COUNTS).toEqual({
      "001": 73, "002": 58, "003": 51, "004": 65, "005": 25,
      "006": 47, "007": 32, "008": 43, "009": 45, "011": 57,
    });
    expect(p4ExpectedTotal()).toBe(496);
    expect(P4_OFFICIAL_SCHOOL_CODES).toEqual(["001", "002", "003", "004", "005", "006", "007", "008", "009", "011"]);
  });
  it("010 is not an official school code; unknown codes fail closed", () => {
    expect("010" in P4_EXPECTED_COUNTS).toBe(false);
    expect(P4_OFFICIAL_SCHOOL_CODES).not.toContain("010");
    expect(() => p4ExpectedTotal("010")).toThrow(/unknown official school code/);
    expect(() => p4ExpectedTotal("012")).toThrow(/unknown official school code/);
  });
  it("per-school totals resolve from the table", () => {
    for (const [code, n] of Object.entries(P4_EXPECTED_COUNTS)) expect(p4ExpectedTotal(code)).toBe(n);
  });
  it("new schools normalize cleanly (004 + 011 samples, apcs optional)", () => {
    const ncku = validRow({ schoolCode: "004", schoolName: "國立成功大學", departmentCode: "004012", departmentName: "中國文學系", quota: 23, sourceUrl: "https://www.cac.edu.tw/apply115/system/X/html/115_004012.htm" });
    const nthu = validRow({ schoolCode: "011", schoolName: "國立清華大學", departmentCode: "011572", departmentName: "藝術與設計學系設計組", quota: 10, sourceUrl: "https://www.cac.edu.tw/apply115/system/X/html/115_011572.htm" });
    for (const row of [ncku, nthu]) {
      const { normalized, issues } = normalizeDbAdmission(row);
      expect(issues.filter((i) => i.level === "error")).toEqual([]);
      expect(normalized?.identityKey).toBe(`115|${row.schoolCode}|${row.departmentCode}|application`);
    }
    const { records, summary } = normalizeBatch([ncku, nthu, validRow()]);
    expect(summary.normalized).toBe(3);
    expect(summary.duplicateKeys).toEqual([]);
    expect(records).toHaveLength(3);
  });
  it("008-style apcs absence stays warning-only (confirmed normal case)", () => {
    const row = validRow({ schoolCode: "008", schoolName: "中原大學", departmentCode: "008012", departmentName: "應用數學系", sourceUrl: "https://www.cac.edu.tw/apply115/system/X/html/115_008012.htm" });
    expect(row.children.apcs).toEqual([]);
    const { normalized, issues } = normalizeDbAdmission(row);
    expect(normalized).not.toBeNull();
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(issues.some((i) => i.check === "apcs-absent" && i.level === "warning")).toBe(true);
  });
  it("original 182 rules still hold (required-field strictness unchanged)", () => {
    expect(normalizeDbAdmission(validRow({ quota: null })).issues.some((i) => i.level === "error")).toBe(true);
    expect(normalizeDbAdmission(validRow({ sourceUrl: null })).issues.some((i) => i.level === "error")).toBe(true);
    const bad = validRow();
    bad.children.schedule = null;
    expect(normalizeDbAdmission(bad).issues.some((i) => i.level === "error")).toBe(true);
  });
  it("reconciliation branch is school-agnostic (identical 004 row diffs empty)", () => {
    const row = validRow({ schoolCode: "004", schoolName: "國立成功大學", departmentCode: "004012", departmentName: "中國文學系", sourceUrl: "https://www.cac.edu.tw/apply115/system/X/html/115_004012.htm" });
    const exp = {
      header: { academicYear: 115, schoolCode: "004", departmentCode: "004012", quota: 18, requirements: { ...row.requirements } },
      firstStageWeight: null, secondStageWeight: "100%",
      subjects: row.children.subjects.map((s) => ({ ...s })),
      sequences: row.children.sequences.map((s) => ({ ...s })),
      secondStage: row.children.secondStage.map((s) => ({ ...s })),
      apcs: [],
      review: row.children.review.map((s) => ({ ...s, minimumCount: null, maximumCount: null })),
      special: row.children.special.map((s) => ({ ...s })),
      schedule: { ...(row.children.schedule as object) },
      notices: row.children.notices.map((s) => ({ ...s })),
      techGroup: null,
      provenance: { sourceUrl: row.sourceUrl },
    };
    expect(diffDbRecords("115|004|004012|application", exp as never, row)).toEqual([]);
  });
});

describe("P4.1d tech screening gate (no import in this phase)", () => {
  it("1+2. 008432 shared 40% recorded once; items carry no weight field", () => {
    const row = techRow();
    expect(row.children.techGroup?.weight).toBe("40%");
    expect(row.children.techGroup?.weightStatus).toBe("shared");
    for (const it of row.children.techItems) expect("weight" in it).toBe(false);
    const { normalized, issues } = normalizeDbAdmission(row);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(normalized?.childCounts.techGroups).toBe(1);
    expect(normalized?.childCounts.techItems).toBe(2);
  });
  it("3. 009432 ◎ stays NULL numerically with raw preserved", () => {
    const row = techRow();
    row.children.techGroup = { weight: null, weightStatus: "attributed_to_stage2", sourceText: "weight= status=attributed_to_stage2 items=主修", admissionId: "a1" };
    row.children.techItems = [
      { position: 1, name: "主修", requirement: null, multiplier: null, scoreMethod: "*1.00", sourceText: "主修|--|◎|*1.00", groupAdmission: "a1", itemAdmission: "a1" },
    ];
    const mult = row.children.techItems[0]!.multiplier;
    expect(mult).toBeNull();
    expect(row.children.techItems[0]!.sourceText).toContain("◎");
    expect(normalizeDbAdmission(row).issues.filter((i) => i.level === "error")).toEqual([]);
  });
  it("4. 009432 90% single-home: group weight null when attributed to stage2", () => {
    const row = techRow();
    row.children.techGroup = { weight: null, weightStatus: "attributed_to_stage2", sourceText: "x", admissionId: "a1" };
    row.children.techItems = [
      { position: 1, name: "主修", requirement: null, multiplier: null, scoreMethod: "*1.00", sourceText: "主修|--|◎|*1.00", groupAdmission: "a1", itemAdmission: "a1" },
    ];
    // Single-home invariant: attributed weight lives in second_stage, never duplicated on the group.
    expect(row.children.techGroup.weight).toBeNull();
    const { issues } = normalizeDbAdmission(row);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });
  it("5. subjects==0 without tech stays an error (missing, not pure-tech)", () => {
    const row = validRow();
    row.children.subjects = [];
    expect(row.children.techItems).toEqual([]);
    const { normalized, issues } = normalizeDbAdmission(row);
    expect(normalized).toBeNull();
    expect(issues.some((i) => i.check === "subjects" && i.level === "error")).toBe(true);
  });
  it("6. pure-tech corroboration: dash-only passes, substantive cells fail", () => {
    expect(findDroppedGsatCells(["grade subject without mapping: --", "grade subject without mapping: "])).toEqual([]);
    expect(findDroppedGsatCells(["grade subject without mapping: --", "grade subject without mapping: 國英數A自"])).toEqual([
      "grade subject without mapping: 國英數A自",
    ]);
    expect(findDroppedGsatCells(["grade subject without mapping: 物理"])).toHaveLength(1);
    expect(findDroppedGsatCells([])).toEqual([]);
  });
  it("pure-tech rows warn tech-only-screening, never error", () => {
    const { normalized, issues } = normalizeDbAdmission(techRow());
    expect(normalized).not.toBeNull();
    expect(issues.some((i) => i.check === "tech-only-screening" && i.level === "warning")).toBe(true);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });
  it("tech admission linkage mismatch is an error", () => {
    const row = techRow();
    row.children.techItems[0] = { ...row.children.techItems[0]!, itemAdmission: "other" };
    expect(normalizeDbAdmission(row).issues.some((i) => i.check === "tech-admission" && i.level === "error")).toBe(true);
  });
  it("empty tech group warns without blocking (when subjects exist)", () => {
    const row = validRow();
    row.children.techGroup = { weight: null, weightStatus: "unstated", sourceText: "x", admissionId: "a1" };
    row.children.techItems = [];
    const { normalized, issues } = normalizeDbAdmission(row);
    expect(normalized).not.toBeNull();
    expect(issues.some((i) => i.check === "tech-group-empty" && i.level === "warning")).toBe(true);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });
  it("10. drift detects missing tech group, extra item, and weight divergence", () => {
    const row = techRow();
    const exp = {
      header: { academicYear: 115, schoolCode: "008", departmentCode: "008432", quota: 18, requirements: { ...row.requirements } },
      firstStageWeight: null, secondStageWeight: "100%",
      subjects: [], sequences: row.children.sequences.map((s) => ({ ...s })),
      secondStage: row.children.secondStage.map((s) => ({ ...s })),
      apcs: [],
      review: row.children.review.map((s) => ({ ...s, minimumCount: null, maximumCount: null })),
      special: row.children.special.map((s) => ({ ...s })),
      schedule: { ...(row.children.schedule as object) },
      notices: row.children.notices.map((s) => ({ ...s })),
      techGroup: { weight: "40%", weightStatus: "shared", items: row.children.techItems.map((t) => ({ ...t })), sourceText: row.children.techGroup!.sourceText },
      provenance: { sourceUrl: row.sourceUrl },
    };
    expect(diffDbRecords("115|008|008432|application", exp as never, row)).toEqual([]);
    const missing = { ...exp, techGroup: null };
    expect(diffDbRecords("k", missing as never, row).some((x) => x.includes("tech-group presence"))).toBe(true);
    const diverged = JSON.parse(JSON.stringify(exp)) as typeof exp;
    diverged.techGroup!.weight = "20%";
    expect(diffDbRecords("k", diverged as never, row).some((x) => x.includes("tech-group.weight"))).toBe(true);
    const dropped = JSON.parse(JSON.stringify(exp)) as typeof exp;
    dropped.techGroup!.items.pop();
    expect(diffDbRecords("k", dropped as never, row).some((x) => x.includes("techItems"))).toBe(true);
  });
});

describe("P4.1f tech corroboration verdicts (read-only, no DB writes)", () => {
  const K = "115|008|008432|application";
  const base = {
    identityKey: K,
    rawExists: true,
    reparseOk: true,
    dbSubjects: 0,
    dbTechItems: 2,
    reparseTechItems: 2,
    droppedGsatCells: [] as string[],
    dbTechTablesPresent: true,
  };
  it("raw+DB GSAT agreement with tech evidence is verified", () => {
    const r = corroborateTechRow(base);
    expect(r.status).toBe("verified");
    expect(r.identityKey).toBe(K);
  });
  it("substantive raw GSAT cells with zero DB subjects is failed, never verified", () => {
    const r = corroborateTechRow({ ...base, droppedGsatCells: ["grade subject without mapping: 國英數A自"] });
    expect(r.status).toBe("failed");
    expect(r.status).not.toBe("verified");
  });
  it("absent raw is not_checked, never verified", () => {
    const r = corroborateTechRow({ ...base, rawExists: false });
    expect(r.status).toBe("not_checked");
  });
  it("failed re-parse can never yield verified", () => {
    const r = corroborateTechRow({ ...base, reparseOk: false });
    expect(r.status).toBe("failed");
  });
  it("pre-006 DB reports not_checked, never a pass", () => {
    const r = corroborateTechRow({ ...base, dbTechTablesPresent: false, dbTechItems: 0 });
    expect(r.status).toBe("not_checked");
    expect(r.reason).toMatch(/006/);
  });
  it("subjects==0 with valid tech but failed corroboration is failed, not verified pure-tech", () => {
    const r = corroborateTechRow({ ...base, droppedGsatCells: ["grade subject without mapping: 物理"] });
    expect(r.status).toBe("failed");
    // Gate keeps the subjects error path intact for missing-tech rows:
    const row = validRow();
    row.children.subjects = [];
    row.children.techItems = [];
    const gate = normalizeDbAdmission(row);
    expect(gate.issues.some((i) => i.check === "subjects" && i.level === "error")).toBe(true);
  });
  it("DB/raw tech disagreement (re-parse finds nothing) is failed", () => {
    const r = corroborateTechRow({ ...base, reparseTechItems: 0 });
    expect(r.status).toBe("failed");
  });
  it("rows with GSAT subjects are not_applicable, never verified or checked", () => {
    const r = corroborateTechRow({ ...base, dbSubjects: 3, dbTechItems: 0 });
    expect(r.status).toBe("not_applicable");
    expect(r.status).not.toBe("verified");
    expect(r.status).not.toBe("not_checked");
  });
  it("rows with GSAT subjects AND tech items are still not_applicable", () => {
    // e.g. 002582-like rows: tech presence does not pull GSAT rows into scope.
    const r = corroborateTechRow({ ...base, dbSubjects: 4, dbTechItems: 1, reparseTechItems: 1 });
    expect(r.status).toBe("not_applicable");
  });
  it("raw-missing rows stay not_checked even with GSAT subjects (never downgraded)", () => {
    const r = corroborateTechRow({ ...base, rawExists: false, dbSubjects: 3 });
    expect(r.status).toBe("not_checked");
  });
  it("reparse failure stays failed even with GSAT subjects", () => {
    const r = corroborateTechRow({ ...base, reparseOk: false, dbSubjects: 3 });
    expect(r.status).toBe("failed");
  });
  it("APCS path and existing warnings are untouched", () => {
    const row = validRow();
    expect(row.children.apcs).toEqual([]);
    const { issues } = normalizeDbAdmission(row);
    expect(issues.some((i) => i.check === "apcs-absent" && i.level === "warning")).toBe(true);
    expect(issues.some((i) => i.check.startsWith("tech-"))).toBe(false);
  });
  it("008432/009432 shapes corroborate once DB tech exists; 8-row cases keep passing", () => {
    const pre = corroborateTechRow({ ...base, dbTechTablesPresent: false, dbTechItems: 0 });
    expect(pre.status).toBe("not_checked");
    const post = corroborateTechRow(base);
    expect(post.status).toBe("verified");
  });
  it("summarizer counts statuses and lists identifiers", () => {
    const recs: TechCorroboration[] = [
      { identityKey: "a", status: "verified", reason: "ok" },
      { identityKey: "b", status: "failed", reason: "bad" },
      { identityKey: "c", status: "not_checked", reason: "skip" },
      { identityKey: "d", status: "not_checked", reason: "skip" },
      { identityKey: "e", status: "not_applicable", reason: "gsat" },
    ];
    const s = summarizeCorroboration(recs);
    expect(s.counts).toEqual({ verified: 1, failed: 1, not_checked: 2, not_applicable: 1 });
    expect(s.identifiers.verified).toEqual(["a"]);
    expect(s.identifiers.failed).toEqual(["b"]);
    expect(s.identifiers.not_checked).toEqual(["c", "d"]);
    expect(s.identifiers.not_applicable).toEqual(["e"]);
    expect(summarizeCorroboration([]).counts).toEqual({ verified: 0, failed: 0, not_checked: 0, not_applicable: 0 });
  });
  it("not_applicable never counts toward applicable verification coverage", () => {
    const s = summarizeCorroboration([
      { identityKey: "a", status: "verified", reason: "ok" },
      { identityKey: "e", status: "not_applicable", reason: "gsat" },
    ]);
    const applicable = s.counts.verified + s.counts.failed + s.counts.not_checked;
    expect(applicable).toBe(1);
    expect(s.counts.not_applicable).toBe(1);
  });
});
