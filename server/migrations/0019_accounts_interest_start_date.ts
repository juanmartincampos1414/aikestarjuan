import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #259: Adds accounts.interest_start_date, the anchor timestamp from
// which the yield (rendimiento) of investment accounts is computed. When
// NULL, the yield calculation falls back to created_at (backward compatible
// for accounts that were never adjusted). When the user adjusts or forces
// the balance of an investment account, the server resets this to NOW(),
// which makes the displayed yield restart from 0 at the new capital.
//
// Idempotent: ADD COLUMN IF NOT EXISTS so reruns are no-ops on environments
// that already have the column.
export async function addAccountsInterestStartDateColumn() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0019_accounts_interest_start_date' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add accounts.interest_start_date...');

  await db.execute(sql`
    ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS interest_start_date timestamp
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0019_accounts_interest_start_date') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: accounts.interest_start_date ready.');
}
