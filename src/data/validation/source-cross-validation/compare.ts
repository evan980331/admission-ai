import type {
  ComparedRow,
  CrossValidationReport,
  FieldDiff,
  OfficialRow,
  RowVerdict,
  ThirdPartyRow,
} from "./types";

/**
 * Official-vs-third-party comparison. Pure function, no I/O.
 * Name matching is normalized (school prefix stripped, 臺/台 unified,
 * whitespace + group suffixes ignored for the base comparison; residual
 * differences -> field_mismatch, never silent).
 */

/**
 * Print-PDF quirk fold: some official PDFs render standard characters with
 * CJK-Radical-Supplement code points that NFKC does NOT fold
 * (e.g. U+2EBA ⺠ for 民 U+6C11, observed in 002082/092/102 "公⺠教育").
 * Explicit, documented, tested — not silent merging (codes still must match).
 */
const RADICAL_FOLD: Record<string, string> = {
  "⺠": "民",
};

function foldRadicals(s: string): string {
  return s
    .split("")
    .map((c) => RADICAL_FOLD[c] ?? c)
    .join("");
}

export function normalizeDeptName(name: string, schoolCode: string): string {
  void schoolCode;
  return (
    foldRadicals(
      name
        // NFKC folds CJK compatibility ideographs found in print-PDF text
        // (e.g. ⽴/⽤/⽂) back to their standard forms before comparing.
        .normalize("NFKC"),
    )
      .replace(/[\s　]/g, "")
      .replace(/^國立臺灣大學|^國立臺灣師範大學|^國立中興大學/, "")
      .replace(/台/g, "臺")
      .replace(/\(.+組\)$/, "")
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === null ? "null" : String(x))).join(",")}]`;
  return String(v);
}

export function compareRows(official: OfficialRow[], thirdParty: ThirdPartyRow[]): ComparedRow[] {
  const tpByCode = new Map<string, ThirdPartyRow[]>();
  for (const t of thirdParty) {
    const k = `${t.schoolCode}|${t.departmentCode}`;
    tpByCode.set(k, [...(tpByCode.get(k) ?? []), t]);
  }
  const offKeys = new Set(official.map((o) => `${o.schoolCode}|${o.departmentCode}`));
  const out: ComparedRow[] = [];

  for (const o of official) {
    const k = `${o.schoolCode}|${o.departmentCode}`;
    const cands = tpByCode.get(k) ?? [];
    if (cands.length === 0) {
      out.push({
        schoolCode: o.schoolCode,
        departmentCode: o.departmentCode,
        officialName: o.departmentName,
        thirdPartyName: null,
        verdict: "missing_in_university_tw",
        diffs: [],
        note: "in official PDF but absent from University TW (check UTW exclusion lists: 術科/APCS/資安/性別限制)",
      });
      continue;
    }
    if (cands.length > 1) {
      out.push({
        schoolCode: o.schoolCode,
        departmentCode: o.departmentCode,
        officialName: o.departmentName,
        thirdPartyName: cands.map((c) => c.departmentName).join(" / "),
        verdict: "ambiguous",
        diffs: [],
        note: `${cands.length} third-party rows share this code; manual review required`,
      });
      continue;
    }
    const t = cands[0]!;
    const diffs: FieldDiff[] = [];
    if (normalizeDeptName(o.departmentName, o.schoolCode) !== normalizeDeptName(t.departmentName, t.schoolCode)) {
      diffs.push({ field: "departmentName", official: o.departmentName, thirdParty: t.departmentName });
    }
    if (o.quota !== null && t.quota !== null && o.quota !== t.quota) {
      diffs.push({ field: "quota", official: fmt(o.quota), thirdParty: fmt(t.quota) });
    } else if ((o.quota === null) !== (t.quota === null)) {
      diffs.push({ field: "quota", official: fmt(o.quota), thirdParty: fmt(t.quota) });
    }
    const reqKeys = new Set([...Object.keys(o.requirements ?? {}), ...Object.keys(t.requirements ?? {})]);
    for (const rk of reqKeys) {
      const ov = o.requirements?.[rk] ?? null;
      const tv = t.requirements?.[rk] ?? null;
      if (ov !== null && tv !== null && ov !== tv) {
        diffs.push({ field: `requirement.${rk}`, official: ov, thirdParty: tv });
      }
    }
    const n = Math.max(o.screeningRatios?.length ?? 0, t.screeningRatios?.length ?? 0);
    for (let i = 0; i < n; i++) {
      const ov = o.screeningRatios?.[i] ?? null;
      const tv = t.screeningRatios?.[i] ?? null;
      if (ov !== null && tv !== null && ov !== tv) {
        diffs.push({ field: `screeningRatio[${i}]`, official: fmt(ov), thirdParty: fmt(tv) });
      }
    }
    const verdict: RowVerdict = diffs.length === 0 ? "match" : "field_mismatch";
    out.push({
      schoolCode: o.schoolCode,
      departmentCode: o.departmentCode,
      officialName: o.departmentName,
      thirdPartyName: t.departmentName,
      verdict,
      diffs,
      note: verdict === "match" ? "ok" : "official is authoritative; third-party kept for discovery only",
    });
  }

  for (const [k, cands] of tpByCode) {
    if (!offKeys.has(k)) {
      const [schoolCode, departmentCode] = k.split("|") as [string, string];
      out.push({
        schoolCode,
        departmentCode,
        officialName: null,
        thirdPartyName: cands.map((c) => c.departmentName).join(" / "),
        verdict: "extra_in_university_tw",
        diffs: [],
        note: "in University TW but absent from official PDF extract; verify against official detail pages",
      });
    }
  }
  return out;
}

export function buildReport(
  academicYear: number,
  officialSource: string,
  thirdPartySource: string,
  rows: ComparedRow[],
): CrossValidationReport {
  const totals: Record<RowVerdict, number> = {
    match: 0,
    missing_in_university_tw: 0,
    extra_in_university_tw: 0,
    field_mismatch: 0,
    ambiguous: 0,
  };
  for (const r of rows) totals[r.verdict]++;
  return { academicYear, officialSource, thirdPartySource, generatedAt: new Date().toISOString(), totals, rows };
}
