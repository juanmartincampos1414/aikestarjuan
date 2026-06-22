// Task #505 — Tests de idempotencia del resumen semanal.
//
// La Task #504 agregó una guarda claim-first (tabla `weekly_digest_sends`,
// INSERT ... ON CONFLICT DO NOTHING) para que el mail del resumen semanal NUNCA
// llegue duplicado si el Scheduled Deployment se reintenta o corre dos veces.
//
// Estos tests verifican esa garantía sin una base Postgres real ni envíos de
// SendGrid de verdad: inyectamos dependencias con
// `__setWeeklyDigestDepsForTesting`. El claim store en memoria modela la
// semántica de la PK (user_id, week_start) + ON CONFLICT DO NOTHING (el segundo
// claim de la misma semana pierde). El "envío" es un spy que cuenta llamadas y
// puede simular fallo.
//
// Cobertura:
//   (1) enforceOnce:true — un segundo generateWeeklyDigestForUser para el mismo
//       (user, semana) NO reenvía: devuelve alreadySent:true y el email se
//       manda una sola vez.
//   (2) Si el envío falla, el claim se libera y un reintento posterior SÍ
//       reenvía (no queda bloqueado por un claim huérfano).
//   (3) El path del test admin (enforceOnce ausente/false) nunca queda
//       bloqueado: reenvía siempre y jamás toca el claim store.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startOfWeek, format } from 'date-fns';

// db.ts crea un Pool al importarse (no conecta hasta una query). Le damos una
// URL dummy para que el import no falle en CI sin DATABASE_URL. Los tests usan
// dependencias inyectadas, así que nunca se abre una conexión real.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const { generateWeeklyDigestForUser, getArgentinaWeekTrigger, runWeeklyDigestForAllUsers, __setWeeklyDigestDepsForTesting } = await import('./services/weeklyDigest');
import type { WeeklyDigestTestDeps } from './services/weeklyDigest';

// ---------------------------------------------------------------------------
// Claim store en memoria que modela `weekly_digest_sends`:
//  - claim(user, week) gana (true) solo si no existe la fila (user, week);
//    si ya existe devuelve false (= ON CONFLICT DO NOTHING no insertó nada).
//  - release(user, week) borra la fila para permitir un reintento.
// ---------------------------------------------------------------------------
class FakeClaimStore {
  private rows = new Set<string>();

  private keyOf(userId: string, weekStart: string) {
    return `${userId}::${weekStart}`;
  }

  async claim(userId: string, weekStart: string): Promise<boolean> {
    const k = this.keyOf(userId, weekStart);
    if (this.rows.has(k)) return false;
    this.rows.add(k);
    return true;
  }

  async release(userId: string, weekStart: string): Promise<void> {
    this.rows.delete(this.keyOf(userId, weekStart));
  }

  has(userId: string, weekStart: string): boolean {
    return this.rows.has(this.keyOf(userId, weekStart));
  }
}

const USER_ID = 'user-1';

// Datos mínimos para que la función llegue hasta el bloque de idempotencia
// (necesita al menos un usuario, una org y datos que produzcan orgsData).
function baseDeps(overrides: Partial<WeeklyDigestTestDeps> = {}): WeeklyDigestTestDeps {
  return {
    getUser: async () => ({ id: USER_ID, email: 'test@example.com', name: 'Test' }),
    getOrganizationsByUser: async () => [{ id: 'org-1', name: 'Org Uno' }],
    getAccountsByOrganization: async () => [
      { id: 'acc-1', balance: '1000', currency: 'ARS', accountCategory: 'operative' },
    ],
    getTransactionsByOrganization: async () => [],
    // No tocar OpenAI en los tests.
    generateAIAnalysis: async () => 'Análisis de prueba',
    ...overrides,
  };
}

afterEach(() => {
  __setWeeklyDigestDepsForTesting(null);
});

