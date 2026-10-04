import { buildReport, compareRows, normalizeDeptName } from "./compare";
import type {
  ComparedRow,
  CrossValidationReport,
  OfficialRow,
  RowVerdict,
  ThirdPartyRow,
} from "./types";

export { buildReport, compareRows, normalizeDeptName };
export type { ComparedRow, CrossValidationReport, OfficialRow, RowVerdict, ThirdPartyRow };
export type { UtwBridgeRow as BridgeRow };

/** Bridge: accept full ThirdPartyRecord-shaped rows, compare on the shared subset. */
export interface UtwBridgeRow extends ThirdPartyRow {
  sourceType?: string;
  sourceName?: string;
  academicYear?: number;
}

export function compareWithProvenance(
  academicYear: number,
  officialSource: string,
  thirdPartySource: string,
  official: OfficialRow[],
  thirdParty: ThirdPartyRow[],
) {
  return buildReport(academicYear, officialSource, thirdPartySource, compareRows(official, thirdParty));
}
