import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  auditDepartmentUrl,
  findDuplicateUrls,
} from "../src/data/audit/official/application115/validation-queue";
import {
  decodePdfPages,
  extractDepartmentNames,
  isPlausibleDepartmentName,
  parseCMap,
  resolveNameStatus,
  stripNameNoise,
} from "../src/data/discovery/official/application115/pdf-text";

/** Minimal synthetic PDF: one page, one subset font, one ToUnicode CMap. */
function synthPdf(cmapBody: string, contentOps: string): Buffer {
  const parts: string[] = [];
  parts.push(`%PDF-1.4
1 0 obj
<</Type /Pages /Kids [2 0 R] /Count 1>>
endobj
2 0 obj
<</Type /Page /Parent 1 0 R /Resources <</Font <</F1 3 0 R>>>> /Contents 5 0 R>>
endobj
3 0 obj
<</Type /Font /BaseFont /ABC+Test /ToUnicode 4 0 R>>
endobj
4 0 obj
<< /Length ${cmapBody.length} >>
stream
${cmapBody}endstream
endobj
5 0 obj
<< /Length ${contentOps.length} >>
stream
${contentOps}endstream
endobj
`);
  return Buffer.from(parts.join(""), "latin1");
}

const CMAP_1BYTE = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 begincodespacerange
<00> <FF>
endcodespacerange
2 beginbfchar
<41> <4E2D>
<42> <6587>
endbfchar
1 beginbfrange
<50> <51> <0030>
endbfrange
endcmap
end
end
`;

describe("pdf-text CMap decoding (synthetic PDF)", () => {
  it("parses bfchar + bfrange and decodes 1-byte units", () => {
    const pages = decodePdfPages(synthPdf(CMAP_1BYTE, "BT /F1 12 Tf <41425051> Tj ET"));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.pageNumber).toBe(1);
    expect(pages[0]!.runs.map((r) => r.text).join("")).toBe("中文01");
  });
  it("unknown CIDs fail loud, never silent", () => {
    const pages = decodePdfPages(synthPdf(CMAP_1BYTE, "BT /F1 12 Tf <FF> Tj ET"));
    expect(pages[0]!.runs.map((r) => r.text).join("")).toContain("�");
  });
  it("parseCMap reads codespace widths only from codespacerange", () => {
    const c = parseCMap(CMAP_1BYTE);
    expect(c.widths).toEqual([[1, 0, 255]]);
    expect(c.map.get(0x41)).toBe("中");
    expect(c.map.get(0x50)).toBe("0");
  });
});

describe("P4.2b name rules", () => {
  it("4. leading zeros preserved end to end", () => {
    const rows = extractDepartmentNames(
      [{ pageNumber: 3, runs: [{ font: "F1", hex: "", text: "測試大學歷史學系 (001012)" }] }],
      "001",
      "測試大學",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code).toBe("001012");
    expect(typeof rows[0]!.code).toBe("string");
  });
  it("1. school+dept codes must both match (cross-school codes excluded)", () => {
    const rows = extractDepartmentNames(
      [{ pageNumber: 1, runs: [{ font: "F1", hex: "", text: "測試大學歷史學系 (001032) 別校系 (002012)" }] }],
      "001",
      "測試大學",
    );
    expect(rows.map((r) => r.code)).toEqual(["001032"]);
  });
  it("2. same name across schools never merges (per-code records)", () => {
    const a = extractDepartmentNames(
      [{ pageNumber: 1, runs: [{ font: "F1", hex: "", text: "甲大學中國文學系 (004012)" }] }],
      "004",
      "甲大學",
    );
    const b = extractDepartmentNames(
      [{ pageNumber: 1, runs: [{ font: "F1", hex: "", text: "乙大學中國文學系 (005012)" }] }],
      "005",
      "乙大學",
    );
    expect(a[0]).toMatchObject({ code: "004012", name: "中國文學系" });
    expect(b[0]).toMatchObject({ code: "005012", name: "中國文學系" });
    expect(a[0]!.code).not.toBe(b[0]!.code);
  });
  it("3. same code with two names is a conflict, never a pick", () => {
    const r = resolveNameStatus({ decodedNames: ["歷史學系", "歷史系"], inAnnots: true });
    expect(r.status).toBe("conflict");
    expect(r.name).toBeNull();
  });
  it("5. source file and page number stay traceable", () => {
    const rows = extractDepartmentNames(
      [
        { pageNumber: 2, runs: [{ font: "F1", hex: "", text: "測試大學歷史學系 (001032)" }] },
      ],
      "001",
      "測試大學",
    );
    expect(rows[0]!.pageNumber).toBe(2);
    expect(rows[0]!.rawSegment.length).toBeGreaterThan(0);
  });
  it("6. implausible text is ambiguous, never verified", () => {
    expect(isPlausibleDepartmentName("")).toBe(false);
    expect(isPlausibleDepartmentName("x".repeat(41))).toBe(false);
    expect(isPlausibleDepartmentName("12345")).toBe(false);
    expect(isPlausibleDepartmentName("審查資料不要求")).toBe(false);
    expect(isPlausibleDepartmentName("歷史學系")).toBe(true);
    expect(isPlausibleDepartmentName("資訊工程學系(APCS組)")).toBe(true);
    const r = resolveNameStatus({ decodedNames: ["審查資料不要求"], inAnnots: true });
    expect(r.status).toBe("ambiguous");
  });
  it("7. absent source yields null name, never invented", () => {
    const r = resolveNameStatus({ decodedNames: [], inAnnots: false });
    expect(r.status).toBe("not_found_in_local_sources");
    expect(r.name).toBeNull();
  });
  it("stripNameNoise keeps name-internal 一般 but drops column noise", () => {
    expect(stripNameNoise("物理學系一般物理組", "某大學")).toBe("物理學系一般物理組");
    expect(stripNameNoise("1不要求50無無無一般否否詳細資料蓄帳戶組", "某大學")).not.toMatch(/不要求|詳細資料|一般否/);
  });
});

describe("P4.2b URL audit", () => {
  it("8. unbuildable codes are not collectable", () => {
    const bad = auditDepartmentUrl("12", null);
    expect(bad.buildError).not.toBeNull();
    expect(bad.collectable).toBe(false);
    const noAnnot = auditDepartmentUrl("012012", null);
    expect(noAnnot.matchesAnnot).toBeNull();
    expect(noAnnot.collectable).toBe(false);
  });
  it("valid code with matching annot is collectable", () => {
    const ok = auditDepartmentUrl(
      "012012",
      "https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_012012.htm?v=1.0",
    );
    expect(ok.buildError).toBeNull();
    expect(ok.matchesAnnot).toBe(true);
    expect(ok.collectable).toBe(true);
  });
  it("9. duplicate built URLs are identified", () => {
    expect(
      findDuplicateUrls([
        { departmentCode: "012012", builtUrl: "https://x/115_012012.htm" },
        { departmentCode: "012022", builtUrl: "https://x/115_012022.htm" },
        { departmentCode: "012032", builtUrl: "https://x/115_012012.htm" },
        { departmentCode: "bad", builtUrl: null },
      ]),
    ).toEqual([{ url: "https://x/115_012012.htm", codes: ["012012", "012032"] }]);
    expect(findDuplicateUrls([{ departmentCode: "a", builtUrl: "u" }])).toEqual([]);
  });
  it("10. formal artifacts are never overwritten by the audit writer", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "p4-2b-names.ts"), "utf8");
    const writes = [...src.matchAll(/writeFileSync\(\s*([^\n,;]+)/g)].map((m) => m[1]!.trim());
    expect(writes.length).toBeGreaterThan(0);
    // Every write targets the gitignored audit dir constant — never a formal path.
    for (const w of writes) {
      expect(w.startsWith("path.join(AUDIT")).toBe(true);
    }
    expect(src).not.toMatch(/writeFileSync\([^)]*(department-manifest|school-index|universe\/school)/);
  });
});
