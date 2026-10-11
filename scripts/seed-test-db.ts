import pg from "pg";
import dotenv from "dotenv";
import { establishTestConnection, preflightHcCommand } from "../src/data/testing/testGuard";
import { buildHcSeedFixtures, seedTestDb } from "../src/data/testing/hcSeed";

dotenv.config({ path: ".env.test.local" });

/**
 * H-C seed entry (guard-first, TEST_DATABASE_URL only).
 * Order: preflight (exit 2) -> token (exit 2) -> establish (preflight +
 * live sentinel; any failure exits 1 with a secret-free message) ->
 * seedTestDb in one transaction -> summary counts. Never touches
 * DATABASE_URL; never runs without a provisioned isolated database
 * (establish fails first when there is nothing to connect to).
 */
function tokenFromArgv(): string {
  const i = process.argv.indexOf("--token");
  const v = i >= 0 ? process.argv[i + 1] : process.env["HC_GUARD_TOKEN"];
  if (typeof v !== "string" || v.length < 16) {
    console.error("missing --token <16+ chars> (or HC_GUARD_TOKEN); the token is never logged");
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  let target: { host: string; dbName: string };
  try {
    target = preflightHcCommand(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
  console.log(`seed-test-db target: host=${target.host} db=${target.dbName}`);
  const token = tokenFromArgv();
  let client: pg.Client | null = null;
  try {
    const established = await establishTestConnection(
      process.env,
      async (cs) => {
        const c = new pg.Client({ connectionString: cs });
        await c.connect();
        return c;
      },
      token,
    );
    client = established.client;
    const summary = await seedTestDb(client, buildHcSeedFixtures(), token);
    console.log(`seed-test-db done: ${JSON.stringify(summary)}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    try {
      await client?.end();
    } catch {
      /* noop */
    }
  }
}

void main();

export { buildHcSeedFixtures, seedTestDb, tokenFromArgv };
