import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { matchDepartmentTab } from "../src/data/acquisition/browser/universe";
import {
  buildInventory,
  extractPdfDetailLinks,
  firstPending,
  PDF_001_ORDER,
  PDF_FILES,
  PDF_NAMES,
  isActionableStatus,
  resolveStatus,
} from "../src/data/discovery/official/application115/pdf-inventory";

/** Synthetic PDF annot text (test-only shape, mirrors real annot dicts). */
const SYNTH_PDF =
  "obj /Annots /URI (https://www.cac.edu.tw/apply115/system/X/html/115_001042.htm?v=1.0)>> " +
  "obj /URI (https://www.cac.edu.tw/apply115/system/X/html/115_001042.htm?v=1.0)>> " +
  "obj /URI (https://www.cac.edu.tw/apply115/system/X/html/115_001052.htm)>>";

describe("admission queue inventory", () => {
  it("1-2. extractPdfDetailLinks dedupes in order; names cover 496 codes", () => {
    const links = extractPdfDetailLinks(SYNTH_PDF);
    expect(links.map((l) => l.code)).toEqual(["001042", "001052"]);
    expect(links[0]!.url).toContain("115_001042.htm");
    expect(Object.keys(PDF_NAMES)).toHaveLength(496 + 1710);
  });
  it("3. codes unique per school file (buildInventory school guard)", () => {
    const inv = buildInventory({ "001": SYNTH_PDF });
    expect(inv.map((e) => e.departmentCode)).toEqual(["001042", "001052"]);
    expect(inv[0]).toMatchObject({ schoolCode: "001", source: "official-pdf" });
  });
  it("4. cross-school code rejected, never fuzzy-matched", () => {
    expect(() => buildInventory({ "002": SYNTH_PDF })).toThrow(/does not belong to school/);
  });
  it("names are non-empty display metadata (identity stays code-only)", () => {
    for (const [code, name] of Object.entries(PDF_NAMES)) {
      expect(code).toMatch(/^\d{6}$/);
      expect(name.trim().length).toBeGreaterThan(0);
    }
    expect(PDF_NAMES["001032"]).toBe("歷史學系");
  });
  it("PDF_001_ORDER stays 73 and consistent with names", () => {
    expect(PDF_001_ORDER).toHaveLength(73);
    for (const c of PDF_001_ORDER) expect(PDF_NAMES[c]).toBeTruthy();
  });
});

