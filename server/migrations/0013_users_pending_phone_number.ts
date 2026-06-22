import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #221: Stop persisting unverified phone numbers in users.phone_number.
//
// Background:
//   Task #69 made the phone number optional at signup. The signup form's value
//   was written directly to users.phone_number with phone_verified=false.
//   That allowed a user to "claim" someone else's phone at signup with no
//   proof of control. From now on the signup form writes to
//   users.pending_phone_number instead (informational only).
//
// What this migration does:
//   • Adds users.pending_phone_number — informational-only column. The signup
//     flow (and admin onboarding emails) write here instead of phone_number.
//     The Settings → WhatsApp wizard uses it to pre-fill the input, but the
//     bot and authentication logic ignore it entirely.
//
// What this migration EXPLICITLY DOES NOT do (per product decision):
//   • It does NOT touch existing rows. Production users who already have a
//     number in users.phone_number — verified or not — keep it exactly as it
//     is. We don't yank phone numbers from accounts that are already in use,
//     even if they were never formally verified, because that would silently
//     break their WhatsApp bot connection. The fix here is forward-only: new
//     signups can no longer plant unverified numbers in users.phone_number.
//
// Safety vs Task #212's partial unique index (migration 0011):
//   This migration only adds a new nullable column; it cannot affect 0011's
//   partial unique index over WHERE phone_verified=true.
//
// Idempotent: ADD COLUMN IF NOT EXISTS + the _migrations marker. Safe to
// re-run; safe to apply on prod databases that already have the column.
export async function addUsersPendingPhoneNumberColumn() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0013_users_pending_phone_number' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add users.pending_phone_number (no backfill)...');

  await db.execute(sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS pending_phone_number text
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0013_users_pending_phone_number') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: users.pending_phone_number ready. Existing rows untouched.');
}
