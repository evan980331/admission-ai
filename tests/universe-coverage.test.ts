import { describe, expect, it } from "vitest";
import {
  buildUniverse,
  checkIdentity,
  classifyRow,
  summarize,
  type UniverseInput,
} from "../src/data/audit/official/application115/universe";

const official = (code: string, extra: Partial<UniverseInput> = {}): UniverseInput => ({
  schoolCode: code.slice(0, 3),
  schoolName: null,
  departmentCode: code,
  departmentName: null,
  detailUrl: `https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_${code}.htm`,
  provenance: "official",
  academicYear: 115,
  ...extra,
});

describe("buildUniverse", () => {
  it("merges by code identity; names never fork rows", () => {
    const rows = buildUniverse([
      official("001012", { departmentName: "中國文學系" }),
      official("001012", { departmentName: "中文系", provenance: "fixture" }),
      official("001022"),
    ]);
    expect(rows.map((r) => r.departmentCode)).toEqual(["001012", "001022"]);
    expect(rows[0]!.provenance).toBe("official");
  });
});

describe("classifyRow", () => {
  it("full pipeline row carries all six flags", () => {
    const r = classifyRow(official("001012"), { raw: true, parsed: true, dataset: true, db: true, canonicalComplete: true, schemaMapped: true });
    expect(r.flags).toEqual(["EXPECTED", "RAW_AVAILABLE", "PARSED", "DATASET_PRESENT", "DB_PRESENT", "CANONICAL_COMPLETE"]);
    expect(r.status).toBe("complete");
  });
  it("missing raw -> NEEDS_ACQUISITION (never guessed present)", () => {
    const r = classifyRow(official("001032"), { raw: false, parsed: false, dataset: false, db: false, canonicalComplete: false, schemaMapped: true });
    expect(r.flags).toContain("NEEDS_ACQUISITION");
    expect(r.status).toBe("needs_acquisition");
  });
  it("raw without parse -> NEEDS_PARSE_FIX", () => {
    const r = classifyRow(official("001032"), { raw: true, parsed: false, dataset: false, db: null, canonicalComplete: false, schemaMapped: true });
    expect(r.flags).toContain("NEEDS_PARSE_FIX");
    expect(r.status).toBe("needs_parse_fix");
  });
  it("parsed but unmapped -> NEEDS_SCHEMA_MAPPING", () => {
    const r = classifyRow(official("001032"), { raw: true, parsed: true, dataset: false, db: null, canonicalComplete: false, schemaMapped: false });
    expect(r.flags).toContain("NEEDS_SCHEMA_MAPPING");
    expect(r.status).toBe("needs_schema_mapping");
  });
  it("unchecked DB stays unknown, not false", () => {
    const r = classifyRow(official("001012"), { raw: true, parsed: true, dataset: true, db: null, canonicalComplete: true, schemaMapped: true });
    expect(r.flags).not.toContain("DB_PRESENT");
    expect(r.status).toBe("db_unknown");
  });
});

describe("summarize", () => {
  it("aggregates flags and per-school gaps", () => {
    const rows = [
      classifyRow(official("001012"), { raw: true, parsed: true, dataset: true, db: true, canonicalComplete: true, schemaMapped: true }),
      classifyRow(official("001032"), { raw: false, parsed: false, dataset: false, db: false, canonicalComplete: false, schemaMapped: true }),
    ];
    const s = summarize(rows);
    expect(s).toMatchObject({ universe: 2, raw: 1, parsed: 1, dataset: 1, db: 1, canonicalComplete: 1, needsAcquisition: 1, needsParseFix: 0, needsSchemaMapping: 0 });
    expect(s.gapsBySchool).toEqual({ "001": 1 });
  });
});

describe("checkIdentity", () => {
  const row = (code: string, school: string, url: string | null) => ({
    schoolCode: school,
    schoolName: null,
    departmentCode: code,
    departmentName: null,
    detailUrl: url,
    provenance: "official" as const,
    raw: true,
    parsed: true,
    dataset: true,
    db: true,
    canonicalComplete: true,
    flags: [] as never[],
    status: "complete",
    reason: "",
  });
  it("accepts code-derived school identity", () => {
    expect(checkIdentity([row("001012", "001", "https://www.cac.edu.tw/apply115/x/html/115_001012.htm")])).toEqual([]);
  });
  it("rejects year-prefix-as-school (P3.12 rule)", () => {
    const issues = checkIdentity([row("001012", "115", null)]);
    expect(issues.some((i) => i.level === "error" && i.check === "school-derivation")).toBe(true);
  });
  it("rejects non-official detail URLs", () => {
    const issues = checkIdentity([row("001012", "001", "https://evil.example.com/115_001012.htm")]);
    expect(issues.some((i) => i.level === "error" && i.check === "detail-url")).toBe(true);
  });
  it("keeps desktop query strings verbatim (no warning for ?v=1.0)", () => {
    expect(checkIdentity([row("001012", "001", "https://www.cac.edu.tw/apply115/x/html/115_001012.htm?v=1.0")])).toEqual([]);
  });
});
