// Task #464 — Test del candado de conversación de WhatsApp con expiración
// automática (TTL). Reemplaza el test del viejo advisory lock de sesión.
//
// Verifica las garantías que el candado con TTL debe cumplir para que el bot
// NUNCA quede "tildado":
//   (a) serializa: con un candado vigente, un segundo mensaje no entra;
//       tras release(), el siguiente mensaje sí puede tomarlo.
//   (b) se auto-libera por TTL: si el handler NUNCA llama a release() (proceso
//       muerto / colgado), el candado vence solo y el próximo mensaje lo reclama.
//   (c) el heartbeat mantiene vivo un flujo legítimamente largo: mientras el
//       handler corre, el candado se renueva y no se reclama antes de tiempo.
//   (d) release limpio libera de inmediato.
//
// Corre en CI sin una base Postgres real: inyectamos un store en memoria
// (`__setWhatsappLockStoreForTesting`) que modela la semántica de TTL del store
// de producción (upsert que sólo gana si no hay candado vigente; extend/release
// sólo afectan al dueño del token).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// db.ts crea un Pool al importarse (no conecta hasta una query). Le damos una
// URL dummy para que el import no falle en CI sin DATABASE_URL. El test usa el
// store en memoria, así que nunca se abre una conexión real.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const { acquireWhatsappLock, __setWhatsappLockStoreForTesting } = await import('./conversation-state');
import type { WhatsappLockStore } from './conversation-state';

// ---------------------------------------------------------------------------
// Store en memoria que modela el candado con TTL de producción:
//  - una entrada por (org:user) con { token, lockedUntil }.
//  - acquire gana si no hay entrada o si la entrada venció (lockedUntil <= now);
//    'reclaimed' si pisó una entrada vencida, 'acquired' si entró limpio,
//    'busy' si hay un candado vigente.
//  - extend/release sólo aplican si el token coincide (dueño del candado).
// ---------------------------------------------------------------------------
class FakeLockStore implements WhatsappLockStore {
  private locks = new Map<string, { token: string; lockedUntil: number }>();

  private keyOf(org: string, user: string) {
    return `${org}:${user}`;
  }

  async acquire(org: string, user: string, token: string, ttlMs: number): Promise<'acquired' | 'reclaimed' | 'busy'> {
    const k = this.keyOf(org, user);
    const now = Date.now();
    const existing = this.locks.get(k);
    if (existing && existing.lockedUntil > now) {
      return 'busy';
    }
    const reclaimed = existing != null; // existía pero estaba vencido
    this.locks.set(k, { token, lockedUntil: now + ttlMs });
    return reclaimed ? 'reclaimed' : 'acquired';
  }

  async extend(org: string, user: string, token: string, ttlMs: number): Promise<void> {
    const k = this.keyOf(org, user);
    const existing = this.locks.get(k);
    if (existing && existing.token === token) {
      existing.lockedUntil = Date.now() + ttlMs;
    }
  }

  async release(org: string, user: string, token: string): Promise<void> {
    const k = this.keyOf(org, user);
    const existing = this.locks.get(k);
    if (existing && existing.token === token) {
      this.locks.delete(k);
    }
  }

  // Helpers de inspección para los tests.
  isHeld(org: string, user: string): boolean {
    const existing = this.locks.get(this.keyOf(org, user));
    return existing != null && existing.lockedUntil > Date.now();
  }
}

const USER = 'user-1';
const ORG = 'org-1';

test.afterEach(() => {
  __setWhatsappLockStoreForTesting(null);
});

test('(a) serializa: con candado vigente un segundo mensaje no entra; tras release el siguiente sí', async () => {
  const store = new FakeLockStore();
  __setWhatsappLockStoreForTesting(store);

  const h1 = await acquireWhatsappLock(USER, ORG, {
    maxAttempts: 1,
    lockTtlMs: 10_000,
    heartbeatIntervalMs: 1_000_000, // que el heartbeat no dispare durante el test
  });
  assert.ok(h1, 'debería obtener el candado la primera vez');
  assert.equal(store.isHeld(ORG, USER), true, 'el candado quedó tomado');

  // Mientras está tomado y vigente, un segundo intento (sin reintentos) no entra.
  const h2 = await acquireWhatsappLock(USER, ORG, {
    maxAttempts: 1,
    lockTtlMs: 10_000,
    heartbeatIntervalMs: 1_000_000,
  });
  assert.equal(h2, null, 'un segundo mensaje no debe entrar con el candado vigente');

  // Tras liberar, el siguiente mensaje puede tomarlo.
  await h1!.release();
  assert.equal(store.isHeld(ORG, USER), false, 'release limpio soltó el candado');

  const h3 = await acquireWhatsappLock(USER, ORG, {
    maxAttempts: 1,
    lockTtlMs: 10_000,
    heartbeatIntervalMs: 1_000_000,
  });
  assert.ok(h3, 'tras release, el siguiente mensaje debe poder tomar el candado');
  await h3!.release();
});

