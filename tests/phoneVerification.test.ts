import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

// Task #212 — Unit tests for the phone verification module. Hits the real
// database (per the project convention used by the other test suites) so the
// SQL paths in `phoneVerificationCodes` are actually exercised. Each test
// scopes itself to a freshly-created user so they can run in any order
// without colliding.

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
  claimPhoneForUser,
  generateCode,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  SENDS_PER_WINDOW,
  WINDOW_MS,
} = await import('../server/lib/phoneVerification');

const SUFFIX = `${process.pid}_${Date.now()}`;
const PHONE_BASE = '+5491121';
let counter = 0;
function uniquePhone(): string {
  counter += 1;
  // 13 digits total (+549 + 10 local). 4499xxxx where xxxx is a counter.
  const tail = String(4499_0000 + counter).padStart(8, '0');
  return `${PHONE_BASE}${tail}`;
}

const createdUserIds: string[] = [];
async function makeUser(): Promise<string> {
  const hashed = await bcrypt.hash('Test1234!', 10);
  const u = await storage.createUser({
    email: `pv-${SUFFIX}-${createdUserIds.length}@test.local`,
    name: 'PV Tester',
    password: hashed,
    accountType: 'business',
  } as any);
  createdUserIds.push(u.id);
  return u.id;
}

after(async () => {
  for (const id of createdUserIds) {
    try { await db.delete(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, id)); } catch {}
    try { await storage.deleteUser?.(id); } catch {}
    try { await db.delete(users).where(eq(users.id, id)); } catch {}
  }
});

describe('generateCode', () => {
  it('always returns a 6-digit zero-padded numeric string', () => {
    for (let i = 0; i < 200; i += 1) {
      const c = generateCode();
      assert.match(c, /^\d{6}$/, `code ${c} is not 6 digits`);
    }
  });
});

describe('startVerification', () => {
  it('creates a row, returns a 6-digit code with a future expiry', async () => {
    const userId = await makeUser();
    const phone = uniquePhone();

    const result = await startVerification(userId, phone);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.code, /^\d{6}$/);
    assert.ok(result.expiresAt.getTime() > Date.now() + CODE_TTL_MS - 5000);

    const rows = await db.select().from(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, userId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].normalizedPhone, phone);
    assert.equal(rows[0].attempts, 0);
    assert.equal(rows[0].sendsInWindow, 1);
    // The plaintext code is never persisted.
    assert.notEqual(rows[0].codeHash, result.code);
    // bcrypt hash format: $2a$ / $2b$ / $2y$ + cost + salt + digest, ~60 chars.
    // We match the prefix and length explicitly so any future regression that
    // reverts to a fast/unsalted hash (e.g. raw sha256 hex) trips this test.
    assert.match(rows[0].codeHash, /^\$2[aby]\$\d{2}\$[A-Za-z0-9./]{53}$/);
    assert.equal(rows[0].codeHash.length, 60);
  });

  it('refreshes the code on a subsequent send within the rate window', async () => {
    const userId = await makeUser();
    const phone = uniquePhone();

    const r1 = await startVerification(userId, phone);
    assert.equal(r1.ok, true);
    const r2 = await startVerification(userId, phone);
    assert.equal(r2.ok, true);

    const rows = await db.select().from(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, userId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sendsInWindow, 2);
  });

  it(`rate-limits after ${SENDS_PER_WINDOW} sends in the window`, async () => {
    const userId = await makeUser();
    const phone = uniquePhone();

    for (let i = 0; i < SENDS_PER_WINDOW; i += 1) {
      const r = await startVerification(userId, phone);
      assert.equal(r.ok, true, `send ${i + 1} should succeed`);
    }
    const blocked = await startVerification(userId, phone);
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.reason, 'rate_limited');
    assert.ok(typeof blocked.retryAfterMs === 'number' && blocked.retryAfterMs! > 0 && blocked.retryAfterMs! <= WINDOW_MS);
  });

  it('rejects when the phone is already verified by another user', async () => {
    const ownerId = await makeUser();
    const phone = uniquePhone();
    // Pretend ownerId already verified the number.
    await db.update(users).set({ phoneNumber: phone, phoneVerified: true }).where(eq(users.id, ownerId));

    const stranger = await makeUser();
    const r = await startVerification(stranger, phone);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'phone_taken');
  });

  it('allows starting verification when the existing binding is unverified (squatter case)', async () => {
    const squatterId = await makeUser();
    const phone = uniquePhone();
    await db.update(users).set({ phoneNumber: phone, phoneVerified: false }).where(eq(users.id, squatterId));

    const realOwner = await makeUser();
    const r = await startVerification(realOwner, phone);
    assert.equal(r.ok, true, 'real owner should be allowed to start verification over a squatter');
  });
});

