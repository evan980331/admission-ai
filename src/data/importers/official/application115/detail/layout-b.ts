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
      // Second-stage columns are independent of the subject cell: a row with
      // `--`/unknown subject (pure 術科 screening) can still carry 指定項目.
      // The item (if any) is resolved first so the unmapped trace below can
      // record whether this row's screening content survived (covered) or
      // not — the P4.1d guard keys off uncovered rows only.
      const itemName = toNull(cols[5]![i] ?? "");
      if (!subject) {
        emptyLines++;
      } else if (!KNOWN_SUBJECTS.includes(subject)) {
        // NOT fatal: tech-layout (術科) rows carry `--` here while their
        // second-stage columns still hold real items (processed below,
        // independent of subject validity). Recorded for traceability.
        unmapped.push(
          itemName
            ? `grade subject without mapping: ${subject} (second-stage captured: ${itemName})`
            : `grade subject without mapping: ${subject}`,
        );
      } else {
        const req = toNull(cols[1]![i] ?? "");
        const mult = toRatio(cols[2]![i] ?? "");
        const method = toNull(cols[3]![i] ?? "");
        subjectRequirements.push({ subject, requirement: req, multiplier: mult, scoreMethod: method });
        rawFields[`grade:${subject}`] = [cols[1]![i] ?? "", cols[2]![i] ?? "", cols[3]![i] ?? ""].join("|");
        const w = (cols[4]![i] ?? "").replace(/\s+/g, "");
        if (/%/.test(w)) overallFirstStageWeight = w;
      }
      // Second-stage columns are independent of the subject cell (resolved
      // above); an item here only means the row carried screening content.
      if (itemName) {
        secondStageItems.push({ name: itemName, requirement: toNull(cols[6]![i] ?? ""), weight: toNull(cols[7]![i] ?? "") });
        rawFields[`stage2:${itemName}`] = `${cols[6]![i] ?? ""}|${cols[7]![i] ?? ""}`;
      }
    }
    if (emptyLines > 2) unmapped.push(`${emptyLines} empty lines in layout-B grade lists (layout padding)`);
  }

  // ---- Tech-layout 術科 block (g3 cells past the 8 standard cols:
  // 術科項目 | 檢定 | 篩選倍率 | 術科成績採計 | 佔比). Shape-gated:
  // 5 cells = arts variant (parsed below); 3 cells = APCS variant whose
  // columns duplicate the nested APCS table (skipped, authoritative there);
  // anything else = unknown shape, traced, never guessed.
  // The 術科成績佔比 is a genuine 甄選總成績 component. Attribution rule:
  // exactly one named 術科項目 AND exactly one 佔比 -> the value is held by
  // the second_stage item (task-A path) and the group records
  // weight=null/status=attributed_to_stage2. Otherwise the raw aggregate
  // stays on the group (shared) or stays null (unstated) — never split.
  let techScreening: DetailRecord["techScreening"] = null;
  {
    const rawTech = codeRow ? codeRow.querySelectorAll("td").filter((td) => (td.getAttribute("class") ?? "").split(/\s+/).includes("g3")).slice(8) : [];
    if (rawTech.length === 5) {
      const techCols = rawTech.map(linesOf);
      while (techCols.length < 5) techCols.push([]);
      const tNames = (techCols[0] ?? []).map((s) => s.trim()).filter((s) => toNull(s) !== null);
      const tWeights = (techCols[4] ?? []).map((s) => s.trim()).filter((s) => toNull(s) !== null);
      let attributed: { name: string; weight: string } | null = null;
      if (tNames.length === 1 && tWeights.length === 1 && /%/.test(tWeights[0]!)) {
        const tReqLine = (techCols[1] ?? []).map((s) => s.trim()).find((s) => toNull(s) !== null) ?? "";
        secondStageItems.push({ name: tNames[0]!, requirement: toNull(tReqLine), weight: toNull(tWeights[0]!) });
        rawFields[`stage2-tech:${tNames[0]}`] = `${tReqLine}|${tWeights[0]!}`;
        attributed = { name: tNames[0]!, weight: tWeights[0]! };
      } else if (tNames.length > 0) {
        unmapped.push(`tech 術科 second-stage not 1:1 attributable (items=${tNames.join("/")} weights=${tWeights.join("/")}); needs modeling decision`);
      }
      // Group + screening-role items (positional pairing by visual row;
      // missing cells stay null, never shifted).
      const tReq = techCols[1] ?? [];
      const tMult = techCols[2] ?? [];
      const tMethod = techCols[3] ?? [];
      const items = (techCols[0] ?? [])
        .map((s, i) => ({
          name: s.trim(),
          requirement: toNull(tReq[i] ?? ""),
          multiplier: toRatio(tMult[i] ?? ""),
          scoreMethod: toNull(tMethod[i] ?? ""),
        }))
        .filter((it) => toNull(it.name) !== null);
      if (items.length > 0) {
        const singleWeight = tWeights.length === 1 ? tWeights[0]! : null;
        if (tWeights.length > 1) {
          unmapped.push(`tech 術科 aggregate weight ambiguous (weights=${tWeights.join("/")}); kept null`);
        }
        const weightStatus = attributed ? "attributed_to_stage2" : singleWeight ? "shared" : "unstated";
        techScreening = {
          weight: attributed ? null : singleWeight,
          weightStatus,
          items,
        };
        rawFields["tech:group"] = `weight=${singleWeight ?? ""} status=${weightStatus} items=${items.map((it) => it.name).join("/")}`;
        for (const it of items) {
          rawFields[`tech:${it.name}`] = [tReq[items.indexOf(it)] ?? "", tMult[items.indexOf(it)] ?? "", tMethod[items.indexOf(it)] ?? ""].join("|");
        }
      }
    } else if (rawTech.length > 0 && rawTech.length !== 3) {
      unmapped.push(`unexpected tech block shape: ${rawTech.length} g3 cells past standard 8; skipped`);
    }
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
  // A 備註 label with an empty value cell (e.g. 101022) means the source
  // publishes no notices — recorded explicitly so the audit layer can tell
  // "present-but-empty" apart from "section missing". Never fabricated.
  let notes: string[] = [];
  let notesSourceEmpty = false;
  if (remarkText) {
    notes = splitNumberedItems(remarkText);
  } else {
    const noteCell = root.querySelector("td.note_ft");
    if (noteCell) {
      // Empty value cell (e.g. 101022) vs unparseable prose: only the
      // former is marked present-but-empty; prose keeps the plain warning.
      if (cellText(noteCell).trim() === "") notesSourceEmpty = true;
      notes = splitNumberedItems(cellText(noteCell));
    } else {
      const labelCell = root.querySelectorAll("td").find((td) => flatLabel(cellText(td)) === "備註");
      if (labelCell) {
        const sib = labelCell?.nextElementSibling;
        if (sib && sib.tagName === "TD") {
          if (cellText(sib as HTMLElement).trim() === "") notesSourceEmpty = true;
          notes = splitNumberedItems(cellText(sib as HTMLElement));
        } else {
          notesSourceEmpty = true;
        }
      }
    }
  }
  if (notes.length === 0) {
    warn("section", "no notes found");
    if (notesSourceEmpty) unmapped.push("notes section present but empty (no published notices)");
  }

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
    techScreening,
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
