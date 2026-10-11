import path from "node:path";
import pg from "pg";
import dotenv from "dotenv";
import { preflightHcCommand, resolveTestConnectionString, verifyDbName } from "../src/data/testing/testGuard";
import { migrateTestDbForHc } from "../src/data/testing/migrateTest";

dotenv.config({ path: ".env.test.local" });

/**
 * Isolated-DB migration entry (guard-first, TEST_DATABASE_URL only).
 * Order: preflight (exit 2) -> connect -> verifyDbName re-check (the
 * sentinel cannot exist before the first migration, so the name check is
 * the bootstrap gate here; seed enforces the full sentinel afterwards) ->
 * migrateTestDbForHc (001..006, per-file transactions). Never touches
 * DATABASE_URL. No seed data is created here.
 */
async function main(): Promise<void> {
  let target: { host: string; dbName: string };
  try {
    target = preflightHcCommand(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
  console.log(`migrate-test-db target: host=${target.host} db=${target.dbName}`);
  const { connectionString } = resolveTestConnectionString(process.env);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await verifyDbName((text, values) => client.query(text, values), target.dbName);
    const applied = await migrateTestDbForHc(connectionString, path.join(process.cwd(), "db", "migrations"));
    console.log(`migrate-test-db done: applied=${applied.length} [${applied.join(",")}]`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    try {
      await client.end();
    } catch {
      /* noop */
    }
  }
}

void main();
