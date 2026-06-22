import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #210: Adds whatsapp_preferences.org_banner_interval_hours, which lets
// each user/org pair configure how often the WhatsApp bot re-shows the
// "Estás registrando movimientos en X" banner at the start of a new
// conversation (null = use default 6h, 0 = never, >0 = hours between
// banners).
//
// The column was added to shared/schema.ts in commit 175c9ab1 (Task #210)
// but the matching migration was never written. The
// GET/PUT /api/whatsapp-preferences endpoints select/update this column,
// so without the migration both routes return 500 on a fresh DB.
//
// Idempotent: ADD COLUMN IF NOT EXISTS, safe to re-run on environments
// where the column was already added manually.
export async function addWhatsappPreferencesOrgBannerIntervalColumn() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0014_whatsapp_preferences_org_banner_interval' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add whatsapp_preferences.org_banner_interval_hours...');

  await db.execute(sql`
    ALTER TABLE whatsapp_preferences
    ADD COLUMN IF NOT EXISTS org_banner_interval_hours integer
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0014_whatsapp_preferences_org_banner_interval') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: whatsapp_preferences.org_banner_interval_hours ready.');
}
