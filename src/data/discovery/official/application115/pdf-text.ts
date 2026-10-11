import { inflateSync } from "node:zlib";

/**
 * PDF text decoding for official CAC school PDFs (P4.2b).
 * These PDFs are Chrome print-to-PDF (Skia): one CJK glyph per Tj op, each
 * glyph in its own subset font with a ToUnicode CMap. Decoding therefore
 * needs per-content-stream font tracking + CMap lookups — plain text
 * extraction yields nothing readable.
 *
 * Pure functions over bytes (no fs, no network). Fails loud (U+FFFD) rather
 * than silently dropping glyphs: a prior incident showed silent drops when
 * 1-byte CIDs met a 2-byte-only width table.
 */

export interface CMapTable {
  map: Map<number, string>;
  /** [byteWidth, lo, hi], widest first. From begincodespacerange ONLY. */
  widths: Array<[number, number, number]>;
}

export interface TaggedRun {
  font: string;
  hex: string;
  text: string;
}

export interface PdfPage {
  pageNumber: number;
  runs: TaggedRun[];
}

function uni(hex: string): string {
  return String.fromCodePoint(parseInt(hex, 16));
}

export function parseCMap(text: string): CMapTable {
  const map = new Map<number, string>();
  const widths: Array<[number, number, number]> = [];
  for (const cs of text.matchAll(/begincodespacerange(.*?)endcodespacerange/gs)) {
    for (const m of cs[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      widths.push([m[1]!.length / 2, parseInt(m[1]!, 16), parseInt(m[2]!, 16)]);
    }
  }
  for (const m of text.matchAll(/beginbfchar(.*?)endbfchar/gs)) {
    for (const l of m[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(l[1]!, 16), uni(l[2]!));
  }
  for (const m of text.matchAll(/beginbfrange(.*?)endbfrange/gs)) {
    const body = m[1]!;
    for (const l of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      let cp = parseInt(l[3]!, 16);
      for (let c = parseInt(l[1]!, 16); c <= parseInt(l[2]!, 16); c++) map.set(c, uni((cp++).toString(16)));
    }
    for (const l of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]*)\]/g)) {
      let c = parseInt(l[1]!, 16);
      for (const d of l[3]!.matchAll(/<([0-9A-Fa-f]+)>/g)) map.set(c++, uni(d[1]!));
    }
  }
  widths.sort((a, b) => b[0] - a[0]);
  return { map, widths };
}

export function decodeHex(hex: string, cmap: CMapTable): string {
  let out = "";
  let i = 0;
  while (i < hex.length) {
    let done = false;
    for (const [w, lo, hi] of cmap.widths) {
      const part = hex.slice(i, i + w * 2);
      if (part.length < w * 2) continue;
      const v = parseInt(part, 16);
      if (v >= lo && v <= hi) {
        out += cmap.map.get(v) ?? "�";
        i += w * 2;
        done = true;
        break;
      }
    }
    if (!done) {
      // Fail loud, never silent: consume one minimal unit as replacement.
      const step = i + 4 <= hex.length ? 4 : hex.length - i;
      out += "�";
      i += step;
    }
  }
  return out;
}

interface PdfObject {
  header: string;
  stream: Buffer | null;
}

/** Split on line-anchored `N M obj` (substring matches like `64 0 obj` in `164 0 obj` corrupt offsets). */
export function splitPdfObjects(raw: Buffer): Map<string, PdfObject> {
  const t = raw.toString("latin1");
  const objs = new Map<string, PdfObject>();
  const objRe = /^(\d+) (\d+) obj\r?$/gm;
  let m: RegExpExecArray | null;
  const starts: Array<{ key: string; idx: number }> = [];
  while ((m = objRe.exec(t))) starts.push({ key: `${m[1]} ${m[2]}`, idx: m.index + m[0].length + 1 });
  for (const s of starts) {
    const end = t.indexOf("endobj", s.idx);
    const body = t.slice(s.idx, end < 0 ? t.length : end);
    const si = body.search(/stream\r?\n/);
    if (si < 0) {
      objs.set(s.key, { header: body, stream: null });
      continue;
    }
    const sHead = s.idx + si + (body.slice(si, si + 8) === "stream\r\n" ? 8 : 7);
    const sEnd = t.indexOf("endstream", sHead);
    let data = raw.subarray(sHead, sEnd < 0 ? raw.length : sEnd);
    if (/\/FlateDecode/.test(body.slice(0, si))) {
      try {
        data = inflateSync(data);
      } catch {
        data = Buffer.alloc(0);
      }
    }
    objs.set(s.key, { header: body.slice(0, si), stream: data });
  }
  return objs;
}

