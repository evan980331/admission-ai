/**
 * P3.9 HTTP adapter — re-exports P2.5 infrastructure (single source of truth).
 * Robots verdict, pacing, timeout/retry client and raw paths all come from P2.5;
 * P3.9 only adds response-metadata fetching needed for validation.
 */
export { evaluateRobots } from "../../../crawlers/official/application115/robots";
export { Pacer, REQUEST_DELAY_MS, REQUEST_TIMEOUT_MS, MAX_RETRIES } from "../../../crawlers/official/application115/rate-limit";
export {
  fetchText,
  fetchWithMeta,
  type FetchMeta,
  type FetchMetaImpl,
  type FetchOptions,
} from "../../../crawlers/official/application115/client";
export {
  departmentPath,
  rawRoot,
  readIfCached,
  robotsCachePath,
  writeRaw,
} from "../../../crawlers/official/application115/cache";
export { ROBOTS_URL } from "../../../crawlers/official/application115/types";
