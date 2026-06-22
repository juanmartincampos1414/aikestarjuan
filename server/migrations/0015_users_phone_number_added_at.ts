import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #219: Adds users.phone_number_added_at, the timestamp tracking when a
// user's `phone_number` was set without `phone_verified=true`. The dashboard
// banner uses this to detect users who abandoned the WhatsApp linking wizard
// (e.g. closed the tab on step 3) and reminds them to finish.
//
// Backfill rule: for any existing user that already has a phoneNumber loaded
// but never verified, we initialize this timestamp from `created_at` so the
// banner can fire immediately for them on next login (they've effectively
// been "abandoned >24h" for a while). For verified users we leave it NULL
// (the banner does not look at verified rows anyway).
//
// Idempotent: ADD COLUMN IF NOT EXISTS + filtered UPDATE so reruns are
// no-ops on environments that already have the column.
export async function addUsersPhoneNumberAddedAtColumn() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0013_users_phone_number_added_at' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add users.phone_number_added_at...');

  await db.execute(sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS phone_number_added_at timestamp
  `);

  // Backfill only the rows the banner actually cares about: phoneNumber
  // present AND phone_verified is NOT true. Restrict to rows where the
  // column is still NULL so a rerun never overwrites a more recent value.
  const backfill = await db.execute(sql`
    UPDATE users
    SET phone_number_added_at = created_at
    WHERE phone_number IS NOT NULL
      AND (phone_verified IS DISTINCT FROM true)
      AND phone_number_added_at IS NULL
  `);
  console.log(`[Migration 0013] Backfilled phone_number_added_at for ${backfill.rowCount ?? 0} unverified users.`);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0013_users_phone_number_added_at') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: users.phone_number_added_at ready.');
}