test('(b) se auto-libera por TTL: el handler nunca libera y el próximo mensaje lo reclama', async () => {
  const store = new FakeLockStore();
  __setWhatsappLockStoreForTesting(store);

  // TTL chico y heartbeat que NO dispara, para simular un handler que murió sin
  // renovar ni liberar: el candado debe vencer solo.
  const h1 = await acquireWhatsappLock(USER, ORG, {
    maxAttempts: 1,
    lockTtlMs: 40,
    heartbeatIntervalMs: 1_000_000,
  });
  assert.ok(h1, 'debería obtener el candado');
  assert.equal(store.isHeld(ORG, USER), true, 'el candado quedó tomado');

  // A propósito NO llamamos a h1.release(). Esperamos a que venza el TTL.
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(store.isHeld(ORG, USER), false, 'el candado debió vencer por TTL');

  // Un mensaje posterior lo reclama (no quedó tildado).
  const h2 = await acquireWhatsappLock(USER, ORG, {
    maxAttempts: 1,
    lockTtlMs: 40,
    heartbeatIntervalMs: 1_000_000,
  });
  assert.ok(h2, 'un mensaje posterior debe poder reclamar el candado vencido');
  await h2!.release();
});

test('(c) el heartbeat mantiene vivo un flujo largo: no se reclama mientras el handler corre', async () => {
  const store = new FakeLockStore();
  __setWhatsappLockStoreForTesting(store);

  // TTL chico pero heartbeat más rápido que el TTL: el candado debe seguir
  // tomado bastante después del TTL base porque el heartbeat lo renueva.
  const h1 = await acquireWhatsappLock(USER, ORG, {
    maxAttempts: 1,
    lockTtlMs: 50,
    heartbeatIntervalMs: 15,
    maxHoldMs: 10_000,
  });
  assert.ok(h1, 'debería obtener el candado');

  // Esperamos > 2x el TTL base. Sin heartbeat ya habría vencido.
  await new Promise((r) => setTimeout(r, 140));
  assert.equal(store.isHeld(ORG, USER), true, 'el heartbeat debió mantener vivo el candado');

  // Un intento concurrente (sin reintentos) sigue sin poder entrar.
  const h2 = await acquireWhatsappLock(USER, ORG, {
    maxAttempts: 1,
    lockTtlMs: 50,
    heartbeatIntervalMs: 15,
  });
  assert.equal(h2, null, 'no debe entrar mientras el candado se mantiene vivo');

  await h1!.release();
  assert.equal(store.isHeld(ORG, USER), false, 'tras release el candado queda libre');
});

test('(d) release limpio libera de inmediato', async () => {
  const store = new FakeLockStore();
  __setWhatsappLockStoreForTesting(store);

  const h1 = await acquireWhatsappLock(USER, ORG, {
    maxAttempts: 1,
    lockTtlMs: 10_000,
    heartbeatIntervalMs: 1_000_000,
  });
  assert.ok(h1);
  await h1!.release();
  assert.equal(store.isHeld(ORG, USER), false, 'el release limpio soltó el candado de inmediato');
});

test('reintenta y entra cuando el candado se libera entre intentos', async () => {
  const store = new FakeLockStore();
  __setWhatsappLockStoreForTesting(store);

  const h1 = await acquireWhatsappLock(USER, ORG, {
    maxAttempts: 1,
    lockTtlMs: 10_000,
    heartbeatIntervalMs: 1_000_000,
  });
  assert.ok(h1);

  // Lanzamos un acquire con reintentos mientras el candado está tomado; lo
  // liberamos en el medio y el acquire debe terminar entrando.
  const pending = acquireWhatsappLock(USER, ORG, {
    maxAttempts: 10,
    retryDelayMs: 20,
    lockTtlMs: 10_000,
    heartbeatIntervalMs: 1_000_000,
  });
  setTimeout(() => {
    void h1!.release();
  }, 50);

  const h2 = await pending;
  assert.ok(h2, 'el acquire con reintentos debe entrar tras liberarse el candado');
  await h2!.release();
});