/** Balanced `<<...>>` dict extractor (non-greedy regex terminates early on nested dicts). */
export function extractDict(text: string, key: string): string | null {
  const i = text.indexOf(key);
  if (i < 0) return null;
  const s = text.indexOf("<<", i);
  if (s < 0) return null;
  let depth = 0;
  for (let p = s; p < text.length - 1; p++) {
    if (text[p] === "<" && text[p + 1] === "<") {
      depth++;
      p++;
    } else if (text[p] === ">" && text[p + 1] === ">") {
      depth--;
      p++;
      if (depth === 0) return text.slice(s + 2, p - 1);
    }
  }
  return null;
}

function buildFontCmaps(objs: Map<string, PdfObject>): Map<string, CMapTable> {
  const out = new Map<string, CMapTable>();
  for (const [key, o] of objs) {
    if (o.stream !== null) continue;
    const tm = o.header.match(/\/ToUnicode\s+(\d+) (\d+) R/);
    if (!tm) continue;
    const cmapObj = objs.get(`${tm[1]} ${tm[2]}`);
    if (cmapObj?.stream?.length) out.set(key, parseCMap(cmapObj.stream.toString("latin1")));
  }
  return out;
}

function fontResources(objs: Map<string, PdfObject>, header: string): Map<string, string> {
  const res = new Map<string, string>();
  const ref = header.match(/\/Resources\s+(\d+) (\d+) R/);
  const resText = ref ? (objs.get(`${ref[1]} ${ref[2]}`)?.header ?? "") : (extractDict(header, "/Resources") ?? "");
  const fonts = extractDict(resText, "/Font");
  if (!fonts) return res;
  for (const fm of fonts.matchAll(/\/(\S+)\s+(\d+) (\d+) R/g)) res.set(fm[1]!, `${fm[2]} ${fm[3]}`);
  return res;
}

function contentStreams(objs: Map<string, PdfObject>, header: string): Buffer[] {
  const out: Buffer[] = [];
  const m = header.match(/\/Contents\s*(?:\[([^\]]*)\]|(\d+) (\d+) R)/);
  if (!m) return out;
  const refs: string[] = [];
  if (m[1] !== undefined) for (const r of m[1].matchAll(/(\d+) (\d+) R/g)) refs.push(`${r[1]} ${r[2]}`);
  else if (m[2] !== undefined) refs.push(`${m[2]} ${m[3]}`);
  for (const k of refs) {
    const so = objs.get(k);
    if (so?.stream?.length) out.push(so.stream);
  }
  return out;
}

const TOK = /\/(\S+)\s+[\d.]+\s*Tf|<([0-9A-Fa-f]+)>\s*Tj|\((?:[^()\\]|\\.)*\)\s*Tj|\[([^\]]*)\]\s*TJ/g;

function decodeStreamText(text: string, fonts: Map<string, string>, cmaps: Map<string, CMapTable>): TaggedRun[] {
  const runs: TaggedRun[] = [];
  let cur: CMapTable | null = null;
  let curName = "?";
  // Fresh regex state per call (global flag is stateful).
  const tok = new RegExp(TOK.source, "g");
  let m: RegExpExecArray | null;
  while ((m = tok.exec(text))) {
    if (m[1] !== undefined) {
      curName = m[1];
      const fo = fonts.get(m[1]);
      cur = (fo && cmaps.get(fo)) || null;
    } else if (m[2] !== undefined && cur) {
      runs.push({ font: curName, hex: m[2], text: decodeHex(m[2], cur) });
    } else if (m[3] !== undefined && cur) {
      let acc = "";
      for (const h of m[3].matchAll(/<([0-9A-Fa-f]+)>/g)) acc += decodeHex(h[1]!, cur);
      runs.push({ font: curName, hex: m[3].slice(0, 80), text: acc });
    }
    // Runs under unknown fonts are skipped (counted by callers via hexDone
    // diagnostics in tests, never silently merged).
  }
  return runs;
}

