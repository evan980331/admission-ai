import { parse, HTMLElement } from "node-html-parser";
import { DETAIL_PARSER_VERSION, DETAIL_YEAR } from "./types";
import type {
  ApcsScreening,
  DetailIssue,
  DetailParseResult,
  DetailRecord,
  SecondStageItem,
  SubjectScreening,
} from "./types";

/**
 * CAC detail page parser — DOM/table/label-driven, never whole-page regex.
 * Section anchors: #BASIC (2-col label->value), #G_GRD (subject matrix +
 * over-quota + APCS), #G_CMP (tie-break list), #step_sd/#step_st (review /
 * interview notes), #step_no (notes). HTML comments (template placeholders)
 * are element-ignored by construction: only real sections are queried.
 */

export interface ParseOptions {
  sourceUrl: string;
  retrievedAt?: string | null;
  dataVersion?: string;
}

const KNOWN_SUBJECTS = ["國文", "英文", "數學A", "數學B", "社會", "自然", "英聽", "術科"];

const BASIC_LABELS: Record<string, string> = {
  "校系代碼": "departmentCode",
  "招生名額": "quota",
  "性別要求": "genderRequirement",
  "預計甄試人數": "expectedInterviewCount",
  "原住民外加名額": "extraQuota.indigenous",
  "離島外加名額": "extraQuota.offshore",
  "願景計畫外加名額": "extraQuota.vision",
  "指定項目甄試費": "applicationFee",
  "寄發(或公告)指定項目甄試通知": "notificationDate",
  "繳交資料收件截止": "materialDeadline",
  "指定項目甄試日期": "secondStageDate",
  "榜示": "resultDate",
  "甄選總成績複查截止": "recheckDeadline",
  "離島外加名額縣市別限制": "offshoreRestriction",
};

function clean(s: string): string {
  return s
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Element text with <br> preserved as newlines. innerHTML is used (not .text)
 *  so <br> positions survive; entities are decoded explicitly afterwards. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function cellText(el: HTMLElement | null): string {
  if (!el) return "";
  return clean(decodeEntities(el.innerHTML.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "")));
}

function toNull(s: string): string | null {
  const t = s.trim();
  return t === "" || t === "--" || t === "無" || t === "(無)" ? null : t;
}

function toInt(s: string): number | null {
  const t = s.trim().replace(/,/g, "");
  if (t === "" || t === "--" || t === "無" || t === "(無)") return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
}

