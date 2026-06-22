import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Task #308 — Tests para `storage.getSubscriptionByUserId`. Cuando un usuario
// tiene varias filas en `subscriptions` (caso real en producción: 35 usuarios
// con duplicados), la función debe devolver la fila con el estado más
// "alto" según el orden funcional: active > trialing > past_due > unpaid >
// pending > cancelled > otros. Dentro del mismo estado, gana `updated_at`
// más reciente. El test usa la base real (igual que el resto de la suite).

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run this test');
}

const { storage } = await import('../server/storage');
const { db } = await import('../server/db');
const { subscriptions, users } = await import('../shared/schema');
const { eq } = await import('drizzle-orm');

const SUFFIX = `${process.pid}_${Date.now()}`;
const createdUserIds: string[] = [];

async function createTestUser(label: string): Promise<string> {
  const email = `test-task308-${label}-${SUFFIX}@aikestar.test`;
  const [user] = await db
    .insert(users)
    .values({
      email,
      name: `Task 308 ${label}`,
      password: 'no-login-test',
    })
    .returning();
  createdUserIds.push(user.id);
  return user.id;
}

async function insertSubRow(opts: {
  userId: string;
  status: string;
  planType?: string;
  createdAt?: Date;
  updatedAt?: Date;
  stripeSubscriptionId?: string | null;
  paymentFailedAt?: Date | null;
}) {
  await db.insert(subscriptions).values({
    userId: opts.userId,
    planType: opts.planType ?? 'starter',
    status: opts.status,
    createdAt: opts.createdAt ?? new Date(),
    updatedAt: opts.updatedAt ?? new Date(),
    stripeSubscriptionId: opts.stripeSubscriptionId ?? null,
    paymentFailedAt: opts.paymentFailedAt ?? null,
  } as any);
}

