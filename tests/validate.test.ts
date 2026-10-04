import { describe, expect, it } from "vitest";
import { runValidation } from "../scripts/validate";

function fakeClient(rows: Record<string, number>, dupRows = 0, anomaly: unknown[] = []) {
  const calls: string[] = [];
  return {
    calls,
    async query(sql: string) {
      calls.push(sql);
      if (sql.includes("departments d LEFT JOIN")) return { rows: [{ c: rows.dept ?? 0 }], rowCount: 1 };
      if (sql.includes("department_admissions a LEFT JOIN"))
        return { rows: [{ c: rows.adm ?? 0 }], rowCount: 1 };
      if (sql.includes("UNION ALL SELECT year")) return { rows: [{ c: rows.year ?? 0 }], rowCount: 1 };
      if (sql.includes("FROM department_admissions WHERE quota"))
        return { rows: [{ c: rows.quota ?? 0 }], rowCount: 1 };
      if (sql.includes("admitted > quota")) return { rows: anomaly, rowCount: anomaly.length };
      if (sql.includes("FROM score_statistics")) return { rows: [{ c: rows.five ?? 0 }], rowCount: 1 };
      if (sql.includes("data_sources s ON")) return { rows: [{ c: rows.src ?? 0 }], rowCount: 1 };
      if (sql.includes("GROUP BY 1,2,3")) return { rows: [{ c: dupRows }], rowCount: 1 };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

describe("runValidation", () => {
  it("passes on clean data", async () => {
    const client = fakeClient({});
    const { results, failed } = await runValidation(client as never);
    expect(failed).toBe(false);
    expect(results).toHaveLength(8);
  });

  it("flags admitted > quota anomalies", async () => {
    const client = fakeClient({}, 0, [{ year: 114, admitted: 50, quota: 40 }]);
    const { failed, results } = await runValidation(client as never);
    expect(failed).toBe(true);
    expect(results.find((r) => r.name.includes("admitted"))?.ok).toBe(false);
  });
});
