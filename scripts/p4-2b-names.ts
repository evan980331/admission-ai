import fs from "node:fs";
import path from "node:path";
import {
  auditDepartmentUrl,
  findDuplicateUrls,
} from "../src/data/audit/official/application115/validation-queue";
import {
  decodePdfPages,
  extractDepartmentNames,
  resolveNameStatus,
} from "../src/data/discovery/official/application115/pdf-text";
import {
  extractPdfDetailLinks,
} from "../src/data/discovery/official/application115/pdf-inventory";

const VERSION = "p4-2b-v0.1.0";
const RAW = path.join(process.cwd(), "data", "raw", "official", "115", "application");
const AUDIT = path.join(RAW, "..", "..", "..", "..", "processed", "official", "115", "application", "pdf-audit");

type NameStatus = "verified_from_pdf" | "verified_from_existing_official_data" | "ambiguous" | "not_found_in_local_sources" | "conflict";

interface NameRecord {
  schoolCode: string;
  schoolName: string;
  departmentCode: string;
  resolvedName: string | null;
  academicYear: string;
  admissionTrack: string | null;
  trackEvidence: string | null;
  status: NameStatus;
  sourceFile: string;
  pageNumber: number | null;
  contextSnippet: string;
  candidateId: string;
  conflictReason: string | null;
}

/**
 * P4.2b offline name resolution (no network, no DB, no PDF moves).
 * Decodes the 54 not-yet-acquired school PDFs with the committed ToUnicode
 * decoder (496/496 exact against human-verified names), then validates each
 * decoded name against the annot-extracted code list (codes are truth, text
 * only supplies names). Nothing is guessed: failures stay unresolved.
 */
