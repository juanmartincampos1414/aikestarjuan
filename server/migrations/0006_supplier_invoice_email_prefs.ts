import { db } from '../db';
import { sql } from 'drizzle-orm';

export async function addSupplierInvoiceEmailPrefsTable() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS supplier_invoice_email_prefs (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      supplier_id VARCHAR NOT NULL UNIQUE REFERENCES suppliers(id) ON DELETE CASCADE,
      default_cc_emails TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
      send_copy_to_self BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_supplier_invoice_email_prefs_org
    ON supplier_invoice_email_prefs(organization_id)
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0006_supplier_invoice_email_prefs') ON CONFLICT (name) DO NOTHING`
  );
}
