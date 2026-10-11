import { createHash } from "node:crypto";

/**
 * P4.2-pre PDF audit — pure, offline, deterministic helpers.
 * Scans local PDFs (sha/size/pages/readability), extracts department codes
 * from CAC link annots (same evidence shape as pdf-inventory, plus file
 * position + nearby-text context), and cross-validates against the official
 * school index / inventory / raw HTML / DB rows supplied by the caller.
 * No fetching, no DB writes, no timestamps inside data payloads (report
 * headers may carry generatedAt; everything else sorts deterministically).
 */

export type PdfDocType = "national-master" | "school-brochure" | "unknown";

export interface PdfFileRecord {
  relativePath: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  pageCount: number | null;
  readable: boolean;
  textExtractable: boolean;
  likelyScannedImage: boolean;
  yearClues: string[];
  schoolClue: string | null;
  docType: PdfDocType;
  /** sha256 peers found later by grouping; empty until grouped. */
  duplicateOf: string[];
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Count real Page objects (exclude the /Pages tree node). Pure string scan. */
export function countPdfPages(latin1: string): number | null {
  const m = latin1.match(/\/Type\s*\/Page[^s\/]/g);
  return m ? m.length : null;
}

/** True when the file parses as PDF and has at least one page or object. */
export function isReadablePdf(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  if (!buf.subarray(0, 5).toString("latin1").startsWith("%PDF-")) return false;
  const t = buf.toString("latin1");
  return t.includes("endobj") || t.includes("/Type");
}

/**
 * Text-extractability probe: CAC school PDFs keep link annots + CMap text
 * uncompressed enough for mechanical extraction. Scanned-image PDFs show
 * pages but (almost) no text-showing operators.
 */
export function hasExtractableText(latin1: string): boolean {
  return /(Tj|TJ| \/URI\s*\()/g.test(latin1);
}

/** Academic-year clues like "115學年度" (string-preserved, never numeric). */
export function extractYearClues(latin1: string, fileName: string): string[] {
  const out = new Set<string>();
  const src = `${fileName}\n${latin1.slice(0, 20000)}`;
  for (const m of src.matchAll(/(1\d{2})\s*學年度/g)) out.add(m[1]!);
  for (const m of fileName.matchAll(/(1\d{2})/g)) out.add(m[1]!);
  return [...out].sort();
}

export function classifyDocType(fileName: string, schoolNames: string[]): { docType: PdfDocType; schoolClue: string | null } {
  const base = fileName.replace(/\.pdf$/i, "");
  if (/查詢所有校系|總表|全國|TotalGsdShow/i.test(base)) return { docType: "national-master", schoolClue: null };
  const hit = schoolNames.find((n) => n !== "" && base.includes(n));
  if (hit) return { docType: "school-brochure", schoolClue: hit };
  return { docType: "unknown", schoolClue: null };
}

export function scanPdfBuffer(buf: Buffer, relativePath: string, fileName: string, schoolNames: string[]): PdfFileRecord {
  const readable = isReadablePdf(buf);
  const latin1 = readable ? buf.toString("latin1") : "";
  const pages = readable ? countPdfPages(latin1) : null;
  const text = readable && hasExtractableText(latin1);
  const { docType, schoolClue } = classifyDocType(fileName, schoolNames);
  return {
    relativePath,
    fileName,
    sizeBytes: buf.length,
    sha256: sha256Hex(buf),
    pageCount: pages,
    readable,
    textExtractable: text,
    likelyScannedImage: readable && (pages ?? 0) > 0 && !text,
    yearClues: extractYearClues(latin1, fileName),
    schoolClue,
    docType,
    duplicateOf: [],
  };
}

/** Group records by sha256; every member lists its peers (sorted). Pure. */
export function groupDuplicates(records: PdfFileRecord[]): PdfFileRecord[] {
  const byHash = new Map<string, string[]>();
  for (const r of records) {
    const peers = byHash.get(r.sha256) ?? [];
    peers.push(r.relativePath);
    byHash.set(r.sha256, peers);
  }
  return records.map((r) => ({
    ...r,
    duplicateOf: (byHash.get(r.sha256) ?? []).filter((p) => p !== r.relativePath).sort(),
  }));
}

// ---------------------------------------------------------------------------
// Department-code extraction with evidence
// ---------------------------------------------------------------------------

export interface DepartmentCandidate {
  academicYear: string;
  schoolCode: string;
  departmentCode: string;
  departmentName: string | null;
  pipeline: string;
  sourceFile: string;
  sourceUrl: string;
  /** 1-based annot order inside the source PDF (stable). */
  evidenceIndex: number;
  /** Nearby raw text around the annot (bounded, may contain binary). */
  contextSnippet: string;
  status: "candidate";
}

const ANNOT_URL_RE = /\/URI\s*\((https:\/\/www\.cac\.edu\.tw\/[^)]*?\/(\d)(\d{2})_(\d{6})\.htm[^)]*)\)/g;

