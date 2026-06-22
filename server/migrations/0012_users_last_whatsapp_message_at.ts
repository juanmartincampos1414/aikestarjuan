import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #211: Adds users.last_whatsapp_message_at, the persisted "last time
// the user wrote to the WhatsApp bot" timestamp. Used by the org-active
// banner (Task #209) to decide whether enough time has passed since the
// user's last message to show the banner again.
//
// Before this column the same info lived in an in-memory Map in
// `server/lib/whatsappSessionState.ts`, which got wiped on every server
// restart. Persisting it in DB means the banner doesn't re-fire for users
// who interacted recently when the server reboots.
//
// Idempotent: ADD COLUMN IF NOT EXISTS so it's safe to re-run on
// environments where the column was already created manually.
export async function addUsersLastWhatsappMessageAtColumn() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0012_users_last_whatsapp_message_at' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add users.last_whatsapp_message_at...');

  await db.execute(sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_whatsapp_message_at timestamp
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0012_users_last_whatsapp_message_at') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: users.last_whatsapp_message_at ready.');
}
