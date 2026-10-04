/**
 * P3.12 acquisition identity helper.
 *
 * schoolCode is ALWAYS the first 3 digits of a well-formed 6-digit
 * departmentCode (ABCDEF -> ABC). It is NEVER derived from the academicYear
 * or from the `115_` year prefix in CAC filenames/URLs (that group is the
 * year, not the school). Malformed codes yield null — never a guess.
 */
export function deriveSchoolCode(departmentCode: string): string | null {
  const code = departmentCode.trim();
  if (!/^\d{6}$/.test(code)) return null;
  return code.slice(0, 3);
}
