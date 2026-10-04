/**
 * P3.11 local import pipeline — types. ZERO network: local HTML files in,
 * validated records + reports out. No DB writes in this layer.
 */

export type FileStatus =
  | "imported"
  | "already_imported"
  | "invalid_html"
  | "unidentified"
  | "source_unverified"
  | "parser_error"
  | "normalization_error";

export interface DiscoveredFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface FileResult {
  path: string;
  sha256: string;
  status: FileStatus;
  schoolCode: string | null;
  departmentCode: string | null;
  departmentName: string | null;
  sourceUrl: string | null;
  reasons: string[];
}

export interface ImportReport {
  generatedAt: string;
  academicYear: number;
  inputDir: string;
  dryRun: boolean;
  discovered: number;
  supported: number;
  imported: number;
  skipped: number;
  unidentified: number;
  sourceUnverified: number;
  parserErrors: number;
  normalizationErrors: number;
  duplicates: number;
  files: FileResult[];
}