function isPageObject(header: string): boolean {
  return /\/Type\s*\/Page(?!s)/.test(header);
}

/**
 * Decode all pages. Page numbers follow the /Pages /Kids order when
 * parseable, else object discovery order. Returns per-page tagged runs.
 */
export function decodePdfPages(raw: Buffer): PdfPage[] {
  const objs = splitPdfObjects(raw);
  const cmaps = buildFontCmaps(objs);
  const pageKeys: string[] = [];
  for (const [key, o] of objs) {
    if (o.stream !== null) continue;
    const kids = o.header.match(/\/Kids\s*\[([^\]]*)\]/);
    if (!kids) continue;
    for (const r of kids[1]!.matchAll(/(\d+) (\d+) R/g)) {
      const k = `${r[1]} ${r[2]}`;
      if (objs.has(k) && !pageKeys.includes(k)) pageKeys.push(k);
    }
    // First /Kids holder wins (single /Pages tree in these PDFs).
    if (pageKeys.length > 0) break;
  }
  if (pageKeys.length === 0) {
    for (const [key, o] of objs) {
      if (o.stream === null && isPageObject(o.header) && !/\/Kids/.test(o.header)) pageKeys.push(key);
    }
  }
  // A /Pages node itself matches isPageObject via lookahead? No: \/Page(?!s)
  // rejects "/Pages". Kids-less fallback above excludes /Kids holders anyway.
  return pageKeys.map((k, i) => {
    const o = objs.get(k)!;
    const fonts = fontResources(objs, o.header);
    const runs: TaggedRun[] = [];
    for (const s of contentStreams(objs, o.header)) runs.push(...decodeStreamText(s.toString("latin1"), fonts, cmaps));
    return { pageNumber: i + 1, runs };
  });
}

/** Flat decoded runs across all pages (document order). */
export function decodePdfText(raw: Buffer): string[] {
  return decodePdfPages(raw).flatMap((p) => p.runs.map((r) => r.text));
}

/**
 * Source-CMap quirk: some CIDs map to CJK-radical compatibility forms that
 * render identically in the PDF (e.g. ⺠ U+2EBA for 民 U+6C11, verified
 * against human-checked names on 001–003). Mechanical, documented, no
 * guessing: only listed code points are rewritten.
 */
const COMPAT_REWRITE: Record<string, string> = { "⺠": "民", "⻑": "長" };

function applyCompat(s: string): string {
  let t = s;
  for (const [a, b] of Object.entries(COMPAT_REWRITE)) t = t.split(a).join(b);
  return t;
}

/** Chrome print header/footer chrome that splits names across page breaks. */
function stripPrintChrome(s: string): string {
  return s.replace(/\d{4}\/\d{1,2}\/\d{1,2} [上下]午\d{1,2}:\d{2}.*?https:\/\/www\.cac\.edu\.tw\/\S+?\d+\/\d+/g, "");
}

/**
 * Remove table-column noise (quotas, dates, 是/否/無 runs, 詳細資料...) from
 * a name segment. Conservative by construction: 一般 is stripped ONLY as a
 * column value (一般否/是), never inside names like 一般物理組.
 */
