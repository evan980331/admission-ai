import { getBrowserVersion, listTargets, type HttpGet } from "./cdp";
import type { CdpTarget } from "./types";

/**
 * Pre-navigation Chrome confirmation (P4.2c1). Shows what we are about to
 * touch and requires explicit operator confirmation before ANY tab is
 * navigated or operated. Fail-closed on every uncertainty: unreachable
 * browser, missing fingerprint, prompt failure, or a "no" answer all refuse
 * to proceed. `--yes` records operator intent only — it is NOT a technical
 * proof of Chrome ownership, profile, or site authorization.
 */

export interface ChromeTabSummary {
  title: string;
  url: string;
}

export interface ChromeInventory {
  endpoint: string;
  version: string | null;
  tabs: ChromeTabSummary[];
}

export interface ConfirmPlan {
  mode: "capture-only" | "full";
  school: string | null;
  department: string | null;
  targetCount: number;
}

export interface ConfirmResult {
  proceed: boolean;
  reason: string;
  /** Operator cancel is graceful (0); identification/prompt failures are errors (1). */
  exitCode: 0 | 1;
}

export async function inspectChrome(
  port: number,
  deps: {
    listTargets?: (port: number) => Promise<CdpTarget[]>;
    getVersion?: (port: number) => Promise<string | null>;
    httpGet?: HttpGet;
  } = {},
): Promise<ChromeInventory> {
  const list = deps.listTargets ?? ((p: number) => listTargets(p, deps.httpGet));
  const versionOf = deps.getVersion ?? ((p: number) => getBrowserVersion(p, deps.httpGet));
  const targets = await list(port);
  const tabs = targets
    .filter((t) => t.type === "page" && t.webSocketDebuggerUrl)
    .map((t) => ({ title: t.title, url: t.url }));
  return { endpoint: `http://127.0.0.1:${port}`, version: await versionOf(port), tabs };
}

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export async function confirmChrome(
  inv: ChromeInventory,
  plan: ConfirmPlan,
  opts: {
    yes: boolean;
    ask: (prompt: string) => Promise<string>;
    log?: (line: string) => void;
  },
): Promise<ConfirmResult> {
  const log = opts.log ?? (() => undefined);
  log(`Chrome endpoint: ${inv.endpoint}`);
  log(`Browser: ${inv.version ?? "UNAVAILABLE"}`);
  log(`Plan: mode=${plan.mode} school=${plan.school ?? "-"} department=${plan.department ?? "-"} targets=${plan.targetCount}`);
  log(`Open tabs (${inv.tabs.length}; only the single ensured tab is ever navigated — others are never closed, switched, or operated):`);
  for (const t of inv.tabs) log(`- ${trunc(t.title, 60)} ${trunc(t.url, 120)}`);
  if (inv.version === null) {
    return { proceed: false, reason: "browser fingerprint unavailable (/json/version unreachable); fail-closed, no navigation performed", exitCode: 1 };
  }
  if (opts.yes) {
    log("--yes means the operator confirms intent to proceed. It does NOT verify Chrome ownership, profile, or site authorization.");
    return { proceed: true, reason: "operator confirmed via --yes", exitCode: 0 };
  }
  let answer: string;
  try {
    answer = (await opts.ask(`Proceed with ${plan.targetCount} ${plan.mode} operation(s) on ${inv.endpoint}? [y/N] `)).trim().toLowerCase();
  } catch (err) {
    return { proceed: false, reason: `confirmation prompt failed (${err instanceof Error ? err.message : String(err)}); fail-closed, no navigation performed`, exitCode: 1 };
  }
  if (answer === "y" || answer === "yes") {
    return { proceed: true, reason: "operator confirmed interactively", exitCode: 0 };
  }
  return { proceed: false, reason: "cancelled by operator; no navigation performed", exitCode: 0 };
}
