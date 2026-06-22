import { db } from '../db';
import { sql } from 'drizzle-orm';

export async function addInvoiceEmailTrackingColumns() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0004_invoice_email_tracking_columns' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add invoice email tracking columns...');

  await db.execute(sql`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS invoice_email_status TEXT,
    ADD COLUMN IF NOT EXISTS invoice_email_last_attempt_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS invoice_email_last_error TEXT,
    ADD COLUMN IF NOT EXISTS invoice_email_last_recipients TEXT
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0004_invoice_email_tracking_columns')`
  );

  console.log('Migration complete: invoice email tracking columns ready.');
}
