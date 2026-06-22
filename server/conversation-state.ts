import type { Account } from '@shared/schema';
import {
  whatsappConversations,
  type WhatsappTransactionSlots,
  type WhatsappCurrentStep,
  type WhatsappPausedFlow,
  type WhatsappAccountRef,
  type WhatsappMessage,
  type WhatsappSlotSource,
  type WhatsappConversationRow,
} from '@shared/schema';
import { db } from './db';
import { and, eq, gt, sql, desc, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { reportWhatsappLockForceRelease } from './services/errorAlerts';

// Task #282 — Persistencia del estado de la conversación de WhatsApp.
// Antes vivía en un Map in-memory module-level. Eso fallaba en dos escenarios
// muy reales: (1) cualquier reinicio/deploy borraba el flujo, así que un "sí"
// post-deploy quedaba mudo (que es exactamente el bug reportado en prod);
// (2) Autoscale con múltiples réplicas, donde cada réplica tiene su propio
// Map: un "1" caía en la réplica A y un "sí" en la B sin contexto.
//
// Ahora se persiste en la tabla `whatsapp_conversations` (PK
// organization_id+user_id). El TTL de 30 minutos se aplica filtrando por
// last_activity_at en cada lectura. Last-write-wins en updates concurrentes:
// no metemos locking distribuido en esta tarea porque el caso real es un
// solo usuario respondiendo en serie a sus propios mensajes.
//
// Las firmas pasaron a async/await — todos los call-sites en
// server/routes/whatsapp.ts fueron actualizados en consecuencia.

// Re-exports: los call-sites importan los tipos desde acá.
export type SlotSource = WhatsappSlotSource;
export type TransactionSlots = WhatsappTransactionSlots;
export type PausedFlow = WhatsappPausedFlow;

export interface ConversationState {
  userId: string;
  organizationId: string;
  slots: TransactionSlots;
  currentStep: WhatsappCurrentStep;
  messages: WhatsappMessage[];
  suggestedAccounts: WhatsappAccountRef[] | null;
  availableCategories: WhatsappAccountRef[] | null;
  createdAt: Date;
  lastActivityAt: Date;
  justCompletedTransaction: boolean;
  pausedFlow: PausedFlow | null;
  waitingForContinueDecision: boolean;
}

// Única fuente de verdad del TTL de la conversación. Si esto cambia, cambian
// las lecturas y el cleanup automáticamente (ver `ttlPredicate` y
// `deleteExpiredConversations`). Mantiene en el código de aplicación el
// número de minutos; el SQL deriva de acá.
export const CONVERSATION_TTL_MS = 30 * 60 * 1000;
const CONVERSATION_TTL_MINUTES = CONVERSATION_TTL_MS / 60 / 1000;
const ttlCutoff = sql<Date>`NOW() - (${CONVERSATION_TTL_MINUTES} || ' minutes')::interval`;

// Predicado SQL tipado para el TTL. Se reutiliza en lecturas y en cleanup.
// Usamos `>=` para que un row con last_activity_at exactamente en el borde
// del TTL siga considerándose vigente — esto matchea la semántica original
// del Map in-memory (`now - lastActivityAt < TTL`, no `<=`).
function ttlPredicate(): SQL {
  return gt(whatsappConversations.lastActivityAt, ttlCutoff);
}

function emptySlots(): TransactionSlots {
  return {
    type: null,
    amount: null,
    currency: null,
    accountId: null,
    accountName: null,
    description: null,
    category: null,
    hasInvoice: null,
    invoiceType: null,
    invoiceNumber: null,
    invoiceTaxId: null,
    invoiceFileUrl: null,
    date: null,
    allowNegativeBalance: null,
    lastNegativeWarning: null,
    accountSource: null,
    categorySource: null,
    invoiceSource: null,
    clientId: null,
    clientName: null,
    supplierId: null,
    supplierName: null,
  };
}

// La fila de DB ya viene tipada por el `.$type<>()` del schema, así que el
// mapeo a ConversationState es directo. Mergeamos `slots` con `emptySlots()`
// solo defensivamente, por si una migración futura agrega campos nuevos a
// `TransactionSlots` y aún hay rows viejos en producción.
function rowToState(row: WhatsappConversationRow): ConversationState {
  return {
    userId: row.userId,
    organizationId: row.organizationId,
    slots: { ...emptySlots(), ...row.slots },
    currentStep: row.currentStep,
    messages: row.messages ?? [],
    suggestedAccounts: row.suggestedAccounts ?? null,
    availableCategories: row.availableCategories ?? null,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    justCompletedTransaction: row.justCompletedTransaction,
    pausedFlow: row.pausedFlow ?? null,
    waitingForContinueDecision: row.waitingForContinueDecision,
  };
}

// Lee la conversación sin tocarla. Devuelve null si no existe o si está
// expirada por TTL. Se usa solo para inspeccionar antes de decidir.
export async function peekConversation(userId: string, organizationId: string): Promise<ConversationState | null> {
  const rows = await db
    .select()
    .from(whatsappConversations)
    .where(
      and(
        eq(whatsappConversations.userId, userId),
        eq(whatsappConversations.organizationId, organizationId),
        ttlPredicate(),
      ),
    )
    .limit(1);

  return rows.length > 0 ? rowToState(rows[0]) : null;
}

// Equivalente al getOrCreate del Map: si existe y no expiró, devuelve el
// estado; si no, inserta un row fresco con slots vacíos. Atomic via ON
// CONFLICT — last-write-wins en caso de carrera, pero el row resultante es
// siempre uno solo por PK.
export async function getOrCreateConversation(userId: string, organizationId: string): Promise<ConversationState> {
  const existing = await peekConversation(userId, organizationId);
  if (existing) return existing;

  const slots = emptySlots();
  // Si había un row vencido por TTL, lo pisamos. Si no había, insertamos.
  const inserted = await db
    .insert(whatsappConversations)
    .values({
      userId,
      organizationId,
      currentStep: 'type',
      slots,
      messages: [],
      suggestedAccounts: null,
      availableCategories: null,
      pausedFlow: null,
      justCompletedTransaction: false,
      waitingForContinueDecision: false,
    })
    .onConflictDoUpdate({
      target: [whatsappConversations.organizationId, whatsappConversations.userId],
      set: {
        currentStep: 'type',
        slots,
        messages: [],
        suggestedAccounts: null,
        availableCategories: null,
        pausedFlow: null,
        justCompletedTransaction: false,
        waitingForContinueDecision: false,
        createdAt: sql<Date>`NOW()`,
        lastActivityAt: sql<Date>`NOW()`,
      },
    })
    .returning();

  return rowToState(inserted[0]);
}

// Merge sobre el row existente (o crea uno nuevo si no existía). `slots`
// se mergea campo a campo igual que la versión in-memory. Cada update
// refresca last_activity_at, lo que extiende el TTL.
export async function updateConversation(
  userId: string,
  organizationId: string,
  updates: Partial<Omit<ConversationState, 'slots'>> & { slots?: Partial<TransactionSlots> },
): Promise<ConversationState> {
  const current = await getOrCreateConversation(userId, organizationId);

  const mergedSlots: TransactionSlots = updates.slots
    ? { ...current.slots, ...updates.slots }
    : current.slots;

  const nextStep: WhatsappCurrentStep = updates.currentStep ?? current.currentStep;
  const nextMessages: WhatsappMessage[] = updates.messages ?? current.messages;
  const nextSuggested: WhatsappAccountRef[] | null = updates.suggestedAccounts !== undefined ? updates.suggestedAccounts : current.suggestedAccounts;
  const nextCategories: WhatsappAccountRef[] | null = updates.availableCategories !== undefined ? updates.availableCategories : current.availableCategories;
  const nextPaused: PausedFlow | null = updates.pausedFlow !== undefined ? updates.pausedFlow : current.pausedFlow;
  const nextJustCompleted = updates.justCompletedTransaction !== undefined ? updates.justCompletedTransaction : current.justCompletedTransaction;
  const nextWaiting = updates.waitingForContinueDecision !== undefined ? updates.waitingForContinueDecision : current.waitingForContinueDecision;

  const updated = await db
    .update(whatsappConversations)
    .set({
      currentStep: nextStep,
      slots: mergedSlots,
      messages: nextMessages,
      suggestedAccounts: nextSuggested,
      availableCategories: nextCategories,
      pausedFlow: nextPaused,
      justCompletedTransaction: nextJustCompleted,
      waitingForContinueDecision: nextWaiting,
      lastActivityAt: sql<Date>`NOW()`,
    })
    .where(
      and(
        eq(whatsappConversations.userId, userId),
        eq(whatsappConversations.organizationId, organizationId),
      ),
    )
    .returning();

  if (updated.length === 0) {
    // Caso raro: el row fue borrado entre el getOrCreate y el update
    // (puede pasar bajo Autoscale multi-réplica si dos webhooks llegan
    // casi simultáneos). Reintentamos como upsert idempotente para
    // evitar unique-violation si otra réplica ya recreó el row.
    const reseeded = await db
      .insert(whatsappConversations)
      .values({
        userId,
        organizationId,
        currentStep: nextStep,
        slots: mergedSlots,
        messages: nextMessages,
        suggestedAccounts: nextSuggested,
        availableCategories: nextCategories,
        pausedFlow: nextPaused,
        justCompletedTransaction: nextJustCompleted,
        waitingForContinueDecision: nextWaiting,
      })
      .onConflictDoUpdate({
        target: [whatsappConversations.organizationId, whatsappConversations.userId],
        set: {
          currentStep: nextStep,
          slots: mergedSlots,
          messages: nextMessages,
          suggestedAccounts: nextSuggested,
          availableCategories: nextCategories,
          pausedFlow: nextPaused,
          justCompletedTransaction: nextJustCompleted,
          waitingForContinueDecision: nextWaiting,
          lastActivityAt: sql<Date>`NOW()`,
        },
      })
      .returning();
    return rowToState(reseeded[0]);
  }

  return rowToState(updated[0]);
}

// "Reset" = borrar y recrear con slots vacíos. La firma original devolvía
// el nuevo estado, mantenemos la semántica.
export async function resetConversation(userId: string, organizationId: string): Promise<ConversationState> {
  await db
    .delete(whatsappConversations)
    .where(
      and(
        eq(whatsappConversations.userId, userId),
        eq(whatsappConversations.organizationId, organizationId),
      ),
    );
  return getOrCreateConversation(userId, organizationId);
}

// Borra la conversación sin recrearla. Útil cuando el usuario completó el
// flujo y no queremos que `findActiveConversationOrgId` la siga viendo
// como activa, o cuando cambiamos de org explícitamente.
export async function clearConversation(userId: string, organizationId: string): Promise<void> {
  await db
    .delete(whatsappConversations)
    .where(
      and(
        eq(whatsappConversations.userId, userId),
        eq(whatsappConversations.organizationId, organizationId),
      ),
    );
}

// Task #464 — Candado por (org, user) con EXPIRACIÓN AUTOMÁTICA (TTL).
//
// Reemplaza al advisory lock de sesión (Task #284/#458). El problema en
// producción: el advisory lock de sesión se tomaba sobre una conexión del
// endpoint *pooled* de Neon. Destruir esa conexión del lado del cliente NO
// terminaba la sesión backend que retenía el lock, así que el candado quedaba
// tomado por minutos (bot "tildado", loop "todavía estoy procesando tu mensaje
// anterior") aunque el movimiento ya se hubiera cargado bien.
//
// La solución: una fila por (organization_id, user_id) en `whatsapp_locks` con
// un vencimiento (`locked_until`) y un token de propietario. El candado se
// auto-libera por tiempo SIN depender de que ninguna conexión siga viva:
//   - Adquirir = upsert atómico que sólo gana si no hay candado vigente
//     (INSERT ... ON CONFLICT DO UPDATE ... WHERE locked_until < NOW()).
//   - Mientras el handler corre, un "heartbeat" extiende `locked_until` para
//     que un flujo legítimamente largo (foto + visión, audio) no se reclame.
//     El heartbeat deja de renovar pasado `maxHoldMs` para que un handler
//     COLGADO igual termine venciendo y el bot no quede trabado.
//   - Liberar = DELETE de la fila (sólo si el token coincide). Si el DELETE
//     falla (conexión inestable), la fila vence sola por TTL.
// Todo corre sobre el pool principal `db`: son queries triviales (un upsert /
// un delete por mensaje), así que no hay riesgo de pool-starvation como con el
// advisory lock de sesión, que retenía una conexión durante todo el handler.

export interface WhatsappLockHandle {
  release(): Promise<void>;
}

export interface AcquireWhatsappLockOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  // Vida del candado en la base. Si nadie lo renueva (proceso muerto) ni lo
  // libera, vence pasado este tiempo y el próximo mensaje lo reclama.
  lockTtlMs?: number;
  // Cada cuánto el heartbeat extiende `locked_until` mientras el handler vive.
  heartbeatIntervalMs?: number;
  // Tope duro de retención: pasado este tiempo el heartbeat DEJA de renovar, así
  // un handler colgado igual vence por TTL en vez de quedar tomado para siempre.
  maxHoldMs?: number;
  // Timeout de cada query del candado (acquire/release). Evita que un acquire o
  // release contra una conexión muerta cuelgue al handler del bot.
  queryTimeoutMs?: number;
}

