/**
 * P3.9 official detail acquisition PoC — shared types.
 * Small-batch only (<=10 URLs, all from the P3.8 manifest). No DB writes.
 */

export const ACQUISITION_VERSION = "official-acquisition-v0.1.0";
export const MAX_BATCH = 10;

export type AcquisitionStatus =
  | "success"
  | "cached"
  | "failed"
  | "robots_blocked"
  | "invalid"
  | "parse_failed";

export interface PageReport {
  departmentCode: string;
  departmentName: string | null;
  url: string;
  finalUrl: string | null;
  status: AcquisitionStatus;
  httpStatus: number | null;
  contentType: string | null;
  bytes: number;
  sha256: string | null;
  retrievedAt: string | null;
  cacheHit: boolean;
  parserStatus: "parsed" | "skipped" | "failed";
  errors: string[];
  warnings: string[];
}

export interface AcquisitionReport {
  academicYear: number;
  source: "official";
  acquisitionVersion: string;
  robotsAllowed: boolean | null;
  robotsNote: string;
  startedAt: string;
  finishedAt: string;
  requested: number;
  success: number;
  cached: number;
  failed: number;
  robotsBlocked: number;
  invalid: number;
  parseFailed: number;
  manifestErrors: string[];
  pages: PageReport[];
}
