import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

// Task #212 (security follow-up): the partial unique index in migration 0011
// would crash startup on a legacy database with duplicate phone numbers
// (because users.phone_number was never UNIQUE before, and migration 0010
// blanket-flips phone_verified=true for every existing binding). Migration
// 0011 must therefore self-heal: detect duplicates and downgrade all but
// the earliest-created owner BEFORE creating the index.
//
// This test plants a duplicate state, re-runs the migration, and asserts:
//   • exactly one verified owner per number is left,
//   • the earliest-created user wins,
//   • losers are downgraded to (phone_number=NULL, phone_verified=false),
//   • the unique index exists and is enforced.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run this test');
}

const { storage } = await import('../server/storage');
const { db } = await import('../server/db');
const { users } = await import('../shared/schema');
const { sql, eq, inArray } = await import('drizzle-orm');
const { addUsersPhoneVerifiedUniqueIndex } = await import('../server/migrations/0011_users_phone_verified_unique');

const SUFFIX = `${process.pid}_${Date.now()}`;
const PHONE = `+54911${String(90_000_000 + (process.pid % 9_000_000)).padStart(8, '0')}`;

let earlierId = '';
let laterId = '';

before(async () => {
  const hashed = await bcrypt.hash('Test1234!', 10);
  // Earlier user (winner). Force created_at into the past so the ordering is
  // unambiguous regardless of clock skew.
  const a = await storage.createUser({
    email: `mig11-early-${SUFFIX}@test.local`, name: 'Earlier', password: hashed, accountType: 'business',
  } as any);
  earlierId = a.id;
  await db.execute(sql`UPDATE users SET created_at = NOW() - INTERVAL '10 days' WHERE id = ${earlierId}`);

  const b = await storage.createUser({
    email: `mig11-late-${SUFFIX}@test.local`, name: 'Later', password: hashed, accountType: 'business',
  } as any);
  laterId = b.id;
  await db.execute(sql`UPDATE users SET created_at = NOW() - INTERVAL '1 day' WHERE id = ${laterId}`);

  // Drop the unique index temporarily so we can plant the duplicate state
  // (the migration's dedup logic must work even in this scenario, which is
  // exactly the production-database situation we are protecting against).
  await db.execute(sql`DROP INDEX IF EXISTS users_phone_number_verified_unique_idx`);
  // Plant duplicate verified bindings.
  await db.update(users).set({ phoneNumber: PHONE, phoneVerified: true }).where(eq(users.id, earlierId));
  await db.update(users).set({ phoneNumber: PHONE, phoneVerified: true }).where(eq(users.id, laterId));
  // Roll back the migration marker so addUsersPhoneVerifiedUniqueIndex does
  // its dedup-and-recreate work on this fresh duplicate state.
  await db.execute(sql`DELETE FROM _migrations WHERE name = '0011_users_phone_verified_unique'`);
});

after(async () => {
  for (const id of [earlierId, laterId]) {
    try { await db.update(users).set({ phoneNumber: null, phoneVerified: false }).where(eq(users.id, id)); } catch {}
    try { await storage.deleteUser(id); } catch {}
    try { await db.delete(users).where(eq(users.id, id)); } catch {}
  }
});

describe('Task #212 — migration 0011 dedup', () => {
  it('downgrades duplicates and creates the unique index without crashing', async () => {
    // Sanity: both rows are currently verified with the same phone.
    const before = await db.select().from(users).where(inArray(users.id, [earlierId, laterId]));
    assert.equal(before.filter((u) => u.phoneVerified === true && u.phoneNumber === PHONE).length, 2, 'precondition: both planted users must be verified+bound to PHONE');

    // Run the migration — this should NOT throw.
    await addUsersPhoneVerifiedUniqueIndex();

    // The earlier-created user wins.
    const after = await db.select().from(users).where(inArray(users.id, [earlierId, laterId]));
    const winner = after.find((u) => u.id === earlierId)!;
    const loser = after.find((u) => u.id === laterId)!;
    assert.equal(winner.phoneNumber, PHONE, 'winner must keep the phone');
    assert.equal(winner.phoneVerified, true, 'winner must remain verified');
    assert.equal(loser.phoneNumber, null, 'loser must lose the phone binding');
    assert.equal(loser.phoneVerified, false, 'loser must lose verified flag');

    // Index must exist now.
    const idx = await db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename = 'users' AND indexname = 'users_phone_number_verified_unique_idx'`);
    assert.ok(idx.rowCount && idx.rowCount > 0, 'partial unique index must exist after migration');

    // Index must actively enforce the rule: re-binding the loser as verified
    // to the same phone should now fail with 23505.
    let didThrow = false;
    try {
      await db.update(users).set({ phoneNumber: PHONE, phoneVerified: true }).where(eq(users.id, laterId));
    } catch (e: any) {
      didThrow = true;
      const code = e?.code ?? e?.cause?.code;
      assert.equal(code, '23505', `expected unique-violation 23505, got ${code}`);
    }
    assert.ok(didThrow, 'partial unique index must reject duplicate verified bindings');
  });
});
