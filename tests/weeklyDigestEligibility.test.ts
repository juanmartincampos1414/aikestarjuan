import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Task #309 — Tests del helper `isEligibleForWeeklyDigest`. Verifica que el
// cron del resumen semanal saltee usuarios eliminados o con suscripción
// bloqueada, y que respete el grace period de 7 días para `past_due`. Igual
// que el resto de la suite, usa la base real.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run this test');
}

const { isEligibleForWeeklyDigest } = await import('../server/services/weeklyDigest');
const { db } = await import('../server/db');
const { subscriptions, users, organizations, memberships } = await import('../shared/schema');
const { eq, inArray } = await import('drizzle-orm');

const SUFFIX = `${process.pid}_${Date.now()}`;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

async function createUser(label: string, opts: { deletedAt?: Date } = {}): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `test-task309-${label}-${SUFFIX}@aikestar.test`,
      name: `Task 309 ${label}`,
      password: 'no-login-test',
      deletedAt: opts.deletedAt ?? null,
    } as any)
    .returning();
  createdUserIds.push(user.id);
  return user.id;
}

async function createOrgWithOwner(label: string, ownerUserId: string): Promise<string> {
  const [org] = await db
    .insert(organizations)
    .values({ name: `Org 309 ${label}`, type: 'business' } as any)
    .returning();
  createdOrgIds.push(org.id);
  await db.insert(memberships).values({
    userId: ownerUserId,
    organizationId: org.id,
    role: 'owner',
  } as any);
  return org.id;
}

async function addMember(orgId: string, userId: string) {
  await db.insert(memberships).values({
    userId,
    organizationId: orgId,
    role: 'operator',
  } as any);
}

async function insertSub(opts: {
  userId: string;
  status: string;
  paymentFailedAt?: Date | null;
  stripeSubscriptionId?: string | null;
  updatedAt?: Date;
}) {
  await db.insert(subscriptions).values({
    userId: opts.userId,
    planType: 'starter',
    status: opts.status,
    paymentFailedAt: opts.paymentFailedAt ?? null,
    stripeSubscriptionId: opts.stripeSubscriptionId ?? null,
    updatedAt: opts.updatedAt ?? new Date(),
  } as any);
}

after(async () => {
  if (createdOrgIds.length > 0) {
    await db.delete(memberships).where(inArray(memberships.organizationId, createdOrgIds));
    await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
  }
  for (const id of createdUserIds) {
    await db.delete(subscriptions).where(eq(subscriptions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('isEligibleForWeeklyDigest (Task #309)', () => {
  it('inelegible si el usuario tiene deletedAt', async () => {
    const userId = await createUser('deleted', { deletedAt: new Date() });
    await createOrgWithOwner('deleted', userId);
    await insertSub({ userId, status: 'active' });
    const r = await isEligibleForWeeklyDigest(userId);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, 'deleted');
  });

  it('elegible si la suscripción propia está active', async () => {
    const userId = await createUser('active');
    await createOrgWithOwner('active', userId);
    await insertSub({ userId, status: 'active' });
    const r = await isEligibleForWeeklyDigest(userId);
    assert.equal(r.eligible, true);
    assert.equal(r.reason, 'eligible');
  });

  it('elegible si la suscripción propia está trialing', async () => {
    const userId = await createUser('trialing');
    await createOrgWithOwner('trialing', userId);
    await insertSub({ userId, status: 'trialing' });
    const r = await isEligibleForWeeklyDigest(userId);
    assert.equal(r.eligible, true);
  });

  it('inelegible si la suscripción propia está cancelled (caso Juan Campos)', async () => {
    const userId = await createUser('cancelled');
    await createOrgWithOwner('cancelled', userId);
    await insertSub({ userId, status: 'cancelled' });
    const r = await isEligibleForWeeklyDigest(userId);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, 'cancelled');
  });

  it('elegible si past_due dentro del grace period de 7 días', async () => {
    const userId = await createUser('past-due-grace');
    await createOrgWithOwner('past-due-grace', userId);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await insertSub({ userId, status: 'past_due', paymentFailedAt: threeDaysAgo });
    const r = await isEligibleForWeeklyDigest(userId);
    assert.equal(r.eligible, true);
  });

  it('inelegible si past_due fuera del grace period (caso Lolita / Nacho / Santiago)', async () => {
    const userId = await createUser('past-due-expired');
    await createOrgWithOwner('past-due-expired', userId);
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await insertSub({ userId, status: 'past_due', paymentFailedAt: tenDaysAgo });
    const r = await isEligibleForWeeklyDigest(userId);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, 'past_due_expired');
  });

  it('inelegible si el usuario no tiene suscripción y no es miembro de otra org', async () => {
    const userId = await createUser('no-sub');
    await createOrgWithOwner('no-sub', userId);
    const r = await isEligibleForWeeklyDigest(userId);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, 'no_subscription');
  });

  it('miembro sin sub propia hereda elegibilidad del dueño de la org', async () => {
    const ownerId = await createUser('inherit-owner');
    const memberId = await createUser('inherit-member');
    const orgId = await createOrgWithOwner('inherit', ownerId);
    await addMember(orgId, memberId);
    await insertSub({ userId: ownerId, status: 'active' });
    // El miembro no tiene sub propia.
    const r = await isEligibleForWeeklyDigest(memberId);
    assert.equal(r.eligible, true);
  });

  it('Task #318 — inelegible si hay duplicados con el mismo stripe_subscription_id y alguno está cancelled (caso Tomy)', async () => {
    // Replica exacto del bug en producción: el usuario tiene dos filas en
    // `subscriptions` para el mismo sub_xxx. La vieja quedó como trialing
    // (creada al signup) y la nueva como cancelled (webhook de Stripe por
    // falta de pago). Aún cuando la fila trialing pudiera ganar el orden
    // determinista, el digest debe respetar a Stripe: si alguna hermana
    // del subscription_id ganador está cancelled/unpaid, no se envía mail.
    const userId = await createUser('dup-stripe-id-digest');
    await createOrgWithOwner('dup-stripe-id-digest', userId);
    const sub = `sub_test_318_${SUFFIX}`;
    await insertSub({
      userId,
      status: 'trialing',
      stripeSubscriptionId: sub,
      updatedAt: new Date('2025-01-01T10:00:00Z'),
    });
    await insertSub({
      userId,
      status: 'cancelled',
      stripeSubscriptionId: sub,
      paymentFailedAt: new Date('2025-03-01T00:00:00Z'),
      updatedAt: new Date('2025-03-22T10:00:00Z'),
    });
    const r = await isEligibleForWeeklyDigest(userId);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, 'cancelled');
  });

  it('miembro queda inelegible si el dueño está cancelled y él no tiene sub propia', async () => {
    const ownerId = await createUser('inherit-bad-owner');
    const memberId = await createUser('inherit-bad-member');
    const orgId = await createOrgWithOwner('inherit-bad', ownerId);
    await addMember(orgId, memberId);
    await insertSub({ userId: ownerId, status: 'cancelled' });
    const r = await isEligibleForWeeklyDigest(memberId);
    assert.equal(r.eligible, false);
  });
});