test('(1) enforceOnce:true — el segundo envío de la misma semana NO reenvía (alreadySent:true)', async () => {
  const store = new FakeClaimStore();
  let sendCount = 0;

  __setWeeklyDigestDepsForTesting(baseDeps({
    claimSend: (u, w) => store.claim(u, w),
    releaseSend: (u, w) => store.release(u, w),
    sendEmail: async () => {
      sendCount++;
      return true;
    },
  }));

  const first = await generateWeeklyDigestForUser(USER_ID, { enforceOnce: true });
  assert.equal(first.sent, true, 'el primer envío debe mandarse');
  assert.notEqual(first.alreadySent, true, 'el primero no está "ya enviado"');
  assert.equal(sendCount, 1, 'el email se mandó una vez');

  const second = await generateWeeklyDigestForUser(USER_ID, { enforceOnce: true });
  assert.equal(second.sent, false, 'el segundo NO debe enviar');
  assert.equal(second.alreadySent, true, 'el segundo reporta alreadySent:true');
  assert.equal(sendCount, 1, 'el email sigue habiéndose mandado UNA sola vez (sin duplicado)');
});

test('(2) si el envío falla, el claim se libera y un reintento posterior SÍ reenvía', async () => {
  const store = new FakeClaimStore();
  let sendCount = 0;
  let shouldFail = true;

  __setWeeklyDigestDepsForTesting(baseDeps({
    claimSend: (u, w) => store.claim(u, w),
    releaseSend: (u, w) => store.release(u, w),
    sendEmail: async () => {
      sendCount++;
      return !shouldFail;
    },
  }));

  const failed = await generateWeeklyDigestForUser(USER_ID, { enforceOnce: true });
  assert.equal(failed.sent, false, 'el primer intento falla el envío');
  assert.notEqual(failed.alreadySent, true, 'no es un duplicado, es un fallo de envío');
  assert.equal(sendCount, 1, 'se intentó enviar una vez');

  // Tras un fallo, el claim debe haberse liberado para no dejar al usuario sin
  // su resumen para siempre.
  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  const weekStartStr = format(weekStart, 'yyyy-MM-dd');
  assert.equal(store.has(USER_ID, weekStartStr), false, 'el claim quedó liberado tras el fallo');

  // El reintento ahora sí logra enviar.
  shouldFail = false;
  const retry = await generateWeeklyDigestForUser(USER_ID, { enforceOnce: true });
  assert.equal(retry.sent, true, 'el reintento debe reenviar correctamente');
  assert.equal(sendCount, 2, 'se intentó enviar de nuevo (segundo intento)');
  assert.equal(store.has(USER_ID, weekStartStr), true, 'tras el éxito el claim queda tomado');
});

test('(3) path admin (enforceOnce ausente/false) nunca queda bloqueado y no toca el claim store', async () => {
  const store = new FakeClaimStore();
  let sendCount = 0;
  let claimCalls = 0;

  __setWeeklyDigestDepsForTesting(baseDeps({
    claimSend: (u, w) => {
      claimCalls++;
      return store.claim(u, w);
    },
    releaseSend: (u, w) => store.release(u, w),
    sendEmail: async () => {
      sendCount++;
      return true;
    },
  }));

  // Sin enforceOnce (admin "probando").
  const a = await generateWeeklyDigestForUser(USER_ID);
  assert.equal(a.sent, true, 'admin envía sin enforceOnce');
  assert.notEqual(a.alreadySent, true);

  // enforceOnce:false explícito.
  const b = await generateWeeklyDigestForUser(USER_ID, { enforceOnce: false });
  assert.equal(b.sent, true, 'admin reenvía con enforceOnce:false');
  assert.notEqual(b.alreadySent, true);

  // Tercera vez, sigue sin bloquearse.
  const c = await generateWeeklyDigestForUser(USER_ID, { enforceOnce: false });
  assert.equal(c.sent, true, 'sigue reenviando, nunca queda bloqueado');

  assert.equal(sendCount, 3, 'el path admin envía las 3 veces');
  assert.equal(claimCalls, 0, 'el path admin nunca llama al claim store');
});

// ---------------------------------------------------------------------------
// Task #506 — Gate temporal del trigger "al despertar".
//
// getArgentinaWeekTrigger debe calcular la clave de semana Y el chequeo horario
// en hora de Argentina (UTC-3, sin DST), nunca en UTC. El caso peligroso es la
// ventana domingo 21:00–23:59 ART, que en UTC ya es lunes: un cálculo naïf con
// startOfWeek(UTC) saltaría a la semana siguiente y mandaría el resumen hasta
// 9 h antes de tiempo. Acá fijamos instantes UTC concretos (ART = UTC-3).
// ---------------------------------------------------------------------------

