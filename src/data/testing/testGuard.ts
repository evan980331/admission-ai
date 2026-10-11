/**
 * H-C isolation guard (P4.4b-7). Pure configuration checks + live-target
 * verification shape. NEVER falls back to DATABASE_URL. NEVER connects by
 * itself — connection happens only in the H-C runner after ALL checks pass,
 * and there is no isolated database yet, so nothing here may be executed
 * against a live server in this phase.
 *
 * No secrets are ever logged, returned, or interpolated into errors: only
 * host/dbname descriptors (non-secret) leave these functions.
 */

export interface DbTarget {
  host: string;
  dbName: string;
}

export interface LiveTargetExpectation {
  dbName: string;
  guardToken: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** TEST_DATABASE_URL or throw. DATABASE_URL is never consulted, never a fallback. */
export function readTestDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const v = env["TEST_DATABASE_URL"];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error("H-C refused: TEST_DATABASE_URL is not set (DATABASE_URL is never used as a fallback)");
  }
  return v;
}

/** Parse host/dbname without exposing credentials. Null when unparseable. */
export function parseDbTarget(url: string): DbTarget | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
  const host = u.hostname.toLowerCase();
  const dbName = u.pathname.replace(/^\//, "");
  if (!host || !dbName) return null;
  return { host, dbName };
}

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase());
}

export interface PreflightResult {
  target: DbTarget;
  /** True when a live sentinel check is still required before any write. */
  needsLiveSentinel: true;
}

/**
 * Pre-connection checks (no I/O). Fail-closed:
 * - unparseable TEST_DATABASE_URL -> refuse;
 * - prod DATABASE_URL known and (same dbname or same host+dbname) -> refuse;
 * - prod unknown and target not loopback -> refuse (cannot verify isolation).
 * URL features are necessary but never sufficient: the live sentinel
 * (verifyLiveTarget) is always still required.
 */
export function preflightConfig(env: NodeJS.ProcessEnv): PreflightResult {
  const testUrl = readTestDatabaseUrl(env);
  const target = parseDbTarget(testUrl);
  if (!target) throw new Error("H-C refused: TEST_DATABASE_URL is unparseable (expected postgres://host/db)");
  const prodRaw = env["DATABASE_URL"];
  if (typeof prodRaw === "string" && prodRaw.trim() !== "") {
    const prod = parseDbTarget(prodRaw);
    if (prod) {
      if (prod.dbName === target.dbName && prod.host === target.host) {
        throw new Error("H-C refused: TEST_DATABASE_URL points at the production database (same host+dbname)");
      }
      if (prod.dbName === target.dbName) {
        throw new Error("H-C refused: TEST_DATABASE_URL dbname matches production dbname");
      }
    }
    // Unparseable prod URL: cannot compare -> fall through to sentinel rule.
  } else if (!isLoopback(target.host)) {
    throw new Error("H-C refused: production URL unknown and target is not loopback (isolation unverifiable)");
  }
  return { target, needsLiveSentinel: true };
}

