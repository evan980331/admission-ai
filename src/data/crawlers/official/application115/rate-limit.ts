/** Rate limiting primitives. Default: strictly sequential with a fixed delay. */

export const REQUEST_DELAY_MS = 2000;
export const REQUEST_TIMEOUT_MS = 15000;
export const MAX_RETRIES = 2;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializes all gated work and enforces a minimum delay between completions.
 * The crawler runs concurrency = 1; every request goes through ONE Pacer.
 */
export class Pacer {
  private tail: Promise<void> = Promise.resolve();
  private lastDone = 0;

  constructor(private readonly delayMs: number = REQUEST_DELAY_MS) {}

  pace(): Promise<void> {
    const run = this.tail.then(async () => {
      const wait = this.delayMs - (Date.now() - this.lastDone);
      if (wait > 0) await sleep(wait);
      this.lastDone = Date.now();
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}
