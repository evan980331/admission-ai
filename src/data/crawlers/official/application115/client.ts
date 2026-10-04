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