export function stripNameNoise(s: string, schoolName: string): string {
  let t = s.split(schoolName).join("");
  t = t.replace(/\d{2,4}\.\d{2}\.\d{2}(?:至\d{2,4}\.\d{2}\.\d{2})?/g, "");
  t = t.replace(/詳細資料|詳細料/g, "");
  t = t.replace(/不要求|不要/g, "");
  t = t.replace(/一般(?=[否是])/g, "");
  for (let i = 0; i < 3; i++) {
    t = t.replace(/[0-9]/g, "");
    t = t.replace(/[否是無]{2,}/g, "");
  }
  t = t.replace(/--|\//g, "");
  t = t.replace(/\s+/g, "");
  return t.replace(/^[()]+/, "").trim();
}

export interface DecodedDepartmentName {
  code: string;
  name: string;
  pageNumber: number;
  /** Raw segment the name was cleaned from (audit trail). */
  rawSegment: string;
}

/**
 * Plausibility gate for decoded names (never a correctness proof).
 * Rejects extraction residue: empty strings, absurd lengths, CJK-less
 * fragments, and leftover column vocabulary (詳細資料/不要求/一般否是).
 * Real counter-examples live in tests, not in silent filters.
 */
export function isPlausibleDepartmentName(name: string): boolean {
  const t = (name ?? "").trim();
  if (t.length < 2 || t.length > 40) return false;
  if (!/[\u4e00-\u9fff]/.test(t)) return false;
  if (/詳細資料|詳細料|不要求|不要|一般(?=[否是])/.test(t)) return false;
  return true;
}

export type NameResolutionStatus = "verified_from_pdf" | "ambiguous" | "not_found_in_local_sources" | "conflict";

/**
 * Pure per-code status decision. `decodedNames` includes variants decoded
 * from OTHER files too: any second distinct name is a conflict, never
 * silently preferred. `inAnnots` = code present in PDF link annots.
 */
export function resolveNameStatus(args: { decodedNames: string[]; inAnnots: boolean }): {
  status: NameResolutionStatus;
  name: string | null;
  reason: string;
} {
  const distinct = [...new Set(args.decodedNames.filter((n) => n !== ""))];
  if (!args.inAnnots) {
    return { status: "not_found_in_local_sources", name: null, reason: "code absent from PDF annot links" };
  }
  if (distinct.length > 1) {
    return {
      status: "conflict",
      name: null,
      reason: `multiple distinct decoded names: ${distinct.map((n) => JSON.stringify(n)).join(" / ")}`,
    };
  }
  const name = distinct[0];
  if (name === undefined || !isPlausibleDepartmentName(name)) {
    return {
      status: "ambiguous",
      name: null,
      reason: name === undefined ? "no name decoded near code" : `implausible decoded text: ${JSON.stringify(name)}`,
    };
  }
  return { status: "verified_from_pdf", name, reason: "single plausible decoded name anchored to school" };
}

/**
 * Extract `校名系名 (CODE)` rows from decoded pages. Pages are joined first
 * (print chrome stripped) so names split across page breaks rejoin; the
 * segment runs from the previous code match, so wrapped names survive.
 * Names are anchored to the school name (never bare similarity matching);
 * school/college/group labels outside the anchor are dropped with the noise.
 * One entry per code (first occurrence wins); codes never come from here
 * (annot list is truth).
 */
export function extractDepartmentNames(pages: PdfPage[], schoolCode: string, schoolName: string): DecodedDepartmentName[] {
  const joined: { pageNumber: number; start: number; text: string }[] = [];
  let full = "";
  for (const page of pages) {
    let text = applyCompat(page.runs.map((r) => r.text).join("").normalize("NFKC"));
    text = stripPrintChrome(text);
    joined.push({ pageNumber: page.pageNumber, start: full.length, text });
    full += text;
  }
  const pageOf = (offset: number): number => {
    let n = joined[0]?.pageNumber ?? 1;
    for (const j of joined) if (offset >= j.start) n = j.pageNumber;
    return n;
  };
  const out: DecodedDepartmentName[] = [];
  const seen = new Set<string>();
  let segStart = 0;
  for (const m of full.matchAll(/\((\d{6})\)/g)) {
    const code = m[1]!;
    const end = (m.index ?? 0) + m[0].length;
    if (!code.startsWith(schoolCode) || seen.has(code)) {
      segStart = end;
      continue;
    }
    seen.add(code);
    const segment = full.slice(segStart, m.index ?? 0);
    const anchor = segment.lastIndexOf(schoolName);
    const afterSchool = anchor >= 0 ? segment.slice(anchor + schoolName.length) : segment;
    out.push({ code, name: stripNameNoise(afterSchool, schoolName), pageNumber: pageOf(m.index ?? 0), rawSegment: afterSchool.slice(-80) });
    segStart = end;
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}
