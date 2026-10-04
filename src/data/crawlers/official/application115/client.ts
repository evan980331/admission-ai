import { CRAWLER_USER_AGENT, type FetchImpl } from "./types";
import { REQUEST_TIMEOUT_MS, MAX_RETRIES } from "./rate-limit";

export interface FetchOptions {
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: FetchImpl;
}

function defaultFetch(): FetchImpl {
  return async (url, init) => {
    const res = await fetch(url, {
      signal: init?.signal,
      headers: { "User-Agent": CRAWLER_USER_AGENT, ...(init?.headers ?? {}) },
    });
    return { status: res.status, text: () => res.text() };
  };
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Rich fetch implementation carrying headers + final URL (redirect-aware). */
export type FetchMetaImpl = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ status: number; headers: Record<string, string>; url: string; bytes: () => Promise<Uint8Array> }>;

export interface FetchMeta {
  status: number;
  headers: Record<string, string>;
  finalUrl: string;
  body: Uint8Array;
  attempts: number;
}

function defaultMetaFetch(): FetchMetaImpl {
  return async (url, init) => {
    const res = await fetch(url, {
      signal: init?.signal,
      headers: { "User-Agent": CRAWLER_USER_AGENT, ...(init?.headers ?? {}) },
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return { status: res.status, headers, url: res.url || url, bytes: () => res.arrayBuffer().then((b) => new Uint8Array(b)) };
  };
}

/**
 * Additive variant of fetchText with response metadata (status/headers/final URL).
 * Same timeout/retry/no-evasion semantics; fetchText behavior unchanged.
 */
export async function fetchWithMeta(
  url: string,
  opts: { timeoutMs?: number; maxRetries?: number; fetchImpl?: FetchMetaImpl } = {},
): Promise<FetchMeta> {
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const impl = opts.fetchImpl ?? defaultMetaFetch();

  let lastError = "";
  let attempts = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await impl(url, {
        signal: ctrl.signal,
        headers: { "User-Agent": CRAWLER_USER_AGENT },
      });
      if (res.status >= 200 && res.status < 300) {
        return { status: res.status, headers: res.headers, finalUrl: res.url || url, body: await res.bytes(), attempts };
      }
      lastError = `HTTP ${res.status} for ${url}`;
      if (!isRetryable(res.status)) {
        return { status: res.status, headers: res.headers, finalUrl: res.url || url, body: new Uint8Array(), attempts };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === maxRetries) throw new Error(`fetch failed after ${maxRetries + 1} attempts: ${lastError}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`unreachable: ${lastError}`);
}

/**
 * Single HTTP GET with timeout + bounded retries. No parallelism here —
 * callers must serialize through Pacer (concurrency = 1).
 * 4xx (except 408/429) is NOT retried; API/session tricks are NOT attempted.
 */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const impl = opts.fetchImpl ?? defaultFetch();

  let lastError = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let status: number;
    let body: () => Promise<string>;
    try {
      const res = await impl(url, {
        signal: ctrl.signal,
        headers: { "User-Agent": CRAWLER_USER_AGENT },
      });
      status = res.status;
      body = res.text;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === maxRetries) {
        throw new Error(`fetch failed after ${maxRetries + 1} attempts: ${lastError}`);
      }
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (status >= 200 && status < 300) return await body();
    lastError = `HTTP ${status} for ${url}`;
    // Non-retryable statuses (e.g. 404) throw immediately — never looped.
    if (!isRetryable(status)) throw new Error(lastError);
  }
  throw new Error(`unreachable: ${lastError}`);
}
