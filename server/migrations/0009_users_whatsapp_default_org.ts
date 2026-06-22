import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #207: Adds users.whatsapp_default_organization_id, the user-chosen
// default organization that the WhatsApp bot uses to register transactions.
// This column is INDEPENDENT from users.last_active_organization_id (which is
// the last org the user opened in the web app). Decoupling them prevents the
// bot from silently switching organizations when the user navigates the web.
// Idempotent: ADD COLUMN IF NOT EXISTS so it's safe to re-run on environments
// where the column was already created manually.
export async function addUsersWhatsappDefaultOrgColumn() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0009_users_whatsapp_default_org' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add users.whatsapp_default_organization_id...');

  await db.execute(sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS whatsapp_default_organization_id varchar
  `);
  await db.execute(sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS whatsapp_default_org_initialized boolean DEFAULT false
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0009_users_whatsapp_default_org') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: users.whatsapp_default_organization_id ready.');
}