describe("P3.5 school inventory expansion (004-009, 011; never 010) + P4.2d 54 schools", () => {
  const EXPECTED_FILES_10: Record<string, string> = {
    "001": "國立臺灣大學.pdf",
    "002": "國立臺灣師範大學.pdf",
    "003": "國立中興大學.pdf",
    "004": "國立成功大學.pdf",
    "005": "東吳大學.pdf",
    "006": "國立政治大學.pdf",
    "007": "高雄醫學大學.pdf",
    "008": "中原大學.pdf",
    "009": "東海大學.pdf",
    "011": "國立清華大學.pdf",
  };
  const EXPECTED_COUNTS: Record<string, number> = {
    "001": 73, "002": 58, "003": 51, "004": 65, "005": 25,
    "006": 47, "007": 32, "008": 43, "009": 45, "011": 57,
  };
  const rawRoot = path.join(__dirname, "..", "data", "raw", "official", "115", "application");
  const buildFull = () => {
    const pdfTexts: Record<string, string> = {};
    for (const [school, file] of Object.entries(PDF_FILES)) {
      pdfTexts[school] = fs.readFileSync(path.join(rawRoot, file), "latin1");
    }
    return buildInventory(pdfTexts);
  };
  it("PDF_FILES holds the 10 official schools plus the 54 P4.2b schools (010 absent)", () => {
    for (const [code, file] of Object.entries(EXPECTED_FILES_10)) {
      expect(PDF_FILES[code]).toBe(file);
    }
    expect(Object.keys(PDF_FILES)).toHaveLength(64);
    expect("010" in PDF_FILES).toBe(false);
  });
  it("010 is never generated and 011 is never skipped for the gap", () => {
    const inv = buildFull();
    const codes = inv.map((e) => e.departmentCode);
    expect(codes.some((c) => c.startsWith("010"))).toBe(false);
    expect(inv.filter((e) => e.schoolCode === "011")).toHaveLength(57);
  });
  it("every PDF department prefix equals its school code", () => {
    const inv = buildFull();
    for (const e of inv) expect(e.departmentCode.startsWith(e.schoolCode)).toBe(true);
  });
  it("department counts match the official audit inventory (496 + 1710 = 2206)", () => {
    const inv = buildFull();
    for (const [school, n] of Object.entries(EXPECTED_COUNTS)) {
      expect(inv.filter((e) => e.schoolCode === school)).toHaveLength(n);
    }
    expect(inv).toHaveLength(73 + 58 + 51 + 65 + 25 + 47 + 32 + 43 + 45 + 57 + 1710);
  });
  it("no duplicate school codes or department codes", () => {
    expect(new Set(Object.keys(PDF_FILES)).size).toBe(Object.keys(PDF_FILES).length);
    const inv = buildFull();
    expect(new Set(inv.map((e) => e.departmentCode)).size).toBe(inv.length);
  });
  it("PDF_NAMES covers every inventory code; 001-003 untouched", () => {
    const inv = buildFull();
    for (const e of inv) expect(PDF_NAMES[e.departmentCode]?.trim().length).toBeGreaterThan(0);
    expect(PDF_NAMES["001032"]).toBe("歷史學系");
    expect(PDF_NAMES["003112"]).toBe("應用經濟學系");
    expect(PDF_NAMES["004012"]).toBe("中國文學系");
    expect(PDF_NAMES["011572"]).toBe("藝術與設計學系設計組");
  });
  it("005 masters seed the 7 new schools idempotently (source scan)", () => {
    const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "005_school_masters.sql"), "utf8");
    for (const [code, name] of [["004", "國立成功大學"], ["005", "東吳大學"], ["006", "國立政治大學"], ["007", "高雄醫學大學"], ["008", "中原大學"], ["009", "東海大學"], ["011", "國立清華大學"]] as const) {
      expect(sql).toContain(`('${code}', '${name}')`);
    }
    expect(sql).not.toMatch(/'010'/);
    expect(sql).toContain("ON CONFLICT (school_code) DO NOTHING");
  });
});

