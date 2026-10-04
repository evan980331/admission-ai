import type { IdentityResolution, IdentityStatus } from "./types";

/**
 * Department identity resolution (P3-5).
 *
 * Identity key (never name-only):
 *   school_code | department_code | program_type | academic_year
 *
 * Resolution policy against candidate history rows:
 *  - exact (school_code, department_code, program_type) match -> matched
 *    (name changes are recorded in notes, never silently merged away)
 *  - department_code changed / cannot be determined -> unresolved (never auto-merge)
 *  - more than one plausible candidate -> ambiguous + quality warning
 */

export function buildIdentityKey(
  schoolCode: string,
  departmentCode: string,
  programType: string,
  academicYear: number,
): string {
  return `${schoolCode}|${departmentCode}|${programType}|${academicYear}`;
}

export interface IdentityCandidate {
  schoolCode: string;
  departmentCode: string;
  programType: string;
  academicYear: number;
  departmentName?: string | null;
}

export function resolveDepartmentIdentity(
  target: IdentityCandidate,
  candidates: IdentityCandidate[],
): IdentityResolution {
  const identityKey = buildIdentityKey(
    target.schoolCode,
    target.departmentCode,
    target.programType,
    target.academicYear,
  );
  if (!target.schoolCode || !target.departmentCode) {
    return { status: "unresolved", identityKey, notes: ["school or department code missing"] };
  }
  const matches = candidates.filter(
    (c) =>
      c.schoolCode === target.schoolCode &&
      c.departmentCode === target.departmentCode &&
      c.programType === target.programType,
  );
  if (matches.length === 0) {
    return {
      status: "unresolved",
      identityKey,
      notes: ["no history row shares (school_code, department_code, program_type); not merged"],
    };
  }

  // Same-year conflict: two rows claim the same identity in one year -> ambiguous.
  const byYear = new Map<number, number>();
  for (const m of matches) byYear.set(m.academicYear, (byYear.get(m.academicYear) ?? 0) + 1);
  const conflictYear = [...byYear.entries()].find(([, n]) => n > 1)?.[0];
  if (conflictYear !== undefined) {
    return {
      status: "ambiguous",
      identityKey,
      notes: [`${matches.length} rows share identity with ${conflictYear} appearing twice; manual review required`],
    };
  }

  const names = new Set([...matches.map((m) => m.departmentName ?? null), target.departmentName ?? null]);
  const years = new Set([...matches.map((m) => m.academicYear), target.academicYear]);
  const sorted = [...years].sort((a, b) => a - b);
  const contiguous = sorted[sorted.length - 1]! - sorted[0]! + 1 === sorted.length;
  const renamed = names.size > 1;
  const notes: string[] = [];
  for (const m of matches) {
    if ((m.departmentName ?? null) !== (target.departmentName ?? null)) {
      notes.push(
        `name differs across years (${m.academicYear}: ${JSON.stringify(m.departmentName)} -> ${target.academicYear}: ${JSON.stringify(target.departmentName)}); same code, kept linked`,
      );
    }
  }
  // Gap + rename suggests possible code reuse -> ambiguous, never auto-merged.
  if (renamed && !contiguous) {
    notes.push("non-contiguous years with differing names; possible code reuse — flagged ambiguous");
    return { status: "ambiguous", identityKey, notes };
  }
  return { status: "matched", identityKey, notes };
}
