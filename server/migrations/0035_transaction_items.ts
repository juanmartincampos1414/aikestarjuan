import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #475: multi-product transactions. Creates the `transaction_items`
// table that holds line items when a transaction carries 2+ distinct
// products. Idempotent and versioned via the `_migrations` marker so it is
// safe to run on every boot (production applies schema changes ONLY through
// these migrations, never db:push).
export async function createTransactionItemsTable() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);
  const done = await db.execute(sql`SELECT 1 FROM _migrations WHERE name = '0035_transaction_items' LIMIT 1`);
  if (done.rowCount && done.rowCount > 0) return;

  console.log('Running migration: create transaction_items table + indexes...');
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS transaction_items (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      transaction_id varchar NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      product_id varchar REFERENCES products(id) ON DELETE SET NULL,
      description text,
      quantity numeric(15,2) NOT NULL,
      unit_price numeric(15,2) NOT NULL,
      profitability_code_id varchar REFERENCES profitability_codes(id) ON DELETE SET NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS transaction_items_tx_idx ON transaction_items (transaction_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS transaction_items_org_product_idx ON transaction_items (organization_id, product_id)`);
  await db.execute(sql`INSERT INTO _migrations (name) VALUES ('0035_transaction_items') ON CONFLICT (name) DO NOTHING`);
  console.log('Migration complete: transaction_items table + indexes ready.');
}
