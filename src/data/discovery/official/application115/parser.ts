/**
 * P3.8 parser layer — SINGLE SOURCE OF TRUTH is P2.5.
 * TotalGsdShow / ShowSchGsd HTML parsing lives in
 * src/data/crawlers/official/application115/{index-parser,school-parser}.ts.
 * This module only re-exports them so P3.8 never forks the logic.
 */
export {
  parseTotalSchools,
  type TotalParseResult,
} from "../../../crawlers/official/application115/index-parser";
export {
  parseSchoolDepartments,
  type SchoolParseResult,
} from "../../../crawlers/official/application115/school-parser";
export type { CrawlIssue } from "../../../crawlers/official/application115/types";