describe('checkVerification', () => {
  it('happy path — valid code returns ok + the normalized phone, then deletes the row', async () => {
    const userId = await makeUser();
    const phone = uniquePhone();
    const fixedCode = '424242';

    const start = await startVerification(userId, phone, { generate: () => fixedCode });
    assert.equal(start.ok, true);

    const verify = await checkVerification(userId, fixedCode);
    assert.equal(verify.ok, true);
    if (!verify.ok) return;
    assert.equal(verify.normalizedPhone, phone);

    const after = await db.select().from(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, userId));
    assert.equal(after.length, 0, 'code should be consumed (deleted) on success');
  });

  it('returns no_pending when no code was sent', async () => {
    const userId = await makeUser();
    const r = await checkVerification(userId, '123456');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'no_pending');
  });

  it('returns expired and clears the row when the code has expired', async () => {
    const userId = await makeUser();
    const phone = uniquePhone();
    const fixedCode = '111111';
    await startVerification(userId, phone, { generate: () => fixedCode });
    // Force expiry.
    await db
      .update(phoneVerificationCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(phoneVerificationCodes.userId, userId));

    const r = await checkVerification(userId, fixedCode);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'expired');
    const rows = await db.select().from(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, userId));
    assert.equal(rows.length, 0);
  });

  it('mismatch increments attempts and reports remaining', async () => {
    const userId = await makeUser();
    const phone = uniquePhone();
    await startVerification(userId, phone, { generate: () => '999999' });

    const r = await checkVerification(userId, '000000');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'mismatch');
    assert.equal(r.remainingAttempts, MAX_ATTEMPTS - 1);

    const rows = await db.select().from(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, userId));
    assert.equal(rows[0].attempts, 1);
  });

  it(`consumes the code after ${MAX_ATTEMPTS} bad attempts`, async () => {
    const userId = await makeUser();
    const phone = uniquePhone();
    await startVerification(userId, phone, { generate: () => '777777' });

    let lastReason = '';
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      const r = await checkVerification(userId, '000000');
      assert.equal(r.ok, false);
      if (!r.ok) lastReason = r.reason;
    }
    assert.equal(lastReason, 'too_many_attempts', 'final attempt should report too_many_attempts');

    const rows = await db.select().from(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, userId));
    assert.equal(rows.length, 0, 'code row should be consumed after max attempts');
  });

  it('rejects malformed codes (non-6-digit) without leaking timing info, but still counts as an attempt', async () => {
    const userId = await makeUser();
    const phone = uniquePhone();
    await startVerification(userId, phone, { generate: () => '555555' });

    const r = await checkVerification(userId, 'abcdef');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'mismatch');

    const rows = await db.select().from(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, userId));
    assert.equal(rows[0].attempts, 1);
  });
});

describe('claimPhoneForUser', () => {
  it('binds the phone as verified and clears any unverified squatter on the same number', async () => {
    const phone = uniquePhone();

    const squatter = await makeUser();
    await db.update(users).set({ phoneNumber: phone, phoneVerified: false }).where(eq(users.id, squatter));

    const realOwner = await makeUser();
    const claim = await claimPhoneForUser(realOwner, phone);
    assert.equal(claim.ok, true);
    if (!claim.ok) return;
    assert.equal(claim.user!.phoneNumber, phone);
    assert.equal(claim.user!.phoneVerified, true);

    const squatterRow = await db.select().from(users).where(eq(users.id, squatter));
    assert.equal(squatterRow[0].phoneNumber, null, 'squatter binding should be cleared');
    assert.equal(squatterRow[0].phoneVerified, false);
  });

  it('refuses to claim when a verified owner already exists', async () => {
    const phone = uniquePhone();
    const verifiedOwner = await makeUser();
    await db.update(users).set({ phoneNumber: phone, phoneVerified: true }).where(eq(users.id, verifiedOwner));

    const challenger = await makeUser();
    const claim = await claimPhoneForUser(challenger, phone);
    assert.equal(claim.ok, false);
    if (claim.ok) return;
    assert.equal(claim.reason, 'phone_taken');
  });
});
