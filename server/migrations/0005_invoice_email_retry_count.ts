import { db } from '../db';
import { sql } from 'drizzle-orm';

export async function addInvoiceEmailRetryCountColumn() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0005_invoice_email_retry_count' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add invoice_email_retry_count column...');

  await db.execute(sql`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS invoice_email_retry_count INTEGER NOT NULL DEFAULT 0
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0005_invoice_email_retry_count')`
  );

  console.log('Migration complete: invoice_email_retry_count column ready.');
}
