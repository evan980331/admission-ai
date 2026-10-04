import fs from "node:fs";
import path from "node:path";
import {
  ACADEMIC_YEAR_115,
  SOURCE_NAME_DEPT_RULES,
  type ParseError,
  type ParseResult,
  type RawParsedRecord,
  type SupportedFormat,
} from "./types";

/**
 * PARSE stage — file bytes -> RawParsedRecord[]. No DB access.
 *
 * Supported inputs (all manually downloaded to data/raw/official/115/application/):
 *  - HTML: cac mobile per-department detail pages (115_<6-digit-code>.htm).
 *          Key-value tables are extracted generically; only CONFIRMED labels are
 *          mapped to canonical field names, everything else -> unmappedSections.
 *  - CSV: canonical manual-edit columns (see README.md).
 *  - JSON: { "records": [ {...same shape as CSV...} ] }.
 */

const HTML_LABEL_MAP: Record<string, string> = {
  "校系代碼": "department_code",
  "招生名額": "quota",
  "預計甄試人數": "expected_screening_count",
  "性別要求": "gender_requirement",
  "原住民外加名額": "indigenous_quota",
  "離島外加名額": "offshore_quota",
  "願景計畫外加名額": "vision_quota",
  "指定項目甄試費": "screening_fee",
  "指定項目甄試日期": "screening_date",
  "榜示": "announce_date",
  "甄選總成績複查截止": "recheck_deadline",
};

export const CSV_COLUMNS = [
  "school_code",
  "school_name",
  "department_code",
  "department_name",
  "group_name",
  "quota",
  "expected_screening_count",
  "chinese_requirement",
  "english_requirement",
  "math_a_requirement",
  "math_b_requirement",
  "social_requirement",
  "science_requirement",
  "english_listening_requirement",
  "screening_ratio_1",
  "screening_ratio_2",
  "screening_ratio_3",
  "screening_score_1",
  "screening_score_2",
  "screening_score_3",
  "final_quota",
] as const;

export function detectFormat(inputPath: string, content: string): SupportedFormat {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".csv") return "csv";
  if (ext === ".json") return "json";
  const trimmed = content.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (/<html|<!doctype html/i.test(trimmed.slice(0, 500))) return "html";
  return "csv";
}

export function parseFile(inputPath: string): ParseResult {
  const content = fs.readFileSync(inputPath, "utf8");
  const format = detectFormat(inputPath, content);
  if (format === "html") return parseHtml(content, inputPath);
  if (format === "csv") return parseCsv(content);
  return parseJson(content);
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Best-effort extraction of <table> th/td pairs from cac detail pages. */
function parseHtml(content: string, inputPath: string): ParseResult {
  const records: RawParsedRecord[] = [];
  const errors: ParseError[] = [];
  const fields: Record<string, string> = {};
  const unmappedSections: string[] = [];
  const mappedLabels = new Set<string>();

  const tables = [...content.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  if (tables.length === 0) {
    return {
      format: "html",
      records: [],
      errors: [{ rowIndex: 1, reason: `no <table> found in ${path.basename(inputPath)}` }],
    };
  }

  for (const table of tables) {
    const cells = [...table.matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((m) =>
      stripTags(m[1]),
    );
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const label = cells[i]!;
      const value = cells[i + 1]!;
      if (!label) continue;
      const canonical = HTML_LABEL_MAP[label];
      if (canonical) {
        fields[canonical] = value;
        mappedLabels.add(label);
      } else if (label.length <= 24 && value) {
        // Keep the raw pair under its original label instead of dropping it.
        fields[`html:${label}`] = value;
        if (!unmappedSections.includes(label)) unmappedSections.push(label);
      }
    }
  }

  // Department name: cac detail pages put it in the first heading line.
  const heading = content.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
  if (heading) {
    const title = stripTags(heading[1]!).split(/\s+/).filter(Boolean).join(" ");
    if (title) fields["page_title"] = title;
  }

  if (!fields["department_code"]) {
    // Fall back to the filename convention 115_<code>.htm — recorded, not guessed silently.
    const m = path.basename(inputPath).match(/(\d{6})/);
    if (m) {
      fields["department_code"] = m[1]!;
      fields["department_code_inferred_from"] = "filename";
      unmappedSections.push("department_code inferred from filename, verify against page content");
    } else {
      return {
        format: "html",
        records: [],
        errors: [{ rowIndex: 1, reason: "missing 校系代碼 and no 6-digit code in filename" }],
      };
    }
  }

  records.push({
    rowIndex: 1,
    sourceName: SOURCE_NAME_DEPT_RULES,
    fields,
    unmappedSections,
  });
  void ACADEMIC_YEAR_115;
  return { format: "html", records, errors };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function parseCsv(content: string): ParseResult {
  const records: RawParsedRecord[] = [];
  const errors: ParseError[] = [];
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    return { format: "csv", records: [], errors: [{ rowIndex: 0, reason: "empty csv" }] };
  }
  const header = splitCsvLine(lines[0]!);
  const unknown = header.filter((h) => !(CSV_COLUMNS as readonly string[]).includes(h));
  for (let i = 1; i < lines.length; i++) {
    const rowIndex = i + 1; // 1-based incl. header
    const cells = splitCsvLine(lines[i]!);
    if (cells.length !== header.length) {
      errors.push({
        rowIndex,
        reason: `column count mismatch: header=${header.length} row=${cells.length}`,
        excerpt: lines[i]!.slice(0, 120),
      });
      continue;
    }
    const fields: Record<string, string> = {};
    header.forEach((h, idx) => {
      fields[h] = cells[idx] ?? "";
    });
    records.push({
      rowIndex,
      sourceName: SOURCE_NAME_DEPT_RULES,
      fields,
      unmappedSections:
        unknown.length > 0 ? [`unknown csv columns kept as-is: ${unknown.join(",")}`] : [],
    });
  }
  return { format: "csv", records, errors };
}

function parseJson(content: string): ParseResult {
  const records: RawParsedRecord[] = [];
  const errors: ParseError[] = [];
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    return {
      format: "json",
      records: [],
      errors: [{ rowIndex: 0, reason: `invalid JSON: ${(err as Error).message}` }],
    };
  }
  const list = Array.isArray(data)
    ? data
    : (data as { records?: unknown }).records ?? (data as { rows?: unknown }).rows;
  if (!Array.isArray(list)) {
    return {
      format: "json",
      records: [],
      errors: [{ rowIndex: 0, reason: 'expected { "records": [...] } or a top-level array' }],
    };
  }
  list.forEach((item, i) => {
    const rowIndex = i + 1;
    if (typeof item !== "object" || item === null) {
      errors.push({ rowIndex, reason: "record is not an object" });
      return;
    }
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      fields[k] = v === null || v === undefined ? "" : String(v);
    }
    records.push({ rowIndex, sourceName: SOURCE_NAME_DEPT_RULES, fields, unmappedSections: [] });
  });
  return { format: "json", records, errors };
}