describe("queue status resolution (DB > raw > inventory)", () => {
  const entry = { academicYear: 115, schoolCode: "001", departmentCode: "001032", departmentName: "歷史學系", detailUrl: "x", source: "official-pdf" as const };
  const st = (over: Partial<Parameters<typeof resolveStatus>[1]>) =>
    resolveStatus(entry, { dbLoaded: null, rawHtm: false, rawMeta: false, parsed: null, validated: null, ...over });
  it("5. DB canonical exists -> LOADED even without queue file", () => {
    expect(st({ dbLoaded: true, rawHtm: true, rawMeta: true })).toBe("LOADED");
    expect(st({ dbLoaded: true })).toBe("LOADED");
  });
  it("6. PDF-only -> PENDING", () => {
    expect(st({})).toBe("PENDING");
  });
  it("7. raw-only -> CAPTURED (htm) / STORED (htm+meta)", () => {
    expect(st({ rawHtm: true, rawMeta: false, parsed: null, validated: null })).toBe("CAPTURED");
    expect(st({ rawHtm: true, rawMeta: true, parsed: true, validated: true })).toBe("VALIDATED");
    expect(st({ rawHtm: true, rawMeta: true, parsed: true, validated: false })).toBe("FAILED");
  });
  it("8. DB beats every file state", () => {
    expect(st({ dbLoaded: true, rawHtm: false, rawMeta: false })).toBe("LOADED");
  });
  it("firstPending walks PDF order", () => {
    expect(firstPending(["001012", "001032"], new Set(["001012"]))).toBe("001032");
  });
  it("queue DB check has no hardcoded school list (004+ stay LOADED)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "admission-queue.ts"), "utf8");
    expect(src).not.toMatch(/school_code IN \('/);
    expect(src).toMatch(/WHERE a\.year = 115`/);
  });
});

describe("DB-checked status (LOAD_REQUIRED retry lane)", () => {
  const entry = { academicYear: 115, schoolCode: "003", departmentCode: "003112", departmentName: "應用經濟學系", detailUrl: "x", source: "official-pdf" as const };
  const st = (over: Partial<Parameters<typeof resolveStatus>[1]>) =>
    resolveStatus(entry, { dbLoaded: false, rawHtm: false, rawMeta: false, parsed: null, validated: null, ...over });
  it("raw exists + DB missing -> LOAD_REQUIRED (never terminal)", () => {
    expect(st({ rawHtm: true, rawMeta: true, parsed: true, validated: true })).toBe("LOAD_REQUIRED");
    expect(st({ rawHtm: true, rawMeta: true, parsed: null, validated: null })).toBe("LOAD_REQUIRED");
    expect(st({ rawHtm: true, rawMeta: false })).toBe("LOAD_REQUIRED");
  });
  it("raw missing + DB missing -> PENDING", () => {
    expect(st({})).toBe("PENDING");
  });
  it("raw exists + DB exists -> LOADED", () => {
    expect(resolveStatus(entry, { dbLoaded: true, rawHtm: true, rawMeta: true, parsed: true, validated: true })).toBe("LOADED");
  });
  it("validation failure + DB missing -> FAILED (no silent retry)", () => {
    expect(st({ rawHtm: true, rawMeta: true, parsed: true, validated: false })).toBe("FAILED");
    expect(st({ rawHtm: true, rawMeta: true, parsed: false, validated: null })).toBe("FAILED");
  });
  it("isActionableStatus: PENDING + LOAD_REQUIRED work, LOADED/FAILED skip", () => {
    expect(isActionableStatus("PENDING")).toBe(true);
    expect(isActionableStatus("LOAD_REQUIRED")).toBe(true);
    expect(isActionableStatus("LOADED")).toBe(false);
    expect(isActionableStatus("FAILED")).toBe(false);
    expect(isActionableStatus("STORED")).toBe(false);
    expect(isActionableStatus("VALIDATED")).toBe(false);
  });
  it("003112/003192 are inventory-known (queue can target them)", () => {
    expect(PDF_NAMES["003112"]).toBe("應用經濟學系");
    expect(PDF_NAMES["003192"]).toBe("機械工程學系");
    // raw-present + DB-missing resolves actionable, so --department never exits early
    for (const code of ["003112", "003192"]) {
      const s = resolveStatus({ ...entry, departmentCode: code }, { dbLoaded: false, rawHtm: true, rawMeta: true, parsed: true, validated: true });
      expect(isActionableStatus(s)).toBe(true);
    }
  });
});

describe("scan safety gates", () => {
  const pages = [{ url: "https://www.cac.edu.tw/apply115/system/X/html/115_001032.htm" }];
  it("9. wrong department rejected", () => {
    expect(matchDepartmentTab(pages, 115, "001042")).toEqual([]);
  });
  it("10. ShowSchGsd never matches a department tab", () => {
    expect(matchDepartmentTab([{ url: "https://www.cac.edu.tw/apply115/system/X/ShowSchGsd.php?colno=001" }], 115, "001032")).toEqual([]);
  });
  it("11-12. queue performs no navigation/fetch (source scan)", () => {
    for (const f of ["scripts/admission-queue.ts", "scripts/scan-official-cdp.ts"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      expect(src).not.toMatch(/page\.goto|goto\(|click\(|newPage|fetch\(|axios|https?\.get|child_process|curl|wget/i);
    }
  });
});

describe("005 school masters (static, offline)", () => {
  const dir = path.join(__dirname, "..", "db", "migrations");
  const sql005 = fs.readFileSync(path.join(dir, "005_school_masters.sql"), "utf8");
  it("inserts 001/002/003 idempotently", () => {
    for (const [code, name] of [["001", "國立臺灣大學"], ["002", "國立臺灣師範大學"], ["003", "國立中興大學"]] as const) {
      expect(sql005).toContain(`('${code}', '${name}')`);
    }
    expect(sql005).toContain("ON CONFLICT (school_code) DO NOTHING");
  });
  it("adds no schema, touches no other migration", () => {
    expect(sql005).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP\s+(TABLE|COLUMN)/i);
    for (const f of ["001_initial_schema.sql", "002_student_preferences.sql", "003_admission_detail.sql", "004_admission_source_fields.sql"]) {
      expect(fs.readFileSync(path.join(dir, f), "utf8")).not.toContain("005_school_masters");
    }
  });
});
