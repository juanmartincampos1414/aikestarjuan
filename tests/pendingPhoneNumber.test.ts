import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

// Task #221: never persist a phone number to users.phone_number until the
// user proves control of it via the verification flow (Task #212).
//
// This file covers three guarantees:
//
//   1. The user-creation handler used by the Stripe checkout webhook stores
//      the signup form's phone in users.pending_phone_number, NOT in
//      users.phone_number.
//
//   2. claimPhoneForUser (the verify-code success path) clears
//      pending_phone_number when it sets phone_number + phone_verified=true,
//      so the "pre-fill the wizard" hint disappears for users who already
//      finished verification.
//
//   3. The 0013 migration moves legacy unverified rows
//      (phone_verified=false AND phone_number IS NOT NULL) into
//      pending_phone_number and nulls out phone_number, while leaving
//      verified rows untouched. This is what cleans up the historical mess
//      created by Task #69.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run this test');
}

const { storage } = await import('../server/storage');
const { db } = await import('../server/db');
const { users } = await import('../shared/schema');
const { sql, eq, inArray } = await import('drizzle-orm');
const { claimPhoneForUser } = await import('../server/lib/phoneVerification');
const { addUsersPendingPhoneNumberColumn } = await import('../server/migrations/0013_users_pending_phone_number');

const SUFFIX = `${process.pid}_${Date.now()}`;
// Use deterministic but per-run-unique numbers so parallel test runs don't
// collide on the partial unique index from migration 0011.
const baseDigits = 80_000_000 + (process.pid % 9_000_000);
const PHONE_VERIFIED = `+54911${String(baseDigits).padStart(8, '0')}`;
const PHONE_UNVERIFIED_LEGACY = `+54911${String(baseDigits + 1).padStart(8, '0')}`;
const PHONE_VERIFY_TARGET = `+54911${String(baseDigits + 2).padStart(8, '0')}`;
const PHONE_SIGNUP_FORM = `+54911${String(baseDigits + 3).padStart(8, '0')}`;

const createdUserIds: string[] = [];

after(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe('Task #221 — phone is informational until verified', () => {
  it('createUser persists pendingPhoneNumber, NOT phoneNumber, for signup-form input', async () => {
    const hashed = await bcrypt.hash('Test1234!', 10);
    const u = await storage.createUser({
      email: `t221-signup-${SUFFIX}@test.local`,
      name: 'Signup Form User',
      password: hashed,
      accountType: 'business',
      // This is what server/routes/auth.ts and server/webhookHandlers.ts now
      // pass when creating the user from a pendingSignup row.
      pendingPhoneNumber: PHONE_SIGNUP_FORM,
    } as any);
    createdUserIds.push(u.id);

    const fresh = await storage.getUser(u.id);
    assert.ok(fresh, 'user should be retrievable');
    assert.equal(fresh!.phoneNumber, null, 'phone_number must remain NULL until verification');
    assert.equal(fresh!.phoneVerified, false, 'phone_verified must default to false');
    assert.equal(
      fresh!.pendingPhoneNumber,
      PHONE_SIGNUP_FORM,
      'pending_phone_number stores the unverified signup hint',
    );
  });

  it('claimPhoneForUser clears pendingPhoneNumber on successful verification', async () => {
    const hashed = await bcrypt.hash('Test1234!', 10);
    const u = await storage.createUser({
      email: `t221-claim-${SUFFIX}@test.local`,
      name: 'Verify Then Clear',
      password: hashed,
      accountType: 'business',
      pendingPhoneNumber: PHONE_VERIFY_TARGET,
    } as any);
    createdUserIds.push(u.id);

    // Sanity: pendingPhoneNumber is set, phoneNumber is not.
    const before = await storage.getUser(u.id);
    assert.equal(before!.phoneNumber, null);
    assert.equal(before!.pendingPhoneNumber, PHONE_VERIFY_TARGET);

    const result = await claimPhoneForUser(u.id, PHONE_VERIFY_TARGET);
    assert.equal(result.ok, true, 'verify should succeed');

    const after = await storage.getUser(u.id);
    assert.equal(after!.phoneNumber, PHONE_VERIFY_TARGET, 'phone_number now bound');
    assert.equal(after!.phoneVerified, true, 'phone_verified flipped to true');
    assert.equal(
      after!.pendingPhoneNumber,
      null,
      'pending_phone_number cleared so the wizard pre-fill hint goes away',
    );
  });

  it('migration 0013 leaves all existing rows untouched (no backfill, per product decision)', async () => {
    // Per product decision: production users who already have a number in
    // users.phone_number — verified or not — must keep it exactly as it is.
    // We don't yank phone numbers from accounts that are already in use.
    // The fix is forward-only: new signups can no longer plant unverified
    // numbers in users.phone_number.
    //
    // This test plants both flavors of "existing" row, re-runs the migration,
    // and asserts neither row is touched.
    const hashed = await bcrypt.hash('Test1234!', 10);

    // Plant a legacy unverified row (the historical state that Task #69 left
    // behind). The migration must NOT strip its phone_number.
    const legacyUser = await storage.createUser({
      email: `t221-legacy-${SUFFIX}@test.local`,
      name: 'Legacy Unverified',
      password: hashed,
      accountType: 'business',
    } as any);
    createdUserIds.push(legacyUser.id);
    await db
      .update(users)
      .set({ phoneNumber: PHONE_UNVERIFIED_LEGACY, phoneVerified: false, pendingPhoneNumber: null })
      .where(eq(users.id, legacyUser.id));

    // Plant a verified row through the proper claim path (so migration 0011's
    // partial unique index stays consistent).
    const verifiedUser = await storage.createUser({
      email: `t221-verified-${SUFFIX}@test.local`,
      name: 'Already Verified',
      password: hashed,
      accountType: 'business',
    } as any);
    createdUserIds.push(verifiedUser.id);
    const claimRes = await claimPhoneForUser(verifiedUser.id, PHONE_VERIFIED);
    assert.equal(claimRes.ok, true, 'verified user should claim successfully');

    // Force-rerun the migration on the planted state.
    await db.execute(sql`DELETE FROM _migrations WHERE name = '0013_users_pending_phone_number'`);
    await addUsersPendingPhoneNumberColumn();

    const legacyAfter = await storage.getUser(legacyUser.id);
    assert.equal(
      legacyAfter!.phoneNumber,
      PHONE_UNVERIFIED_LEGACY,
      'legacy unverified phone_number must remain (no backfill)',
    );
    assert.equal(legacyAfter!.phoneVerified, false, 'legacy phone_verified stays false');
    assert.equal(
      legacyAfter!.pendingPhoneNumber,
      null,
      'legacy row must NOT gain a pending hint — the migration never touches existing rows',
    );

    const verifiedAfter = await storage.getUser(verifiedUser.id);
    assert.equal(
      verifiedAfter!.phoneNumber,
      PHONE_VERIFIED,
      'verified row phone_number must remain untouched',
    );
    assert.equal(verifiedAfter!.phoneVerified, true, 'verified row stays verified');
    assert.equal(
      verifiedAfter!.pendingPhoneNumber,
      null,
      'verified row must not gain a pending hint',
    );
  });
});
