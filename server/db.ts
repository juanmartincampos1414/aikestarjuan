import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import * as schema from "@shared/schema";

const isProduction = process.env.NODE_ENV === 'production';
const databaseUrl = (isProduction ? process.env.NEON_OHIO_URL : undefined) || process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

const dbSource = (isProduction && process.env.NEON_OHIO_URL) ? 'NEON_OHIO_URL' : 'DATABASE_URL';
try {
  const dbHost = new URL(databaseUrl).host;
  console.log(`[DB] Connecting to ${dbHost} (source: ${dbSource})`);
} catch {
  console.log(`[DB] Connecting (source: ${dbSource})`);
}
if (process.env.NODE_ENV === 'production' && !process.env.NEON_OHIO_URL) {
  console.warn('[DB] WARNING: NEON_OHIO_URL not set in production — falling back to injected DATABASE_URL. Verify this is intentional (rollback) and not a missing secret.');
}

export const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 20,
});

pool.on('error', (err) => {
  console.error('[DB Pool] Unexpected error on idle client:', err.message);
});

export const db = drizzle(pool, { schema });
