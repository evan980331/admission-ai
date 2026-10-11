import { describe, expect, it } from "vitest";
import {
  buildMasterCandidate,
  classifyDocType,
  countPdfPages,
  crossValidate,
  extractDepartmentCandidates,
  extractYearClues,
  findMissingCodes,
  groupDuplicates,
  hasExtractableText,
  isReadablePdf,
  scanPdfBuffer,
  sha256Hex,
  type CrossInputs,
} from "../src/data/audit/official/application115/pdf-audit";

const URL115 = (code: string) => `https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/html/115_${code}.htm?v=1.0`;
const annot = (code: string, year = "115") =>
  `obj /Annots /URI (https://www.cac.edu.tw/apply${year}/system/X/html/${year}_${code}.htm)>>`;

function baseInputs(over: Partial<CrossInputs> = {}): CrossInputs {
  return {
    academicYear: "115",
    officialSchools: new Map([["001", "國立臺灣大學"]]),
    manifest: new Map(),
    master: [],
    rawHtmlCodes: new Set(),
    normalizedCodes: new Set(),
    dbChecked: false,
    ...over,
  };
}

describe("pdf-audit: code identity", () => {
  it("1. leading-zero codes stay strings", () => {
    const out = extractDepartmentCandidates(annot("001012"), { sourceFile: "a.pdf", pipeline: "t" });
    expect(out).toHaveLength(1);
    expect(out[0]!.departmentCode).toBe("001012");
    expect(typeof out[0]!.departmentCode).toBe("string");
  });
  it("2. school code and department code stay separate", () => {
    const out = extractDepartmentCandidates(annot("001012"), { sourceFile: "a.pdf", pipeline: "t" });
    expect(out[0]!.schoolCode).toBe("001");
    expect(out[0]!.departmentCode).toBe("001012");
    expect(out[0]!.schoolCode).not.toBe(out[0]!.departmentCode);
  });
  it("3. phone/date/quota/score numbers never match without a CAC detail URL", () => {
    const noise = [
      "電話 02-33664003 招生名額 23 預計甄試 69 人",
      "日期 115.05.15 最低錄取 425.5 分",
      "校系代碼 001012（純文字、無連結）",
      "/URI (https://example.com/115_001012.htm)",
    ].join("\n");
    expect(extractDepartmentCandidates(noise, { sourceFile: "a.pdf", pipeline: "t" })).toHaveLength(0);
  });
});

describe("pdf-audit: master + years", () => {
  it("4. same department across PDFs dedups but keeps every source", () => {
    const a = extractDepartmentCandidates(annot("001012"), { sourceFile: "a.pdf", pipeline: "t" });
    const b = extractDepartmentCandidates(annot("001012"), { sourceFile: "b.pdf", pipeline: "t" });
    const master = buildMasterCandidate([...a, ...b]);
    expect(master).toHaveLength(1);
    expect(master[0]!.sources.map((s) => s.sourceFile).sort()).toEqual(["a.pdf", "b.pdf"]);
  });
  it("5. different academic years never merge", () => {
    const a = extractDepartmentCandidates(annot("001012", "115"), { sourceFile: "a.pdf", pipeline: "t" });
    const b = extractDepartmentCandidates(annot("001012", "114"), { sourceFile: "a.pdf", pipeline: "t" });
    const master = buildMasterCandidate([...a, ...b]);
    expect(master).toHaveLength(2);
    expect(master.map((m) => m.academicYear).sort()).toEqual(["114", "115"]);
  });
});

describe("pdf-audit: unreadable input", () => {
  it("6. textless PDF is flagged scanned-suspect, never silent zero-department", () => {
    const buf = Buffer.from("%PDF-1.7\n1 0 obj<</Type /Page /Contents 2 0 R>>endobj\n", "latin1");
    const r = scanPdfBuffer(buf, "x/scan.pdf", "scan.pdf", []);
    expect(r.readable).toBe(true);
    expect(r.textExtractable).toBe(false);
    expect(r.likelyScannedImage).toBe(true);
  });
  it("7. corrupt input is flagged unreadable; OCR need is explicit", () => {
    const r = scanPdfBuffer(Buffer.from("not a pdf at all"), "x/bad.pdf", "bad.pdf", []);
    expect(r.readable).toBe(false);
    expect(r.pageCount).toBeNull();
  });
  it("sha256 + page counting are mechanical", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(countPdfPages("1 0 obj<</Type /Page>>endobj 2 0 obj<</Type /Pages /Count 9>>endobj")).toBe(1);
    expect(hasExtractableText("BT <0041> Tj ET")).toBe(true);
    expect(extractYearClues("115學年度招生", "國立臺灣大學.pdf")).toEqual(["115"]);
  });
});

