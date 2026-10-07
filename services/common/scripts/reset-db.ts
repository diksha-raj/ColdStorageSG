// A fresh local chain restarts on-chain ids at 1, so the off-chain tables must start fresh too.
// Run automatically by `npm run deploy` (local and e2e networks only, never Sepolia). Services recreate their tables on startup.
import { db, env } from "../src/index.ts";

if (env.CHAIN_NETWORK !== "localhost" && env.CHAIN_NETWORK !== "e2e") {
  console.log(`Skipping DB reset on ${env.CHAIN_NETWORK}`);
} else {
  for (const schema of ["identity", "custody", "oracle", "certificate"]) {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
  console.log("Reset off-chain schemas (restart running services to recreate tables)");
}
await db.end();
