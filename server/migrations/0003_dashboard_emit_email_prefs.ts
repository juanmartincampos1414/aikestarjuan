import { db } from '../db';
import { sql } from 'drizzle-orm';

export async function addDashboardEmitEmailPrefsColumns() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0003_dashboard_emit_email_prefs' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add dashboard_preferences last_emit_* columns...');

  await db.execute(sql`
    ALTER TABLE dashboard_preferences
    ADD COLUMN IF NOT EXISTS last_emit_send_email boolean,
    ADD COLUMN IF NOT EXISTS last_emit_send_self_copy boolean,
    ADD COLUMN IF NOT EXISTS last_emit_cc_list text[]
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0003_dashboard_emit_email_prefs')`
  );

  console.log('Migration complete: dashboard_preferences last_emit_* columns ready.');
}
