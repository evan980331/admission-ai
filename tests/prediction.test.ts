import { describe, expect, it } from "vitest";
import { predictPlaceholder } from "../src/server/prediction/model";

describe("predictPlaceholder (P1 interface-only)", () => {
  it("never returns a numeric probability", () => {
    const out = predictPlaceholder({
      academicYear: 115,
      programType: "application",
      examType: "gsat",
      departmentId: "test-dept",
      subjectLevels: { chinese: 13 },
    });
    expect(out.pFirstStagePass).toBeNull();
    expect(out.pSecondStagePass).toBeNull();
    expect(out.pFinalAdmission).toBeNull();
    expect(out.warnings.length).toBeGreaterThan(0);
  });
});
