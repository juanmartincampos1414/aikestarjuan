import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #212: Adds phone_verification_codes table (one-row-per-user store of
// the active 6-digit code the user must enter to prove control of a WhatsApp
// number) and backfills users.phone_verified=true for any user that already
// has a phone_number bound. The backfill grandfathers existing bindings so
// the bot does not stop working for current users when the webhook starts
// honoring the verified flag.
//
// Idempotent on every step (CREATE IF NOT EXISTS, ALTER ... IF NOT EXISTS,
// UPDATE filtered to rows that still need it). The _migrations marker only
// gates the *expensive* setup; the UPDATE is harmless even if rerun.
export async function addPhoneVerificationCodesTable() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0010_phone_verification_codes' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: phone_verification_codes + phone_verified backfill...');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS phone_verification_codes (
      user_id varchar PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      normalized_phone text NOT NULL,
      code_hash text NOT NULL,
      expires_at timestamptz NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      sends_in_window integer NOT NULL DEFAULT 1,
      window_started_at timestamptz NOT NULL DEFAULT NOW(),
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS phone_verification_codes_normalized_phone_idx
    ON phone_verification_codes (normalized_phone)
  `);

  // Grandfather existing bindings: any user with a phone_number stored before
  // this feature shipped is treated as verified, so the WhatsApp bot keeps
  // working for them. New bindings (post-deploy) MUST go through the
  // verification flow because PUT /api/user/phone is gated to delete-only.
  const backfill = await db.execute(sql`
    UPDATE users
    SET phone_verified = true
    WHERE phone_number IS NOT NULL
      AND (phone_verified IS DISTINCT FROM true)
  `);
  console.log(`[Migration 0010] Backfilled phone_verified=true for ${backfill.rowCount ?? 0} existing users.`);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0010_phone_verification_codes') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: phone_verification_codes ready.');
}
