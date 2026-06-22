import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Task #187 — getUserByPhone must find a user even if the stored number is in
// the legacy AR format (without the 9) but the lookup uses the canonical
// +549... form (or vice-versa). This is what makes the WhatsApp bot match
// users created before the auto-9 fix without requiring a manual migration.

const HAS_DB = Boolean(process.env.DATABASE_URL);

if (!HAS_DB) {
  // Skip gracefully in environments without a database (e.g. some CI lanes).
  // Register a single skipped test instead of calling process.exit() — exiting
  // could mask failures from other test files when this file is part of a
  // multi-file run.
  describe('whatsappPhoneLookup (DB integration)', () => {
    it('skipped: DATABASE_URL not set', { skip: true }, () => {});
  });
} else {
  await runDbTests();
}

async function runDbTests() {
const { db } = await import('../server/db');
const { storage } = await import('../server/storage');
const { users } = await import('../shared/schema');
const { eq, or } = await import('drizzle-orm');

const LEGACY_USER_EMAIL = `__test_phone_legacy_${process.pid}_${Date.now()}@example.test`;
const CANONICAL_USER_EMAIL = `__test_phone_canon_${process.pid}_${Date.now()}@example.test`;
const NON_AR_USER_EMAIL = `__test_phone_nonar_${process.pid}_${Date.now()}@example.test`;

const LEGACY_PHONE = '+541168247426'; // missing the 9 — how legacy users were stored
const CANONICAL_PHONE = '+5491168247425'; // different last digit, canonical form
const NON_AR_PHONE = '+12025550199';

let legacyUserId: string;
let canonicalUserId: string;
let nonArUserId: string;

before(async () => {
  const [legacy] = await db.insert(users).values({
    email: LEGACY_USER_EMAIL,
    name: 'Legacy AR',
    password: 'x',
    phoneNumber: LEGACY_PHONE,
    accountType: 'personal',
    country: 'AR',
  }).returning();
  legacyUserId = legacy.id;

  const [canon] = await db.insert(users).values({
    email: CANONICAL_USER_EMAIL,
    name: 'Canonical AR',
    password: 'x',
    phoneNumber: CANONICAL_PHONE,
    accountType: 'personal',
    country: 'AR',
  }).returning();
  canonicalUserId = canon.id;

  const [nonAr] = await db.insert(users).values({
    email: NON_AR_USER_EMAIL,
    name: 'US user',
    password: 'x',
    phoneNumber: NON_AR_PHONE,
    accountType: 'personal',
    country: 'US',
  }).returning();
  nonArUserId = nonAr.id;
});

after(async () => {
  await db.delete(users).where(or(
    eq(users.id, legacyUserId),
    eq(users.id, canonicalUserId),
    eq(users.id, nonArUserId),
  ));
});

describe('storage.getUserByPhone — Argentine fallback', () => {
  it('finds a legacy user (stored without 9) when looking up by canonical +549', async () => {
    const found = await storage.getUserByPhone('+5491168247426');
    assert.ok(found, 'expected to find legacy user via canonical lookup');
    assert.equal(found!.id, legacyUserId);
  });

  it('finds a legacy user when looking up with the same legacy form', async () => {
    const found = await storage.getUserByPhone('+541168247426');
    assert.ok(found);
    assert.equal(found!.id, legacyUserId);
  });

  it('finds a legacy user when input is digits-only (54...)', async () => {
    const found = await storage.getUserByPhone('5491168247426');
    assert.ok(found);
    assert.equal(found!.id, legacyUserId);
  });

  it('finds a canonical user when looking up by the legacy form', async () => {
    const found = await storage.getUserByPhone('+541168247425');
    assert.ok(found, 'expected to find canonical user via legacy-form lookup');
    assert.equal(found!.id, canonicalUserId);
  });

  it('returns the right non-AR user without false-positive AR fallbacks', async () => {
    const found = await storage.getUserByPhone(NON_AR_PHONE);
    assert.ok(found);
    assert.equal(found!.id, nonArUserId);
  });

  it('returns undefined when no user matches', async () => {
    const found = await storage.getUserByPhone('+5499999999999');
    assert.equal(found, undefined);
  });

  it('returns undefined for empty input', async () => {
    const found = await storage.getUserByPhone('');
    assert.equal(found, undefined);
  });
});

describe('storage.getUserByPhone — ambiguity safety', () => {
  const COLLISION_LEGACY_EMAIL = `__test_phone_collision_legacy_${process.pid}_${Date.now()}@example.test`;
  const COLLISION_CANON_EMAIL = `__test_phone_collision_canon_${process.pid}_${Date.now()}@example.test`;

  // Both rows map to the same logical AR identity but were stored in conflicting
  // forms (one before the auto-9 fix, one after). The lookup must NOT silently
  // pick one — that would route WhatsApp to the wrong account.
  const COLLIDING_LEGACY = '+541143217654';
  const COLLIDING_CANON = '+5491143217654';

  let collisionLegacyId: string;
  let collisionCanonId: string;

  before(async () => {
    const [a] = await db.insert(users).values({
      email: COLLISION_LEGACY_EMAIL,
      name: 'Collision Legacy',
      password: 'x',
      phoneNumber: COLLIDING_LEGACY,
      accountType: 'personal',
      country: 'AR',
    }).returning();
    collisionLegacyId = a.id;

    const [b] = await db.insert(users).values({
      email: COLLISION_CANON_EMAIL,
      name: 'Collision Canonical',
      password: 'x',
      phoneNumber: COLLIDING_CANON,
      accountType: 'personal',
      country: 'AR',
    }).returning();
    collisionCanonId = b.id;
  });

  after(async () => {
    await db.delete(users).where(or(
      eq(users.id, collisionLegacyId),
      eq(users.id, collisionCanonId),
    ));
  });

  it('returns undefined when canonical lookup matches both legacy + canonical rows', async () => {
    const found = await storage.getUserByPhone(COLLIDING_CANON);
    assert.equal(found, undefined, 'must refuse to disambiguate to avoid mis-routing');
  });

  it('returns undefined when legacy lookup matches both rows', async () => {
    const found = await storage.getUserByPhone(COLLIDING_LEGACY);
    assert.equal(found, undefined);
  });
});

describe('webhook lazy migration — round-trip', () => {
  // Simulates the side effect of server/routes/whatsapp.ts when a legacy user
  // sends an incoming message: the handler upgrades their stored phone to the
  // canonical +549… form. After migration, both legacy and canonical lookups
  // must still resolve to the same user via arPhoneCandidates fallback.
  const LAZY_USER_EMAIL = `__test_phone_lazy_${process.pid}_${Date.now()}@example.test`;
  const LEGACY = '+541198765432';
  const CANONICAL = '+5491198765432';
  let lazyUserId: string;

  before(async () => {
    const [u] = await db.insert(users).values({
      email: LAZY_USER_EMAIL,
      name: 'Lazy migration user',
      password: 'x',
      phoneNumber: LEGACY,
      accountType: 'personal',
      country: 'AR',
    }).returning();
    lazyUserId = u.id;
  });

  after(async () => {
    await db.delete(users).where(eq(users.id, lazyUserId));
  });

  it('persists canonical phone and keeps lookups working after migration', async () => {
    // Sanity: legacy form resolves before migration.
    let found = await storage.getUserByPhone(LEGACY);
    assert.ok(found);
    assert.equal(found!.id, lazyUserId);
    assert.equal(found!.phoneNumber, LEGACY);

    // Canonical lookup also works thanks to the AR fallback.
    found = await storage.getUserByPhone(CANONICAL);
    assert.ok(found);
    assert.equal(found!.id, lazyUserId);

    // Simulate the lazy-migration write the WhatsApp webhook performs.
    await storage.updateUser(lazyUserId, { phoneNumber: CANONICAL });

    // Verify the row was actually rewritten.
    const [row] = await db.select().from(users).where(eq(users.id, lazyUserId));
    assert.equal(row.phoneNumber, CANONICAL);

    // Canonical lookup still hits directly.
    found = await storage.getUserByPhone(CANONICAL);
    assert.ok(found);
    assert.equal(found!.id, lazyUserId);

    // Legacy lookup still works via fallback (no need to update old contact links).
    found = await storage.getUserByPhone(LEGACY);
    assert.ok(found, 'legacy form must still resolve via arPhoneCandidates');
    assert.equal(found!.id, lazyUserId);
  });
});

} // end runDbTests
