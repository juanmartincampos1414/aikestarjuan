import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db';
import * as schema from '@shared/schema';
import { phoneVerificationCodes, users, type User } from '@shared/schema';
import { eq, and, inArray, ne, sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { arPhoneCandidates } from '@shared/phone';

// Concrete transaction type matching the runtime `db` (NodePgDatabase<typeof
// schema>) so the per-user advisory-lock helper gets the same query surface
// as the outer db without falling back to `any`.
type Tx = PgTransaction<NodePgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;

// Task #212 — Phone verification service.
//
// Flow:
//   1) startVerification(userId, normalizedPhone) generates a fresh 6-digit
//      code, hashes it, persists (userId, normalizedPhone, hash, expiry,
//      attempts=0), enforces a per-user rate limit (max SENDS_PER_WINDOW in
//      WINDOW_MS), and returns the plaintext code so the caller can send it
//      via WhatsApp. The plaintext is NEVER stored.
//   2) checkVerification(userId, code) compares the user-provided code to
//      the stored hash, checks expiry & attempts, and on success returns
//      the verified normalizedPhone (caller flips users.phoneVerified=true
//      and reassigns the binding).
//
// Failure semantics (the route layer translates these to user-facing
// messages, but the codes are stable so tests can assert on them):
//   - 'rate_limited'  — too many sends in the rolling window
//   - 'phone_taken'   — phone already bound to a *verified* user
//   - 'no_pending'    — verify called without an active code
//   - 'expired'       — code older than CODE_TTL_MS
//   - 'too_many_attempts' — more than MAX_ATTEMPTS bad guesses; code is
//                         consumed (deleted) so the user must re-send
//   - 'mismatch'      — wrong code (attempts++)

export const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_ATTEMPTS = 5;
export const SENDS_PER_WINDOW = 3;
export const WINDOW_MS = 60 * 60 * 1000; // 1 hour

export function generateCode(): string {
  // 6-digit zero-padded numeric code. crypto.randomInt is uniform.
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, '0');
}

// Codes are hashed with bcrypt (cost 10). The 6-digit numeric code has only
// 1,000,000 possible values; an unsalted fast hash like SHA-256 would be
// brute-forceable in milliseconds if the DB were ever exposed, defeating the
// purpose of hashing at all. bcrypt's per-hash random salt + adaptive cost
// makes that attack ~100ms per guess, which combined with the 5-attempt-cap
// and the 10-min TTL is the desired margin. The `pv1:` prefix is preserved so
// the wire format remains visibly versioned for future rotation.
const BCRYPT_COST = 10;

async function hashCode(code: string): Promise<string> {
  return bcrypt.hash(`pv1:${code}`, BCRYPT_COST);
}

async function verifyCodeHash(plaintext: string, storedHash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(`pv1:${plaintext}`, storedHash);
  } catch {
    return false;
  }
}

export type StartResult =
  | { ok: true; code: string; expiresAt: Date }
  | { ok: false; reason: 'rate_limited' | 'phone_taken'; retryAfterMs?: number };

export type VerifyResult =
  | { ok: true; normalizedPhone: string }
  | { ok: false; reason: 'no_pending' | 'expired' | 'too_many_attempts' | 'mismatch'; remainingAttempts?: number };

export interface StartDeps {
  now?: () => Date;
  generate?: () => string;
}

export interface VerifyDeps {
  now?: () => Date;
}

// Per-user serialization of phone-verification operations. We use a Postgres
// advisory transaction lock keyed on hashtext(userId) so concurrent
// send-code / verify-code requests for the SAME user are processed one at a
// time. This prevents two well-known race conditions:
//   1) Two parallel /send-code calls both reading sendsInWindow < 3 and both
//      committing, bypassing the per-hour cap.
//   2) Two parallel /verify-code calls both reading attempts < 5 and both
//      incrementing from the same value, bypassing the per-attempt cap.
// hashtext is deterministic and the lock is automatically released at COMMIT
// or ROLLBACK, so callers cannot leak it.
async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
}