export interface LiveQuery {
  (text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Live-target verification shape (called only by the H-C runner AFTER
 * preflight, against the isolated database). Fails closed unless BOTH the
 * database name matches AND the seeded sentinel row carries the expected
 * token. Tested with injected mock queries — never against Neon here.
 */
export async function verifyLiveTarget(query: LiveQuery, expected: LiveTargetExpectation): Promise<void> {
  const db = await query("SELECT current_database() AS db");
  const actualDb = db.rows[0]?.["db"];
  if (actualDb !== expected.dbName) {
    throw new Error(`H-C refused: connected database is not the expected test database (name mismatch)`);
  }
  let guard: { rows: Array<Record<string, unknown>> };
  try {
    guard = await query("SELECT token FROM __hc_guard WHERE id = $1", ["hc"]);
  } catch {
    throw new Error("H-C refused: sentinel table __hc_guard absent (not a provisioned H-C database)");
  }
  if (guard.rows[0]?.["token"] !== expected.guardToken) {
    throw new Error("H-C refused: sentinel token mismatch (not the provisioned H-C database)");
  }
}

const CLEANABLE_TABLES = new Set([
  "screening_subject_rules",
  "screening_sequences",
  "second_stage_items",
  "apcs_requirements",
  "review_requirements",
  "special_requirements",
  "admission_schedule",
  "admission_notices",
  "tech_screening_groups",
  "tech_screening_items",
]);

const MAX_CLEANUP_IDS = 200;

export interface CleanupStatement {
  text: string;
  values: unknown[];
}

/**
 * Scoped cleanup builder (pure). Only the ten child tables, only explicit
 * admission-id whitelists. Protected masters (departments, schools,
 * programs, sources, migrations) can never be expressed here; empty or
 * oversized scopes throw. Execution belongs to the H-C runner, not here.
 */
export function buildScopedCleanup(table: string, admissionIds: string[]): CleanupStatement[] {
  if (!CLEANABLE_TABLES.has(table)) {
    throw new Error(`H-C refused: table ${table} is not cleanable (protected or unknown)`);
  }
  if (admissionIds.length === 0) throw new Error("H-C refused: empty cleanup scope (unbounded DELETE forbidden)");
  if (admissionIds.length > MAX_CLEANUP_IDS) throw new Error(`H-C refused: cleanup scope too large (${admissionIds.length} > ${MAX_CLEANUP_IDS})`);
  if (admissionIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("H-C refused: cleanup scope contains an empty id");
  }
  const placeholders = admissionIds.map((_, i) => `$${i + 1}`).join(",");
  return [{ text: `DELETE FROM ${table} WHERE admission_id IN (${placeholders})`, values: [...admissionIds] }];
}

/**
 * H-C command preflight (env only, no I/O): resolves the target descriptor
 * or throws fail-closed. The CLI prints host/dbname only — never the URL.
 */
export function preflightHcCommand(env: NodeJS.ProcessEnv): DbTarget {
  return preflightConfig(env).target;
}

/**
 * Resolves the validated TEST connection string (pure: no client created,
 * no connection). The string is returned verbatim — never mutated, never
 * substituted with DATABASE_URL. Callers must pass it to
 * establishTestConnection (which enforces guard-first + live sentinel),
 * never to production code paths.
 */
export function resolveTestConnectionString(env: NodeJS.ProcessEnv): { connectionString: string; target: DbTarget } {
  const target = preflightHcCommand(env);
  const connectionString = readTestDatabaseUrl(env);
  return { connectionString, target };
}

// ---------------------------------------------------------------------------
// Sentinel contract (P4.4b-9 §A). The sentinel table identifies a provisioned
// H-C database. It is created ONLY by the dedicated H-C seed step against
// the guard-verified test target — never automatically, never on prod.
// Presence/columns/token are all verified by verifyLiveTarget above.
// ---------------------------------------------------------------------------

export const SENTINEL_TABLE = "__hc_guard";
export const SENTINEL_ID = "hc";

export interface SeedStatement {
  text: string;
  values: unknown[];
}

/**
 * Sentinel seed statements (pure builders, never executed here). Idempotent
 * by construction: CREATE IF NOT EXISTS + INSERT ... ON CONFLICT DO NOTHING
 * (an existing token is never overwritten). Contains no TRUNCATE, DELETE,
 * DROP, or unbounded statements — asserted by test.
 */
export function buildSentinelSeedStatements(guardToken: string): SeedStatement[] {
  if (typeof guardToken !== "string" || guardToken.length < 16) {
    throw new Error("H-C refused: guard token must be a non-trivial secret value (never logged)");
  }
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS __hc_guard (id TEXT PRIMARY KEY, token TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      values: [],
    },
    {
      text: `INSERT INTO __hc_guard (id, token) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      values: [SENTINEL_ID, guardToken],
    },
  ];
}

export interface HcSeedDepartment {
  schoolCode: string;
  departmentCode: string;
}

export interface HcSeedSpec {
  /** Only the literal "synthetic" is accepted — prod copies are forbidden. */
  source: string;
  /** Synthetic-only department codes: /^9\d{5}$/ (never official inventory). */
  departments: HcSeedDepartment[];
  guardToken: string;
}

/**
 * Dedicated-seed contract validation (pure). Seed data must be synthetic
 * (9xxxxx range, disjoint from every official school code) so test rows can
 * never be confused with, or merged into, official admissions.
 */
export function validateSeedSpec(spec: HcSeedSpec): string[] {
  const errs: string[] = [];
  if (spec.source !== "synthetic") errs.push('seed source must be the literal "synthetic" (prod copies forbidden)');
  if (!Array.isArray(spec.departments) || spec.departments.length === 0) errs.push("seed departments must be non-empty");
  else {
    for (const [i, d] of spec.departments.entries()) {
      if (!/^\d{3}$/.test(d.schoolCode)) errs.push(`seed[${i}].schoolCode must be 3 digits`);
      if (!/^9\d{5}$/.test(d.departmentCode)) {
        errs.push(`seed[${i}].departmentCode must be synthetic 9xxxxx (never official inventory)`);
      } else if (!d.departmentCode.startsWith(d.schoolCode)) {
        errs.push(`seed[${i}].departmentCode does not start with schoolCode`);
      }
    }
  }
  if (typeof spec.guardToken !== "string" || spec.guardToken.length < 16) errs.push("guard token must be non-trivial");
  return errs;
}

export interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Sanctioned H-C connection order (guard-first): preflight -> factory ->
 * live sentinel -> hand over. The factory is injected (mock in tests); this
 * function never reads DATABASE_URL and never skips the sentinel. On ANY
 * failure it throws before the caller can write. The factory may be async
 * (real pg.Client needs connect()); sync factories keep working.
 */
export async function establishTestConnection<TClient extends TestClient>(
  env: NodeJS.ProcessEnv,
  createClient: (connectionString: string) => TClient | Promise<TClient>,
  expectedToken: string,
): Promise<{ client: TClient; target: DbTarget }> {
  const { connectionString, target } = resolveTestConnectionString(env);
  const client = await createClient(connectionString);
  await verifyLiveTarget(
    (text, values) => client.query(text, values),
    { dbName: target.dbName, guardToken: expectedToken },
  );
  return { client, target };
}

/**
 * Post-connect database-name recheck (necessary, never sufficient alone).
 * Used by bootstrap flows (e.g. test migration) that must run BEFORE any
 * sentinel row can exist. Returns the verified name or throws.
 */
export async function verifyDbName(
  query: LiveQuery,
  expectedDbName: string,
): Promise<void> {
  const db = await query("SELECT current_database() AS db");
  if (db.rows[0]?.["db"] !== expectedDbName) {
    throw new Error("H-C refused: connected database is not the expected test database (name mismatch)");
  }
}

/** Live H-C case IDs (H-C1..H-C12). The runner reports these explicitly. */
export const HC_LIVE_CASES = [
  "H-C1-migrate-order-schema",
  "H-C2-native-constraints",
  "H-C3-seed-lifecycle",
  "H-C4-guard-entry",
  "H-C5-sentinel-refusal",
  "H-C6-reconcile-already-applied",
  "H-C7-refusal-paths",
  "H-C8-rollback-residue",
  "H-C9-scope-isolation",
  "H-C10-tech-linkage",
  "H-C11-advisory-lock",
  "H-C12-disconnect-recovery",
] as const;

export interface HcExecutionPlan {
  mode: "LIVE" | "BLOCKED";
  reason: string;
  /** Live cases that will NOT run under this plan (empty when LIVE). */
  notRun: string[];
}

/**
 * Execution-plan gate (pure, no I/O): LIVE only with HC_LIVE=1 AND a
 * passing preflight. Anything else is BLOCKED with the full NOT RUN list
 * so skip counts can never be misread as passes.
 */
export function hcExecutionPlan(env: NodeJS.ProcessEnv): HcExecutionPlan {
  if (env["HC_LIVE"] !== "1") {
    return { mode: "BLOCKED", reason: "HC_LIVE != 1 (live suite disabled; NOT RUN)", notRun: [...HC_LIVE_CASES] };
  }
  try {
    preflightHcCommand(env);
  } catch (err) {
    return { mode: "BLOCKED", reason: err instanceof Error ? err.message : String(err), notRun: [...HC_LIVE_CASES] };
  }
  return { mode: "LIVE", reason: "", notRun: [] };
}
