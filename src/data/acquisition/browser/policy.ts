/**
 * CAC access policy disclosure (P4.2d, offline).
 *
 * Audited fact: `https://www.cac.edu.tw/robots.txt` is `Disallow: /` for
 * automated fetching (see docs/data-sources/official-115-application.md).
 * This module performs NO network requests and reads NO live state — it
 * only renders the standing policy so every acquisition run (including
 * dry-run) shows it before any queue or confirmation output.
 *
 * What the runner is and is not:
 * - It NEVER issues bulk HTTP requests; the only browser contact is
 *   loopback CDP against the operator's own user-owned Chrome, one tab.
 * - It NEVER navigates without explicit operator confirmation
 *   (confirmChrome, fail-closed). `--yes` records operator intent only —
 *   it is NOT official-site authorization and does NOT lift the
 *   robots.txt restriction or the throttle/stop rules.
 * - Until site authorization is confirmed, this project ships an auditable
 *   pending queue only; actual collection stays blocked on confirmation.
 */

export const CAC_ROBOTS_DISALLOW_ALL = true;

export const CAC_ROBOTS_SOURCE = "docs/data-sources/official-115-application.md";

export function accessPolicyLines(): string[] {
  return [
    "Access policy: cac.edu.tw robots.txt is Disallow:/ (automated fetch prohibited; see docs/data-sources/official-115-application.md).",
    "Access policy: this runner makes no bulk HTTP requests; only loopback CDP on the operator-owned Chrome, single tab.",
    "Access policy: no navigation without explicit operator confirmation (fail-closed); --yes is intent only, not site authorization.",
  ];
}
