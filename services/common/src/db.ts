import pg from "pg";
import { env } from "./env.ts";

// One Postgres instance; each service keeps its tables in its own schema.
export const db = new pg.Pool({ connectionString: env.DATABASE_URL });

/** Runs a service's idempotent CREATE ... IF NOT EXISTS statements on startup. */
export async function migrate(sql: string) {
  await db.query(sql);
}
