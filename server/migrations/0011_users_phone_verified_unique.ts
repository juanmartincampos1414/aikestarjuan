import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #212 (security follow-up): enforce at the database level that there is
// at most ONE verified owner per phone number. Without this, a race between
// two users finishing /verify-code at exactly the same moment could leave
// both users bound to the same number — the WhatsApp lookup helper would
// then refuse to route messages (it returns undefined on ambiguous matches),
// effectively locking BOTH accounts out of the bot.
//
// We use a partial unique index on phone_number WHERE phone_verified = true
// so unverified squatters can still coexist (they'll be cleaned up at claim
// time inside `claimPhoneForUser`), but no two rows can both be verified
// owners of the same number.
//
// Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS. If a duplicate already
// exists in the database (e.g. a pre-existing dirty row before we shipped
// the verification flow), the index creation will fail loudly — that is the
// desired behavior, because the operator must investigate which account
// truly owns the number before promoting one of them.
export async function addUsersPhoneVerifiedUniqueIndex() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0011_users_phone_verified_unique' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: partial unique index on users.phone_number where phone_verified=true...');

  // Step 1 — resolve historical duplicates BEFORE creating the unique index.
  //
  // `users.phone_number` was never UNIQUE at the DB level, so legacy rows can
  // hold the same number for two different accounts. Migration 0010
  // grandfathered every existing binding to phone_verified=true, which means
  // those duplicates would now fail the partial unique index and abort
  // startup if we tried to create it directly.
  //
  // Resolution rule (deterministic, idempotent): for each phone_number
  // shared by N>1 verified users, KEEP the user whose row was created
  // earliest (`created_at ASC, id ASC` as tie-breaker — the original owner is
  // the most likely real owner) and DOWNGRADE the others to
  // (phone_number=NULL, phone_verified=false). Downgraded users do NOT lose
  // their account; they simply lose bot access until they re-claim a number
  // through the verification flow. This is the safest available choice
  // because the alternative — leaving the duplicates in place — guarantees
  // that BOTH users lose bot access (the lookup helper returns undefined on
  // ambiguous matches by design).
  const dupes = await db.execute(sql`
    SELECT phone_number, COUNT(*)::int AS n
    FROM users
    WHERE phone_verified = true AND phone_number IS NOT NULL
    GROUP BY phone_number
    HAVING COUNT(*) > 1
  `);
  if (dupes.rowCount && dupes.rowCount > 0) {
    console.warn(`[Migration 0011] Found ${dupes.rowCount} duplicate phone_number(s) among verified users. Downgrading all but the earliest-created owner of each.`);
    const downgrade = await db.execute(sql`
      UPDATE users
      SET phone_number = NULL, phone_verified = false
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY phone_number
                   ORDER BY created_at ASC NULLS LAST, id ASC
                 ) AS rn
          FROM users
          WHERE phone_verified = true AND phone_number IS NOT NULL
        ) ranked
        WHERE rn > 1
      )
    `);
    console.warn(`[Migration 0011] Downgraded ${downgrade.rowCount ?? 0} duplicate user binding(s). Affected users must re-verify their phone via Configuración → WhatsApp.`);
  }

  // Step 2 — now safe to create the partial unique index.
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS users_phone_number_verified_unique_idx
    ON users (phone_number)
    WHERE phone_verified = true AND phone_number IS NOT NULL
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0011_users_phone_verified_unique') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: users_phone_number_verified_unique_idx in place.');
}
