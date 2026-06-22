import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Task #282 — Tests de la persistencia Postgres del estado de WhatsApp.
// Estos tests complementan a `conversationStateActiveOrg.test.ts` y
// cubren explícitamente:
//   1) El row sobrevive entre módulos / "reinicios" lógicos.
//   2) El TTL de 30 minutos en lecturas: forzando `last_activity_at` al
//      pasado vía SQL directo, las helpers de lectura ignoran el row.
//   3) El cleanup borra físicamente los rows vencidos.

const { db } = await import('../server/db');
const {
  users,
  organizations,
  whatsappConversations,
} = await import('../shared/schema');
const { eq, and, inArray } = await import('drizzle-orm');
const { sql } = await import('drizzle-orm');

const {
  getOrCreateConversation,
  peekConversation,
  updateConversation,
  findActiveConversationOrgId,
  clearConversation,
  deleteExpiredConversations,
} = await import('../server/conversation-state');

const userId = 'user-persist-test';
const orgA = 'org-persist-test-a';
const orgB = 'org-persist-test-b';

async function seed() {
  await db.insert(users).values({
    id: userId, email: `${userId}@test.local`, name: userId, password: 'x',
  }).onConflictDoNothing();
  await db.insert(organizations).values({ id: orgA, name: orgA }).onConflictDoNothing();
  await db.insert(organizations).values({ id: orgB, name: orgB }).onConflictDoNothing();
}

async function teardown() {
  await db.delete(whatsappConversations).where(eq(whatsappConversations.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(organizations).where(inArray(organizations.id, [orgA, orgB]));
}

describe('Persistencia en Postgres — el estado sobrevive entre lecturas', () => {
  before(async () => {
    await seed();
    await clearConversation(userId, orgA);
    await clearConversation(userId, orgB);
  });
  after(teardown);

  it('un update queda persistido y se lee idéntico en la próxima query', async () => {
    await getOrCreateConversation(userId, orgA);
    await updateConversation(userId, orgA, {
      currentStep: 'confirm',
      slots: {
        type: 'expense',
        amount: 1500,
        currency: 'ARS',
        description: 'Nafta',
        hasInvoice: true,
        invoiceNumber: '0001-00012345',
      },
      suggestedAccounts: [{ id: 'acc-1', name: 'Caja' }],
      justCompletedTransaction: false,
    });

    // "Reinicio" lógico: la siguiente lectura es una query nueva contra DB.
    // Con el Map in-memory esto fallaba después de un deploy o entre réplicas.
    const read = await peekConversation(userId, orgA);
    assert.ok(read, 'la conversación debe existir tras el update');
    assert.equal(read!.currentStep, 'confirm');
    assert.equal(read!.slots.type, 'expense');
    assert.equal(read!.slots.amount, 1500);
    assert.equal(read!.slots.currency, 'ARS');
    assert.equal(read!.slots.description, 'Nafta');
    assert.equal(read!.slots.hasInvoice, true);
    assert.equal(read!.slots.invoiceNumber, '0001-00012345');
    assert.deepEqual(read!.suggestedAccounts, [{ id: 'acc-1', name: 'Caja' }]);
  });

  it('updates sucesivos mergean slots sin pisar campos previos', async () => {
    await clearConversation(userId, orgB);
    await updateConversation(userId, orgB, {
      slots: { type: 'income', amount: 5000, currency: 'ARS' },
    });
    await updateConversation(userId, orgB, {
      slots: { description: 'Honorarios' },
    });
    await updateConversation(userId, orgB, {
      slots: { hasInvoice: true },
    });

    const read = await peekConversation(userId, orgB);
    assert.equal(read!.slots.type, 'income');
    assert.equal(read!.slots.amount, 5000);
    assert.equal(read!.slots.description, 'Honorarios');
    assert.equal(read!.slots.hasInvoice, true);
  });
});

describe('TTL de 30 minutos — lecturas ignoran rows vencidos', () => {
  before(async () => {
    await seed();
    await clearConversation(userId, orgA);
  });
  after(teardown);

  it('peekConversation devuelve null si last_activity_at > 30 min atrás', async () => {
    await getOrCreateConversation(userId, orgA);
    await updateConversation(userId, orgA, { currentStep: 'amount' });

    // Sanity: existe y se lee.
    assert.ok(await peekConversation(userId, orgA));

    // Envejecemos el row server-side: ponemos last_activity_at 31 min atrás.
    await db.execute(sql`
      UPDATE whatsapp_conversations
      SET last_activity_at = NOW() - INTERVAL '31 minutes'
      WHERE user_id = ${userId} AND organization_id = ${orgA}
    `);

    assert.equal(await peekConversation(userId, orgA), null, 'TTL vencido: peek debe devolver null');
  });

  it('findActiveConversationOrgId ignora rows vencidos', async () => {
    // El row anterior sigue vencido. Confirmamos que no aparece.
    assert.equal(await findActiveConversationOrgId(userId), null);

    // Y si abrimos uno fresco, aparece de nuevo.
    await getOrCreateConversation(userId, orgA);
    await updateConversation(userId, orgA, { currentStep: 'amount' });
    assert.equal(await findActiveConversationOrgId(userId), orgA);
  });

  it('getOrCreateConversation pisa el row vencido con uno fresco', async () => {
    // Envejecemos el row.
    await db.execute(sql`
      UPDATE whatsapp_conversations
      SET last_activity_at = NOW() - INTERVAL '31 minutes',
          current_step = 'confirm'
      WHERE user_id = ${userId} AND organization_id = ${orgA}
    `);

    // getOrCreate ve TTL vencido y hace upsert con slots vacíos.
    const fresh = await getOrCreateConversation(userId, orgA);
    assert.equal(fresh.currentStep, 'type', 'el row fresco debe arrancar en "type"');
    assert.equal(fresh.slots.type, null);
    assert.equal(fresh.slots.amount, null);
  });
});

describe('Cleanup físico — deleteExpiredConversations borra rows vencidos', () => {
  before(async () => {
    await seed();
    await clearConversation(userId, orgA);
    await clearConversation(userId, orgB);
  });
  after(teardown);

  it('borra solo los rows con last_activity_at > 30 min atrás', async () => {
    // Uno vencido, uno fresco.
    await getOrCreateConversation(userId, orgA);
    await getOrCreateConversation(userId, orgB);
    await db.execute(sql`
      UPDATE whatsapp_conversations
      SET last_activity_at = NOW() - INTERVAL '31 minutes'
      WHERE user_id = ${userId} AND organization_id = ${orgA}
    `);

    const deleted = await deleteExpiredConversations();
    assert.ok(deleted >= 1, 'al menos el row vencido debe haberse borrado');

    // El fresco sigue ahí.
    const rows = await db
      .select()
      .from(whatsappConversations)
      .where(and(
        eq(whatsappConversations.userId, userId),
        eq(whatsappConversations.organizationId, orgB),
      ));
    assert.equal(rows.length, 1, 'el row fresco debe sobrevivir al cleanup');

    // El vencido no.
    const rowsA = await db
      .select()
      .from(whatsappConversations)
      .where(and(
        eq(whatsappConversations.userId, userId),
        eq(whatsappConversations.organizationId, orgA),
      ));
    assert.equal(rowsA.length, 0, 'el row vencido debe haber sido borrado');
  });
});
