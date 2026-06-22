import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #229: Adds the "Medios de Cobro" feature (payment methods + concepts).
// Creates two new tables and adds payment_method_id to transactions.
//
// Idempotent: uses IF NOT EXISTS for tables, columns and indexes.
export async function addPaymentMethodsTables() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0016_payment_methods' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: payment_methods + payment_method_concepts...');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS payment_methods (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name text NOT NULL,
      description text,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_org_name_lower_unique
      ON payment_methods (organization_id, lower(name))
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS payment_method_concepts (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_method_id varchar NOT NULL REFERENCES payment_methods(id) ON DELETE CASCADE,
      name text NOT NULL,
      kind text NOT NULL,
      value numeric(15, 4) NOT NULL,
      expense_category_id varchar,
      position integer NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS payment_method_concepts_method_idx
      ON payment_method_concepts (payment_method_id)
  `);

  await db.execute(sql`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS payment_method_id varchar
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS transactions_payment_method_idx
      ON transactions (payment_method_id)
      WHERE payment_method_id IS NOT NULL
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0016_payment_methods') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: payment methods ready.');
}