type AcquireResult = 'acquired' | 'reclaimed' | 'busy';

// Operaciones del candado contra la base. Se extrae como "store" para poder
// inyectar una implementación en memoria en los tests (ver
// `__setWhatsappLockStoreForTesting`) y verificar la semántica de TTL,
// heartbeat y release sin depender de una base Postgres real.
export interface WhatsappLockStore {
  acquire(organizationId: string, userId: string, token: string, ttlMs: number): Promise<AcquireResult>;
  extend(organizationId: string, userId: string, token: string, ttlMs: number): Promise<void>;
  release(organizationId: string, userId: string, token: string): Promise<void>;
}

// Store de producción: upsert/delete sobre la tabla `whatsapp_locks` vía `db`.
const dbLockStore: WhatsappLockStore = {
  async acquire(organizationId, userId, token, ttlMs) {
    // El upsert gana (RETURNING devuelve fila) sólo si: no existía candado
    // (INSERT) o el existente ya venció (DO UPDATE con WHERE locked_until<NOW()).
    // Si hay un candado vigente, el WHERE no matchea, no se afecta ninguna fila
    // y RETURNING viene vacío => 'busy'. `(xmax <> 0)` distingue UPDATE (reclamo
    // de un candado vencido = el handler previo no liberó) de INSERT (alta limpia).
    const res = await db.execute(sql`
      INSERT INTO whatsapp_locks (organization_id, user_id, locked_until, lock_token)
      VALUES (
        ${organizationId},
        ${userId},
        NOW() + (${ttlMs}::double precision * interval '1 millisecond'),
        ${token}
      )
      ON CONFLICT (organization_id, user_id) DO UPDATE
        SET locked_until = EXCLUDED.locked_until,
            lock_token = EXCLUDED.lock_token
        WHERE whatsapp_locks.locked_until < NOW()
      RETURNING (xmax <> 0) AS reclaimed
    `);
    const rows = (res as unknown as { rows: Array<{ reclaimed: boolean }> }).rows;
    if (!rows || rows.length === 0) return 'busy';
    return rows[0].reclaimed ? 'reclaimed' : 'acquired';
  },
  async extend(organizationId, userId, token, ttlMs) {
    await db.execute(sql`
      UPDATE whatsapp_locks
      SET locked_until = NOW() + (${ttlMs}::double precision * interval '1 millisecond')
      WHERE organization_id = ${organizationId}
        AND user_id = ${userId}
        AND lock_token = ${token}
    `);
  },
  async release(organizationId, userId, token) {
    await db.execute(sql`
      DELETE FROM whatsapp_locks
      WHERE organization_id = ${organizationId}
        AND user_id = ${userId}
        AND lock_token = ${token}
    `);
  },
};

