import { describe, expect, it } from "vitest";
import { parseDetailHtml } from "../src/data/importers/official/application115/detail/parser";

/**
 * P4.4a row-shape regression tests (synthetic layout-B only).
 * Mirrors the exact row shapes proven in the P4.3 audit against real raw
 * HTML (001262 composite row, 005092 國英 row, 008382/009032/009062 empty
 * rows, 008432 `--`/empty rows, 002582/009432 tech attribution) without
 * depending on raw files: no network, no DB, local strings only.
 */

const g3 = (lines: string): string => `<td class="g3">${lines}</td>`;

function page(codeRowInner: string, extra = ""): string {
  return `<html><body><table>
<tr><td class="school_title"><div class="colname">S</div><div class="gsdname">D</div></td></tr>
<tr>${codeRowInner}</tr>${extra}</table></body></html>`;
}

function codeRow(c0: string, c5: string, tech = ""): string {
  return `<td class="Lb">校系代碼</td><td class="Rb">008991</td>`
    + g3(c0) + g3("") + g3("") + g3("") + g3("") + g3(c5) + g3("") + g3("") + tech;
}

const std8 = (c0: string, c5: string, tech = ""): string =>
  page(codeRow(c0, c5, tech));

function parse(html: string) {
  return parseDetailHtml(html, { sourceUrl: "synthetic-p44a", dataVersion: "p44a" });
}

describe("P4.4a secondStage independent of subject cell", () => {
  it("composite subject row keeps its item (001262 國英數A自 → 生物+化學 shape)", () => {
    // Direct shape: composite row carries the item.
    const { record: rec, issues: iss } = parse(page(
      `<td class="Lb">校系代碼</td><td class="Rb">008991</td>`
      + g3("國文<br>國英數A自") + g3("") + g3("") + g3("") + g3("")
      + g3("審查資料<br>生物+化學") + g3("") + g3(""),
    ));
    expect(iss.filter((i) => i.level === "error")).toHaveLength(0);
    expect(rec!.subjectRequirements.map((s) => s.subject)).toEqual(["國文"]);
    expect(rec!.secondStageItems.map((s) => s.name)).toEqual(["審查資料", "生物+化學"]);
    expect(rec!.unmapped.join("\n")).toMatch(/grade subject without mapping: 國英數A自/);
  });
  it("國英 composite row keeps 面試 (005092 shape)", () => {
    const { record } = parse(page(
      `<td class="Lb">校系代碼</td><td class="Rb">008991</td>`
      + g3("英文<br>國英") + g3("") + g3("") + g3("") + g3("")
      + g3("審查資料<br>面試") + g3("") + g3(""),
    ));
    expect(record!.subjectRequirements.map((s) => s.subject)).toEqual(["英文"]);
    expect(record!.secondStageItems.map((s) => s.name)).toEqual(["審查資料", "面試"]);
  });
  it("empty subject row keeps its item (008382/009032/009062 shape)", () => {
    const { record } = parse(page(
      `<td class="Lb">校系代碼</td><td class="Rb">008991</td>`
      + g3("英文<br>") + g3("") + g3("") + g3("") + g3("")
      + g3("審查資料<br>面試") + g3("") + g3(""),
    ));
    expect(record!.secondStageItems.map((s) => s.name)).toEqual(["審查資料", "面試"]);
  });
  it("`--` row keeps its item and invents no subject (008432 shape)", () => {
    const { record, issues } = parse(std8("--", "審查資料"));
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
    expect(record!.subjectRequirements).toEqual([]);
    expect(record!.secondStageItems.map((s) => s.name)).toEqual(["審查資料"]);
  });
  it("unknown subject is traced, never dropped silently, item kept", () => {
    const { record } = parse(std8("火星語", "面試"));
    expect(record!.subjectRequirements).toEqual([]);
    expect(record!.secondStageItems.map((s) => s.name)).toEqual(["面試"]);
    expect(record!.unmapped.join("\n")).toMatch(/grade subject without mapping: 火星語/);
  });
});

describe("P4.4a tech block shapes", () => {
  const tech5attr =
    g3("主修") + g3("--") + g3("◎") + g3("*1.00") + g3("90%");
  it("1:1 attribution single-homes weight in second_stage (002582/009432 shape)", () => {
    const { record, issues } = parse(page(
      `<td class="Lb">校系代碼</td><td class="Rb">008991</td>`
      + g3("--") + g3("") + g3("") + g3("") + g3("")
      + g3("審查資料") + g3("") + g3("") + tech5attr,
    ));
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
    expect(record!.secondStageItems).toEqual([
      expect.objectContaining({ name: "審查資料" }),
      expect.objectContaining({ name: "主修", weight: "90%" }),
    ]);
    // ◎ multiplier stays null, never 0.
    expect(record!.techScreening).toMatchObject({ weight: null, weightStatus: "attributed_to_stage2" });
    expect(record!.techScreening!.items).toHaveLength(1);
    expect(record!.techScreening!.items[0]).toMatchObject({ name: "主修", requirement: null, multiplier: null });
  });
  it("shared multi-item aggregate is not split (008432 shape)", () => {
    const tech = g3("彩繪技法<br>創意表現") + g3("--<br>--") + g3("5<br>3") + g3("*1.00<br>*1.50") + g3("40%");
    const { record } = parse(page(
      `<td class="Lb">校系代碼</td><td class="Rb">008991</td>`
      + g3("--<br>") + g3("") + g3("") + g3("") + g3("")
      + g3("審查資料<br>面試") + g3("") + g3("") + tech,
    ));
    const names = record!.secondStageItems.map((s) => s.name);
    expect(names).toEqual(["審查資料", "面試"]);
    expect(record!.techScreening).toMatchObject({ weight: "40%", weightStatus: "shared" });
    expect(record!.techScreening!.items.map((t) => t.name)).toEqual(["彩繪技法", "創意表現"]);
  });
  it("3-cell APCS-variant tech columns are skipped, tech stays null", () => {
    const { record } = parse(std8("國文", "", g3("A") + g3("B") + g3("C")));
    expect(record!.subjectRequirements.map((s) => s.subject)).toEqual(["國文"]);
    expect(record!.techScreening).toBeNull();
  });
  it("unknown tech shape is traced and skipped, never guessed", () => {
    const { record } = parse(std8("國文", "", g3("A") + g3("B") + g3("C") + g3("D")));
    expect(record!.techScreening).toBeNull();
    expect(record!.unmapped.join("\n")).toMatch(/unexpected tech block shape: 4 g3 cells/);
  });
  it("standard page without tech emits techScreening null", () => {
    const { record } = parse(std8("國文<br>英文", "審查資料<br>口試"));
    expect(record!.techScreening).toBeNull();
    expect(record!.secondStageItems.map((s) => s.name)).toEqual(["審查資料", "口試"]);
  });
});

describe("P4.4a scoping", () => {
  it("tech/secondStage scope to the first code row; identity enforced downstream", () => {
    const { record } = parse(page(codeRow("國文", "審查資料"),
      `<tr><td class="Lb">校系代碼</td><td class="Rb">009999</td>`
      + g3("英文") + g3("") + g3("") + g3("") + g3("") + g3("口試") + g3("") + g3("") + `</tr>`));
    // First code row wins; a second department row can never merge in.
    expect(record!.departmentCode).toBe("008991");
    expect(record!.secondStageItems.map((s) => s.name)).toEqual(["審查資料"]);
  });
});
