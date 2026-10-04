import type { RawHistoricalInput } from "../../data/normalization/types";
import type { DetailRecord } from "../../data/importers/official/application115/detail/types";
import type { CanonicalAdmissionDetail } from "./types";

export interface CompletenessIssue {
  level: "error" | "warning";
  check: string;
  detail: string;
}

/**
 * Data-loss guard: every DetailRecord field must have a canonical home.
 * Returns errors for silent drops; warnings for knowingly-unstructured
 * content (kept in sourceText). Parser-level drops (e.g. layout-A rows for
 * subjects outside KNOWN_SUBJECTS) cannot be seen from DetailRecord and are
 * documented, not asserted here.
 */
const DETAIL_FIELDS = [
  "academicYear",
  "schoolCode",
  "departmentCode",
  "schoolName",
  "departmentName",
  "quota",
  "expectedInterviewCount",
  "genderRequirement",
  "subjectRequirements",
  "overallFirstStageWeight",
  "overQuotaRules",
  "tieBreakingRules",
  "secondStageItems",
  "reviewItems",
  "reviewNotes",
  "interviewNotes",
  "extraQuotas",
  "applicationFee",
  "notificationDate",
  "materialDeadline",
  "secondStageDate",
  "resultDate",
  "recheckDeadline",
  "offshoreRestriction",
  "notes",
  "apcs",
  "source",
  "sourceUrl",
  "retrievedAt",
  "parserVersion",
  "dataVersion",
  "rawFields",
  "unmapped",
] as const;

