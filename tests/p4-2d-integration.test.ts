import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildInventory,
  extractPdfDetailLinks,
  PDF_FILES,
  PDF_NAMES,
  resolveStatus,
} from "../src/data/discovery/official/application115/pdf-inventory";
import {
  assertAnnotationMatchesBuilder,
} from "../src/data/discovery/official/application115/universe";
import { accessPolicyLines, CAC_ROBOTS_DISALLOW_ALL } from "../src/data/acquisition/browser/policy";

/**
 * P4.2d: 54 schools + 1,710 P4.2b candidates wired into the existing
 * acquisition inventory. All offline: synthetic PDF text, committed source
 * constants, and local audit artifacts (same precedent as the existing
 * buildFull tests that read local raw PDFs). No network, no Chrome, no DB.
 */

const OLD10: Record<string, string> = {
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

const rawRoot = path.join(__dirname, "..", "data", "raw", "official", "115", "application");
const auditDir = path.join(rawRoot, "..", "..", "..", "..", "processed", "official", "115", "application", "pdf-audit");

interface CandidateRow {
  schoolCode: string;
  schoolName: string;
  departmentCode: string;
  sourceFile: string;
  detailUrl: string;
  validationStatus: string;
}
const candidates = JSON.parse(
  fs.readFileSync(path.join(auditDir, "acquisition-queue-candidate.json"), "utf8"),
).data.queue as CandidateRow[];
const schoolIndex = JSON.parse(
  fs.readFileSync(path.join(rawRoot, "universe", "school-index.json"), "utf8"),
) as { schools: { schoolCode: string; schoolName: string }[] };
const indexNames = new Map(schoolIndex.schools.map((s) => [s.schoolCode, s.schoolName]));

const buildFull = () => {
  const pdfTexts: Record<string, string> = {};
  for (const [school, file] of Object.entries(PDF_FILES)) {
    pdfTexts[school] = fs.readFileSync(path.join(rawRoot, file), "latin1");
  }
  return buildInventory(pdfTexts);
};

describe("P4.2d-1: 54 school PDFs map to correct official school codes", () => {
  it("PDF_FILES keys are the 10 old schools plus exactly the 54 candidate schools", () => {
    const candidateSchools = [...new Set(candidates.map((c) => c.schoolCode))].sort();
    expect(candidateSchools).toHaveLength(54);
    expect(Object.keys(PDF_FILES).sort()).toEqual([...Object.keys(OLD10), ...candidateSchools].sort());
    expect(Object.keys(PDF_FILES)).toHaveLength(64);
  });
  it("every new school name matches the official school index", () => {
    for (const c of candidates) {
      expect(indexNames.get(c.schoolCode)).toBe(c.schoolName);
    }
  });
  it("full 64-PDF build: every extracted code starts with its school key", () => {
    for (const e of buildFull()) {
      expect(e.departmentCode.startsWith(e.schoolCode)).toBe(true);
    }
  });
});

describe("P4.2d-2: no re-registration of the 10 schools or the master table", () => {
  it("old 10 filenames byte-identical", () => {
    for (const [code, file] of Object.entries(OLD10)) {
      expect(PDF_FILES[code]).toBe(file);
    }
  });
  it("010 never appears; national master PDF never registered", () => {
    expect("010" in PDF_FILES).toBe(false);
    expect(Object.values(PDF_FILES)).not.toContain("查詢所有校系-校系分則查詢-申請入學.pdf");
    for (const e of buildFull()) {
      expect(e.departmentCode.startsWith("010")).toBe(false);
    }
  });
});

describe("P4.2d-3: 1,710 candidates enter the expected queue", () => {
  it("full inventory is 496 + 1710 = 2206 with unique codes", () => {
    const inv = buildFull();
    expect(inv).toHaveLength(2206);
    expect(new Set(inv.map((e) => e.departmentCode)).size).toBe(2206);
  });
  it("new-school inventory code set equals the candidate code set exactly", () => {
    const inv = buildFull().filter((e) => !(e.schoolCode in OLD10));
    expect(inv).toHaveLength(1710);
    const invCodes = new Set(inv.map((e) => e.departmentCode));
    const candCodes = new Set(candidates.map((c) => c.departmentCode));
    expect(invCodes.size).toBe(1710);
    for (const c of candCodes) expect(invCodes.has(c)).toBe(true);
  });
  it("per-school counts match the P4.2b audit", () => {
    const inv = buildFull();
    const candCounts = new Map<string, number>();
    for (const c of candidates) candCounts.set(c.schoolCode, (candCounts.get(c.schoolCode) ?? 0) + 1);
    for (const [school, n] of candCounts) {
      expect(inv.filter((e) => e.schoolCode === school)).toHaveLength(n);
    }
  });
  it("all 1710 candidates are confirmed_new (nothing uncertain queued)", () => {
    for (const c of candidates) expect(c.validationStatus).toBe("confirmed_new");
  });
});

describe("P4.2d-4/5: --school filtering (new schools + 003 unchanged)", () => {
  const inv = buildFull();
  const bySchool = (school: string) => inv.filter((e) => e.schoolCode === school);
  it("--school 012 selects 17", () => {
    expect(bySchool("012")).toHaveLength(17);
  });
  it("--school 028 selects 4", () => {
    expect(bySchool("028")).toHaveLength(4);
  });
  it("--school 063 selects 4", () => {
    expect(bySchool("063")).toHaveLength(4);
  });
  it("--school 003 still selects the same 51 with names intact", () => {
    expect(bySchool("003")).toHaveLength(51);
    expect(PDF_NAMES["003112"]).toBe("應用經濟學系");
    expect(PDF_NAMES["003192"]).toBe("機械工程學系");
  });
  it("acquire and queue filter on the same schoolCode rule (source scan)", () => {
    const acquire = fs.readFileSync(path.join(__dirname, "..", "scripts", "admission-acquire.ts"), "utf8");
    const queue = fs.readFileSync(path.join(__dirname, "..", "scripts", "admission-queue.ts"), "utf8");
    expect(acquire).toMatch(/r\.entry\.schoolCode === schoolFilter/);
    expect(queue).toContain("bySchool(r.entry) === schoolFilter");
    expect(queue).not.toMatch(/bySchool\(r\.entry\.departmentCode\)/);
  });
});

describe("P4.2d-6: unverified or bad-URL candidates never enter the queue", () => {
  it("annotation/builder mismatch fails closed", () => {
    expect(() =>
      assertAnnotationMatchesBuilder(
        "https://www.cac.edu.tw/apply115/system/X/html/115_012012.htm",
        115,
        "012022",
      ),
    ).toThrow();
  });
  it("cross-school codes rejected, never fuzzy-matched", () => {
    const synth =
      "obj /URI (https://www.cac.edu.tw/apply115/system/X/html/115_012012.htm)>> " +
      "obj /URI (https://www.cac.edu.tw/apply115/system/X/html/115_012022.htm)>>";
    expect(() => buildInventory({ "013": synth })).toThrow(/does not belong to school/);
    const ok = buildInventory({ "012": synth });
    expect(ok.map((e) => e.departmentCode)).toEqual(["012012", "012022"]);
  });
  it("new-school PENDING requires explicit queue states (no silent LOADED)", () => {
    const entry = {
      academicYear: 115,
      schoolCode: "012",
      departmentCode: "012012",
      departmentName: null,
      detailUrl: "x",
      source: "official-pdf" as const,
    };
    expect(
      resolveStatus(entry, { dbLoaded: null, rawHtm: false, rawMeta: false, parsed: null, validated: null }),
    ).toBe("PENDING");
  });
});

describe("P4.2d-7: same department, different tracks are never wrongly deduped", () => {
  it("APCS vs general tracks keep distinct codes end to end", () => {
    expect(PDF_NAMES["001582"]).toBe("資訊工程學系");
    expect(PDF_NAMES["001592"]).toBe("資訊工程學系(APCS組)");
    const synth =
      "obj /URI (https://www.cac.edu.tw/apply115/system/X/html/115_001582.htm)>> " +
      "obj /URI (https://www.cac.edu.tw/apply115/system/X/html/115_001592.htm)>>";
    expect(extractPdfDetailLinks(synth).map((l) => l.code)).toEqual(["001582", "001592"]);
  });
  it("repeated annots of one code dedupe to a single entry (identity rule)", () => {
    const synth =
      "obj /URI (https://www.cac.edu.tw/apply115/system/X/html/115_028012.htm?v=1.0)>> " +
      "obj /URI (https://www.cac.edu.tw/apply115/system/X/html/115_028012.htm)>>";
    expect(extractPdfDetailLinks(synth)).toHaveLength(1);
  });
});

describe("P4.2d-8: existing DB/raw drift is never marked fixed", () => {
  it("queue LOADED still means row-exists only; drift stays with the independent audit", () => {
    const entry = {
      academicYear: 115,
      schoolCode: "008",
      departmentCode: "008432",
      departmentName: null,
      detailUrl: "x",
      source: "official-pdf" as const,
    };
    // Drift (raw differs from DB) does not surface here by design — the
    // p4 normalization audit owns drift; the queue must not claim repair.
    expect(
      resolveStatus(entry, { dbLoaded: true, rawHtm: true, rawMeta: true, parsed: true, validated: true }),
    ).toBe("LOADED");
    const queue = fs.readFileSync(path.join(__dirname, "..", "scripts", "admission-queue.ts"), "utf8");
    expect(queue).not.toMatch(/drift/i);
  });
});

describe("P4.2d-9: no CDP navigation, Neon writes, or loader entry", () => {
  it("inventory + policy modules are network/DB free (source scan)", () => {
    for (const f of [
      "src/data/discovery/official/application115/pdf-inventory.ts",
      "src/data/acquisition/browser/policy.ts",
    ]) {
      const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      expect(src).not.toMatch(/fetch\(|axios|pg\.Client|executeDbLoad|child_process|navigateTab|ensureSingleTab/i);
    }
  });
  it("acquire prints the access policy before any confirmation or queue work", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "admission-acquire.ts"), "utf8");
    const policyIdx = src.indexOf("accessPolicyLines()");
    expect(policyIdx).toBeGreaterThan(-1);
    expect(policyIdx).toBeLessThan(src.indexOf("confirmChrome("));
    expect(policyIdx).toBeLessThan(src.indexOf("runQueue("));
  });
  it("policy states robots Disallow:/ and --yes limits", () => {
    expect(CAC_ROBOTS_DISALLOW_ALL).toBe(true);
    const lines = accessPolicyLines().join("\n");
    expect(lines).toMatch(/Disallow:\//);
    expect(lines).toMatch(/--yes is intent only, not site authorization/);
    expect(lines).toMatch(/no bulk HTTP requests/);
  });
});

describe("P4.2d-10: 54-school list stays traceable to the PDF audit", () => {
  it("every new school PDF exists on disk under its candidate sourceFile name", () => {
    const seen = new Set<string>();
    for (const c of candidates) {
      if (seen.has(c.schoolCode)) continue;
      seen.add(c.schoolCode);
      const base = c.sourceFile.split("/").pop()!;
      expect(PDF_FILES[c.schoolCode]).toBe(base);
      expect(fs.existsSync(path.join(rawRoot, base))).toBe(true);
    }
    expect(seen.size).toBe(54);
  });
  it("PDF_NAMES covers all 2206 inventory codes; old names untouched", () => {
    expect(Object.keys(PDF_NAMES)).toHaveLength(2206);
    expect(PDF_NAMES["001032"]).toBe("歷史學系");
    expect(PDF_NAMES["004012"]).toBe("中國文學系");
    expect(PDF_NAMES["011572"]).toBe("藝術與設計學系設計組");
    expect(PDF_NAMES["047012"]).toBe("新聞學系");
  });
});
