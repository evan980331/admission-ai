import {
  assertLoopback,
  captureCurrentPage,
  defaultWsEvaluate,
  listTargets,
  navigateTab,
  type HttpGet,
  type WsEvaluate,
  type WsSend,
} from "./cdp";
import type { CdpTarget } from "./types";
import { isCacDetailTabUrl } from "./tabs";
import { isCacSchoolTabUrl } from "./universe";

export interface RunnerCdpDeps {
  httpGet?: HttpGet;
  httpPut?: (url: string) => Promise<{ status: number; text: string }>;
  wsEvaluate?: WsEvaluate;
  wsSend?: WsSend;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RunnerConfig {
  navTimeoutMs: number;
  settleTimeoutMs: number;
  settleStableMs: number;
  pollMs: number;
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  navTimeoutMs: 30000,
  settleTimeoutMs: 10000,
  settleStableMs: 1500,
  pollMs: 500,
};

const defaultHttpPut: (url: string) => Promise<{ status: number; text: string }> = async (url) => {
  assertLoopback(url);
  const res = await fetch(url, { method: "PUT" });
  return { status: res.status, text: await res.text() };
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isCacPage(url: string): boolean {
  return isCacDetailTabUrl(url) || isCacSchoolTabUrl(url) !== null;
}

/**
 * Single-tab invariant: at most one CAC page may be open. Returns the
 * existing CAC detail tab, or creates exactly one blank tab (never more).
 * Refuses when the user has 2+ CAC pages open.
 */
export async function ensureSingleTab(
  port: number,
  deps: RunnerCdpDeps = {},
): Promise<{ wsUrl: string; created: boolean; reusedUrl: string | null }> {
  const targets = await listTargets(port, deps.httpGet);
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const cacPages = pages.filter((p) => isCacPage(p.url));
  if (cacPages.length > 1) {
    throw new Error(`refusing: ${cacPages.length} CAC pages open (keep at most one for runner mode)`);
  }
  const detailPages = cacPages.filter((p) => isCacDetailTabUrl(p.url));
  if (detailPages.length === 1) {
    return { wsUrl: detailPages[0]!.webSocketDebuggerUrl, created: false, reusedUrl: detailPages[0]!.url };
  }
  if (cacPages.length === 1) {
    throw new Error(`the single open CAC page is not a detail tab (${cacPages[0]!.url.slice(0, 80)}); close it or open nothing CAC and retry`);
  }
  const put = deps.httpPut ?? defaultHttpPut;
  const res = await put(`http://127.0.0.1:${port}/json/new?about:blank`);
  if (res.status !== 200) throw new Error(`Chrome tab creation failed (HTTP ${res.status})`);
  const created = JSON.parse(res.text) as { webSocketDebuggerUrl?: unknown };
  if (typeof created.webSocketDebuggerUrl !== "string" || !created.webSocketDebuggerUrl) {
    throw new Error("Chrome tab creation returned no debugger URL");
  }
  return { wsUrl: created.webSocketDebuggerUrl, created: true, reusedUrl: null };
}

const STATE_EXPR = `JSON.stringify({ ready: document.readyState, href: location.href, len: document.documentElement.outerHTML.length })`;

export interface SettledPage {
  href: string;
  html: string;
}

/**
 * Navigate one tab, then wait for: load-complete + expected pathname +
 * HTML length stable across polls. Throws FAILED on any timeout.
 * No fixed 1s sleep: polls until stable or budgeted timeouts expire.
 */
export async function navigateAndSettle(
  wsUrl: string,
  url: string,
  expectedPath: string,
  config: RunnerConfig = DEFAULT_RUNNER_CONFIG,
  deps: RunnerCdpDeps = {},
): Promise<SettledPage> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const wsEvaluate = deps.wsEvaluate;
  const wsSend = deps.wsSend;
  await navigateTab(wsUrl, url, wsSend);
  const deadline = now() + config.navTimeoutMs + config.settleTimeoutMs;
  let stableSince: number | null = null;
  let lastLen = -1;
  for (;;) {
    if (now() > deadline) {
      throw new Error(`navigation/settle timeout for ${url.slice(0, 80)}`);
    }
    let state: { ready?: unknown; href?: unknown; len?: unknown };
    try {
      const raw = await (wsEvaluate ?? defaultWsEvaluate)(wsUrl, STATE_EXPR);
      state = JSON.parse(raw) as typeof state;
    } catch {
      await sleep(config.pollMs);
      continue;
    }
    const href = typeof state.href === "string" ? state.href : "";
    let path: string | null = null;
    try {
      path = new URL(href).pathname;
    } catch {
      path = null;
    }
    if (state.ready === "complete" && path === expectedPath && typeof state.len === "number") {
      if (state.len === lastLen) {
        if (stableSince === null) stableSince = now();
        if (now() - stableSince >= config.settleStableMs) {
          const page = await captureCurrentPage(wsUrl, wsEvaluate);
          return { href: page.tabUrl || href, html: page.outerHtml };
        }
      } else {
        lastLen = state.len;
        stableSince = null;
      }
    } else {
      lastLen = -1;
      stableSince = null;
    }
    await sleep(config.pollMs);
  }
}

export type { CdpTarget };
