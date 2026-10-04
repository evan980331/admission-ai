import type { CapturedPage, CdpTarget } from "./types";

/**
 * CDP transport with a hard network boundary: ONLY loopback destinations
 * (127.0.0.1 / ::1 / localhost) are ever contacted. Anything else throws
 * before any socket is opened. Uses the Node global WebSocket (no new deps).
 */

export function assertLoopback(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`refused non-URL target: ${url.slice(0, 80)}`);
  }
  const host = u.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error(`network boundary: only 127.0.0.1 is allowed, refused ${host}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ws:" && u.protocol !== "wss:") {
    throw new Error(`network boundary: unexpected protocol ${u.protocol}`);
  }
}

export type HttpGet = (url: string) => Promise<{ status: number; text: string }>;
export type WsEvaluate = (wsUrl: string, expression: string) => Promise<string>;

const defaultHttpGet: HttpGet = async (url) => {
  assertLoopback(url);
  const res = await fetch(url);
  return { status: res.status, text: await res.text() };
};

const defaultWsEvaluate: WsEvaluate = (wsUrl, expression) =>
  new Promise<string>((resolve, reject) => {
    try {
      assertLoopback(wsUrl);
    } catch (err) {
      reject(err);
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      reject(new Error("CDP evaluate timeout"));
    }, 15000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String((ev as MessageEvent).data));
        if (msg.id !== 1) return;
        clearTimeout(timer);
        ws.close();
        if (msg.error) reject(new Error(`CDP error: ${msg.error.message ?? JSON.stringify(msg.error)}`));
        else resolve(String(msg.result?.result?.value ?? ""));
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
    ws.addEventListener("error", (ev) => {
      clearTimeout(timer);
      reject(new Error(`CDP websocket error: ${String((ev as ErrorEvent).message ?? ev)}`));
    });
  });

export async function listTargets(port: number, httpGet: HttpGet = defaultHttpGet): Promise<CdpTarget[]> {
  const url = `http://127.0.0.1:${port}/json`;
  let res: { status: number; text: string };
  try {
    res = await httpGet(url);
  } catch (err) {
    throw new Error(
      `cannot reach Chrome at ${url} (${err instanceof Error ? err.message : String(err)}). ` +
        `Start Chrome with remote debugging first (see docs).`,
    );
  }
  if (res.status !== 200) throw new Error(`Chrome /json returned HTTP ${res.status}`);
  const data = JSON.parse(res.text) as CdpTarget[];
  if (!Array.isArray(data)) throw new Error("Chrome /json returned unexpected data");
  return data;
}

const PAGE_SNAPSHOT_EXPR = `JSON.stringify({
  html: document.documentElement.outerHTML,
  href: location.href,
  title: document.title
})`;

/** Full-document capture (outerHTML, never body-only) + live href/title. */
export async function captureCurrentPage(
  wsUrl: string,
  wsEvaluate: WsEvaluate = defaultWsEvaluate,
): Promise<CapturedPage> {
  const raw = await wsEvaluate(wsUrl, PAGE_SNAPSHOT_EXPR);
  let snap: { html?: unknown; href?: unknown; title?: unknown };
  try {
    snap = JSON.parse(raw) as typeof snap;
  } catch {
    throw new Error("CDP returned unparseable page snapshot");
  }
  if (typeof snap.html !== "string" || snap.html.length === 0) {
    throw new Error("CDP returned empty outerHTML");
  }
  return {
    tabUrl: typeof snap.href === "string" ? snap.href : "",
    tabTitle: typeof snap.title === "string" ? snap.title : "",
    outerHtml: snap.html,
  };
}
