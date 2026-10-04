import type { AdmissionYearMetadata } from "./types";

/**
 * Academic-year metadata / comparability rules (P3-4).
 *
 * This is SYSTEM knowledge (which regimes existed), not招生 data:
 * 111–115 are all under the 108-curriculum GSAT + post-111 分科 regime, so the
 * 申請入學 pipeline shape is comparable — but raw scores / thresholds must
 * NEVER be treated as directly comparable across years (difficulty, quota and
 * screening rules shift every year). Comparability here means "may be used as
 * reference with year adjustment", not "equal".
 */

const METADATA: Record<number, AdmissionYearMetadata> = {
  111: {
    academicYear: 111,
    examSystem: "gsat-108-curriculum",
    admissionSystem: "application",
    comparableWith: [111, 112, 113, 114, 115],
    notes: [
      "108 課綱首屆學測；分科測驗取代指考首年（與申請入學並行參考）。",
      "原始分數不可跨年直接比較，需經年度校正（percentile 等）。",
    ],
  },
  112: {
    academicYear: 112,
    examSystem: "gsat-108-curriculum",
    admissionSystem: "application",
    comparableWith: [111, 112, 113, 114, 115],
    notes: ["與 111 同課綱體制；篩選倍率與名額以當年簡章為準。"],
  },
  113: {
    academicYear: 113,
    examSystem: "gsat-108-curriculum",
    admissionSystem: "application",
    comparableWith: [111, 112, 113, 114, 115],
    notes: ["與 111 同課綱體制；篩選倍率與名額以當年簡章為準。"],
  },
  114: {
    academicYear: 114,
    examSystem: "gsat-108-curriculum",
    admissionSystem: "application",
    comparableWith: [111, 112, 113, 114, 115],
    notes: ["與 111 同課綱體制；篩選倍率與名額以當年簡章為準。"],
  },
  115: {
    academicYear: 115,
    examSystem: "gsat-108-curriculum",
    admissionSystem: "application",
    comparableWith: [111, 112, 113, 114, 115],
    notes: [
      "現行招生年度；部分校系第二階段結果尚未公告，缺值保持 null。",
      "comparableWith 僅表示體制可參照，不表示分數可直接比較。",
    ],
  },
};

export function getYearMetadata(year: number): AdmissionYearMetadata | null {
  return METADATA[year] ?? null;
}

export function supportedYears(): number[] {
  return Object.keys(METADATA)
    .map(Number)
    .sort((a, b) => a - b);
}

/** True only when both years explicitly list each other as comparable. */
export function areComparable(a: number, b: number): boolean {
  const ma = METADATA[a];
  const mb = METADATA[b];
  if (!ma || !mb) return false;
  return ma.comparableWith.includes(b) && mb.comparableWith.includes(a);
}