export function auditCanonicalCompleteness(
  record: DetailRecord,
  canonical: CanonicalAdmissionDetail,
): CompletenessIssue[] {
  const issues: CompletenessIssue[] = [];
  const error = (check: string, detail: string) => issues.push({ level: "error", check, detail });
  const warn = (check: string, detail: string) => issues.push({ level: "warning", check, detail });

  // Identity: all scalar fields must round-trip exactly.
  const id = canonical.identity;
  if (id.academicYear !== record.academicYear) error("identity", "academicYear lost");
  if (id.schoolCode !== record.schoolCode) error("identity", "schoolCode lost");
  if (id.departmentCode !== record.departmentCode) error("identity", "departmentCode lost");
  if (id.schoolName !== record.schoolName) error("identity", "schoolName lost");
  if (id.departmentName !== record.departmentName) error("identity", "departmentName lost");
  if (id.quota !== record.quota) error("identity", "quota lost");
  if (id.expectedInterviewCount !== record.expectedInterviewCount) error("identity", "expectedInterviewCount lost");

  // Screening: every subject row must survive with all three cells.
  if (canonical.firstStage.subjectRules.length !== record.subjectRequirements.length) {
    error("screening", `subject row count ${record.subjectRequirements.length} -> ${canonical.firstStage.subjectRules.length}`);
  }
  record.subjectRequirements.forEach((s, i) => {
    const c = canonical.firstStage.subjectRules[i];
    if (!c || c.subject !== s.subject || c.requirement !== s.requirement || c.multiplier !== s.multiplier || c.scoreMethod !== s.scoreMethod) {
      error("screening", `subject row ${i} (${s.subject}) altered or dropped`);
    }
    if (!c.sourceText) error("screening", `subject row ${s.subject} missing sourceText`);
  });
  if (canonical.firstStage.overallWeight !== record.overallFirstStageWeight) error("screening", "overallFirstStageWeight lost");

  // Sequences: over-quota + tie-break counts and order must survive.
  const over = canonical.firstStage.sequences.filter((s) => s.kind === "over_quota");
  const tie = canonical.firstStage.sequences.filter((s) => s.kind === "tie_break");
  if (over.length !== record.overQuotaRules.length) error("sequence", "over-quota rule count changed");
  if (tie.length !== record.tieBreakingRules.length) error("sequence", "tie-break rule count changed");
  over.forEach((r, i) => {
    if (r.description !== record.overQuotaRules[i]) error("sequence", `over-quota rule ${i} altered`);
  });
  tie.forEach((r, i) => {
    if (r.description !== record.tieBreakingRules[i]) error("sequence", `tie-break rule ${i} altered`);
  });

  // Second stage: items kept even without requirement; weight separate.
  if (canonical.secondStage.items.length !== record.secondStageItems.length) error("second-stage", "item count changed");
  record.secondStageItems.forEach((s, i) => {
    const c = canonical.secondStage.items[i];
    if (!c || c.name !== s.name || c.requirement !== s.requirement || c.weight !== s.weight) {
      error("second-stage", `item ${i} (${s.name}) altered or dropped`);
    }
  });

  // Review: structured or not, the full text must survive.
  const reviewText = [record.reviewItems ?? "", record.reviewNotes ?? ""].join("");
  const keptText = canonical.reviewRequirements.map((r) => r.sourceText).join("");
  for (const needle of [record.reviewItems, record.reviewNotes]) {
    if (needle && !keptText.includes(needle.slice(0, 20))) error("review", "review text lost");
  }
  if (reviewText.trim() === "" && canonical.reviewRequirements.length !== 0) error("review", "review rows fabricated from nothing");
  if (canonical.reviewRequirements.some((r) => r.categoryCode !== null)) {
    warn("review", "structured review codes present — parser cannot produce these; verify source");
  }
  // Interview notes live in rawFields.interview; canonical has no interview
  // slot by design (二階筆試/口試說明 belong to second-stage preparation,
  // a later phase). Flag so the gap stays visible.
  if (record.interviewNotes) warn("interview", "interviewNotes kept in parser rawFields only; no canonical slot yet (later phase)");

  // Special: gender/offshore/extras/listening mirror + APCS rows.
  const special = new Map(canonical.specialRequirements.map((s) => [s.kind, s.value]));
  if (special.get("gender_restriction") !== record.genderRequirement) error("special", "genderRequirement lost");
  if (special.get("offshore_restriction") !== record.offshoreRestriction) error("special", "offshoreRestriction lost");
  for (const k of ["indigenous", "offshore", "vision"] as const) {
    if (special.get(`${k}_extra` as never) !== (record.extraQuotas[k] ?? null)) error("special", `${k} extra quota lost`);
  }
  const listening = record.subjectRequirements.find((s) => s.subject === "英聽");
  if ((special.get("english_listening") ?? null) !== (listening ? listening.requirement : null)) {
    error("special", "english-listening mirror diverged from 英聽 rule");
  }
  if ((record.apcs === null) !== (canonical.apcs === null)) error("special", "apcs presence flipped");
  if (record.apcs && canonical.apcs) {
    if (canonical.apcs.length !== record.apcs.items.length) error("special", "apcs item count changed");
    record.apcs.items.forEach((a, i) => {
      const c = canonical.apcs![i];
      if (!c || c.subject !== a.subject || c.requirement !== a.requirement || c.multiplier !== a.multiplier) {
        error("special", `apcs item ${i} altered`);
      }
    });
    if (canonical.apcsNote !== record.apcs.note) error("special", "apcs note lost");
  }

  // Schedule + fee: ISO dates must equal ROC conversion, never invented.
  const schedPairs = [
    [canonical.schedule.notification, record.notificationDate],
    [canonical.schedule.materialDeadline, record.materialDeadline],
    [canonical.schedule.secondStageDate, record.secondStageDate],
    [canonical.schedule.resultDate, record.resultDate],
    [canonical.schedule.recheckDeadline, record.recheckDeadline],
  ] as const;
  for (const [got, want] of schedPairs) {
    if ((got.sourceText ?? null) !== want) error("schedule", `schedule sourceText diverged from ${JSON.stringify(want)}`);
  }
  if (canonical.schedule.applicationFee !== record.applicationFee) error("schedule", "applicationFee lost");

  // Notices: every official note survives in order.
  if (canonical.notices.length !== record.notes.length) error("notices", "note count changed");
  record.notes.forEach((n, i) => {
    if (canonical.notices[i]?.text !== n) error("notices", `note ${i} altered or dropped`);
  });

  // Provenance: sourceUrl canonical spelling, desktop/mobile untouched.
  const p = canonical.provenance;
  if (p.sourceUrl !== record.sourceUrl) error("provenance", "sourceUrl altered");
  if (p.source !== "official" || p.academicYear !== record.academicYear || p.parserVersion !== record.parserVersion || p.dataVersion !== record.dataVersion) {
    error("provenance", "provenance fields altered");
  }

  // Field inventory: fail loudly if DetailRecord ever gains a field we ignore.
  const seen = new Set<string>(DETAIL_FIELDS);
  for (const k of Object.keys(record)) {
    if (!seen.has(k)) error("inventory", `unmapped DetailRecord field: ${k}`);
  }
  return issues;
}

/**
 * Forward-only legacy adapter: canonical -> quota-only P3Input for the old
 * dataset path (same semantics as detail toP3Input, which stays untouched).
 * There is deliberately NO constructor in the reverse direction.
 */
export function canonicalToLegacyP3Input(canonical: CanonicalAdmissionDetail): RawHistoricalInput {
  return {
    academicYear: canonical.identity.academicYear,
    programType: "application",
    schoolCode: canonical.identity.schoolCode,
    departmentCode: canonical.identity.departmentCode,
    departmentName: canonical.identity.departmentName,
    quota: canonical.identity.quota,
    applicants: null,
    screened: null,
    secondStage: null,
    admitted: null,
    waitlisted: null,
    minimumScore: null,
    averageScore: null,
    sourceId: canonical.provenance.sourceId,
    dataVersion: canonical.provenance.dataVersion || null,
  };
}
