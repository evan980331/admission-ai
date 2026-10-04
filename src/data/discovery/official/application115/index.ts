import { totalHtmlToManifestInput, manifestEntryToDetailInput } from "./adapter";
import { buildManifest } from "./normalizer";
import { validateDetailUrl, detailCodeOf } from "./validator";
import { parseTotalSchools, parseSchoolDepartments } from "./parser";

export {
  totalHtmlToManifestInput,
  manifestEntryToDetailInput,
  buildManifest,
  validateDetailUrl,
  detailCodeOf,
  parseTotalSchools,
  parseSchoolDepartments,
};
export type {
  OfficialDepartmentEntry,
  OfficialDepartmentManifest,
  OfficialSchoolManifest,
  ManifestReport,
  ManifestIssue,
  UrlValidation,
} from "./types";