export async function startVerification(
  userId: string,
  normalizedPhone: string,
  deps: StartDeps = {}
): Promise<StartResult> {
  const now = (deps.now ?? (() => new Date()))();
  const candidates = arPhoneCandidates(normalizedPhone);
  const code = (deps.generate ?? generateCode)();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  const codeHash = await hashCode(code);

  return await db.transaction(async (tx) => {
    await lockUser(tx, userId);

    // Refuse if the phone is already bound to a *different verified* user.
    // Unverified bindings on someone else's account are treated as squatters
    // and silently overridden when this user later confirms the code.
    if (candidates.length > 0) {
      const conflicts = await tx
        .select({ id: users.id, phoneVerified: users.phoneVerified })
        .from(users)
        .where(and(inArray(users.phoneNumber, candidates), ne(users.id, userId)));
      if (conflicts.some((c) => c.phoneVerified === true)) {
        return { ok: false, reason: 'phone_taken' as const };
      }
    }

    // Rate limit: SENDS_PER_WINDOW per user per WINDOW_MS, sliding via
    // window_started_at. The advisory lock above guarantees serial reads/writes.
    const existing = await tx
      .select()
      .from(phoneVerificationCodes)
      .where(eq(phoneVerificationCodes.userId, userId))
      .limit(1);

    if (existing.length > 0) {
      const row = existing[0];
      const windowAge = now.getTime() - row.windowStartedAt.getTime();
      if (windowAge < WINDOW_MS) {
        if (row.sendsInWindow >= SENDS_PER_WINDOW) {
          return {
            ok: false,
            reason: 'rate_limited' as const,
            retryAfterMs: WINDOW_MS - windowAge,
          };
        }
        await tx
          .update(phoneVerificationCodes)
          .set({
            normalizedPhone,
            codeHash,
            expiresAt,
            attempts: 0,
            sendsInWindow: row.sendsInWindow + 1,
          })
          .where(eq(phoneVerificationCodes.userId, userId));
      } else {
        await tx
          .update(phoneVerificationCodes)
          .set({
            normalizedPhone,
            codeHash,
            expiresAt,
            attempts: 0,
            sendsInWindow: 1,
            windowStartedAt: now,
          })
          .where(eq(phoneVerificationCodes.userId, userId));
      }
    } else {
      await tx.insert(phoneVerificationCodes).values({
        userId,
        normalizedPhone,
        codeHash,
        expiresAt,
        attempts: 0,
        sendsInWindow: 1,
        windowStartedAt: now,
      });
    }

    return { ok: true as const, code, expiresAt };
  });
}

export async function checkVerification(
  userId: string,
  rawCode: string,
  deps: VerifyDeps = {}
): Promise<VerifyResult> {
  const now = (deps.now ?? (() => new Date()))();

  return await db.transaction(async (tx) => {
    await lockUser(tx, userId);

    const rows = await tx
      .select()
      .from(phoneVerificationCodes)
      .where(eq(phoneVerificationCodes.userId, userId))
      .limit(1);

    if (rows.length === 0) {
      return { ok: false as const, reason: 'no_pending' as const };
    }

    const row = rows[0];

    if (row.expiresAt.getTime() <= now.getTime()) {
      // Code expired — drop it so the next /send-code starts fresh.
      await tx
        .delete(phoneVerificationCodes)
        .where(eq(phoneVerificationCodes.userId, userId));
      return { ok: false as const, reason: 'expired' as const };
    }

    if (row.attempts >= MAX_ATTEMPTS) {
      await tx
        .delete(phoneVerificationCodes)
        .where(eq(phoneVerificationCodes.userId, userId));
      return { ok: false as const, reason: 'too_many_attempts' as const };
    }

    const candidate = (rawCode || '').trim();
    // Reject anything that isn't 6 digits before doing the constant-time compare
    // so we don't waste an attempt slot on obvious typos.
    if (!/^\d{6}$/.test(candidate)) {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await tx
          .delete(phoneVerificationCodes)
          .where(eq(phoneVerificationCodes.userId, userId));
        return { ok: false as const, reason: 'too_many_attempts' as const };
      }
      await tx
        .update(phoneVerificationCodes)
        .set({ attempts })
        .where(eq(phoneVerificationCodes.userId, userId));
      return { ok: false as const, reason: 'mismatch' as const, remainingAttempts: MAX_ATTEMPTS - attempts };
    }

    if (!(await verifyCodeHash(candidate, row.codeHash))) {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await tx
          .delete(phoneVerificationCodes)
          .where(eq(phoneVerificationCodes.userId, userId));
        return { ok: false as const, reason: 'too_many_attempts' as const };
      }
      await tx
        .update(phoneVerificationCodes)
        .set({ attempts })
        .where(eq(phoneVerificationCodes.userId, userId));
      return { ok: false as const, reason: 'mismatch' as const, remainingAttempts: MAX_ATTEMPTS - attempts };
    }

    // Success — consume the code so it cannot be replayed.
    await tx
      .delete(phoneVerificationCodes)
      .where(eq(phoneVerificationCodes.userId, userId));

    return { ok: true as const, normalizedPhone: row.normalizedPhone };
  });
}

