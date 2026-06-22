import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #343: Replaces the hard UNIQUE(email) constraint on `users` with a
// case-insensitive partial unique index that only applies to rows where
// `deleted_at IS NULL`. This lets a soft-deleted user free up their email
// so that someone (or the same person) can register again with it, while
// keeping the old row intact for audit purposes.
//
// Migration steps:
//   1) Drop the auto-generated `users_email_unique` constraint if present.
//   2) Drop any leftover plain unique index on `email` (defensive, in case
//      a previous environment created it as an index instead of a constraint).
//   3) Create the partial unique index `users_email_active_unique`
//      on LOWER(email) WHERE deleted_at IS NULL.
//
// Idempotent: all steps are guarded with IF EXISTS / IF NOT EXISTS and the
// migration marker prevents reruns from doing any work after the first apply.
export async function addUsersEmailPartialUniqueIndex() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0021_users_email_partial_unique' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration 0021: users.email partial unique index...');

  // Safety check: no duplicate active emails (case-insensitive). If there
  // are duplicates the partial index would fail to create — better to
  // fail loudly here than silently leave the old constraint in place.
  const dupes = await db.execute(sql`
    SELECT LOWER(email) AS email, COUNT(*)::int AS n
    FROM users
    WHERE deleted_at IS NULL
    GROUP BY LOWER(email)
    HAVING COUNT(*) > 1
  `);
  if (dupes.rowCount && dupes.rowCount > 0) {
    console.error('[Migration 0021] Aborting: found duplicate active emails (case-insensitive). Resolve manually before re-running.');
    console.error(dupes.rows);
    throw new Error('Migration 0021 aborted: duplicate active emails detected');
  }

  // Drop the old constraint (auto-generated name from drizzle's .unique()).
  await db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_email_unique'
          AND conrelid = 'users'::regclass
      ) THEN
        ALTER TABLE users DROP CONSTRAINT users_email_unique;
      END IF;
    END$$;
  `);

  // Defensive: also drop any plain index with the same name in case some
  // environment created it as an index instead of a constraint.
  await db.execute(sql`DROP INDEX IF EXISTS users_email_unique`);

  // Create the partial unique index.
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_active_unique
      ON users (LOWER(email))
      WHERE deleted_at IS NULL
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0021_users_email_partial_unique') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration 0021 complete: users_email_active_unique partial index ready.');
}