let lockStoreOverride: WhatsappLockStore | null = null;

// Test seam: inyecta un store en memoria. En producción nunca se setea.
export function __setWhatsappLockStoreForTesting(store: WhatsappLockStore | null): void {
  lockStoreOverride = store;
}

function getLockStore(): WhatsappLockStore {
  return lockStoreOverride ?? dbLockStore;
}

// Corre una promesa con un tope de tiempo. Si vence, rechaza; la query subyacente
// puede seguir su curso, pero el handler del bot no queda colgado esperándola.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
    timer.unref?.();
  });
  return Promise.race([
    p.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timeout,
  ]);
}

export async function acquireWhatsappLock(
  userId: string,
  organizationId: string,
  opts: AcquireWhatsappLockOptions = {},
): Promise<WhatsappLockHandle | null> {
  const maxAttempts = opts.maxAttempts ?? 25;
  const retryDelayMs = opts.retryDelayMs ?? 200;
  const lockTtlMs = opts.lockTtlMs ?? 30_000;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 10_000;
  const maxHoldMs = opts.maxHoldMs ?? 90_000;
  const queryTimeoutMs = opts.queryTimeoutMs ?? 5_000;
  // Clave sólo para logging/alertas (la PK real es (org, user)). Trade-off
  // conocido (igual que Task #284): si el handler cambia `effectiveOrgId`
  // mid-flow, el candado acompaña a la org inicial. Es aceptable porque los
  // cambios de org mid-mensaje son raros y priorizar serialización por org
  // evita bloquear mensajes legítimos de otra org del mismo dueño.
  const key = `${organizationId}:${userId}`;
  const store = getLockStore();
  const token = randomUUID();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let result: AcquireResult;
    try {
      result = await withTimeout(
        store.acquire(organizationId, userId, token, lockTtlMs),
        queryTimeoutMs,
        'whatsapp lock acquire timeout',
      );
    } catch (err) {
      // Acquire falló/expiró (conexión inestable): lo tratamos como ocupado.
      // El handler responde suave pidiendo reintentar y no queda colgado.
      console.error('[WhatsApp Lock] acquire falló o expiró:', err);
      return null;
    }

    if (result !== 'busy') {
      if (result === 'reclaimed') {
        // El candado anterior estaba vencido: el handler previo no lo liberó
        // (murió o se colgó). Lo reportamos al panel/alertas (Task #459) como la
        // contraparte TTL de las viejas liberaciones forzadas.
        reportWhatsappLockForceRelease({
          kind: 'ttl_reclaim',
          reason: 'candado anterior vencido por TTL; reclamado por un nuevo mensaje',
          key,
          organizationId,
          userId,
          holdMs: lockTtlMs,
        });
      }

      let released = false;
      const startedAt = Date.now();
      let heartbeat: ReturnType<typeof setInterval> | null = setInterval(() => {
        if (released) return;
        if (Date.now() - startedAt >= maxHoldMs) {
          // Tope de retención alcanzado: dejamos de renovar. Si el handler está
          // colgado, el candado vence por TTL y el próximo mensaje lo reclama.
          console.error(
            `[WhatsApp Lock] candado retenido > ${maxHoldMs}ms para key=${key}; dejo de renovarlo para que expire por TTL.`,
          );
          if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
          }
          return;
        }
        void store
          .extend(organizationId, userId, token, lockTtlMs)
          .catch((err) => {
            console.error('[WhatsApp Lock] heartbeat extend falló:', err);
          });
      }, heartbeatIntervalMs);
      heartbeat.unref?.();

      return {
        async release() {
          if (released) return;
          released = true;
          if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
          }
          try {
            await withTimeout(
              store.release(organizationId, userId, token),
              queryTimeoutMs,
              'whatsapp lock release timeout',
            );
          } catch (err) {
            // Si el DELETE falla, no pasa nada: el candado vence solo por TTL.
            console.error(
              '[WhatsApp Lock] release falló o expiró; el candado expirará por TTL:',
              err,
            );
          }
        },
      };
    }

    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }

  return null;
}

