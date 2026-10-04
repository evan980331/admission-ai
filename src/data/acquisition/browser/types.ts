/**
 * P3.12 browser-assisted acquisition — types.
 * Reads ONLY pages the user already opened in their own Chrome via CDP on
 * localhost. NEVER issues HTTP requests to CAC or any external host.
 */

export const BROWSER_DEFAULT_PORT = 9222;
export const ACQ_BROWSER_VERSION = "browser-acquisition-v0.1.0";

export type BrowserCaptureStatus =
  | "captured"
  | "already_captured"
  | "content_changed"
  | "parse_success"
  | "parse_error"
  | "source_rejected";

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

export interface CapturedPage {
  tabUrl: string;
  tabTitle: string;
  outerHtml: string;
}

export interface CaptureMeta {
  sourceType: "official";
  sourceUrl: string;
  capturedAt: string;
  academicYear: number;
  departmentCode: string;
  schoolCode: string;
  sha256: string;
  previousSha256: string | null;
  acquisitionMethod: "browser_cdp";
  browserPort: number;
  parserVersion: string | null;
  status: BrowserCaptureStatus;
}

export interface BrowserImportResult {
  tabUrl: string | null;
  schoolCode: string | null;
  schoolName: string | null;
  departmentCode: string | null;
  departmentName: string | null;
  htmlBytes: number;
  sha256: string | null;
  captureStatus: BrowserCaptureStatus;
  parserStatus: "success" | "failed" | "skipped";
  normalizationStatus: "success" | "failed" | "skipped";
  reasons: string[];
}
