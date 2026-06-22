import * as cron from 'node-cron';
import { storage } from '../storage';
import { db } from '../db';
import { clients as clientsTable, transactions as transactionsTable, type Client, type SubscriptionPlan } from '@shared/schema';
import { and, eq, or, isNull, lt, sql } from 'drizzle-orm';

function currentMonthAR(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const y = parts.find(p => p.type === 'year')?.value ?? '1970';
  const m = parts.find(p => p.type === 'month')?.value ?? '01';
  return `${y}-${m}`;
}

function buildChargeDate(yearMonth: string, billingDay: number): Date {
  const [y, m] = yearMonth.split('-').map(Number);
  const safeDay = Math.min(Math.max(billingDay || 1, 1), 28);
  return new Date(Date.UTC(y, m - 1, safeDay, 12, 0, 0));
}

export interface GenerateChargeResult {
  generated: boolean;
  reason?: 'not_subscriber' | 'no_quantity' | 'no_price' | 'already_billed' | 'before_start' | 'invalid_plan';
  transactionId?: string;
  amount?: string;
  currency?: string;
  month?: string;
}

export async function generateChargeForClient(
  client: Client,
  opts: { force?: boolean; month?: string } = {}
): Promise<GenerateChargeResult> {
  if (client.clientType !== 'suscriptores') {
    return { generated: false, reason: 'not_subscriber' };
  }
  const quantity = client.subscriberQuantity || 0;
  if (quantity <= 0) {
    return { generated: false, reason: 'no_quantity' };
  }

  const month = opts.month || currentMonthAR();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return { generated: false, reason: 'no_price', month };
  }

  if (client.subscriberStartMonth && client.subscriberStartMonth > month) {
    return { generated: false, reason: 'before_start', month };
  }

  // Resolve plan with strict org-scoping (prevent cross-org plan reuse).
  let plan: SubscriptionPlan | undefined;
  if (client.subscriberPlanId) {
    plan = await storage.getSubscriptionPlan(client.subscriberPlanId, client.organizationId);
    if (!plan) {
      return { generated: false, reason: 'invalid_plan', month };
    }
  }
  const unitPriceStr = client.subscriberUnitPriceOverride ?? plan?.monthlyPrice;
  const currency = client.subscriberCurrencyOverride ?? plan?.currency ?? 'ARS';
  if (!unitPriceStr) {
    return { generated: false, reason: 'no_price', month };
  }
  const unitPrice = parseFloat(unitPriceStr as string);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    return { generated: false, reason: 'no_price', month };
  }

  const totalAmount = (unitPrice * quantity).toFixed(2);
  const billingDay = client.subscriberBillingDay || 1;
  const chargeDate = buildChargeDate(month, billingDay);
  const planLabel = plan?.name || 'Suscripción';
  const description = `${planLabel} - ${month} (${quantity} x ${currency} ${unitPrice.toFixed(2)}) - ${client.name}`;

  // Atomic claim + insert. The UPDATE acts as a serializable guard:
  // only one concurrent caller can advance `subscriber_last_billed_month`
  // from < month to = month. When `force` is true the guard is bypassed
  // (legitimate user-initiated regeneration of an already-billed month).
  try {
    const result = await db.transaction(async (tx) => {
      const baseConds = [
        eq(clientsTable.id, client.id),
        eq(clientsTable.organizationId, client.organizationId),
      ];
      const updateConds = opts.force
        ? baseConds
        : [
            ...baseConds,
            or(
              isNull(clientsTable.subscriberLastBilledMonth),
              lt(clientsTable.subscriberLastBilledMonth, month),
            )!,
          ];

      const claimed = await tx
        .update(clientsTable)
        .set({ subscriberLastBilledMonth: month, updatedAt: new Date() })
        .where(and(...updateConds))
        .returning({ id: clientsTable.id });

      if (claimed.length === 0) {
        return { ok: false as const, reason: 'already_billed' as const };
      }

      const [inserted] = await tx
        .insert(transactionsTable)
        .values({
          organizationId: client.organizationId,
          type: 'receivable',
          // Categoría obligatoria a nivel DB (NOT NULL). El cobro mensual
          // por suscripción se asienta como "Abonos" — alineado con la
          // convención existente en transactions de tipo receivable.
          // Si en el futuro se quiere configurable, agregar
          // `subscriptionPlans.defaultCategory` y leerlo del plan.
          category: 'Abonos',
          amount: totalAmount,
          currency,
          description,
          date: chargeDate,
          imputationDate: chargeDate,
          status: 'scheduled',
          clientId: client.id,
          hasInvoice: false,
          isRecurring: true,
          recurrenceFrequency: 'monthly',
          createdVia: 'subscription_billing',
        } as any)
        .returning();

      return { ok: true as const, transaction: inserted };
    });

    if (!result.ok) {
      return { generated: false, reason: 'already_billed', month };
    }
    return {
      generated: true,
      transactionId: result.transaction.id,
      amount: totalAmount,
      currency,
      month,
    };
  } catch (err) {
    console.error('[SubscriptionBilling] Transaction error for client', client.id, err);
    throw err;
  }
}

