import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';

// Task #310 — Tests del nuevo upsert y de la idempotencia del webhook
// frente al race condition que producía duplicados en `subscriptions`.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run this test');
}

const { storage } = await import('../server/storage');
const { db } = await import('../server/db');
const { subscriptions, users } = await import('../shared/schema');
const { WebhookHandlers } = await import('../server/webhookHandlers');

const SUFFIX = `t310_${process.pid}_${Date.now()}`;
const createdUserIds: string[] = [];

async function createTestUser(label: string): Promise<string> {
  const [u] = await db.insert(users).values({
    email: `test-task310-${label}-${SUFFIX}@aikestar.test`,
    name: `T310 ${label}`,
    password: 'no-login',
  } as any).returning();
  createdUserIds.push(u.id);
  return u.id;
}

async function countSubsByStripeId(stripeId: string): Promise<number> {
  const rows = await db.select({ id: subscriptions.id }).from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, stripeId));
  return rows.length;
}

after(async () => {
  for (const id of createdUserIds) {
    await db.delete(subscriptions).where(eq(subscriptions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('storage.upsertSubscriptionByStripeId (Task #310)', () => {
  it('inserta una fila nueva si no existe ninguna con ese stripe_subscription_id', async () => {
    const userId = await createTestUser('upsert-insert');
    const stripeId = `sub_test_${SUFFIX}_a`;

    const sub = await storage.upsertSubscriptionByStripeId(stripeId, userId, {
      planType: 'solo',
      status: 'trialing',
    });

    assert.equal(sub.stripeSubscriptionId, stripeId);
    assert.equal(sub.status, 'trialing');
    assert.equal(await countSubsByStripeId(stripeId), 1);
  });

  it('actualiza la fila existente en vez de insertar una nueva (idempotente)', async () => {
    const userId = await createTestUser('upsert-update');
    const stripeId = `sub_test_${SUFFIX}_b`;

    await storage.upsertSubscriptionByStripeId(stripeId, userId, {
      planType: 'solo', status: 'trialing',
    });
    const sub2 = await storage.upsertSubscriptionByStripeId(stripeId, userId, {
      planType: 'solo', status: 'active',
    });

    assert.equal(sub2.status, 'active');
    assert.equal(await countSubsByStripeId(stripeId), 1, 'no se debe crear una segunda fila');
  });

  it('reclama el placeholder con stripe_subscription_id NULL en vez de insertar', async () => {
    const userId = await createTestUser('upsert-placeholder');
    const stripeId = `sub_test_${SUFFIX}_c`;

    // Insertamos un placeholder pre-checkout (sin stripeSubscriptionId).
    const placeholder = await storage.createSubscription({
      userId, planType: 'solo', status: 'pending', stripeSubscriptionId: null,
    } as any);

    const sub = await storage.upsertSubscriptionByStripeId(stripeId, userId, {
      planType: 'solo', status: 'trialing',
    });

    assert.equal(sub.id, placeholder.id, 'debe reusar el placeholder, no crear uno nuevo');
    assert.equal(sub.stripeSubscriptionId, stripeId);
    assert.equal(await countSubsByStripeId(stripeId), 1);
  });
});

describe('storage.upsertSubscriptionByStripeId concurrency (Task #310)', () => {
  it('si dos upserts compiten por el mismo stripe_id, el segundo se resuelve como update (sin duplicado)', async () => {
    const userId = await createTestUser('upsert-race');
    const stripeId = `sub_test_${SUFFIX}_race`;

    const [a, b] = await Promise.all([
      storage.upsertSubscriptionByStripeId(stripeId, userId, { planType: 'solo', status: 'trialing' }),
      storage.upsertSubscriptionByStripeId(stripeId, userId, { planType: 'solo', status: 'active' }),
    ]);

    assert.ok(a.id);
    assert.ok(b.id);
    assert.equal(await countSubsByStripeId(stripeId), 1, 'la unique constraint debe colapsar el race a una sola fila');
  });
});

describe('WebhookHandlers.handleSubscriptionUpdated idempotencia (Task #310)', () => {
  it('dos eventos customer.subscription.updated consecutivos NO producen filas duplicadas', async () => {
    const userId = await createTestUser('webhook-double');
    const customerId = `cus_test_${SUFFIX}`;
    const stripeId = `sub_test_${SUFFIX}_webhook`;

    await db.update(users).set({ stripeCustomerId: customerId }).where(eq(users.id, userId));

    const event = {
      id: stripeId,
      customer: customerId,
      status: 'active',
      items: {
        data: [{ price: { id: 'price_test', product: 'prod_test' } }],
      },
      metadata: { planType: 'solo' },
    };

    await WebhookHandlers.handleSubscriptionUpdated(event);
    await WebhookHandlers.handleSubscriptionUpdated({ ...event, status: 'active' });

    const rows = await db.select().from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, stripeId));
    assert.equal(rows.length, 1, 'tiene que existir UNA sola fila para ese stripe_subscription_id');
    assert.equal(rows[0].status, 'active');
  });

  it('subscription.deleted actualiza la fila keyed por stripe_id, no la primera del usuario (multi-sub history)', async () => {
    const userId = await createTestUser('webhook-deleted-multi');
    const customerId = `cus_test_${SUFFIX}_del`;
    const oldStripeId = `sub_test_${SUFFIX}_old`;
    const newStripeId = `sub_test_${SUFFIX}_new`;

    await db.update(users).set({ stripeCustomerId: customerId, stripeSubscriptionId: newStripeId }).where(eq(users.id, userId));

    // Simulamos historial: una sub vieja ya cancelada + una nueva activa.
    // El handler debe actuar sobre la NUEVA si es la que Stripe está borrando,
    // sin volver a tocar la vieja.
    const oldSub = await storage.createSubscription({
      userId, planType: 'solo', status: 'cancelled', stripeSubscriptionId: oldStripeId,
    } as any);
    const newSub = await storage.createSubscription({
      userId, planType: 'solo', status: 'active', stripeSubscriptionId: newStripeId,
    } as any);

    // Confirmación directa del lookup (storage-level).
    const found = await storage.getSubscriptionByStripeId(newStripeId);
    assert.equal(found?.id, newSub.id, 'getSubscriptionByStripeId debe devolver la fila exacta del stripe_id');
    assert.notEqual(found?.id, oldSub.id);

    // Handler: la llamada a Stripe API va a fallar en el test env (sin key
    // válida) y caer en la rama de safety, que ahora usa getSubscriptionByStripeId.
    await WebhookHandlers.handleSubscriptionDeleted({
      id: newStripeId,
      customer: customerId,
      metadata: { planType: 'solo' },
    });

    const oldAfter = await db.select().from(subscriptions).where(eq(subscriptions.id, oldSub.id));
    const newAfter = await db.select().from(subscriptions).where(eq(subscriptions.id, newSub.id));
    assert.equal(newAfter[0].status, 'cancelled', 'la fila NUEVA debe quedar marcada como cancelled');
    assert.equal(oldAfter[0].status, 'cancelled', 'la fila vieja queda como estaba (ya estaba cancelled)');
    assert.equal(oldAfter[0].updatedAt.getTime(), oldSub.updatedAt.getTime(), 'la fila vieja NO debe haber sido tocada por este handler');
  });

  it('plan-change: si ambas filas (vieja y nueva) ya existen, no se genera conflicto unique y queda una sola fila por stripe_id', async () => {
    const userId = await createTestUser('webhook-plan-change');
    const customerId = `cus_test_${SUFFIX}_pc`;
    const oldStripeId = `sub_test_${SUFFIX}_pc_old`;
    const newStripeId = `sub_test_${SUFFIX}_pc_new`;

    await db.update(users).set({ stripeCustomerId: customerId, stripeSubscriptionId: oldStripeId }).where(eq(users.id, userId));

    // Setup: el usuario ya tiene la sub vieja Y la nueva en local.
    const oldSub = await storage.createSubscription({
      userId, planType: 'solo', status: 'active', stripeSubscriptionId: oldStripeId,
    } as any);
    const newSub = await storage.createSubscription({
      userId, planType: 'solo', status: 'active', stripeSubscriptionId: newStripeId,
    } as any);

    // El handler llama Stripe API → falla en test env → cae a safety
    // branch (que ahora también usa getSubscriptionByStripeId).
    await WebhookHandlers.handleSubscriptionDeleted({
      id: oldStripeId,
      customer: customerId,
      metadata: { planType: 'solo' },
    });

    const oldRows = await db.select().from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, oldStripeId));
    const newRows = await db.select().from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, newStripeId));
    assert.equal(oldRows.length, 1, 'exactamente UNA fila para el stripe_id viejo');
    assert.equal(newRows.length, 1, 'exactamente UNA fila para el stripe_id nuevo');
    assert.equal(oldRows[0].id, oldSub.id);
    assert.equal(newRows[0].id, newSub.id);
    assert.equal(oldRows[0].status, 'cancelled', 'la vieja queda cancelled');
  });

  it('si llega un evento con status distinto, actualiza la misma fila (no inserta)', async () => {
    const userId = await createTestUser('webhook-status-change');
    const customerId = `cus_test_${SUFFIX}_2`;
    const stripeId = `sub_test_${SUFFIX}_webhook2`;

    await db.update(users).set({ stripeCustomerId: customerId }).where(eq(users.id, userId));

    const baseEvent = {
      id: stripeId,
      customer: customerId,
      items: { data: [{ price: { id: 'price_test', product: 'prod_test' } }] },
      metadata: { planType: 'solo' },
    };

    await WebhookHandlers.handleSubscriptionUpdated({ ...baseEvent, status: 'trialing' });
    await WebhookHandlers.handleSubscriptionUpdated({ ...baseEvent, status: 'active' });
    await WebhookHandlers.handleSubscriptionUpdated({ ...baseEvent, status: 'past_due' });

    const rows = await db.select().from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, stripeId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'past_due');
  });
});
