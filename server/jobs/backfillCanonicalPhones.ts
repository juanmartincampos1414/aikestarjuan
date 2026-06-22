import { db } from '../db';
import { users } from '@shared/schema';
import { eq, and, like, not } from 'drizzle-orm';
import { normalizePhoneInput } from '@shared/phone';

export interface BackfillCanonicalPhonesResult {
  scanned: number;
  migrated: number;
  conflicts: number;
  invalid: number;
  unchanged: number;
}

export async function backfillCanonicalPhones(): Promise<BackfillCanonicalPhonesResult> {
  const result: BackfillCanonicalPhonesResult = {
    scanned: 0,
    migrated: 0,
    conflicts: 0,
    invalid: 0,
    unchanged: 0,
  };

  const legacy = await db
    .select({ id: users.id, phoneNumber: users.phoneNumber })
    .from(users)
    .where(
      and(
        like(users.phoneNumber, '+54%'),
        not(like(users.phoneNumber, '+549%')),
      ),
    );

  result.scanned = legacy.length;
  if (legacy.length === 0) {
    console.log('[Backfill] WhatsApp phones: nothing to migrate');
    return result;
  }

  for (const row of legacy) {
    const current = row.phoneNumber;
    if (!current) {
      result.invalid++;
      continue;
    }

    const normalized = normalizePhoneInput(current);
    if (!normalized.ok || !normalized.isArMobile) {
      result.invalid++;
      console.warn(
        `[Backfill] WhatsApp phones: skipped user ${row.id} (cannot normalize "${current}")`,
      );
      continue;
    }

    if (normalized.phone === current) {
      result.unchanged++;
      continue;
    }

    const collisions = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(eq(users.phoneNumber, normalized.phone), not(eq(users.id, row.id))),
      );

    if (collisions.length > 0) {
      result.conflicts++;
      const conflictIds = collisions.map((c) => c.id).join(', ');
      console.warn(
        `[Backfill] WhatsApp phones: collision for user ${row.id} ("${current}" -> "${normalized.phone}"). Already taken by user(s) ${conflictIds}. Left unchanged for manual review.`,
      );
      continue;
    }

    await db
      .update(users)
      .set({ phoneNumber: normalized.phone })
      .where(eq(users.id, row.id));
    result.migrated++;
  }

  console.log(
    `[Backfill] WhatsApp phones: ${result.migrated} migrated, ${result.conflicts} conflicts, ${result.invalid} invalid (scanned ${result.scanned})`,
  );

  return result;
}
