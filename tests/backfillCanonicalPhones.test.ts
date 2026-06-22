import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Task #190 — backfillCanonicalPhones must rewrite legacy AR mobile numbers
// (+5411…) to the canonical +549… form at boot, while leaving already-canonical
// numbers, foreign numbers, and conflicting rows untouched.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run the backfill canonical phones test');
}

const { db } = await import('../server/db');
const { users } = await import('../shared/schema');
const { eq, inArray } = await import('drizzle-orm');
const { backfillCanonicalPhones } = await import('../server/jobs/backfillCanonicalPhones');

const RUN_ID = `${process.pid}_${Date.now()}`;
const tag = (slug: string) => `__test_backfill_${slug}_${RUN_ID}@example.test`;

const LEGACY_EMAIL = tag('legacy');
const CANONICAL_EMAIL = tag('canonical');
const FOREIGN_EMAIL = tag('foreign');

// Conflict scenario emails
const CONFLICT_LEGACY_EMAIL = tag('conflict_legacy');
const CONFLICT_CANONICAL_EMAIL = tag('conflict_canonical');

const LEGACY_PHONE = '+5411' + '60000001'.padStart(8, '0'); // +541160000001 (12 digits)
const CANONICAL_FROM_LEGACY = '+54911' + '60000001'.padStart(8, '0'); // expected migration target
const CANONICAL_PHONE = '+541160000002'; // legacy form for the "already canonical" user
const CANONICAL_PHONE_FULL = '+5491160000002';
const FOREIGN_PHONE = '+59899123456';

const CONFLICT_LEGACY_PHONE = '+541160000003';
const CONFLICT_CANONICAL_PHONE = '+5491160000003';

let legacyUserId: string;
let canonicalUserId: string;
let foreignUserId: string;
let conflictLegacyUserId: string;
let conflictCanonicalUserId: string;

before(async () => {
  // Make sure no leftover row from a previous failed run exists.
  await db
    .delete(users)
    .where(
      inArray(users.email, [
        LEGACY_EMAIL,
        CANONICAL_EMAIL,
        FOREIGN_EMAIL,
        CONFLICT_LEGACY_EMAIL,
        CONFLICT_CANONICAL_EMAIL,
      ]),
    );

  const [legacy] = await db
    .insert(users)
    .values({
      email: LEGACY_EMAIL,
      name: 'Legacy AR',
      password: 'x',
      phoneNumber: LEGACY_PHONE,
      accountType: 'personal',
      country: 'AR',
    })
    .returning();
  legacyUserId = legacy.id;

  const [canon] = await db
    .insert(users)
    .values({
      email: CANONICAL_EMAIL,
      name: 'Canonical AR',
      password: 'x',
      phoneNumber: CANONICAL_PHONE_FULL,
      accountType: 'personal',
      country: 'AR',
    })
    .returning();
  canonicalUserId = canon.id;

  const [foreign] = await db
    .insert(users)
    .values({
      email: FOREIGN_EMAIL,
      name: 'Foreign user',
      password: 'x',
      phoneNumber: FOREIGN_PHONE,
      accountType: 'personal',
      country: 'UY',
    })
    .returning();
  foreignUserId = foreign.id;

  const [conflictLegacy] = await db
    .insert(users)
    .values({
      email: CONFLICT_LEGACY_EMAIL,
      name: 'Conflict legacy',
      password: 'x',
      phoneNumber: CONFLICT_LEGACY_PHONE,
      accountType: 'personal',
      country: 'AR',
    })
    .returning();
  conflictLegacyUserId = conflictLegacy.id;

  const [conflictCanonical] = await db
    .insert(users)
    .values({
      email: CONFLICT_CANONICAL_EMAIL,
      name: 'Conflict canonical',
      password: 'x',
      phoneNumber: CONFLICT_CANONICAL_PHONE,
      accountType: 'personal',
      country: 'AR',
    })
    .returning();
  conflictCanonicalUserId = conflictCanonical.id;
});

after(async () => {
  await db
    .delete(users)
    .where(
      inArray(users.id, [
        legacyUserId,
        canonicalUserId,
        foreignUserId,
        conflictLegacyUserId,
        conflictCanonicalUserId,
      ]),
    );
});

describe('backfillCanonicalPhones — Task #190', () => {
  it('migrates legacy AR mobile to canonical +549… and leaves canonical / foreign rows untouched', async () => {
    const result = await backfillCanonicalPhones();
    assert.ok(result.migrated >= 1, 'at least one row should have been migrated');

    const [legacyRow] = await db.select().from(users).where(eq(users.id, legacyUserId));
    assert.equal(legacyRow.phoneNumber, CANONICAL_FROM_LEGACY);

    const [canonicalRow] = await db.select().from(users).where(eq(users.id, canonicalUserId));
    assert.equal(canonicalRow.phoneNumber, CANONICAL_PHONE_FULL);

    const [foreignRow] = await db.select().from(users).where(eq(users.id, foreignUserId));
    assert.equal(foreignRow.phoneNumber, FOREIGN_PHONE);
  });

  it('does NOT migrate when the canonical target is already taken by another user (collision)', async () => {
    const result = await backfillCanonicalPhones();
    assert.ok(result.conflicts >= 1, 'should have logged at least one conflict');

    const [conflictLegacyRow] = await db
      .select()
      .from(users)
      .where(eq(users.id, conflictLegacyUserId));
    assert.equal(
      conflictLegacyRow.phoneNumber,
      CONFLICT_LEGACY_PHONE,
      'legacy row must be left untouched when the canonical form already exists for another user',
    );

    const [conflictCanonicalRow] = await db
      .select()
      .from(users)
      .where(eq(users.id, conflictCanonicalUserId));
    assert.equal(conflictCanonicalRow.phoneNumber, CONFLICT_CANONICAL_PHONE);
  });

  it('is idempotent — running twice in a row produces no extra migrations', async () => {
    const second = await backfillCanonicalPhones();
    // After the previous tests, the only legacy row left in our fixtures is the
    // conflict one (which still cannot be migrated). Anything migrated here would
    // mean the WHERE filter regressed.
    assert.equal(second.migrated, 0, 'second run must not migrate any of our fixtures');
  });
});
