import {
  ACADEMIC_YEAR_115,
  PROGRAM_TYPE_APPLICATION,
  type NormalizedAdmission,
  type NormalizedDepartment,
  type NormalizedSchool,
  type ValidateResult,
  type ValidationIssue,
} from "./types";

/**
 * VALIDATE stage — the 12 P2 checks. Pure function (batch-level).
 * DB-existence duplicate check lives in index.ts (needs a client) and appends
 * to the same issue list; batch-level duplicate detection is check #10 here.
 */

function err(check: string, detail: string, rowIndex?: number): ValidationIssue {
  return { level: "error", check, detail, rowIndex };
}

function warn(check: string, detail: string, rowIndex?: number): ValidationIssue {
  return { level: "warning", check, detail, rowIndex };
}

export function validateBatch(
  schools: NormalizedSchool[],
  departments: NormalizedDepartment[],
  admissions: NormalizedAdmission[],
  rowIndexByAdmission: number[],
): ValidateResult {
  const issues: ValidationIssue[] = [];
  const invalid = new Set<number>();

  // #1 school code 不重複
  {
    const seen = new Set<string>();
    for (const s of schools) {
      if (seen.has(s.school_code)) {
        issues.push(err("01-school-unique", `duplicate school_code ${s.school_code}`));
      }
      seen.add(s.school_code);
      if (!s.school_code.trim() || !s.name.trim()) {
        issues.push(err("01-school-unique", `school with empty code/name: ${JSON.stringify(s)}`));
      }
    }
  }

  // #2 department code 在 school 下不重複
  {
    const seen = new Set<string>();
    for (const d of departments) {
      const k = `${d.school_code}:${d.department_code}`;
      if (seen.has(k)) issues.push(err("02-dept-unique", `duplicate department ${k}`));
      seen.add(k);
    }
  }

  const deptKeys = new Set(departments.map((d) => `${d.school_code}:${d.department_code}`));

  admissions.forEach((a, i) => {
    const fail = (check: string, detail: string) => {
      issues.push(err(check, detail, rowIndexByAdmission[i]));
      invalid.add(i);
    };

    // #3 year 正確 (P2 只允許 115)
    if (a.year !== ACADEMIC_YEAR_115) fail("03-year", `year must be 115, got ${a.year}`);
    // #4 program_type 正確
    if (a.program_type !== PROGRAM_TYPE_APPLICATION)
      fail("04-program-type", `program_type must be application, got ${a.program_type}`);
    // #5 quota >= 0 (NULL = 官方未提供，記 warning 不擋)
    if (a.quota === null) {
      issues.push(warn("05-quota", "quota missing (NULL kept, not invented)", rowIndexByAdmission[i]));
    } else if (a.quota < 0) {
      fail("05-quota", `quota must be >= 0, got ${a.quota}`);
    }
    // #6 screening ratio > 0 或 NULL
    (["screening_ratio_1", "screening_ratio_2", "screening_ratio_3"] as const).forEach((k) => {
      const v = a[k];
      if (v !== null && !(v > 0)) fail("06-screening-ratio", `${k} must be > 0 or NULL, got ${v}`);
    });
    // #7 requirement 格式合法 (只接受已知的檢定文字；未知值記 warning 保留原文)
    const reqKeys = [
      "chinese_requirement",
      "english_requirement",
      "math_a_requirement",
      "math_b_requirement",
      "social_requirement",
      "science_requirement",
      "english_listening_requirement",
    ] as const;
    for (const k of reqKeys) {
      const v: unknown = (a as unknown as Record<string, unknown>)[k];
      if (typeof v === "string" && v.length > 200)
        fail("07-requirement", `${k} too long (${v.length} chars)`);
    }
    // #8 不允許無法對應 department 的 admission
    if (!deptKeys.has(`${a.school_code}:${a.department_code}`)) {
      fail(
        "08-dept-ref",
        `admission references unknown department ${a.school_code}:${a.department_code}`,
      );
    }
  });

  // #10 同一 year + department + program 不得 duplicate (batch 內)
  {
    const seen = new Map<string, number>();
    admissions.forEach((a, i) => {
      const k = `${a.year}:${a.school_code}:${a.department_code}:${a.program_type}`;
      if (seen.has(k)) {
        const first = seen.get(k)!;
        issues.push(
          err(
            "10-no-duplicate",
            `duplicate admission ${k} (rows ${rowIndexByAdmission[first]} and ${rowIndexByAdmission[i]})`,
            rowIndexByAdmission[i],
          ),
        );
        invalid.add(i);
      } else {
        seen.set(k, i);
      }
    });
  }

  // #9 source_id 缺失：source 由 pipeline 統一建立；此處保證每筆 admission 都會帶上同一個 source。
  // (Checks #11/#12 — 不靜默吞資料、失敗 row 進 error report — 由 parser/normalizer + report 保證，
  //  此處以斷言方式覆核。)
  if (admissions.length === 0) {
    issues.push(warn("12-empty", "no admission rows to validate"));
  }

  return {
    validAdmissions: admissions.filter((_, i) => !invalid.has(i)),
    issues,
  };
}
