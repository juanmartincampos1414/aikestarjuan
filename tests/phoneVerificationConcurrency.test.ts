import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

// Task #212 (security follow-up): prove that the per-user advisory lock
// prevents the two race conditions flagged by code review:
//
//   1) Parallel /send-code calls cannot exceed SENDS_PER_WINDOW (3) per user.
//   2) Parallel /verify-code calls cannot exceed MAX_ATTEMPTS (5) per code.
//
// We exercise the service layer directly (not HTTP) because the per-route
// authLimiter already throttles requests to ~5/min and would mask the race we
// want to test.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run this test');
}

const { storage } = await import('../server/storage');
const { db } = await import('../server/db');
const { phoneVerificationCodes, users } = await import('../shared/schema');
const { eq } = await import('drizzle-orm');
const {
  startVerification,
  checkVerification,
  SENDS_PER_WINDOW,
  MAX_ATTEMPTS,
} = await import('../server/lib/phoneVerification');

const SUFFIX = `${process.pid}_${Date.now()}`;
const EMAIL = `pv-conc-${SUFFIX}@test.local`;
const PHONE = `+54911${String(60_000_000 + (process.pid % 9_000_000)).padStart(8, '0')}`;

let userId = '';

before(async () => {
  const hashed = await bcrypt.hash('Test1234!', 10);
  const u = await storage.createUser({
    email: EMAIL, name: 'PV Concurrency', password: hashed, accountType: 'business',
  } as any);
  userId = u.id;
});

after(async () => {
  try { await db.delete(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, userId)); } catch {}
  try { await db.update(users).set({ phoneNumber: null, phoneVerified: false }).where(eq(users.id, userId)); } catch {}
  try { await storage.deleteUser(userId); } catch {}
  try { await db.delete(users).where(eq(users.id, userId)); } catch {}
});

describe('Task #212 — concurrency', () => {
  it('startVerification: 10 parallel sends still respect SENDS_PER_WINDOW (3)', async () => {
    // Reset state.
    await db.delete(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, userId));

    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () => startVerification(userId, PHONE)),
    );

    const okCount = results.filter((r) => r.ok).length;
    const rateLimited = results.filter((r) => !r.ok && r.reason === 'rate_limited').length;

    assert.equal(okCount, SENDS_PER_WINDOW, `expected exactly ${SENDS_PER_WINDOW} successful sends, got ${okCount} (results: ${JSON.stringify(results.map(r => r.ok ? 'ok' : r.reason))})`);
    assert.equal(rateLimited, N - SENDS_PER_WINDOW, `expected ${N - SENDS_PER_WINDOW} rate-limited responses`);

    const rows = await db
      .select()
      .from(phoneVerificationCodes)
      .where(eq(phoneVerificationCodes.userId, userId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sendsInWindow, SENDS_PER_WINDOW, 'sends_in_window must be exactly capped at SENDS_PER_WINDOW');
  });

  it('checkVerification: 20 parallel wrong codes still respect MAX_ATTEMPTS (5)', async () => {
    // Plant a fresh code so we can submit wrong guesses against it.
    await db.delete(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, userId));
    const start = await startVerification(userId, PHONE);
    assert.equal(start.ok, true, 'precondition: startVerification must succeed');

    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => checkVerification(userId, '999999')),
    );

    const mismatch = results.filter((r) => !r.ok && r.reason === 'mismatch').length;
    const tooMany = results.filter((r) => !r.ok && r.reason === 'too_many_attempts').length;
    const noPending = results.filter((r) => !r.ok && r.reason === 'no_pending').length;

    // Implementation contract (see checkVerification):
    //   • Calls 1..MAX_ATTEMPTS-1 increment row.attempts from k → k+1 with k+1 < MAX_ATTEMPTS,
    //     so they all return 'mismatch'. That's MAX_ATTEMPTS - 1 = 4 mismatches.
    //   • Call MAX_ATTEMPTS computes attempts = (MAX_ATTEMPTS - 1) + 1 = MAX_ATTEMPTS,
    //     trips `attempts >= MAX_ATTEMPTS`, deletes the row and returns 'too_many_attempts'.
    //   • All remaining calls find no active code → 'no_pending'.
    // The CRITICAL invariant for race-safety is that the totals add up to exactly
    // (MAX_ATTEMPTS - 1) mismatches + 1 too_many — no more — even with N parallel
    // requests; without the advisory lock, two callers reading attempts=4 in
    // parallel would BOTH return mismatch (or both consume the row).
    assert.equal(mismatch, MAX_ATTEMPTS - 1, `expected ${MAX_ATTEMPTS - 1} mismatches, got ${mismatch}`);
    assert.equal(tooMany, 1, `expected exactly 1 too_many_attempts, got ${tooMany}`);
    assert.equal(noPending, N - MAX_ATTEMPTS, `expected ${N - MAX_ATTEMPTS} no_pending, got ${noPending}`);

    const rows = await db
      .select()
      .from(phoneVerificationCodes)
      .where(eq(phoneVerificationCodes.userId, userId));
    assert.equal(rows.length, 0, 'code row must be consumed after too_many_attempts');
  });
});
