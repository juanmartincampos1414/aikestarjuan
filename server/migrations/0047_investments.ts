import { db } from '../db';
import { sql } from 'drizzle-orm';

// Crea la tabla de Inversiones (cartera monitoreada con cotizaciones en vivo). Idempotente.
export async function createInvestmentTables() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);
  const done = await db.execute(sql`SELECT 1 FROM _migrations WHERE name = '0047_investments' LIMIT 1`);
  if (done.rowCount && done.rowCount > 0) return;

  console.log('Running migration: investments table...');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS market_investments (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name text NOT NULL,
      symbol text NOT NULL,
      asset_type text NOT NULL DEFAULT 'otro',
      quantity numeric(20,8) NOT NULL DEFAULT '0',
      buy_price numeric(20,8),
      currency text NOT NULL DEFAULT 'ARS',
      buy_date timestamp,
      broker text,
      notes text,
      archived_at timestamp,
      created_by varchar REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS market_investments_org_idx ON market_investments (organization_id, created_at)`);

  await db.execute(sql`INSERT INTO _migrations (name) VALUES ('0047_investments') ON CONFLICT (name) DO NOTHING`);
  console.log('Migration complete: investments table ready.');
}
