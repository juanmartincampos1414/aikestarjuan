import { db } from '../db';
import { sql } from 'drizzle-orm';

export async function addInvoiceEmissionErrorColumns() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0017_invoice_emission_error' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add invoice emission error columns...');

  await db.execute(sql`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS invoice_emission_error_message text
  `);
  await db.execute(sql`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS invoice_emission_error_code text
  `);
  await db.execute(sql`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS invoice_emission_error_at timestamptz
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0017_invoice_emission_error') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: invoice emission error columns ready.');
}
