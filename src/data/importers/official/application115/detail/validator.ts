import type { DetailIssue, DetailRecord } from "./types";

/**
 * Detail-specific validation (P3.7 §7).
 * Missing data -> warning. Impossible formats / HTML artifacts -> error.
 */

const TEMPLATE_ARTIFACTS = ["centertimes", "centercal", "centercompose", "telclowest"];

function hasArtifact(s: string | null | undefined): boolean {
  if (!s) return false;
  const low = s.toLowerCase();
  return TEMPLATE_ARTIFACTS.some((t) => low.includes(t)) || /<[^>]+>/.test(s);
}

export function validateDetail(record: DetailRecord): DetailIssue[] {
  const issues: DetailIssue[] = [];
  const err = (check: string, detail: string) => issues.push({ level: "error", check, detail });
  const warn = (check: string, detail: string) => issues.push({ level: "warning", check, detail });

  // Identity formats
  if (!/^\d{3}$/.test(record.schoolCode)) err("school-code", `schoolCode must be 3 digits, got ${JSON.stringify(record.schoolCode)}`);
  if (!/^\d{6}$/.test(record.departmentCode)) {
    err("dept-code", `departmentCode must be 6 digits, got ${JSON.stringify(record.departmentCode)}`);
  } else if (record.departmentCode.slice(0, 3) !== record.schoolCode) {
    err("code-relation", `departmentCode ${record.departmentCode} does not start with schoolCode ${record.schoolCode}`);
  }
  if (!record.departmentName) warn("dept-name", "departmentName missing");

  // Non-negative numerics (null = missing -> warning)
  const nums: [string, number | null][] = [
    ["quota", record.quota],
    ["expectedInterviewCount", record.expectedInterviewCount],
    ["applicationFee", record.applicationFee],
  ];
  for (const [name, v] of nums) {
    if (v === null) warn(name, `${name} missing -> null`);
    else if (v < 0) err(name, `${name} = ${v} (impossible negative)`);
  }

  // Second-stage weights: each 0-100%, total must not exceed 100%.
  const pct = (s: string | null): number | null => {
    if (!s) return null;
    const m = s.replace(/\s/g, "").match(/^([\d.]+)%$/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  };
  const weights: number[] = [];
  const w0 = pct(record.overallFirstStageWeight);
  if (w0 !== null) weights.push(w0);
  for (const item of record.secondStageItems) {
    const w = pct(item.weight);
    if (item.weight !== null && w === null) {
      warn("stage2-weight", `unparseable weight ${JSON.stringify(item.weight)} on ${item.name}; kept as text`);
    }
    if (w !== null) {
      if (w < 0 || w > 100) err("stage2-weight", `weight out of range on ${item.name}: ${item.weight}`);
      weights.push(w);
    }
  }
  const total = weights.reduce((a, b) => a + b, 0);
  if (weights.length > 0 && total > 100.5) {
    warn("stage2-total", `weights sum to ${total}% (>100%); second-stage structure may need review`);
  }

  // HTML parsing artifacts must never leak into values.
  const checkTexts: [string, string | null | undefined][] = [
    ["departmentName", record.departmentName],
    ["reviewItems", record.reviewItems],
    ["interviewNotes", record.interviewNotes],
    ...record.subjectRequirements.flatMap((s) => [
      [`req:${s.subject}`, s.requirement] as [string, string | null],
    ]),
  ];
  for (const [field, v] of checkTexts) {
    if (hasArtifact(v)) err("html-artifact", `${field} contains template/HTML artifact: ${JSON.stringify((v ?? "").slice(0, 80))}`);
  }

  // Empty-but-expected sections
  if (record.subjectRequirements.length === 0) warn("subjects", "no subject rows parsed");
  if (record.secondStageItems.length === 0) warn("stage2", "no second-stage items parsed");
  if (record.unmapped.length > 0) {
    for (const u of record.unmapped.slice(0, 5)) warn("unmapped", u);
  }
  return issues;
}
