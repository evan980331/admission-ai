import fs from "node:fs";
import path from "node:path";
import pg from "pg";

/**
 * Isolated-DB migration runner (H-C only). Applies db/migrations *.sql in
 * filename order with per-file transactions + schema_migrations
 * bookkeeping (same shape as db/migrate.ts). Takes an explicit connection
 * string — callers must have passed the H-C preflight first; this function
 * performs no guard itself. Never called against production.
 */
export async function migrateTestDbForHc(connectionString: string, migrationsDir: string): Promise<string[]> {
  const applied: string[] = [];
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const done = await client.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [file]);
      if ((done.rowCount ?? 0) > 0) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    return applied;
  } finally {
    await client.end();
  }
}
