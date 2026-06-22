import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Task #309 — Test de integración a nivel cron. Verifica que
// `runWeeklyDigestForAllUsers` saltea efectivamente a los usuarios con
// suscripción bloqueada y NO los pasa a `generateWeeklyDigestForUser`.
//
// Estrategia: monkey-patch a `storage.getAllUsers` para que devuelva sólo
// nuestros dos usuarios de prueba (uno active, uno cancelled). Los usuarios
// no tienen organizaciones, así que `generateWeeklyDigestForUser` retorna
// `{sent:false}` sin tocar SendGrid ni OpenAI — perfecto para verificar
// el filtro sin enviar mails reales.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run this test');
}

const { runWeeklyDigestForAllUsers } = await import('../server/services/weeklyDigest');
const { storage } = await import('../server/storage');
const { db } = await import('../server/db');
const { subscriptions, users } = await import('../shared/schema');
const { eq } = await import('drizzle-orm');

const SUFFIX = `cron_${process.pid}_${Date.now()}`;
const createdIds: string[] = [];
let originalGetAllUsers: typeof storage.getAllUsers;

async function createTestUser(label: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `test-task309-${label}-${SUFFIX}@aikestar.test`,
      name: `T309 ${label}`,
      password: 'no-login',
    } as any)
    .returning();
  createdIds.push(u.id);
  return u.id;
}

before(async () => {
  originalGetAllUsers = storage.getAllUsers.bind(storage);
});

after(async () => {
  // Restaurar antes que nada por si el test falló.
  storage.getAllUsers = originalGetAllUsers;
  for (const id of createdIds) {
    await db.delete(subscriptions).where(eq(subscriptions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('runWeeklyDigestForAllUsers (Task #309 cron-level)', () => {
  it('saltea usuarios cancelled y procesa usuarios active', async () => {
    const activeId = await createTestUser('cron-active');
    const cancelledId = await createTestUser('cron-cancelled');
    await db.insert(subscriptions).values({
      userId: activeId, planType: 'starter', status: 'active',
    } as any);
    await db.insert(subscriptions).values({
      userId: cancelledId, planType: 'starter', status: 'cancelled',
    } as any);

    // Sólo devolvemos los dos usuarios de prueba — así el cron no toca
    // ningún usuario real ni manda mails de verdad.
    const testUsers = await Promise.all([
      storage.getUser(activeId),
      storage.getUser(cancelledId),
    ]);
    storage.getAllUsers = async () => testUsers.filter(Boolean) as any;

    const result = await runWeeklyDigestForAllUsers();

    assert.equal(result.usersProcessed, 2, 'debería procesar los 2 test users');
    assert.equal(result.usersSkipped, 1, 'debería saltear al cancelled');
    assert.equal(result.skippedByReason.cancelled, 1, 'el motivo debe ser cancelled');
    // El active no tiene orgs, así que no se manda mail real, pero NO fue salteado.
    assert.equal(result.emailsSent, 0, 'no se mandan mails sin orgs');
    assert.equal(result.errors, 0, 'sin errores');
  });
});