// Task #315 — Disparo "best-effort" desde create/update de cliente.
//
// Cuando el usuario crea o edita un cliente de tipo `suscriptores` con datos
// suficientes (cantidad > 0, plan o precio override, mes de inicio <= mes
// actual, estado activo) queremos generar la cuenta por cobrar del mes en
// el acto, sin esperar al cron diario de las 02:15. Pero — y esto es
// crítico — la operación primaria del endpoint es crear/editar al cliente:
// si la generación del cobro falla por cualquier razón (DB, plan inválido
// que escapó a la validación, etc), el endpoint igual tiene que devolver
// 200 con el cliente. Por eso este wrapper traga las excepciones y devuelve
// un resultado descriptivo para que el caller decida si loguear o no.
//
// La idempotencia frente a doble alta/edición en el mismo mes ya está
// garantizada por el claim atómico de `subscriberLastBilledMonth` dentro de
// `generateChargeForClient`, así que llamadas repetidas son seguras.
export async function tryGenerateCurrentMonthCharge(
  client: Client,
): Promise<{ outcome: 'generated'; result: GenerateChargeResult }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'error'; error: unknown }> {
  // Filtros baratos primero: si el cliente claramente no califica, ni
  // siquiera entramos al servicio (evita un round-trip a la DB para
  // buscar el plan).
  if (client.clientType !== 'suscriptores') {
    return { outcome: 'skipped', reason: 'not_subscriber' };
  }
  // Alineado con `getSubscriberClientsDue` (cron): se factura todo cliente
  // suscriptor cuyo `isActive` sea true y cuyo `status` no sea 'inactive'.
  // Estados como 'active' (default) o 'potential' califican. Tener gates
  // distintos entre upsert y cron produciría que el cron generara cobros
  // que el alta saltea — peor experiencia para el usuario.
  if (!client.isActive || client.status === 'inactive') {
    return { outcome: 'skipped', reason: 'inactive_client' };
  }
  if (!client.subscriberQuantity || client.subscriberQuantity <= 0) {
    return { outcome: 'skipped', reason: 'no_quantity' };
  }
  if (!client.subscriberPlanId && !client.subscriberUnitPriceOverride) {
    return { outcome: 'skipped', reason: 'no_price' };
  }
  try {
    const result = await generateChargeForClient(client);
    if (result.generated) {
      return { outcome: 'generated', result };
    }
    return { outcome: 'skipped', reason: result.reason || 'unknown' };
  } catch (err) {
    console.error('[SubscriptionBilling] tryGenerateCurrentMonthCharge failed for client', client.id, err);
    return { outcome: 'error', error: err };
  }
}

export async function generateDueChargesForOrg(organizationId: string): Promise<{ generated: number; skipped: number; errors: number }> {
  const month = currentMonthAR();
  const dueClients = await storage.getSubscriberClientsDue(organizationId, month);
  let generated = 0, skipped = 0, errors = 0;
  for (const client of dueClients) {
    try {
      const result = await generateChargeForClient(client);
      if (result.generated) generated++;
      else skipped++;
    } catch (err) {
      console.error(`[SubscriptionBilling] Error for client ${client.id}:`, err);
      errors++;
    }
  }
  return { generated, skipped, errors };
}

export async function generateAllDueCharges(): Promise<void> {
  const month = currentMonthAR();
  const dueClients = await storage.getSubscriberClientsDue(null, month);
  console.log(`[SubscriptionBilling] Checking ${dueClients.length} due subscriber clients for month ${month}`);
  let generated = 0, skipped = 0, errors = 0;
  for (const client of dueClients) {
    try {
      const result = await generateChargeForClient(client);
      if (result.generated) generated++;
      else skipped++;
    } catch (err) {
      console.error(`[SubscriptionBilling] Error for client ${client.id}:`, err);
      errors++;
    }
  }
  if (generated > 0 || errors > 0) {
    console.log(`[SubscriptionBilling] Month ${month}: generated=${generated}, skipped=${skipped}, errors=${errors}`);
  }
}

let billingJob: ReturnType<typeof cron.schedule> | null = null;

export function startSubscriptionBillingCron() {
  if (billingJob) {
    console.log('[SubscriptionBilling] Cron already running');
    return;
  }
  billingJob = cron.schedule('15 2 * * *', async () => {
    console.log('[SubscriptionBilling] Daily cron triggered');
    try {
      await generateAllDueCharges();
    } catch (err) {
      console.error('[SubscriptionBilling] Cron error:', err);
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });
  console.log('[SubscriptionBilling] Daily cron started (02:15 Argentina time)');

  setTimeout(() => {
    generateAllDueCharges().catch(err => console.error('[SubscriptionBilling] Boot run error:', err));
  }, 30_000);
}

export function stopSubscriptionBillingCron() {
  if (billingJob) {
    billingJob.stop();
    billingJob = null;
  }
}
