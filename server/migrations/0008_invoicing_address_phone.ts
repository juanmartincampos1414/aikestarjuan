import { db } from '../db';
import { sql } from 'drizzle-orm';

// Adds optional contact fields used by the simulated ARCA invoice PDF:
//   - invoicing_accounts.address / phone (emitter contact data printed in
//     the comprobante header)
//   - transactions.invoice_address / invoice_phone (per-emission snapshot
//     of the receiver's contact data so the printed PDF doesn't change if
//     the underlying client/supplier is later edited)
// Idempotent: uses ADD COLUMN IF NOT EXISTS so it's safe to re-run on
// environments where the columns were already created manually.
export async function addInvoicingAddressPhoneColumns() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0008_invoicing_address_phone' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add invoicing address/phone columns...');

  await db.execute(sql`
    ALTER TABLE invoicing_accounts
    ADD COLUMN IF NOT EXISTS address text
  `);
  await db.execute(sql`
    ALTER TABLE invoicing_accounts
    ADD COLUMN IF NOT EXISTS phone text
  `);
  await db.execute(sql`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS invoice_address text
  `);
  await db.execute(sql`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS invoice_phone text
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0008_invoicing_address_phone') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: invoicing address/phone columns ready.');
}
