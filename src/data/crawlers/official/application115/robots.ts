/**
 * robots.txt handling. The crawler fetches robots.txt ONCE at startup and
 * refuses batch mode when it is disallowed. This module never fetches anything
 * except the robots.txt content handed to it.
 */

export interface RobotsVerdict {
  allowed: boolean;
  note: string;
}

/**
 * Conservative parser: looks at `User-agent: *` (and prefix-matching groups)
 * for a root `Disallow: /`. Any explicit root disallow => not allowed.
 * Unparseable / missing file => not allowed (fail closed).
 */
export function evaluateRobots(robotsText: string | null): RobotsVerdict {
  if (robotsText === null || robotsText.trim() === "") {
    return { allowed: false, note: "robots.txt missing or empty; fail closed (no batch fetch)" };
  }
  const lines = robotsText.split(/\r?\n/);
  let inWildcardGroup = false;
  let sawWildcard = false;
  for (const raw of lines) {
    const line = raw.split("#")[0]!.trim();
    if (!line) continue;
    const ua = line.match(/^User-agent\s*:\s*(.+)$/i);
    if (ua) {
      const val = ua[1]!.trim();
      inWildcardGroup = val === "*";
      if (inWildcardGroup) sawWildcard = true;
      continue;
    }
    if (!inWildcardGroup) continue;
    const dis = line.match(/^Disallow\s*:\s*(.*)$/i);
    if (dis) {
      const p = dis[1]!.trim();
      if (p === "/" || p === "/*") {
        return {
          allowed: false,
          note: "robots.txt contains `User-agent: *` + `Disallow: /`; batch fetch refused",
        };
      }
    }
  }
  if (!sawWildcard) {
    return { allowed: true, note: "no `User-agent: *` group found; no site-wide disallow" };
  }
  return { allowed: true, note: "`User-agent: *` group has no root disallow" };
}
