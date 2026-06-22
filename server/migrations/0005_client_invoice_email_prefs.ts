import { db } from '../db';
import { sql } from 'drizzle-orm';

export async function addClientInvoiceEmailPrefsTable() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  // Always run idempotent table create + column reconciliation, since an earlier
  // version of this migration shipped with different column names.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS client_invoice_email_prefs (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      client_id VARCHAR NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
      default_cc_emails TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
      send_copy_to_self BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Rename legacy columns from the earlier draft of this migration, if present.
  await db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'client_invoice_email_prefs' AND column_name = 'default_cc_list'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'client_invoice_email_prefs' AND column_name = 'default_cc_emails'
      ) THEN
        ALTER TABLE client_invoice_email_prefs RENAME COLUMN default_cc_list TO default_cc_emails;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'client_invoice_email_prefs' AND column_name = 'send_copy_to_me'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'client_invoice_email_prefs' AND column_name = 'send_copy_to_self'
      ) THEN
        ALTER TABLE client_invoice_email_prefs RENAME COLUMN send_copy_to_me TO send_copy_to_self;
      END IF;
    END$$;
  `);

  // Ensure NOT NULL + defaults match the schema (legacy rows could be NULL).
  await db.execute(sql`UPDATE client_invoice_email_prefs SET default_cc_emails = ARRAY[]::text[] WHERE default_cc_emails IS NULL`);
  await db.execute(sql`UPDATE client_invoice_email_prefs SET send_copy_to_self = false WHERE send_copy_to_self IS NULL`);
  await db.execute(sql`ALTER TABLE client_invoice_email_prefs ALTER COLUMN default_cc_emails SET DEFAULT ARRAY[]::text[]`);
  await db.execute(sql`ALTER TABLE client_invoice_email_prefs ALTER COLUMN default_cc_emails SET NOT NULL`);
  await db.execute(sql`ALTER TABLE client_invoice_email_prefs ALTER COLUMN send_copy_to_self SET DEFAULT false`);
  await db.execute(sql`ALTER TABLE client_invoice_email_prefs ALTER COLUMN send_copy_to_self SET NOT NULL`);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_client_invoice_email_prefs_org
    ON client_invoice_email_prefs(organization_id)
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0005_client_invoice_email_prefs') ON CONFLICT (name) DO NOTHING`
  );
}
