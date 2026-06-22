import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #481: presupuestos con productos/servicios. Creates the `quote_items`
// table that holds line items (producto/desc, cantidad, precio unitario,
// código de rentabilidad) for a quote. A quote with 0 line items behaves as a
// legacy single-amount quote. Idempotent and versioned via the `_migrations`
// marker so it is safe to run on every boot (production applies schema changes
// ONLY through these migrations, never db:push).
export async function createQuoteItemsTable() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);
  const done = await db.execute(sql`SELECT 1 FROM _migrations WHERE name = '0036_quote_items' LIMIT 1`);
  if (done.rowCount && done.rowCount > 0) return;

  console.log('Running migration: create quote_items table + indexes...');
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS quote_items (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      quote_id varchar NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      product_id varchar REFERENCES products(id) ON DELETE SET NULL,
      description text,
      quantity numeric(15,2) NOT NULL,
      unit_price numeric(15,2) NOT NULL,
      profitability_code_id varchar REFERENCES profitability_codes(id) ON DELETE SET NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS quote_items_quote_idx ON quote_items (quote_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS quote_items_org_product_idx ON quote_items (organization_id, product_id)`);
  await db.execute(sql`INSERT INTO _migrations (name) VALUES ('0036_quote_items') ON CONFLICT (name) DO NOTHING`);
  console.log('Migration complete: quote_items table + indexes ready.');
}
