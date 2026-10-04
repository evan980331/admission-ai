import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseFile } from "../src/data/importers/official/application115/parser";

const FIX = path.join(__dirname, "fixtures", "application115");

describe("application115 parser", () => {
  it("parses the html fixture and maps confirmed labels", () => {
    const r = parseFile(path.join(FIX, "sample-dept.html"));
    expect(r.format).toBe("html");
    expect(r.errors).toHaveLength(0);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]!.fields["department_code"]).toBe("901001");
    expect(r.records[0]!.fields["quota"]).toBe("40");
    // unknown tables are kept, not dropped
    expect(r.records[0]!.unmappedSections.length).toBeGreaterThan(0);
  });

  it("parses the csv fixture", () => {
    const r = parseFile(path.join(FIX, "sample.csv"));
    expect(r.format).toBe("csv");
    expect(r.errors).toHaveLength(0);
    expect(r.records).toHaveLength(2);
  });

  it("parses the json fixture", () => {
    const r = parseFile(path.join(FIX, "sample.json"));
    expect(r.format).toBe("json");
    expect(r.records).toHaveLength(1);
  });

  it("reports malformed rows instead of swallowing them", () => {
    const r = parseFile(path.join(FIX, "malformed.csv"));
    expect(r.errors.length).toBeGreaterThan(0);
    // first bad row parses (fails later at normalize/validate), second fails at parse
    expect(r.records.length + r.errors.length).toBe(2);
  });
});