// Task #207: cuando un usuario está en medio de una conversación multi-step,
// la org de esa conversación debe tener prioridad sobre la default. Devuelve
// la organizationId de la conversación más reciente no expirada, o null.
export async function findActiveConversationOrgId(userId: string): Promise<string | null> {
  const rows = await db
    .select({ organizationId: whatsappConversations.organizationId })
    .from(whatsappConversations)
    .where(
      and(
        eq(whatsappConversations.userId, userId),
        ttlPredicate(),
      ),
    )
    .orderBy(desc(whatsappConversations.lastActivityAt))
    .limit(1);

  return rows.length > 0 ? rows[0].organizationId : null;
}

const GENERIC_DESCRIPTIONS = [
  'gasto', 'gastos', 'ingreso', 'ingresos', 'pago', 'pagos', 'cobro', 'cobros',
  'movimiento', 'movimientos', 'transferencia', 'transferencias',
  'expense', 'income', 'payment', 'transaction'
];

export function isGenericDescription(description: string | null): boolean {
  if (!description) return true;
  const normalized = description.toLowerCase().trim();
  return GENERIC_DESCRIPTIONS.includes(normalized) || normalized.length < 3;
}

export function getNextStep(slots: TransactionSlots): WhatsappCurrentStep {
  if (!slots.type) return 'type';
  if (slots.amount === null) return 'amount';
  if (!slots.currency) return 'currency';
  const needsAccount = slots.type === 'income' || slots.type === 'expense';
  if (needsAccount && !slots.accountId) return 'account';
  if (!slots.description || isGenericDescription(slots.description)) {
    if (slots.clientName || slots.supplierName) {
      // client/supplier name provides enough context
    } else {
      return 'description';
    }
  }
  if (slots.hasInvoice === null && !slots.invoiceSource) return 'invoice';
  if (slots.hasInvoice === true && slots.invoiceSource !== 'pattern' && slots.invoiceSource !== 'preference') {
    // Task #294: si la foto ya viajó como adjunto (caso "foto suelta de
    // ticket" de Task #290), el ticket ES la factura — no tiene sentido
    // pedir número formal ni volver a pedir foto. Saltamos directo a
    // confirm. El número de factura queda null (los tickets no llevan).
    if (slots.invoiceFileUrl !== null) return 'confirm';
    if (slots.invoiceNumber === null) return 'invoice_number';
    if (slots.invoiceFileUrl === null) return 'invoice_image';
  }
  return 'confirm';
}

