import type { DetailRecord } from "../../data/importers/official/application115/detail/types";
import type {
  AdmissionNotice,
  AdmissionProvenance,
  ApcsRequirement,
  CanonicalAdmissionDetail,
  RocDate,
  SecondStageItem,
  SequenceRule,
  SpecialRequirement,
  SubjectRule,
} from "./types";

export interface FromDetailIssue {
  level: "error" | "warning";
  check: string;
  detail: string;
}

/**
 * ROC date (e.g. "115.5.6", "115.05.06") -> ISO YYYY-MM-DD (year + 1911).
 * Unparseable or impossible dates -> null date with sourceText preserved.
 * Pure; no guessing, no fallback to today.
 */
export function rocToIsoDate(source: string | null): RocDate {
  if (source === null || source.trim() === "") return { date: null, sourceText: source };
  const t = source.trim();
  const m = t.match(/^(\d{2,3})\.(\d{1,2})\.(\d{1,2})$/);
  if (!m) return { date: null, sourceText: t };
  const y = Number(m[1]) + 1911;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return { date: null, sourceText: t };
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { date: null, sourceText: t };
  }
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { date: iso, sourceText: t };
}

/**
 * DetailRecord -> CanonicalAdmissionDetail. Total mapping: every parser field
 * lands somewhere (see auditCanonicalCompleteness in validation.ts).
 * Reads DetailRecord only; never touches parser internals.
 */
export function fromDetailRecord(record: DetailRecord): { canonical: CanonicalAdmissionDetail; issues: FromDetailIssue[] } {
  const issues: FromDetailIssue[] = [];

  const subjectRules: SubjectRule[] = record.subjectRequirements.map((s, i) => {
    const raw = record.rawFields[`grade:${s.subject}`] ?? [s.requirement ?? "", String(s.multiplier ?? ""), s.scoreMethod ?? ""].join("|");
    const empty = s.requirement === null && s.multiplier === null && s.scoreMethod === null;
    return {
      position: i + 1,
      subject: s.subject,
      requirement: s.requirement,
      multiplier: s.multiplier,
      scoreMethod: s.scoreMethod,
      status: empty ? "not_applicable" : "active",
      sourceText: raw,
    };
  });

  const sequences: SequenceRule[] = [
    ...record.overQuotaRules.map((r, i) => ({
      position: i + 1,
      kind: "over_quota" as const,
      subjects: null as string[] | null,
      description: r,
      sourceText: r,
    })),
    ...record.tieBreakingRules.map((r, i) => ({
      position: i + 1,
      kind: "tie_break" as const,
      subjects: null as string[] | null,
      description: r,
      sourceText: r,
    })),
  ];
  if (record.overQuotaRules.length === 0) issues.push({ level: "warning", check: "over-quota", detail: "no over-quota rules parsed" });
  if (record.tieBreakingRules.length === 0) issues.push({ level: "warning", check: "tie-break", detail: "no tie-break rules parsed" });

  const items: SecondStageItem[] = record.secondStageItems.map((s, i) => {
    const raw = record.rawFields[`stage2:${s.name}`];
    return {
      position: i + 1,
      name: s.name,
      requirement: s.requirement,
      weight: s.weight,
      itemType: null,
      description: null,
      sourceText: raw !== undefined ? `${s.name}|${raw}` : s.name,
    };
  });

  const apcs: ApcsRequirement[] | null = record.apcs
    ? record.apcs.items.map((a, i) => ({
        position: i + 1,
        subject: a.subject,
        requirement: a.requirement,
        multiplier: a.multiplier,
        note: record.apcs!.note,
        sourceText: `${a.subject}|${a.requirement ?? ""}|${a.multiplier ?? ""}`,
      }))
    : null;

  const reviewSource = [record.reviewItems ?? "", record.reviewNotes ? `\n說明：${record.reviewNotes}` : ""].join("").trim();
  const reviewRequirements =
    reviewSource !== ""
      ? [
          {
            position: 1,
            categoryCode: null as string | null,
            categoryName: null as string | null,
            required: null as string | null,
            minimumCount: null as number | null,
            maximumCount: null as number | null,
            description: null as string | null,
            restriction: null as string | null,
            sourceText: reviewSource,
          },
        ]
      : [];
  if (reviewRequirements.length === 0) {
    issues.push({ level: "warning", check: "review", detail: "no review items/notes parsed; kept empty, not fabricated" });
  }

  const specialRequirements: SpecialRequirement[] = [
    { kind: "gender_restriction", value: record.genderRequirement, sourceText: record.rawFields["basic:性別要求"] ?? null },
    { kind: "offshore_restriction", value: record.offshoreRestriction, sourceText: record.rawFields["basic:離島外加名額縣市別限制"] ?? record.rawFields["offshoreRestriction:fallback"] ?? null },
    { kind: "indigenous_extra", value: record.extraQuotas["indigenous"] ?? null, sourceText: record.rawFields["basic:原住民外加名額"] ?? null },
    { kind: "offshore_extra", value: record.extraQuotas["offshore"] ?? null, sourceText: record.rawFields["basic:離島外加名額"] ?? null },
    { kind: "vision_extra", value: record.extraQuotas["vision"] ?? null, sourceText: record.rawFields["basic:願景計畫外加名額"] ?? null },
  ];
  const listening = subjectRules.find((s) => s.subject === "英聽");
  specialRequirements.push({
    kind: "english_listening",
    // Documented mirror of the 英聽 subject rule (view, not a second truth).
    value: listening ? listening.requirement : null,
    sourceText: listening ? listening.sourceText : null,
  });

  const notices: AdmissionNotice[] = record.notes.map((n, i) => ({ position: i + 1, type: "other", text: n, sourceText: n }));

  const provenance: AdmissionProvenance = {
    source: "official",
    sourceUrl: record.sourceUrl,
    academicYear: record.academicYear,
    retrievedAt: record.retrievedAt,
    parserVersion: record.parserVersion,
    dataVersion: record.dataVersion,
    sourceId: null,
  };

  const canonical: CanonicalAdmissionDetail = {
    identity: {
      academicYear: record.academicYear,
      schoolCode: record.schoolCode,
      schoolName: record.schoolName,
      departmentCode: record.departmentCode,
      departmentName: record.departmentName,
      quota: record.quota,
      expectedInterviewCount: record.expectedInterviewCount,
    },
    firstStage: { subjectRules, sequences, overallWeight: record.overallFirstStageWeight },
    apcs,
    apcsNote: record.apcs ? record.apcs.note : null,
    specialRequirements,
    secondStage: { items, overallWeight: null },
    reviewRequirements,
    schedule: {
      notification: rocToIsoDate(record.notificationDate),
      materialDeadline: rocToIsoDate(record.materialDeadline),
      secondStageDate: rocToIsoDate(record.secondStageDate),
      resultDate: rocToIsoDate(record.resultDate),
      recheckDeadline: rocToIsoDate(record.recheckDeadline),
      applicationFee: record.applicationFee,
      applicationFeeSource: record.rawFields["basic:指定項目甄試費"] ?? null,
    },
    notices,
    provenance,
  };
  return { canonical, issues };
}