test('(4) lunes 06:00 ART => due, weekKey = lunes de esa semana', () => {
  // 2026-06-15 09:00 UTC = lunes 06:00 ART.
  const r = getArgentinaWeekTrigger(new Date('2026-06-15T09:00:00Z'));
  assert.equal(r.isDue, true, 'a las 06:00 ART del lunes ya corresponde enviar');
  assert.equal(r.weekKey, '2026-06-15', 'la semana es la del propio lunes');
});

test('(5) lunes 05:59 ART => NO due todavía (falta la hora del envío)', () => {
  // 2026-06-15 08:59 UTC = lunes 05:59 ART.
  const r = getArgentinaWeekTrigger(new Date('2026-06-15T08:59:00Z'));
  assert.equal(r.isDue, false, 'antes de las 06:00 ART del lunes no se envía');
  assert.equal(r.weekKey, '2026-06-15', 'la clave ya es la de ese lunes');
});

test('(6) domingo 23:00 ART (= lunes UTC) NO adelanta la semana ni dispara temprano', () => {
  // 2026-06-15 02:00 UTC = domingo 2026-06-14 23:00 ART. En UTC es lunes, pero
  // en ART todavía es domingo: la clave debe ser el lunes ANTERIOR (2026-06-08),
  // no el 2026-06-15. isDue es true (ya pasó el lunes 6 AM de ESA semana), pero
  // como esa semana ya se completó el lunes pasado, lastCompletedWeekKey la frena.
  const r = getArgentinaWeekTrigger(new Date('2026-06-15T02:00:00Z'));
  assert.equal(r.weekKey, '2026-06-08', 'domingo noche ART pertenece a la semana que empezó el 2026-06-08');
  assert.notEqual(r.weekKey, '2026-06-15', 'NO debe adelantarse a la semana siguiente (bug de UTC)');
  assert.equal(r.isDue, true);
});

test('(7) sábado a media semana => due, weekKey = lunes de la misma semana', () => {
  // 2026-06-13 18:00 UTC = sábado 15:00 ART. Si el lunes no se mandó, igual sale.
  const r = getArgentinaWeekTrigger(new Date('2026-06-13T18:00:00Z'));
  assert.equal(r.isDue, true);
  assert.equal(r.weekKey, '2026-06-08', 'el sábado pertenece a la semana que empezó el 2026-06-08');
});

test('(8) consistencia: el claim usa EXACTAMENTE el weekStartKey ART pasado (no startOfWeek UTC)', async () => {
  // El runner pasa weekStartKey (= weekKey ART) para que la idempotencia por
  // usuario use la MISMA semana que el wake trigger. Acá pasamos una clave ART
  // arbitraria y verificamos que el claim store quede tomado bajo ESA clave, sin
  // importar en qué semana caiga "hoy" (UTC). Esto cierra el bug de borde donde
  // domingo noche ART = lunes UTC haría divergir la clave del claim de la del trigger.
  const store = new FakeClaimStore();
  let sendCount = 0;
  const ART_WEEK_KEY = '2026-06-08';

  __setWeeklyDigestDepsForTesting(baseDeps({
    claimSend: (u, w) => store.claim(u, w),
    releaseSend: (u, w) => store.release(u, w),
    hasSend: (u, w) => Promise.resolve(store.has(u, w)),
    sendEmail: async () => {
      sendCount++;
      return true;
    },
  }));

  const r = await generateWeeklyDigestForUser(USER_ID, { enforceOnce: true, weekStartKey: ART_WEEK_KEY });
  assert.equal(r.sent, true, 'envía la primera vez');
  assert.equal(sendCount, 1);
  assert.equal(store.has(USER_ID, ART_WEEK_KEY), true, 'el claim quedó tomado bajo la clave ART pasada');

  // Un segundo intento con la misma clave ART NO reenvía (dedup por esa clave).
  const r2 = await generateWeeklyDigestForUser(USER_ID, { enforceOnce: true, weekStartKey: ART_WEEK_KEY });
  assert.equal(r2.alreadySent, true, 'el segundo intento detecta el claim por la clave ART');
  assert.equal(sendCount, 1, 'no se reenvía');
});

