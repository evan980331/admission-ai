/**
 * scoreGap = candidateNormalizedScore - historicalThreshold (P3-7).
 * Deterministic feature helper ONLY. No probability, no prediction.
 * Missing threshold (or missing candidate) -> null, never 0.
 */

export function computeScoreGap(
  candidateNormalizedScore: number | null | undefined,
  historicalThreshold: number | null | undefined,
): number | null {
  if (
    candidateNormalizedScore === null ||
    candidateNormalizedScore === undefined ||
    historicalThreshold === null ||
    historicalThreshold === undefined ||
    !Number.isFinite(candidateNormalizedScore) ||
    !Number.isFinite(historicalThreshold)
  ) {
    return null;
  }
  return candidateNormalizedScore - historicalThreshold;
}
