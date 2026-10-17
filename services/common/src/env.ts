import { config } from "dotenv";
import { join } from "node:path";
import { z } from "zod";

// All services share the repo-root .env (see .env.example).
export const repoRoot = join(import.meta.dirname, "..", "..", "..");
config({ path: join(repoRoot, ".env"), quiet: true });

const schema = z.object({
  DATABASE_URL: z.string().default("postgres://localhost:5433/coldchainsg"),
  RPC_URL: z.string().default("http://127.0.0.1:8545"),
  CHAIN_NETWORK: z.string().default("localhost"),
  FRONTEND_ORIGIN: z.string().default("http://localhost:5173"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  // Service wallets (only the service that signs with a key needs it set).
  ADMIN_PRIVATE_KEY: z.string().optional(),
  ORACLE_PRIVATE_KEY: z.string().optional(),
  CERTIFIER_PRIVATE_KEY: z.string().optional(),
  // The sensor gateway's key: funds each sensor's device key and derives it (see sensor-gateway).
  SENSOR_PRIVATE_KEY: z.string().optional(),
  IDENTITY_PORT: z.coerce.number().default(4001),
  CUSTODY_PORT: z.coerce.number().default(4002),
  ORACLE_PORT: z.coerce.number().default(4003),
  CERTIFICATE_PORT: z.coerce.number().default(4004),
  GATEWAY_PORT: z.coerce.number().default(4005),
});

export const env = schema.parse(process.env);