export function suggestAccounts(
  accounts: Account[],
  transactionType: string | null,
  currency: string | null
): Array<{ account: Account; reason: string }> {
  if (!accounts || accounts.length === 0) return [];

  const targetCurrency = currency || 'ARS';

  const currencyMatches = (accountCurrency: string, target: string): boolean => {
    const normalizedAccount = accountCurrency?.toUpperCase() || 'ARS';
    const normalizedTarget = target?.toUpperCase() || 'ARS';
    if (normalizedTarget === 'USD' || normalizedTarget === 'USD_CASH') {
      return normalizedAccount === 'USD' || normalizedAccount === 'USD_CASH';
    }
    return normalizedAccount === normalizedTarget;
  };

  const filteredAccounts = currency
    ? accounts.filter(acc => currencyMatches(acc.currency || 'ARS', targetCurrency))
    : accounts;

  const accountsToScore = filteredAccounts.length > 0 ? filteredAccounts : accounts;

  const suggestions: Array<{ account: Account; reason: string; score: number }> = [];

  for (const account of accountsToScore) {
    const accountCurrency = account.currency || 'ARS';
    const balance = parseFloat(account.balance || '0');
    let score = 0;
    let reason = '';

    if (currencyMatches(accountCurrency, targetCurrency)) {
      score += 100;
      reason = `Moneda coincidente (${accountCurrency})`;
    }

    if (transactionType === 'expense' && balance > 0) {
      score += 50;
      reason = reason ? `${reason}, tiene saldo disponible` : 'Tiene saldo disponible';
    }

    if (transactionType === 'income') {
      score += 30;
    }

    if (account.type === 'cash' && (account.name?.toLowerCase().includes('caja') || account.name?.toLowerCase().includes('efectivo'))) {
      score += 20;
      reason = reason || 'Cuenta de efectivo';
    }

    if (account.type === 'bank') {
      score += 15;
      reason = reason || 'Cuenta bancaria';
    }

    suggestions.push({ account, reason: reason || 'Cuenta disponible', score });
  }

  return suggestions
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ account, reason }) => ({ account, reason }));
}

