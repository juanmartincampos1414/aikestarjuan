import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Task #284 — Lock por (org, user) en la conversación de WhatsApp.
//
// Estos tests prueban que `acquireWhatsappLock` serializa el procesamiento
// de mensajes concurrentes del mismo usuario:
//
//   1) Dos llamadas simultáneas al lock no se pisan: la primera obtiene
//      el lock, la segunda obtiene `null` (porque usamos retries cortos
//      para que falle rápido en el test) o espera a que la primera lo
//      libere.
//   2) Bajo un escenario "race" — dos `updateConversation` simultáneos
//      envueltos cada uno en su propio lock — los slots quedan
//      consistentes con la última escritura (no se pierden campos
//      en medio).
//   3) Cuando el lock se libera, la siguiente acquire tiene éxito.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run this test');
}

const { db } = await import('../server/db');
const {
  users,
  organizations,
  whatsappConversations,
} = await import('../shared/schema');
const { eq, inArray } = await import('drizzle-orm');

const {
  acquireWhatsappLock,
  updateConversation,
  peekConversation,
  clearConversation,
} = await import('../server/conversation-state');
type TransactionSlots = import('../server/conversation-state').TransactionSlots;

const SUFFIX = `${process.pid}_${Date.now()}`;
const userId = `user-lock-${SUFFIX}`;
const orgId = `org-lock-${SUFFIX}`;

async function seed() {
  await db.insert(users).values({
    id: userId, email: `${userId}@test.local`, name: userId, password: 'x',
  }).onConflictDoNothing();
  await db.insert(organizations).values({ id: orgId, name: orgId }).onConflictDoNothing();
}

async function teardown() {
  await db.delete(whatsappConversations).where(eq(whatsappConversations.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(organizations).where(inArray(organizations.id, [orgId]));
}

describe('acquireWhatsappLock — exclusión mutua por (org, user)', () => {
  before(async () => {
    await seed();
    await clearConversation(userId, orgId);
  });
  after(teardown);

  it('una segunda adquisición concurrente con retries cortos devuelve null', async () => {
    const first = await acquireWhatsappLock(userId, orgId);
    assert.ok(first, 'el primer acquire debe obtener el lock');

    try {
      // Retries cortos: 3 intentos x 20ms = ~60ms, no llega a esperar
      // a que se libere. Debe devolver null porque el lock está tomado.
      const second = await acquireWhatsappLock(userId, orgId, {
        maxAttempts: 3,
        retryDelayMs: 20,
      });
      assert.equal(second, null, 'el segundo acquire concurrente debe ser null');
    } finally {
      await first!.release();
    }
  });

  it('tras liberar el lock, una nueva adquisición tiene éxito', async () => {
    const handle = await acquireWhatsappLock(userId, orgId, {
      maxAttempts: 3,
      retryDelayMs: 20,
    });
    assert.ok(handle, 'el acquire post-release debe tener éxito');
    await handle!.release();
  });

  it('release es idempotente (no rompe si se llama dos veces)', async () => {
    const handle = await acquireWhatsappLock(userId, orgId);
    assert.ok(handle);
    await handle!.release();
    await handle!.release(); // no debe tirar
  });

  it('locks sobre (org, user) distintos no se bloquean entre sí', async () => {
    // La key real combina organizationId+userId, así que dos requests
    // del mismo usuario en orgs distintas — o de dos usuarios distintos
    // en la misma org — pueden procesarse en paralelo.
    const otherOrgId = `${orgId}-other`;
    await db.insert(organizations).values({ id: otherOrgId, name: otherOrgId }).onConflictDoNothing();
    try {
      const a = await acquireWhatsappLock(userId, orgId);
      const b = await acquireWhatsappLock(userId, otherOrgId, {
        maxAttempts: 3,
        retryDelayMs: 20,
      });
      assert.ok(a, 'lock (user, orgA) obtenido');
      assert.ok(b, 'lock (user, orgB) debe obtenerse en paralelo (claves distintas)');
      await a!.release();
      await b!.release();
    } finally {
      await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    }
  });
});

describe('Race test — dos webhooks simultáneos no se pisan los slots', () => {
  before(async () => {
    await seed();
    await clearConversation(userId, orgId);
  });
  after(teardown);

  it('dos updates serializados por el lock dejan ambos slots consistentes', async () => {
    // Simulamos dos webhooks concurrentes del mismo (org, user). Cada uno
    // toma el lock, hace un `updateConversation` parcial, y lo libera. La
    // serialización del lock garantiza que ambos updates queden mergeados
    // en el row final, sin que el segundo "pise" al primero por leer un
    // estado base obsoleto.

    async function simulateWebhook(slotPatch: Partial<TransactionSlots>) {
      const lock = await acquireWhatsappLock(userId, orgId);
      assert.ok(lock, 'cada webhook debe terminar obteniendo el lock');
      try {
        // Pequeña espera dentro del crítico para forzar el solapamiento.
        await new Promise((r) => setTimeout(r, 30));
        await updateConversation(userId, orgId, {
          slots: slotPatch,
        });
      } finally {
        await lock!.release();
      }
    }

    await Promise.all([
      simulateWebhook({ type: 'expense', amount: 1500, currency: 'ARS' }),
      simulateWebhook({ description: 'Nafta', hasInvoice: true }),
    ]);

    const final = await peekConversation(userId, orgId);
    assert.ok(final, 'la conversación debe existir');
    // Ambos updates deben estar reflejados — esto sólo es cierto si se
    // serializaron. Sin el lock, el segundo update leería el row base
    // antes de que el primero commitee y pisaría sus campos.
    assert.equal(final!.slots.type, 'expense');
    assert.equal(final!.slots.amount, 1500);
    assert.equal(final!.slots.currency, 'ARS');
    assert.equal(final!.slots.description, 'Nafta');
    assert.equal(final!.slots.hasInvoice, true);
  });
});
