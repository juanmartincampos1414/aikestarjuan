import { db } from '../db';
import { sql } from 'drizzle-orm';

export async function addInvoiceSimulatedColumns() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0002_invoice_simulated_columns' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add invoice_simulated / is_simulated columns...');

  await db.execute(sql`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS invoice_simulated boolean NOT NULL DEFAULT false
  `);
  await db.execute(sql`
    ALTER TABLE invoicing_accounts
    ADD COLUMN IF NOT EXISTS is_simulated boolean NOT NULL DEFAULT false
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0002_invoice_simulated_columns')`
  );

  console.log('Migration complete: invoice_simulated / is_simulated columns ready.');
}
