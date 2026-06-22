import { db } from '../db';
import { sql } from 'drizzle-orm';

// Adds invoicing_accounts.admin_cuit (text, nullable). For sociedades
// (CUIT 30/33) ARCA requires authenticating with the personal CUIT of the
// administrator (20/23/24/27); we persist it so the user doesn't have to
// re-enter it on every re-sync. Clave fiscal is NEVER persisted.
// Idempotent: ADD COLUMN IF NOT EXISTS.
export async function addInvoicingAdminCuitColumn() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0018_invoicing_admin_cuit' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add invoicing_accounts.admin_cuit column...');

  await db.execute(sql`
    ALTER TABLE invoicing_accounts
    ADD COLUMN IF NOT EXISTS admin_cuit text
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0018_invoicing_admin_cuit') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: invoicing_accounts.admin_cuit ready.');
}