function toRatio(s: string): number | null {
  const t = s.trim();
  if (t === "" || t === "--") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Split "一、xxx二、yyy" / numbered lines into items. */
export function splitNumberedItems(text: string): string[] {
  const t = text.replace(/^\s*[^一二三四五六七八九十\d]*?(?=[一二三四五六七八九十]+\s*、|\d+\s*[.、])/s, "");
  const parts = t
    .split(/\n+/)
    .flatMap((line) => line.split(/(?=[一二三四五六七八九十]+\s*、)/g))
    .flatMap((line) => line.split(/(?<=。)(?=\d+\s*[.、])/g))
    .map((s) => s.trim().replace(/^[、，\s]+/, ""))
    .filter((s) => s.length > 0);
  // Drop pure-punctuation fragments, keep real content.
  return parts.filter((s) => /[\u4e00-\u9fffA-Za-z0-9]/.test(s));
}

function sectionById(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector(`#${id}`);
}

export function parseDetailHtml(html: string, opts: ParseOptions): DetailParseResult {
  const issues: DetailIssue[] = [];
  const unmapped: string[] = [];
  const rawFields: Record<string, string> = {};
  const err = (check: string, detail: string) => issues.push({ level: "error", check, detail });
  const warn = (check: string, detail: string) => issues.push({ level: "warning", check, detail });

  let root;
  try {
    root = parse(html);
  } catch (e) {
    return { record: null, issues: [{ level: "error", check: "parse", detail: `HTML parse failed: ${(e as Error).message}` }] };
  }

  // ---- Title: school + department ----
  const titleCell = root.querySelector('td[bgcolor="#1A4899"]');
  const titleParts = titleCell ? cellText(titleCell).split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const schoolName = titleParts[0] ?? null;
  const departmentName = titleParts.slice(1).join("") || null;

  // ---- BASIC ----
  const basic: Record<string, string> = {};
  const basicSection = sectionById(root, "BASIC");
  if (!basicSection) {
    err("section", "missing #BASIC section");
  } else {
    const basicTable = basicSection.querySelector("table");
    const basicRows = basicTable ? basicTable.querySelectorAll("tr") : [];
    for (const tr of basicRows) {
      const tds = tr.querySelectorAll("td");
      if (tds.length < 2) continue;
      const label = cellText(tds[0]).replace(/\s+/g, "");
      const value = cellText(tds[1]);
      if (!label) continue;
      basic[label] = value;
      rawFields[`basic:${label}`] = value;
    }
  }
  const mapped: Record<string, string | null> = {};
  for (const [label, value] of Object.entries(basic)) {
    const key = BASIC_LABELS[label];
    if (!key) {
      unmapped.push(`BASIC label without mapping: ${label}=${value.slice(0, 60)}`);
      continue;
    }
    if (key.startsWith("extraQuota.")) {
      mapped[key] = toNull(value);
    } else {
      mapped[key] = value;
    }
  }

  const departmentCode = (basic["校系代碼"] ?? "").trim();
  const schoolCode = /^\d{6}$/.test(departmentCode) ? departmentCode.slice(0, 3) : "";

  // ---- G_GRD subject matrix ----
  const subjectRequirements: SubjectScreening[] = [];
  const secondStageItems: SecondStageItem[] = [];
  let overallFirstStageWeight: string | null = null;
  const overQuotaRules: string[] = [];
  const apcsItems: ApcsScreening[] = [];
  let apcsNote: string | null = null;
  let emptySubjectRows = 0;

  const grd = sectionById(root, "G_GRD");
  if (!grd) {
    err("section", "missing #G_GRD section");
  } else {
    const mainTable = grd.querySelector("table");
    const trs = mainTable ? mainTable.querySelectorAll(":scope > tr").length > 0
      ? [...mainTable.querySelectorAll(":scope > tr")]
      : (mainTable.childNodes.filter((n) => n.nodeType === 1 && (n as HTMLElement).tagName === "TR") as HTMLElement[]) : [];
    for (const tr of trs) {
      const tds = tr.querySelectorAll(":scope > td").length > 0
        ? tr.querySelectorAll(":scope > td")
        : (tr.childNodes.filter((n) => n.nodeType === 1 && (n as HTMLElement).tagName === "TD") as HTMLElement[]);
      if (tds.length === 0) continue;
      const first = cellText(tds[0]).replace(/\s+/g, "");
      if (first === "科目" || first === "") {
        if (first === "" && tds.length >= 4) emptySubjectRows++;
        continue;
      }
      if (!KNOWN_SUBJECTS.includes(first)) continue;
      const cells = tds.map((td) => cellText(td));
      // Layout: [subject, 檢定, 倍率, 採計方式, (rowspan 佔比 only in first row), 指定項目, 檢定2, 佔比2].
      // The rowspan cell shifts later rows, so second-stage fields are ALWAYS the last three cells.
      const req = toNull(cells[1] ?? "");
      const mult = toRatio(cells[2] ?? "");
      const method = toNull(cells[3] ?? "");
      subjectRequirements.push({ subject: first, requirement: req, multiplier: mult, scoreMethod: method });
      rawFields[`grade:${first}`] = cells.slice(1, 4).join("|");
      if (cells[4] && cells[4].trim() !== "") {
        const w = cells[4].replace(/\s+/g, "");
        if (/%/.test(w)) overallFirstStageWeight = w;
      }
      const tail = cells.slice(-3);
      const itemName = toNull(tail[0] ?? "");
      if (itemName) {
        secondStageItems.push({ name: itemName, requirement: toNull(tail[1] ?? ""), weight: toNull(tail[2] ?? "") });
        rawFields[`stage2:${itemName}`] = `${tail[1] ?? ""}|${tail[2] ?? ""}`;
      }
    }
    if (emptySubjectRows > 2) unmapped.push(`${emptySubjectRows} empty filler rows in grade matrix (layout padding)`);

    // Over-quota rules: innermost cell carrying the marker (shortest text wins).
    const overCells = grd
      .querySelectorAll("td")
      .filter((td) => /同級分.{0,4}超額篩選方式/.test(cellText(td)))
      .sort((a, b) => cellText(a).length - cellText(b).length);
    if (overCells[0]) {
      const body = cellText(overCells[0]).replace(/^.*超額篩選方式\s*[:：]?/s, "");
      overQuotaRules.push(...splitNumberedItems(body));
      rawFields["overQuota"] = body.slice(0, 300);
    }
    // APCS nested table: pick the INNERMOST table carrying the marker
    // (an outer wrapper td's subtree text also matches, so td-first search
    // would wrongly scope to the whole grade matrix).
    const apcsTables = grd
      .querySelectorAll("table")
      .filter((t) => /APCS篩選方式/.test(cellText(t)))
      .sort((a, b) => a.querySelectorAll("tr").length - b.querySelectorAll("tr").length);
    const apcsTable = apcsTables[0] ?? null;
    if (apcsTable) {
      {
        for (const r of apcsTable.querySelectorAll("tr")) {
          const c = r.querySelectorAll("td").map((d) => cellText(d));
          if (c.length >= 3 && c[0] && !/科目|APCS/.test(c[0])) {
            apcsItems.push({ subject: c[0], requirement: toNull(c[1] ?? ""), multiplier: toRatio(c[2] ?? "") });
          }
          if (/APCS說明/.test(c[0] ?? "")) {
            apcsNote = c.slice(1).join(" ").trim() || null;
          }
        }
        rawFields["apcs"] = apcsItems.map((i) => `${i.subject}:${i.requirement}:${i.multiplier}`).join(";");
      }
    } else if (grd.querySelectorAll("td").some((td) => /APCS篩選方式/.test(cellText(td)))) {
      unmapped.push("APCS marker found without inner table");
    }
  }

  // ---- G_CMP tie-break ----
  const tieBreakingRules: string[] = [];
  const cmp = sectionById(root, "G_CMP");
  if (!cmp) {
    warn("section", "missing #G_CMP section");
  } else {
    tieBreakingRules.push(...splitNumberedItems(cellText(cmp).replace(/^.*順序/, "")));
  }

  // ---- step_sd review / step_st interview ----
  let reviewItems: string | null = null;
  let reviewNotes: string | null = null;
  let interviewNotes: string | null = null;
  const sd = sectionById(root, "step_sd");
  if (sd) {
    const text = cellText(sd);
    const parts = text.split(/(?=說明\s*[:：])/);
    const itemPart = parts[0]?.replace(/^項目\s*[:：]?/, "").trim() ?? "";
    reviewItems = itemPart || null;
    reviewNotes = parts.slice(1).join(" ").replace(/^說明\s*[:：]?/, "").trim() || null;
    rawFields["review"] = text.slice(0, 500);
  } else {
    warn("section", "missing #step_sd (review) section");
  }
  const st = sectionById(root, "step_st");
  if (st) {
    const items = splitNumberedItems(cellText(st));
    interviewNotes = items.length > 0 ? items.join("\n") : null;
    rawFields["interview"] = cellText(st).slice(0, 500);
  } else {
    warn("section", "missing #step_st (interview notes) section");
  }

  // ---- step_no notes ----
  const notes: string[] = [];
  const no = sectionById(root, "step_no");
  if (no) {
    notes.push(...splitNumberedItems(cellText(no)));
  } else {
    warn("section", "missing #step_no section");
  }

  if (!departmentCode) {
    err("identity", "departmentCode missing (no 校系代碼 in #BASIC)");
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
    genderRequirement: toNull(mapped["genderRequirement"] ?? "") as string | null,
    subjectRequirements,
    overallFirstStageWeight,
    overQuotaRules,
    tieBreakingRules,
    secondStageItems,
    reviewItems,
    reviewNotes,
    interviewNotes,
    extraQuotas: {
      indigenous: toNull(mapped["extraQuota.indigenous"] ?? "") as string | null,
      offshore: toNull(mapped["extraQuota.offshore"] ?? "") as string | null,
      vision: toNull(mapped["extraQuota.vision"] ?? "") as string | null,
    },
    applicationFee: toInt(mapped["applicationFee"] ?? ""),
    notificationDate: toNull(mapped["notificationDate"] ?? "") as string | null,
    materialDeadline: toNull(mapped["materialDeadline"] ?? "") as string | null,
    secondStageDate: toNull(mapped["secondStageDate"] ?? "") as string | null,
    resultDate: toNull(mapped["resultDate"] ?? "") as string | null,
    recheckDeadline: toNull(mapped["recheckDeadline"] ?? "") as string | null,
    offshoreRestriction: toNull(mapped["offshoreRestriction"] ?? "") as string | null,
    notes,
    apcs: apcsItems.length > 0 || apcsNote ? { items: apcsItems, note: apcsNote } : null,
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