async function main() {
  const queueJson = JSON.parse(fs.readFileSync(path.join(AUDIT, "acquisition-queue-candidate.json"), "utf8")) as {
    data: { queue: { schoolCode: string; schoolName: string | null; departmentCode: string; academicYear: string; admissionTrack: string | null; trackEvidence: string | null; sourceFile: string; detailUrl: string }[] };
  };
  const indexJson = JSON.parse(fs.readFileSync(path.join(RAW, "universe", "school-index.json"), "utf8")) as {
    schools: { schoolCode: string; schoolName: string }[];
  };
  const schoolNameOf = new Map(indexJson.schools.map((s) => [s.schoolCode, s.schoolName]));
  const queue = queueJson.data.queue;
  console.log(`queue candidates: ${queue.length}`);

  // Group queue rows by school PDF actually on disk.
  const byFile = new Map<string, typeof queue>();
  for (const q of queue) {
    const hit = byFile.get(q.sourceFile) ?? [];
    hit.push(q);
    byFile.set(q.sourceFile, hit);
  }

  const resolved: NameRecord[] = [];
  const unresolved: NameRecord[] = [];
  const perSchool = new Map<string, { ok: number; ambiguous: number; conflict: number; missing: number }>();
  const bump = (code: string, k: "ok" | "ambiguous" | "conflict" | "missing") => {
    const hit = perSchool.get(code) ?? { ok: 0, ambiguous: 0, conflict: 0, missing: 0 };
    hit[k] += 1;
    perSchool.set(code, hit);
  };

  // Pass 1: decode every school PDF; collect cross-file name variants so a
  // code decoded differently in two files becomes a conflict, never a pick.
  const decodedByFile = new Map<string, { code: string; name: string; pageNumber: number; rawSegment: string; annotCodes: Set<string> }[]>();
  const variantsByCode = new Map<string, { name: string; file: string }[]>();
  for (const [rel] of [...byFile.entries()].sort()) {
    const full = path.join(process.cwd(), rel);
    if (!fs.existsSync(full)) continue;
    const buf = fs.readFileSync(full);
    const pages = decodePdfPages(buf);
    const firstRow = byFile.get(rel)![0]!;
    const schoolName = schoolNameOf.get(firstRow.schoolCode) ?? firstRow.schoolName ?? "";
    const decoded = extractDepartmentNames(pages, firstRow.schoolCode, schoolName);
    const annotCodes = new Set(extractPdfDetailLinks(buf.toString("latin1")).map((l) => l.code));
    decodedByFile.set(rel, decoded.map((d) => ({ code: d.code, name: d.name, pageNumber: d.pageNumber, rawSegment: d.rawSegment, annotCodes })));
    for (const d of decoded) {
      if (d.name === "") continue;
      const hit = variantsByCode.get(d.code) ?? [];
      hit.push({ name: d.name, file: rel });
      variantsByCode.set(d.code, hit);
    }
  }

  // Pass 2: resolve each queue row (own-file names + cross-file variants).
  for (const [rel, rows] of [...byFile.entries()].sort()) {
    const full = path.join(process.cwd(), rel);
    const decoded = decodedByFile.get(rel) ?? [];
    const annotCodes = decoded[0]?.annotCodes ?? new Set<string>();
    for (const q of rows) {
      const own = decoded.filter((d) => d.code === q.departmentCode).map((d) => d.name);
      const cross = (variantsByCode.get(q.departmentCode) ?? [])
        .filter((v) => v.file !== rel)
        .map((v) => v.name);
      const verdict = resolveNameStatus({ decodedNames: [...own, ...cross], inAnnots: annotCodes.has(q.departmentCode) });
      const schoolName = schoolNameOf.get(q.schoolCode) ?? q.schoolName ?? "";
      const base = {
        schoolCode: q.schoolCode,
        schoolName,
        departmentCode: q.departmentCode,
        academicYear: q.academicYear,
        admissionTrack: q.admissionTrack,
        trackEvidence: q.trackEvidence,
        sourceFile: rel,
        candidateId: `${q.academicYear}|${q.schoolCode}|${q.departmentCode}`,
      };
      if (verdict.status === "verified_from_pdf") {
        const first = decoded.find((d) => d.code === q.departmentCode && d.name === verdict.name)!;
        resolved.push({ ...base, resolvedName: verdict.name, status: verdict.status, pageNumber: first.pageNumber, contextSnippet: first.rawSegment, conflictReason: null });
        bump(q.schoolCode, "ok");
      } else if (verdict.status === "conflict") {
        unresolved.push({ ...base, resolvedName: null, status: "conflict", pageNumber: null, contextSnippet: "", conflictReason: verdict.reason });
        bump(q.schoolCode, "conflict");
      } else if (verdict.status === "not_found_in_local_sources") {
        const reason = annotCodes.size === 0 && !fs.existsSync(full)
          ? `source PDF absent on disk: ${rel}`
          : "code absent from PDF annot links";
        unresolved.push({ ...base, resolvedName: null, status: verdict.status, pageNumber: null, contextSnippet: "", conflictReason: reason });
        bump(q.schoolCode, "missing");
      } else {
        const first = decoded.find((d) => d.code === q.departmentCode);
        unresolved.push({ ...base, resolvedName: null, status: "ambiguous", pageNumber: first?.pageNumber ?? null, contextSnippet: first?.rawSegment ?? "", conflictReason: verdict.reason });
        bump(q.schoolCode, "ambiguous");
      }
    }
  }

  // ---- Phase 2: URL audit (local only, existing builder via helpers) ----
  const urlRows = queue.map((q) => {
    const a = auditDepartmentUrl(q.departmentCode, q.detailUrl ?? null);
    return { ...a, collectable: a.collectable };
  });
  const annotMismatches = urlRows.filter((r) => r.matchesAnnot === false).length;
  const dupUrls = findDuplicateUrls(urlRows);
  const badFormat = urlRows.filter((r) => r.buildError !== null);
  const seenUrls = new Set(urlRows.map((r) => r.builtUrl).filter((u): u is string => u !== null));

  // ---- Phase 3: reports (new files only; formal manifest/dataset untouched) ----
  const generatedAt = new Date().toISOString();
  const write = (name: string, data: unknown) => fs.writeFileSync(path.join(AUDIT, name), JSON.stringify({ generatedAt, generator: VERSION, data }, null, 2));
  const okCount = resolved.length;
  write("department-name-resolution.json", {
    total: queue.length,
    verifiedFromPdf: okCount,
    verifiedFromExistingOfficialData: 0,
    verifiedFromExistingNote: "no second official dept-name source exists locally (school-index carries counts only; master PDF is school-level); status reserved, count honestly zero",
    ambiguousOrConflict: unresolved.filter((u) => u.status === "ambiguous" || u.status === "conflict").length,
    notFound: unresolved.filter((u) => u.status === "not_found_in_local_sources").length,
    perSchool: [...perSchool.entries()].map(([code, s]) => ({ schoolCode: code, schoolName: schoolNameOf.get(code) ?? null, ...s })).sort((a, b) => a.schoolCode.localeCompare(b.schoolCode)),
    resolved,
  });
  write("department-name-unresolved.json", { total: unresolved.length, unresolved });
  write("department-url-audit.json", {
    total: urlRows.length,
    generatedUnique: seenUrls.size,
    duplicateUrls: dupUrls,
    buildFailures: badFormat.map((r) => ({ code: r.departmentCode, error: r.buildError })),
    annotMismatches,
    sample: urlRows.slice(0, 5),
  });
  const rate = ((okCount / queue.length) * 100).toFixed(1);
  // Trial shortlist: fully-verified small schools only (recommendation, no action).
  const trial = [...perSchool.entries()]
    .filter(([, s]) => s.ambiguous === 0 && s.conflict === 0 && s.missing === 0 && s.ok > 0)
    .map(([code]) => code)
    .sort((a, b) => (perSchool.get(a)!.ok ?? 0) - (perSchool.get(b)!.ok ?? 0))
    .slice(0, 3);
  fs.writeFileSync(
    path.join(AUDIT, "p4.2b-report.md"),
    [
      `# P4.2b name resolution report (${generatedAt})`,
      ``,
      `Candidates: ${queue.length}; verified_from_pdf=${okCount} (${rate}%); verified_from_existing=0 (no second source); unresolved=${unresolved.length}.`,
      `Per-school ok/ambiguous/conflict/missing in department-name-resolution.json.`,
      `URLs: ${urlRows.length} built, ${seenUrls.size} unique, duplicates=${dupUrls.length}, build-failures=${badFormat.length}, annot-mismatches=${annotMismatches}.`,
      `Unresolved need official-page confirmation before acquisition.`,
      `Trial shortlist (fully-verified small schools, recommendation only, no browser opened): ${trial.join(", ") || "(none)"}.`,
      ``,
      `Master list remains CANDIDATE ONLY. Names verified here are display metadata; identity stays code-based.`,
      ``,
    ].join("\n"),
  );

  console.log(`resolved=${okCount}/${queue.length} (${rate}%) unresolved=${unresolved.length}`);
  console.log(`urls: unique=${seenUrls.size}/${urlRows.length} dups=${dupUrls.length} buildFail=${badFormat.length} annotMismatch=${annotMismatches}`);
  console.log(`trial: ${trial.join(",")}`);
  console.log(`out: ${AUDIT}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