describe("pdf-audit: cross-validation honesty", () => {
  it("8. unknown-school codes land in unresolved, never forced", () => {
    const master = buildMasterCandidate(extractDepartmentCandidates(annot("901012"), { sourceFile: "x.pdf", pipeline: "t" }));
    const { rows, summary } = crossValidate(baseInputs({ master }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("unresolved");
    expect(summary.unresolved).toBe(1);
    expect(summary.matched).toBe(0);
  });
  it("8b. school-name aliases do not merge codes across schools", () => {
    const master = buildMasterCandidate(extractDepartmentCandidates(annot("001012"), { sourceFile: "x.pdf", pipeline: "t" }));
    const manifest = new Map([["001012", { schoolCode: "002", departmentName: null as string | null }]]);
    const { rows } = crossValidate(baseInputs({ manifest, master }));
    expect(rows[0]!.status).toBe("code_mismatch");
  });
  it("9. without an authority list, completeness is unjudgeable and unclaimed", () => {
    const master = buildMasterCandidate(extractDepartmentCandidates(annot("001012"), { sourceFile: "x.pdf", pipeline: "t" }));
    const r = crossValidate(baseInputs({ officialSchools: new Map(), master }));
    expect(r.completeness).toBe("unjudgeable");
    expect(r.rows.every((x) => x.status === "unresolved")).toBe(true);
  });
  it("matched / missing / duplicate statuses", () => {
    const master = buildMasterCandidate([
      ...extractDepartmentCandidates(annot("001012"), { sourceFile: "a.pdf", pipeline: "t" }),
      ...extractDepartmentCandidates(annot("001012"), { sourceFile: "b.pdf", pipeline: "t" }),
      ...extractDepartmentCandidates(annot("001032"), { sourceFile: "a.pdf", pipeline: "t" }),
    ]);
    const manifest = new Map([
      ["001012", { schoolCode: "001", departmentName: null as string | null }],
      ["001022", { schoolCode: "001", departmentName: null as string | null }],
    ]);
    const { summary } = crossValidate(baseInputs({ manifest, master }));
    expect(summary.duplicate).toBe(1);
    expect(summary.missing_from_pdf).toBe(1);
    expect(summary.new_candidate).toBe(1);
    expect(findMissingCodes(new Set(["001012"]), new Set(["001012", "001022"]))).toEqual(["001022"]);
  });
  it("name_mismatch does not silently pass", () => {
    const master = buildMasterCandidate(
      extractDepartmentCandidates(annot("001012"), { sourceFile: "a.pdf", pipeline: "t", departmentNames: { "001012": "歷史學系" } }),
    );
    const manifest = new Map([["001012", { schoolCode: "001", departmentName: "中國文學系" as string | null }]]);
    const { rows } = crossValidate(baseInputs({ manifest, master }));
    expect(rows[0]!.status).toBe("name_mismatch");
  });
  it("classifyDocType keeps master/school/unknown apart", () => {
    expect(classifyDocType("查詢所有校系-校系分則查詢-申請入學.pdf", ["國立臺灣大學"]).docType).toBe("national-master");
    expect(classifyDocType("國立臺灣大學.pdf", ["國立臺灣大學"])).toEqual({ docType: "school-brochure", schoolClue: "國立臺灣大學" });
    expect(classifyDocType("random.pdf", ["國立臺灣大學"]).docType).toBe("unknown");
  });
});

describe("pdf-audit: determinism", () => {
  it("10. reruns are byte-identical except timestamps", () => {
    const run = () => {
      const recs = groupDuplicates([
        scanPdfBuffer(Buffer.from("%PDF-1.4\n1 0 obj<</Type /Page>>endobj " + "x".repeat(100), "latin1"), "b.pdf", "b.pdf", []),
        scanPdfBuffer(Buffer.from("%PDF-1.4\n1 0 obj<</Type /Page>>endobj " + "y".repeat(50), "latin1"), "a.pdf", "a.pdf", []),
      ]);
      const master = buildMasterCandidate([
        ...extractDepartmentCandidates(annot("001022") + annot("001012"), { sourceFile: "b.pdf", pipeline: "t" }),
        ...extractDepartmentCandidates(annot("001012"), { sourceFile: "a.pdf", pipeline: "t" }),
      ]);
      return JSON.stringify({ recs, master });
    };
    expect(run()).toBe(run());
  });
});