// On successful verification, claim the phone for `userId`: clear the same
// number from any *unverified* foreign user (squatter cleanup) and bind it
// here as verified=true. Verified foreign owners would have caused
// startVerification to abort earlier, so we don't have to handle them here —
// but we still re-check defensively to avoid races.
export async function claimPhoneForUser(userId: string, normalizedPhone: string): Promise<{ ok: boolean; reason?: 'phone_taken'; user?: User }> {
  const candidates = arPhoneCandidates(normalizedPhone);

  try {
    return await db.transaction(async (tx) => {
      await lockUser(tx, userId);
      if (candidates.length > 0) {
        const conflicts = await tx
          .select({ id: users.id, phoneVerified: users.phoneVerified })
          .from(users)
          .where(and(inArray(users.phoneNumber, candidates), ne(users.id, userId)))
          .for('update');

        if (conflicts.some((c) => c.phoneVerified === true)) {
          return { ok: false, reason: 'phone_taken' as const };
        }

        const unverifiedIds = conflicts.filter((c) => c.phoneVerified !== true).map((c) => c.id);
        if (unverifiedIds.length > 0) {
          await tx
            .update(users)
            // Task #219: also wipe phoneNumberAddedAt so squatters whose
            // unverified binding we just stripped don't keep getting the
            // "finish linking" banner for a number they no longer hold.
            .set({ phoneNumber: null, phoneVerified: false, phoneNumberAddedAt: null })
            .where(inArray(users.id, unverifiedIds));
        }
      }

      // Task #221: once the number is verified we drop the pending hint.
      // pendingPhoneNumber only exists to pre-fill the wizard for unverified
      // users; clearing it after success keeps the user model tidy.
      const updated = await tx
        .update(users)
        // Task #219: clear phoneNumberAddedAt on successful verification so
        // the dashboard banner stops firing once the user finishes the wizard.
        // Task #221: also clear pendingPhoneNumber — it only exists to
        // pre-fill the wizard for unverified users, so verifying drops it.
        .set({
          phoneNumber: normalizedPhone,
          phoneVerified: true,
          phoneNumberAddedAt: null,
          pendingPhoneNumber: null,
        })
        .where(eq(users.id, userId))
        .returning();

      return { ok: true, user: updated[0] };
    });
  } catch (err: any) {
    // The partial unique index `users_phone_number_verified_unique_idx`
    // (migration 0011) guarantees at most one verified owner per number.
    // If two verifications race past the advisory lock layer (e.g. across
    // database restarts where the lock is dropped), the loser surfaces a
    // unique-constraint violation here. Translate it to phone_taken so the
    // route layer can return a clean 409 instead of a 500.
    const code = err?.code ?? err?.cause?.code;
    if (code === '23505') {
      return { ok: false, reason: 'phone_taken' as const };
    }
    throw err;
  }
}