// ---------------------------------------------------------------------------
// Task #507 — Un email fallido NO bloquea el resumen del resto de la semana.
//
// El trigger "al despertar" (maybeRunWeeklyDigestOnWake) solo sella la semana
// (lastCompletedWeekKey) cuando runWeeklyDigestForAllUsers devuelve errors===0.
// Un envío fallido cuenta como error, de modo que el lote NO se sella y el
// próximo despertar reintenta a ese usuario (la idempotencia por usuario evita
// reenviar a los que sí salieron). Estos tests cubren el LOTE COMPLETO usando el
// seam de testing (getAllUsers + isEligible inyectables), que antes no existía.
// ---------------------------------------------------------------------------

// Deps de lote: lista de usuarios inyectada, todos elegibles, claim store en
// memoria y datos mínimos por org. El sendEmail por defecto siempre devuelve
// true; cada test lo sobreescribe para simular fallos selectivos.
function batchDeps(
  users: Array<{ id: string; email: string }>,
  store: FakeClaimStore,
): WeeklyDigestTestDeps {
  return {
    getAllUsers: async () => users,
    isEligible: async () => ({ eligible: true, reason: 'eligible' as any }),
    getUser: async (id: string) => {
      const u = users.find((x) => x.id === id);
      return u ? { id: u.id, email: u.email, name: u.email } : null;
    },
    getOrganizationsByUser: async (id: string) => [{ id: `org-${id}`, name: `Org ${id}` }],
    getAccountsByOrganization: async () => [
      { id: 'acc-1', balance: '1000', currency: 'ARS', accountCategory: 'operative' },
    ],
    getTransactionsByOrganization: async () => [],
    generateAIAnalysis: async () => 'Análisis de prueba',
    claimSend: (u, w) => store.claim(u, w),
    releaseSend: (u, w) => store.release(u, w),
    hasSend: (u, w) => Promise.resolve(store.has(u, w)),
    sendEmail: async () => true, // sobreescrito abajo por userId; ver wrapper
  };
}

test('(9) un envío fallido en el lote deja errors>0 (NO sella la semana) y el resto SÍ sale', async () => {
  const store = new FakeClaimStore();
  const users = [
    { id: 'u-ok-1', email: 'ok1@example.com' },
    { id: 'u-fail', email: 'fail@example.com' },
    { id: 'u-ok-2', email: 'ok2@example.com' },
  ];
  const sent: string[] = [];

  // sendEmail no conoce el userId directamente, así que mapeamos por email:
  // el segundo usuario (fail@) falla, los otros dos salen bien.
  const emailToUser = new Map(users.map((u) => [u.email, u.id]));
  const deps = batchDeps(users, store);
  deps.sendEmail = async (email: string) => {
    const uid = emailToUser.get(email);
    if (uid === 'u-fail') return false; // este envío falla
    if (uid) sent.push(uid);
    return true;
  };

  __setWeeklyDigestDepsForTesting(deps);

  const result = await runWeeklyDigestForAllUsers();

  assert.ok(result.errors > 0, 'al menos un envío fallido debe contar como error');
  assert.equal(result.errors, 1, 'exactamente un usuario falló');
  assert.equal(result.emailsSent, 2, 'los otros dos usuarios SÍ recibieron su resumen');
  assert.deepEqual(sent.sort(), ['u-ok-1', 'u-ok-2'], 'el fallo de uno no bloqueó a los demás');
  assert.equal(result.usersProcessed, 3);
});

test('(10) con todos los envíos OK, errors===0 (el wake trigger puede sellar la semana)', async () => {
  const store = new FakeClaimStore();
  const users = [
    { id: 'a', email: 'a@example.com' },
    { id: 'b', email: 'b@example.com' },
    { id: 'c', email: 'c@example.com' },
  ];
  let sendCount = 0;

  const deps = batchDeps(users, store);
  deps.sendEmail = async () => {
    sendCount++;
    return true;
  };

  __setWeeklyDigestDepsForTesting(deps);

  const result = await runWeeklyDigestForAllUsers();

  assert.equal(result.errors, 0, 'sin fallos, errors debe ser 0');
  assert.equal(result.emailsSent, 3, 'los tres usuarios recibieron su resumen');
  assert.equal(sendCount, 3, 'se intentó enviar a los tres');
  assert.equal(result.usersProcessed, 3);
});
