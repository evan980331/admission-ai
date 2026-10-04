import { neon } from "@neondatabase/serverless";

/**
 * Edge / serverless-safe Neon client.
 * Requires DATABASE_URL in runtime env (.env.local, never committed).
 */
export function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
  }
  return neon(url);
}

export async function checkDatabaseConnection(): Promise<{ ok: boolean; now?: string }> {
  const sql = getSql();
  const rows = await sql`select now() as now`;
  return { ok: true, now: String((rows as Array<{ now: string }>)[0]?.now ?? "") };
}