/**
 * Extract 6-digit department codes ONLY from CAC detail-page annot URLs of
 * the form .../115_001012.htm. The URL prefix is the guard: phone numbers,
 * page numbers, dates, quotas and scores can never match because they are
 * not inside a CAC detail URL. Codes stay strings (leading zeros kept);
 * school code (first 3 digits) is derived, never merged into one id.
 */
export function extractDepartmentCandidates(
  pdfText: string,
  args: { sourceFile: string; pipeline: string; departmentNames?: Record<string, string> },
): DepartmentCandidate[] {
  const out: DepartmentCandidate[] = [];
  const seen = new Set<string>();
  let idx = 0;
  for (const m of pdfText.matchAll(ANNOT_URL_RE)) {
    idx += 1;
    const url = m[1]!;
    const yearDigit = m[2]!;
    const yearRest = m[3]!;
    const code = m[4]!;
    if (!/^\d{6}$/.test(code)) continue;
    const start = Math.max(0, (m.index ?? 0) - 120);
    const snippet = pdfText
      .slice(start, (m.index ?? 0) + m[0].length + 60)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
      .slice(0, 360);
    const academicYear = `${yearDigit}${yearRest}`;
    const dedup = `${academicYear}|${code}|${args.sourceFile}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push({
      academicYear,
      schoolCode: code.slice(0, 3),
      departmentCode: code,
      departmentName: args.departmentNames?.[code] ?? null,
      pipeline: args.pipeline,
      sourceFile: args.sourceFile,
      sourceUrl: url,
      evidenceIndex: idx,
      contextSnippet: snippet,
      status: "candidate",
    });
  }
  return out;
}

export interface MasterEntry {
  academicYear: string;
  schoolCode: string;
  departmentCode: string;
  departmentName: string | null;
  sources: { sourceFile: string; sourceUrl: string; evidenceIndex: number }[];
}

/** Dedup by academicYear|departmentCode (year never merged); keep all sources. Pure + sorted. */
export function buildMasterCandidate(cands: DepartmentCandidate[]): MasterEntry[] {
  const map = new Map<string, MasterEntry>();
  const sorted = [...cands].sort((a, b) =>
    a.academicYear === b.academicYear
      ? a.departmentCode === b.departmentCode
        ? a.sourceFile.localeCompare(b.sourceFile)
        : a.departmentCode.localeCompare(b.departmentCode)
      : a.academicYear.localeCompare(b.academicYear),
  );
  for (const c of sorted) {
    const k = `${c.academicYear}|${c.departmentCode}`;
    const hit = map.get(k);
    const src = { sourceFile: c.sourceFile, sourceUrl: c.sourceUrl, evidenceIndex: c.evidenceIndex };
    if (!hit) {
      map.set(k, {
        academicYear: c.academicYear,
        schoolCode: c.schoolCode,
        departmentCode: c.departmentCode,
        departmentName: c.departmentName,
        sources: [src],
      });
    } else {
      if (!hit.sources.some((s) => s.sourceFile === src.sourceFile && s.sourceUrl === src.sourceUrl)) {
        hit.sources.push(src);
      }
      if (hit.departmentName === null && c.departmentName !== null) hit.departmentName = c.departmentName;
    }
  }
  return [...map.values()].sort((a, b) =>
    a.academicYear === b.academicYear ? a.departmentCode.localeCompare(b.departmentCode) : a.academicYear.localeCompare(b.academicYear),
  );
}

// ---------------------------------------------------------------------------
// Cross-validation
// ---------------------------------------------------------------------------

export type CrossStatus =
  | "matched"
  | "new_candidate"
  | "missing_from_pdf"
  | "missing_from_manifest"
  | "name_mismatch"
  | "code_mismatch"
  | "duplicate"
  | "unresolved";

export interface CrossRow {
  academicYear: string;
  schoolCode: string;
  departmentCode: string;
  status: CrossStatus;
  detail: string;
}

export interface CrossInputs {
  academicYear: string;
  /** Official school index (code -> name). Absence => completeness unjudgeable. */
  officialSchools: Map<string, string>;
  /** Existing manifest rows (code set + names). */
  manifest: Map<string, { schoolCode: string; departmentName: string | null }>;
  /** Extracted master candidates. */
  master: MasterEntry[];
  /** Raw HTML codes present locally (115_XXXXXX.htm). */
  rawHtmlCodes: Set<string>;
  /** Normalized DB codes (read-only snapshot; empty set = not checked). */
  normalizedCodes: Set<string>;
  dbChecked: boolean;
}

/**
 * Compare extracted candidates against every authority. Without an official
 * school list the result is explicitly `unresolved` for completeness —
 * never a completeness claim.
 */
export function crossValidate(inputs: CrossInputs): { rows: CrossRow[]; completeness: "judgeable" | "unjudgeable"; summary: Record<CrossStatus, number> } {
  const summary: Record<CrossStatus, number> = {
    matched: 0,
    new_candidate: 0,
    missing_from_pdf: 0,
    missing_from_manifest: 0,
    name_mismatch: 0,
    code_mismatch: 0,
    duplicate: 0,
    unresolved: 0,
  };
  const rows: CrossRow[] = [];
  const push = (academicYear: string, schoolCode: string, departmentCode: string, status: CrossStatus, detail: string) => {
    summary[status] += 1;
    rows.push({ academicYear, schoolCode, departmentCode, status, detail });
  };
  const year = inputs.academicYear;
  if (inputs.officialSchools.size === 0) {
    for (const m of inputs.master) {
      push(m.academicYear, m.schoolCode, m.departmentCode, "unresolved", "no official school list; completeness unjudgeable");
    }
    return { rows, completeness: "unjudgeable", summary };
  }
  const masterByCode = new Map(inputs.master.map((m) => [m.departmentCode, m]));
  const manifestByCode = new Map(inputs.manifest);
  const seenMaster = new Set<string>();
  const distinctFiles = (m: MasterEntry) => [...new Set(m.sources.map((s) => s.sourceFile))].sort();
  for (const [code, info] of manifestByCode) {
    if (!/^\d{6}$/.test(code)) {
      push(year, info.schoolCode, code, "code_mismatch", "manifest code is not 6 digits");
      continue;
    }
    const m = masterByCode.get(code);
    if (!m) {
      push(year, info.schoolCode, code, "missing_from_pdf", "in manifest/universe but not extracted from any PDF");
      continue;
    }
    seenMaster.add(code);
    const files = distinctFiles(m);
    if (files.length > 1) {
      push(year, info.schoolCode, code, "duplicate", `same code extracted from ${files.length} files: ${files.join(", ")}`);
      continue;
    }
    if (m.schoolCode !== info.schoolCode) {
      push(year, info.schoolCode, code, "code_mismatch", `school prefix ${m.schoolCode} != manifest ${info.schoolCode}`);
      continue;
    }
    if (info.departmentName && m.departmentName && info.departmentName !== m.departmentName) {
      push(year, info.schoolCode, code, "name_mismatch", `manifest ${info.departmentName} != pdf ${m.departmentName}`);
      continue;
    }
    push(year, info.schoolCode, code, "matched", "manifest + pdf agree");
  }
  for (const m of inputs.master) {
    if (seenMaster.has(m.departmentCode)) continue;
    const files = distinctFiles(m);
    if (files.length > 1) {
      push(m.academicYear, m.schoolCode, m.departmentCode, "duplicate", `same code extracted from ${files.length} files: ${files.join(", ")}`);
      continue;
    }
    if (!inputs.officialSchools.has(m.schoolCode)) {
      push(m.academicYear, m.schoolCode, m.departmentCode, "unresolved", `school ${m.schoolCode} not in official school list; needs human check`);
      continue;
    }
    push(m.academicYear, m.schoolCode, m.departmentCode, "new_candidate", "extracted from PDF, absent from manifest");
  }
  rows.sort((a, b) =>
    a.academicYear === b.academicYear
      ? a.departmentCode.localeCompare(b.departmentCode)
      : a.academicYear.localeCompare(b.academicYear),
  );
  return { rows, completeness: "judgeable", summary };
}

/** Codes present in raw-HTML/universe but absent from a code set (missing_from_manifest side). */
export function findMissingCodes(present: Set<string>, expected: Set<string>): string[] {
  return [...expected].filter((c) => !present.has(c)).sort();
}
