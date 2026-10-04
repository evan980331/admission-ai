/**
 * P1-B Canonical Admission Detail — the lossless domain model for official
 * CAC detail pages. Mirrors P3.7 DetailRecord 1:1 (every field has a home);
 * NOTHING here invents values: unstructured content stays in sourceText,
 * missing stays null, and completeness states distinguish
 * missing / not_applicable / unknown / zero.
 *
 * Direction: DetailRecord -> CanonicalAdmissionDetail -> DB records.
 * The reverse (narrow P3Input -> canonical) is forbidden; a forward-only
 * legacy adapter (canonical -> quota-only P3Input) exists for the old
 * dataset path, which is untouched.
 */

export type CompletenessState = "present" | "missing" | "not_applicable" | "unknown";

/** Subject rule status: active row vs explicitly-not-screened vs ambiguous. */
export type SubjectRuleStatus = "active" | "not_applicable" | "unknown";

export interface AdmissionIdentity {
  academicYear: number;
  schoolCode: string;
  schoolName: string | null;
  departmentCode: string;
  departmentName: string | null;
  quota: number | null;
  expectedInterviewCount: number | null;
}

export interface SubjectRule {
  position: number;
  subject: string;
  /** 檢定/標準 (e.g. 前標). null = missing ("--"), never 0. */
  requirement: string | null;
  /** 倍率. null = missing, never 0. */
  multiplier: number | null;
  /** 採計方式 (e.g. *1.50). */
  scoreMethod: string | null;
  status: SubjectRuleStatus;
  /** Raw "requirement|multiplier|method" triple as parsed. */
  sourceText: string;
}

export type SequenceKind = "over_quota" | "tie_break";

export interface SequenceRule {
  position: number;
  kind: SequenceKind;
  /** Structured subjects when safely extractable; null = kept as text only. */
  subjects: string[] | null;
  description: string;
  sourceText: string;
}

export interface FirstStage {
  subjectRules: SubjectRule[];
  /** 同級分超額篩選 + 同分參酌 share one ordered-rule shape (kind differs). */
  sequences: SequenceRule[];
  /** 佔第一階段成績比例 (e.g. 40%). */
  overallWeight: string | null;
}

export interface ApcsRequirement {
  position: number;
  subject: string;
  requirement: string | null;
  multiplier: number | null;
  /** Group note repeated per row (documented denormalization). */
  note: string | null;
  sourceText: string;
}

export type SpecialKind =
  | "gender_restriction"
  | "offshore_restriction"
  | "indigenous_extra"
  | "offshore_extra"
  | "vision_extra"
  | "english_listening";

export interface SpecialRequirement {
  kind: SpecialKind;
  value: string | null;
  sourceText: string | null;
}

export interface SecondStageItem {
  position: number;
  name: string;
  /** 檢定/門檻 (e.g. 70分). null when the item has none — item is kept. */
  requirement: string | null;
  /** 佔比 (e.g. 25%). Kept separate from requirement. */
  weight: string | null;
  /** Parser does not type items; null + sourceText until it can. */
  itemType: string | null;
  description: string | null;
  sourceText: string;
}

export interface SecondStage {
  items: SecondStageItem[];
  /** No second-stage overall weight exists in CAC pages; null + documented. */
  overallWeight: string | null;
}

export interface ReviewRequirement {
  position: number;
  /** Structured codes (A-S) when a future parser splits them; null today. */
  categoryCode: string | null;
  categoryName: string | null;
  required: string | null;
  minimumCount: number | null;
  maximumCount: number | null;
  description: string | null;
  restriction: string | null;
  /** Full 項目/說明 text — never dropped. */
  sourceText: string;
}

export interface RocDate {
  /** ISO YYYY-MM-DD, ROC year + 1911. null when unparseable (sourceText kept). */
  date: string | null;
  sourceText: string | null;
}

export interface AdmissionSchedule {
  notification: RocDate;
  materialDeadline: RocDate;
  secondStageDate: RocDate;
  resultDate: RocDate;
  recheckDeadline: RocDate;
  applicationFee: number | null;
  applicationFeeSource: string | null;
}

export interface AdmissionNotice {
  position: number;
  type: string;
  text: string;
  sourceText: string;
}

export interface AdmissionProvenance {
  source: "official";
  sourceUrl: string;
  academicYear: number;
  retrievedAt: string | null;
  parserVersion: string;
  dataVersion: string;
  /** Assigned by the DB loader (data_sources.id); null until loaded. */
  sourceId: string | null;
}

export interface CanonicalAdmissionDetail {
  identity: AdmissionIdentity;
  firstStage: FirstStage;
  /** APCS rows; null when the page has no APCS section (not fabricated). */
  apcs: ApcsRequirement[] | null;
  apcsNote: string | null;
  specialRequirements: SpecialRequirement[];
  secondStage: SecondStage;
  reviewRequirements: ReviewRequirement[];
  schedule: AdmissionSchedule;
  notices: AdmissionNotice[];
  provenance: AdmissionProvenance;
}