after(async () => {
  for (const id of createdUserIds) {
    await db.delete(subscriptions).where(eq(subscriptions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('storage.getSubscriptionByUserId — determinismo por estado (Task #308)', () => {
  it('devuelve undefined cuando el usuario no tiene filas', async () => {
    const userId = await createTestUser('empty');
    const result = await storage.getSubscriptionByUserId(userId);
    assert.equal(result, undefined);
  });

  it('devuelve la única fila cuando hay una sola', async () => {
    const userId = await createTestUser('single');
    await insertSubRow({ userId, status: 'active' });
    const result = await storage.getSubscriptionByUserId(userId);
    assert.ok(result);
    assert.equal(result?.status, 'active');
  });

  it('prioriza trialing sobre cancelled aunque cancelled sea más reciente', async () => {
    // Reproduce el caso real de Tomás de la Vega: una fila trialing creada
    // primero, una cancelled insertada milisegundos después. Antes del fix,
    // el ORDER BY createdAt DESC agarraba la cancelled y rompía el acceso.
    const userId = await createTestUser('trialing-vs-cancelled');
    const t0 = new Date('2025-01-01T10:00:00Z');
    const t1 = new Date('2025-01-01T10:00:00.200Z');
    await insertSubRow({ userId, status: 'trialing', createdAt: t0, updatedAt: t0 });
    await insertSubRow({ userId, status: 'cancelled', createdAt: t1, updatedAt: t1 });
    const result = await storage.getSubscriptionByUserId(userId);
    assert.equal(result?.status, 'trialing');
  });

  it('prioriza active sobre trialing y past_due', async () => {
    const userId = await createTestUser('active-wins');
    const t = new Date('2025-01-01T10:00:00Z');
    await insertSubRow({ userId, status: 'past_due', createdAt: t, updatedAt: t });
    await insertSubRow({ userId, status: 'trialing', createdAt: t, updatedAt: t });
    await insertSubRow({ userId, status: 'active', createdAt: t, updatedAt: t });
    const result = await storage.getSubscriptionByUserId(userId);
    assert.equal(result?.status, 'active');
  });

  it('con empate de estado, gana la fila con updatedAt más reciente', async () => {
    const userId = await createTestUser('updated-tiebreak');
    const older = new Date('2025-01-01T10:00:00Z');
    const newer = new Date('2025-06-01T10:00:00Z');
    // Primera fila: creada después, pero con updatedAt vieja.
    await insertSubRow({
      userId,
      status: 'active',
      planType: 'starter',
      createdAt: new Date('2025-07-01T10:00:00Z'),
      updatedAt: older,
    });
    // Segunda fila: creada antes, pero con updatedAt fresca.
    await insertSubRow({
      userId,
      status: 'active',
      planType: 'pro',
      createdAt: new Date('2025-02-01T10:00:00Z'),
      updatedAt: newer,
    });
    const result = await storage.getSubscriptionByUserId(userId);
    assert.equal(result?.status, 'active');
    assert.equal(result?.planType, 'pro');
  });

  it('un estado desconocido cae al final (ELSE 7) y pierde contra cancelled', async () => {
    // Si Stripe agrega un estado nuevo (ej. "incomplete") y entra en la
    // tabla, el CASE lo mapea a 7 — peor que cualquier estado conocido. La
    // función debe seguir devolviendo la mejor fila conocida en vez del
    // estado desconocido.
    const userId = await createTestUser('unknown-status');
    const t = new Date('2025-01-01T10:00:00Z');
    await insertSubRow({ userId, status: 'incomplete', createdAt: t, updatedAt: t });
    await insertSubRow({ userId, status: 'cancelled', createdAt: t, updatedAt: t });
    const result = await storage.getSubscriptionByUserId(userId);
    assert.equal(result?.status, 'cancelled');
  });

  it('Task #318 — con duplicados del mismo stripe_subscription_id gana la fila con updatedAt más nuevo, no la "mejor" por prioridad', async () => {
    // Caso real de Tomás de la Vega: el webhook de signup insertó una fila
    // trialing en enero con sub_xxx, y dos meses después el webhook de
    // payment_failed/customer.subscription.deleted insertó otra fila para
    // el MISMO sub_xxx con status='cancelled' y payment_failed_at. La
    // función debe reconocer que ambas filas representan la misma
    // suscripción en Stripe y devolver la más reciente (cancelled), no la
    // que tiene mejor prioridad funcional (trialing).
    const userId = await createTestUser('dup-stripe-id');
    const sub = `sub_test_${SUFFIX}_dup`;
    const tOld = new Date('2025-01-29T13:57:00Z');
    const tNew = new Date('2025-03-22T15:00:00Z');
    await insertSubRow({
      userId, status: 'trialing', stripeSubscriptionId: sub,
      createdAt: tOld, updatedAt: tOld,
    });
    await insertSubRow({
      userId, status: 'cancelled', stripeSubscriptionId: sub,
      paymentFailedAt: new Date('2025-03-01T00:00:00Z'),
      createdAt: tNew, updatedAt: tNew,
    });
    const result = await storage.getSubscriptionByUserId(userId);
    assert.equal(result?.status, 'cancelled');
    assert.ok(result?.paymentFailedAt, 'debe preservar payment_failed_at de la fila ganadora');
  });

  it('Task #318 — dos suscripciones DIFERENTES (otro stripe_subscription_id) siguen ordenándose por prioridad', async () => {
    // Si un usuario migró entre dos planes (dos suscripciones distintas en
    // Stripe), la dedup por stripe_subscription_id no se aplica entre ellas
    // y mantenemos la prioridad funcional: active > cancelled.
    const userId = await createTestUser('two-distinct-subs');
    const tNewer = new Date('2025-06-01T10:00:00Z');
    const tOlder = new Date('2025-01-01T10:00:00Z');
    await insertSubRow({
      userId, status: 'cancelled', stripeSubscriptionId: `sub_${SUFFIX}_A`,
      createdAt: tNewer, updatedAt: tNewer,
    });
    await insertSubRow({
      userId, status: 'active', stripeSubscriptionId: `sub_${SUFFIX}_B`,
      createdAt: tOlder, updatedAt: tOlder,
    });
    const result = await storage.getSubscriptionByUserId(userId);
    assert.equal(result?.status, 'active');
  });

  it('prioriza past_due sobre unpaid sobre pending sobre cancelled', async () => {
    const userId = await createTestUser('blocked-order');
    const t = new Date('2025-01-01T10:00:00Z');
    await insertSubRow({ userId, status: 'cancelled', createdAt: t, updatedAt: t });
    await insertSubRow({ userId, status: 'pending', createdAt: t, updatedAt: t });
    await insertSubRow({ userId, status: 'unpaid', createdAt: t, updatedAt: t });
    await insertSubRow({ userId, status: 'past_due', createdAt: t, updatedAt: t });
    const result = await storage.getSubscriptionByUserId(userId);
    assert.equal(result?.status, 'past_due');
  });
});
