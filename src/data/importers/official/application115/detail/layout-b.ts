import type { HTMLElement } from "node-html-parser";
import {
  BASIC_LABELS,
  KNOWN_SUBJECTS,
  cellText,
  splitNumberedItems,
  toInt,
  toNull,
  toRatio,
  type ParseOptions,
} from "./parser";
import { DETAIL_PARSER_VERSION, DETAIL_YEAR, type DetailIssue, type DetailParseResult, type DetailRecord } from "./types";

/**
 * Layout-B parser: desktop single-table CAC template (no section IDs).
 * Anchors: td.school_title (div.colname/div.gsdname), td.Lb label cells,
 * rowspan=7 g3 grade-list cells, td.stestdesc_ft2 / td.note_ft content cells.
 * Produces the same canonical DetailRecord as layout-A.
 */

function flatLabel(s: string): string {
  return s.replace(/\s+/g, "");
}

function linesOf(cell: HTMLElement): string[] {
  return cellText(cell)
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseLayoutB(root: HTMLElement, opts: ParseOptions): DetailParseResult {
  const issues: DetailIssue[] = [];
  const unmapped: string[] = [];
  const rawFields: Record<string, string> = {};
  const err = (check: string, detail: string) => issues.push({ level: "error", check, detail });
  const warn = (check: string, detail: string) => issues.push({ level: "warning", check, detail });

  // ---- Title ----
  const titleCell = root.querySelector("td.school_title");
  if (!titleCell) {
    err("layout", "layout-B title cell (td.school_title) not found; not a recognized CAC layout");
    return { record: null, issues };
  }
  const schoolName = (() => {
    const el = titleCell.querySelector("div.colname");
    const t = cellText(el).trim();
    return t || null;
  })();
  const departmentName = (() => {
    const el = titleCell.querySelector("div.gsdname");
    const t = cellText(el).trim();
    return t || null;
  })();

  // ---- BASIC label->value pairs (td.Lb followed by its value cell) ----
  // Special full-row sections (over-quota rules, 備註) are routed directly
  // instead of the generic label dict.
  let overQuotaText: string | null = null;
  let remarkText: string | null = null;
  const basic: Record<string, string> = {};
  for (const tr of root.querySelectorAll("table tr")) {
    const tds = tr.querySelectorAll("td");
    for (let i = 0; i < tds.length; i++) {
      const cls = (tds[i]!.getAttribute("class") ?? "").split(/\s+/);
      if (!cls.includes("Lb")) continue;
      const label = flatLabel(cellText(tds[i]));
      // Skip layout furniture (vertical headings without value semantics).
      if (!label || /^(指定項目內容|甄試說明|審查資料)$/.test(label)) continue;
      if (/同級分.{0,4}超額篩選方式/.test(label)) {
        overQuotaText = cellText(tds[i + 1] ?? null);
        rawFields["overQuota"] = (overQuotaText ?? "").slice(0, 300);
        continue;
      }
      if (label === "備註") {
        remarkText = cellText(tds[i + 1] ?? null);
        rawFields["remark"] = (remarkText ?? "").slice(0, 300);
        continue;
      }
      if (!tds[i + 1]) {
        unmapped.push(`BASIC label without value cell: ${label}`);
        continue;
      }
      const value = cellText(tds[i + 1]);
      if (!(label in basic)) {
        basic[label] = value;
        rawFields[`basic:${label}`] = value;
      }
    }
  }
  const mapped: Record<string, string | null> = {};
  for (const [label, value] of Object.entries(basic)) {
    const key = BASIC_LABELS[label];
    if (!key) {
      unmapped.push(`BASIC label without mapping: ${label}=${value.slice(0, 60)}`);
      continue;
    }
    mapped[key] = value;
  }

  const departmentCode = (basic["校系代碼"] ?? "").trim();
  const schoolCode = /^\d{6}$/.test(departmentCode) ? departmentCode.slice(0, 3) : "";

  // ---- Grade matrix: the code row's td.g3 cells in column order ----
  const subjectRequirements: DetailRecord["subjectRequirements"] = [];
  const secondStageItems: DetailRecord["secondStageItems"] = [];
  let overallFirstStageWeight: string | null = null;
  let emptyLines = 0;
  const codeRow = root.querySelectorAll("table tr").find((tr) =>
    tr.querySelectorAll("td").some((td) => flatLabel(cellText(td)) === "校系代碼"),
  );
  if (!codeRow) {
    err("grade", "layout-B code row not found");
  } else {
    const g3 = codeRow.querySelectorAll("td").filter((td) => (td.getAttribute("class") ?? "").split(/\s+/).includes("g3"));
    // Expected column order: subjects, 檢定, 倍率, 採計, 佔比, 指定項目, 檢定2, 佔比2.
    const cols = g3.slice(0, 8).map(linesOf);
    while (cols.length < 8) cols.push([]);
    const n = Math.max(...cols.map((c) => c.length));
    for (let i = 0; i < n; i++) {
      const subject = (cols[0]![i] ?? "").trim();
      if (!subject) {
        emptyLines++;
        continue;
      }
      if (!KNOWN_SUBJECTS.includes(subject)) {
        unmapped.push(`grade subject without mapping: ${subject}`);
        continue;
      }
      const req = toNull(cols[1]![i] ?? "");
      const mult = toRatio(cols[2]![i] ?? "");
      const method = toNull(cols[3]![i] ?? "");
      subjectRequirements.push({ subject, requirement: req, multiplier: mult, scoreMethod: method });
      rawFields[`grade:${subject}`] = [cols[1]![i] ?? "", cols[2]![i] ?? "", cols[3]![i] ?? ""].join("|");
      const w = (cols[4]![i] ?? "").replace(/\s+/g, "");
      if (/%/.test(w)) overallFirstStageWeight = w;
      const itemName = toNull(cols[5]![i] ?? "");
      if (itemName) {
        secondStageItems.push({ name: itemName, requirement: toNull(cols[6]![i] ?? ""), weight: toNull(cols[7]![i] ?? "") });
        rawFields[`stage2:${itemName}`] = `${cols[6]![i] ?? ""}|${cols[7]![i] ?? ""}`;
      }
    }
    if (emptyLines > 2) unmapped.push(`${emptyLines} empty lines in layout-B grade lists (layout padding)`);
  }

  // ---- Tie-break: non-g3, non-label cell in the code row with numbered items ----
  // (The tie-break cell carries class Rb like value cells; only the numbered
  // list shape distinguishes it. A bare code value yields <2 items.)
  const tieBreakingRules: string[] = [];
  if (codeRow) {
    for (const td of codeRow.querySelectorAll("td")) {
      const cls = (td.getAttribute("class") ?? "").split(/\s+/);
      if (cls.includes("g3") || cls.includes("Lb")) continue;
      const items = splitNumberedItems(cellText(td));
      if (items.length >= 2 && /^一、/.test(items[0]!)) {
        tieBreakingRules.push(...items);
        rawFields["tiebreak"] = items.join(" / ").slice(0, 300);
        break;
      }
    }
  }
  if (tieBreakingRules.length === 0) warn("tiebreak", "no tie-break cell found in layout-B code row");

  // ---- Over-quota rules (BASIC pair first, nested-cell fallback) ----
  const overQuotaRules: string[] = [];
  if (overQuotaText) {
    overQuotaRules.push(...splitNumberedItems(overQuotaText));
  } else {
    const overCells = root
      .querySelectorAll("td")
      .filter((td) => /同級分.{0,4}超額篩選方式/.test(cellText(td)))
      .sort((a, b) => cellText(a).length - cellText(b).length);
    if (overCells[0]) {
      const body = cellText(overCells[0]).replace(/^.*超額篩選方式\s*[:：]?/s, "");
      overQuotaRules.push(...splitNumberedItems(body));
      rawFields["overQuota"] = body.slice(0, 300);
    } else {
      warn("overQuota", "no over-quota cell found");
    }
  }

  // ---- APCS: innermost table carrying the marker (layout-B structure unknown) ----
  let apcs: DetailRecord["apcs"] = null;
  const apcsTables = root
    .querySelectorAll("table")
    .filter((t) => /APCS篩選方式/.test(cellText(t)))
    .sort((a, b) => cellText(a).length - cellText(b).length);
  if (apcsTables[0]) {
    const items: { subject: string; requirement: string | null; multiplier: number | null }[] = [];
    let note: string | null = null;
    for (const r of apcsTables[0].querySelectorAll("tr")) {
      const c = r.querySelectorAll("td").map((d) => cellText(d));
      if (c.length >= 3 && c[0] && !/科目|APCS/.test(c[0])) {
        items.push({ subject: c[0], requirement: toNull(c[1] ?? ""), multiplier: toRatio(c[2] ?? "") });
      }
      if (/APCS說明/.test(c[0] ?? "")) note = c.slice(1).join(" ").trim() || null;
    }
    apcs = { items, note };
    rawFields["apcs"] = items.map((i) => `${i.subject}:${i.requirement}:${i.multiplier}`).join(";");
    if (items.length === 0) warn("apcs", "APCS marker present but no items parsed (layout-B APCS structure unverified)");
  }

  // ---- Review (項目：/說明：) ----
  let reviewItems: string | null = null;
  let reviewNotes: string | null = null;
  const reviewCell = root
    .querySelectorAll("td")
    .filter((td) => /項目：/.test(cellText(td)))
    .sort((a, b) => cellText(a).length - cellText(b).length)[0];
  if (reviewCell) {
    const text = cellText(reviewCell);
    const parts = text.split(/(?=說明\s*[:：])/);
    reviewItems = parts[0]?.replace(/^項目\s*[:：]?/, "").trim() || null;
    reviewNotes = parts.slice(1).join(" ").replace(/^說明\s*[:：]?/, "").trim() || null;
    rawFields["review"] = text.slice(0, 500);
  } else {
    warn("section", "no review (項目：) cell found");
  }

  // ---- Interview notes (stestdesc cells) + generic numbered fallback ----
  let interviewNotes: string | null = null;
  const stest = root.querySelectorAll("td").filter((td) => (td.getAttribute("class") ?? "").includes("stestdesc"));
  if (stest.length > 0) {
    const items = splitNumberedItems(stest.map((td) => cellText(td)).join("\n"));
    interviewNotes = items.length > 0 ? items.join("\n") : null;
    rawFields["interview"] = stest.map((td) => cellText(td)).join("\n").slice(0, 500);
  } else {
    warn("section", "no stestdesc interview cell found");
  }

  // ---- Notes (BASIC-pair remark first, note_ft, else Lb=備註 sibling) ----
  let notes: string[] = [];
  if (remarkText) {
    notes = splitNumberedItems(remarkText);
  } else {
    const noteCell = root.querySelector("td.note_ft");
    if (noteCell) {
      notes = splitNumberedItems(cellText(noteCell));
    } else {
      const labelCell = root.querySelectorAll("td").find((td) => flatLabel(cellText(td)) === "備註");
      const sib = labelCell?.nextElementSibling;
      if (sib && sib.tagName === "TD") notes = splitNumberedItems(cellText(sib as HTMLElement));
    }
  }
  if (notes.length === 0) warn("section", "no notes found");

  // ---- Offshore restriction fallback: the label cell can sit in a row of
  // its own (rowspan layout) while the value lives rows below. Pattern-match
  // the value shape (e.g. 1名限連江縣) rather than guessing.
  let offshoreRestriction = toNull(mapped["offshoreRestriction"] ?? "");
  if (!offshoreRestriction) {
    const cands = root
      .querySelectorAll("td")
      .map((td) => cellText(td).trim())
      .filter((t) => /名限.+縣/.test(t));
    if (cands.length === 1) {
      offshoreRestriction = cands[0]!;
      rawFields["offshoreRestriction:fallback"] = cands[0]!;
    } else if (cands.length > 1) {
      unmapped.push(`multiple offshore-restriction candidates, kept null: ${cands.slice(0, 3).join(" / ")}`);
    }
  }

  if (!departmentCode) {
    err("identity", "departmentCode missing (no 校系代碼 label)");
    return { record: null, issues };
  }

  const record: DetailRecord = {
    academicYear: DETAIL_YEAR,
    schoolCode,
    departmentCode,
    schoolName,
    departmentName,
    quota: toInt(mapped["quota"] ?? ""),
    expectedInterviewCount: toInt(mapped["expectedInterviewCount"] ?? ""),
    genderRequirement: toNull(mapped["genderRequirement"] ?? ""),
    subjectRequirements,
    overallFirstStageWeight,
    overQuotaRules,
    tieBreakingRules,
    secondStageItems,
    reviewItems,
    reviewNotes,
    interviewNotes,
    extraQuotas: {
      indigenous: toNull(mapped["extraQuota.indigenous"] ?? ""),
      offshore: toNull(mapped["extraQuota.offshore"] ?? ""),
      vision: toNull(mapped["extraQuota.vision"] ?? ""),
    },
    applicationFee: toInt(mapped["applicationFee"] ?? ""),
    notificationDate: toNull(mapped["notificationDate"] ?? ""),
    materialDeadline: toNull(mapped["materialDeadline"] ?? ""),
    secondStageDate: toNull(mapped["secondStageDate"] ?? ""),
    resultDate: toNull(mapped["resultDate"] ?? ""),
    recheckDeadline: toNull(mapped["recheckDeadline"] ?? ""),
    offshoreRestriction,
    notes,
    apcs,
    source: "official",
    sourceUrl: opts.sourceUrl,
    retrievedAt: opts.retrievedAt ?? null,
    parserVersion: DETAIL_PARSER_VERSION,
    dataVersion: opts.dataVersion ?? "",
    rawFields,
    unmapped,
  };
  return { record, issues };
}