export function formatAccountSuggestions(suggestions: Array<{ account: Account; reason: string }>): string {
  if (suggestions.length === 0) return '';

  return suggestions.map((s, i) => {
    const balance = parseFloat(s.account.balance || '0');
    const curr = s.account.currency || 'ARS';
    const symbol = curr === 'USD' || curr === 'USD_CASH' ? 'U$D' : curr === 'EUR' ? '€' : '$';
    return `${i + 1}. ${s.account.name} (${symbol}${balance.toLocaleString('es-AR')})`;
  }).join('\n');
}

// Barrido periódico: borra conversaciones vencidas para que la tabla no
// crezca sin límite. Se arranca desde server/index.ts después del boot.
// El TTL ya se aplica en lecturas, así que esto es solo limpieza física.
let cleanupTimer: NodeJS.Timeout | null = null;

export function startConversationStateCleanup(intervalMs: number = 5 * 60 * 1000): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(async () => {
    try {
      await deleteExpiredConversations();
    } catch (err) {
      console.error('[conversation-state] cleanup failed:', err);
    }
  }, intervalMs);
  // Que no impida que el proceso cierre limpio.
  cleanupTimer.unref?.();
}

export function stopConversationStateCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// Helper compartido con tests/cleanup: borra de una sola pasada todos los
// rows vencidos por TTL. Se usa desde el setInterval del cleanup y desde
// tests. La condición es el complemento de `ttlPredicate`.
export async function deleteExpiredConversations(): Promise<number> {
  const res = await db
    .delete(whatsappConversations)
    .where(sql`${whatsappConversations.lastActivityAt} <= ${ttlCutoff}`)
    .returning({ userId: whatsappConversations.userId });
  return res.length;
}
