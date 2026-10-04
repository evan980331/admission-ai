import type { GapKind, SourceTier } from "./types";

/**
 * Source-tier + gap classifier. Policy mirrors docs/data-sources/source-tiers.md:
 * official is authoritative; third_party is validation/discovery only;
 * research_only never enters the official layer.
 */

export function classifyTier(sourceType: string): SourceTier {
  if (sourceType === "official") return "official";
  if (sourceType === "third_party") return "third_party";
  return "research_only";
}

export function usableAsOfficial(tier: SourceTier): boolean {
  return tier === "official";
}

export interface GapInput {
  hasOfficialPage: boolean;
  pageAcquired: boolean;
  parsed: boolean;
  parserSupports: boolean;
  fieldApplicable: boolean;
}

/**
 * Gap taxonomy (never lump every null as an acquisition problem):
 *  - field not applicable -> NOT_APPLICABLE
 *  - no reliable source exists -> SOURCE_GAP
 *  - page known but not acquired -> ACQUISITION_GAP
 *  - acquired but parser lacks support -> PARSER_GAP
 *  - otherwise -> UNKNOWN
 */
export function classifyGap(input: GapInput): GapKind {
  if (!input.fieldApplicable) return "NOT_APPLICABLE";
  if (!input.hasOfficialPage) return "SOURCE_GAP";
  if (!input.pageAcquired) return "ACQUISITION_GAP";
  if (!input.parsed && !input.parserSupports) return "PARSER_GAP";
  if (!input.parsed && input.parserSupports) return "ACQUISITION_GAP";
  return "UNKNOWN";
}
