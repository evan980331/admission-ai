import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseDetailHtml } from "../src/data/importers/official/application115/detail/parser";
import {
  findDroppedGsatCells,
  P4_EXPECTED_COUNTS,
  resolveExpectedTotal,
} from "../src/data/normalization/admission115";

/**
 * Full-scope normalize fixes (101022 empty notices, 023292 covered
 * composite, dynamic inventory scope). Synthetic layout-B only: no raw
 * files, no DB, no network.
 */

const g3 = (lines: string): string => `<td class="g3">${lines}</td>`;

function page(codeRowInner: string, extra = ""): string {
  return `<html><body><table>
<tr><td class="school_title"><div class="colname">S</div><div class="gsdname">D</div></td></tr>
<tr>${codeRowInner}</tr>${extra}</table></body></html>`;
}

function codeRow(c0: string, c5: string, tech = ""): string {
  return `<td class="Lb">校系代碼</td><td class="Rb">990012</td>`
    + g3(c0) + g3("") + g3("") + g3("") + g3("") + g3(c5) + g3("") + g3("") + tech;
}

const parse = (html: string) =>
  parseDetailHtml(html, { sourceUrl: "synthetic-scope", dataVersion: "test" });

describe("covered composite rows are not dropped content", () => {
  it("composite subject with captured item is traced but not dropped", () => {
    const { record, issues } = parse(page(
      `<td class="Lb">校系代碼</td><td class="Rb">990012</td>`
      + g3("國英社") + g3("") + g3("") + g3("") + g3("")
      + g3("審查資料") + g3("") + g3(""),
    ));
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
    expect(record!.secondStageItems.map((s) => s.name)).toEqual(["審查資料"]);
    const traces = (record!.unmapped ?? []).filter((u) => u.startsWith("grade subject without mapping:"));
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatch(/\(second-stage captured: 審查資料\)/);
    // Covered: the guard sees no dropped content here.
    expect(findDroppedGsatCells(record!.unmapped ?? [])).toEqual([]);
  });
  it("composite subject with no captured item still fires the guard", () => {
    const { record } = parse(page(
      `<td class="Lb">校系代碼</td><td class="Rb">990012</td>`
      + g3("國英社") + g3("") + g3("") + g3("") + g3("")
      + g3("") + g3("") + g3(""),
    ));
    const traces = (record!.unmapped ?? []).filter((u) => u.startsWith("grade subject without mapping:"));
    expect(traces).toEqual(["grade subject without mapping: 國英社"]);
    expect(findDroppedGsatCells(record!.unmapped ?? [])).toEqual(["grade subject without mapping: 國英社"]);
  });
  it("legacy bare inputs keep exact legacy behavior", () => {
    expect(findDroppedGsatCells(["grade subject without mapping: --", "grade subject without mapping: "])).toEqual([]);
    expect(findDroppedGsatCells(["grade subject without mapping: 物理"])).toEqual(["grade subject without mapping: 物理"]);
  });
});

describe("empty-but-present notes section is marked, never fabricated", () => {
  const remarkRow = `<tr><td class="Lb RBb">備註</td><td class="RBb note_ft"></td></tr>`;
  it("empty note_ft cell yields the present-but-empty marker, zero notes", () => {
    const { record, issues } = parse(page(codeRow("國文", "審查資料"), remarkRow));
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
    expect(record!.notes).toEqual([]);
    expect(record!.unmapped).toContain("notes section present but empty (no published notices)");
  });
  it("normal notes page carries no empty marker", () => {
    const { record } = parse(
      page(codeRow("國文", "審查資料"), `<tr><td class="Lb">備註</td><td class="Rb">一、注意A</td></tr>`),
    );
    expect(record!.notes.length).toBeGreaterThan(0);
    expect(record!.unmapped).not.toContain("notes section present but empty (no published notices)");
  });
  it("page with no notes section at all carries no marker", () => {
    const { record } = parse(page(codeRow("國文", "審查資料")));
    expect(record!.notes).toEqual([]);
    expect(record!.unmapped).not.toContain("notes section present but empty (no published notices)");
  });
});

describe("dynamic expected scope (legacy table frozen)", () => {
  const inv = { total: 2206, perSchool: new Map([["012", 17], ["003", 51]]) };
  it("department filter pins 1; school filter reads inventory; blank reads total", () => {
    expect(resolveExpectedTotal({ departmentCode: "012012" }, inv)).toBe(1);
    expect(resolveExpectedTotal({ schoolCode: "012" }, inv)).toBe(17);
    expect(resolveExpectedTotal({ schoolCode: "003" }, inv)).toBe(51);
    expect(resolveExpectedTotal({}, inv)).toBe(2206);
  });
  it("unknown schools still fail closed", () => {
    expect(() => resolveExpectedTotal({ schoolCode: "010" }, inv)).toThrow(/unknown official school code/);
    expect(() => resolveExpectedTotal({ schoolCode: "999" }, inv)).toThrow(/unknown official school code/);
  });
  it("P4_EXPECTED_COUNTS stays frozen for the legacy suite", () => {
    expect(P4_EXPECTED_COUNTS["003"]).toBe(51);
    expect(Object.keys(P4_EXPECTED_COUNTS).sort()).toEqual(["001", "002", "003", "004", "005", "006", "007", "008", "009", "011"]);
  });
});

describe("runner wiring (source locks, behavior in tests)", () => {
  const src = () => fs.readFileSync(path.join(__dirname, "..", "scripts", "normalize-admission-115.ts"), "utf8");
  it("expected total comes from inventory, not the frozen table", () => {
    expect(src()).toContain("resolveExpectedTotal(");
    expect(src()).toContain("buildInventory(pdfTexts)");
    expect(src()).not.toMatch(/p4ExpectedTotal\(/);
  });
  it("notices demotion is evidence-gated and narrow", () => {
    const s = src();
    expect(s).toContain("notices-empty-source");
    expect(s).toContain("notes section present but empty");
    // Only notices-check errors with a proven-empty source qualify.
    expect(s).toMatch(/i\.check === "notices" && i\.identityKey !== undefined && emptyNoticesKeys\.has/);
    // The underlying normalizeBatch rule still errors by default (demotion
    // lives only in the runner's evidence-gated reporting layer).
    expect(s).toContain('check: "notices-empty-source"');
  });
  it("--import gate still blocks on any remaining error", () => {
    expect(src()).toContain("IMPORT BLOCKED");
  });
});
