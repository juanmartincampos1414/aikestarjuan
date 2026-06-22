import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Task #261 — migration 0019 must be idempotent.
//
// On every server boot, `addAccountsInterestStartDateColumn` runs. If it
// were to crash, duplicate the _migrations row, or re-run the ALTER TABLE
// on an already-migrated DB, every deploy would risk downtime. This test
// rolls back the marker, runs the migration twice in a row, and verifies:
//   • neither call throws,
//   • the column still exists,
//   • the _migrations table contains EXACTLY one row for the migration.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run this test');
}

const { db } = await import('../server/db');
const { sql } = await import('drizzle-orm');
const { addAccountsInterestStartDateColumn } = await import('../server/migrations/0019_accounts_interest_start_date');

const MIGRATION_NAME = '0019_accounts_interest_start_date';
let savedAppliedAt: any = null;

before(async () => {
  // Save the current marker (if any) so we can restore it afterwards and
  // not pollute the shared dev database state.
  const res: any = await db.execute(
    sql`SELECT applied_at FROM _migrations WHERE name = ${MIGRATION_NAME} LIMIT 1`,
  );
  if (res.rowCount && res.rowCount > 0) {
    savedAppliedAt = res.rows?.[0]?.applied_at ?? null;
  }
  // Roll back the marker so the next run actually does work.
  await db.execute(sql`DELETE FROM _migrations WHERE name = ${MIGRATION_NAME}`);
});

after(async () => {
  // Restore the marker — we never want to leave the shared DB in a state
  // where the next boot tries to re-run the ALTER TABLE.
  if (savedAppliedAt) {
    await db.execute(
      sql`INSERT INTO _migrations (name, applied_at) VALUES (${MIGRATION_NAME}, ${savedAppliedAt}) ON CONFLICT (name) DO NOTHING`,
    );
  } else {
    await db.execute(
      sql`INSERT INTO _migrations (name) VALUES (${MIGRATION_NAME}) ON CONFLICT (name) DO NOTHING`,
    );
  }
});

describe('Task #261 — migration 0019 idempotency', () => {
  it('running addAccountsInterestStartDateColumn twice in a row succeeds and produces exactly one _migrations row', async () => {
    await addAccountsInterestStartDateColumn();
    await addAccountsInterestStartDateColumn();

    // Column still exists.
    const col: any = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'accounts' AND column_name = 'interest_start_date'
    `);
    assert.ok(col.rowCount && col.rowCount > 0, 'accounts.interest_start_date column must exist');

    // Exactly one marker row.
    const marker: any = await db.execute(
      sql`SELECT count(*)::int AS count FROM _migrations WHERE name = ${MIGRATION_NAME}`,
    );
    const count = Number(marker.rows?.[0]?.count ?? 0);
    assert.equal(count, 1, `_migrations must contain exactly one row for ${MIGRATION_NAME}, got ${count}`);
  });
});
