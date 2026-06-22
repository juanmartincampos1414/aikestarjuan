import type { Subscription } from "@shared/schema";

// Churn mensual real y LTV derivado (ARPU / churn) calculados sobre el
// historial completo de suscripciones.
//
// Decisiones clave (Task #423):
//   - Se trabaja sobre TODAS las filas de `subscriptions`, no sobre la fila
//     canónica por usuario, para no perder ciclos de vida: un usuario que se
//     dio de baja y volvió a suscribirse tiene varias suscripciones y ambas
//     bajas deben contar.
//   - Antes de calcular se deduplican las filas que comparten el mismo
//     `stripeSubscriptionId` (un bug histórico del webhook generaba duplicados):
//     sobrevive la última actualizada. Las filas sin `stripeSubscriptionId`
//     (placeholders pre-checkout) se mantienen tal cual.
//   - La fecha efectiva de baja es determinista: `currentPeriodEnd` (cuando el
//     cliente realmente se pierde) y, si falta, `cancellationRequestedAt`.
//     NO se usa `updatedAt`, porque cualquier actualización no relacionada
//     movería la baja de mes y haría inestable el churn.
//   - Una suscripción se considera dada de baja si su estado es 'cancelled'
//     (o 'canceled', la grafía de Stripe), su `cancellationStatus` es
//     'cancelled', o tiene `cancelAtPeriodEnd` (baja programada al fin del
//     período). En este último caso la baja se imputa a `currentPeriodEnd`; si
//     esa fecha es futura, sigue contando como activa hasta entonces.
//   - Si una baja no tiene fecha imputable se excluye por completo del cálculo
//     (ni base ni baja) para no contaminar la tasa.

export const CHURN_WINDOW_MONTHS = 6;
export const CHURN_MIN_MONTHS_WITH_DATA = 2;
export const CHURN_MIN_CANCELLATIONS = 3;

export interface ChurnLtvResult {
  monthlyRatePct: number | null;
  avgLifetimeMonths: number | null;
  ltvArs: number | null;
  ltvUsd: number | null;
  cancellationsInWindow: number;
  monthsWithData: number;
  windowMonths: number;
  hasEnoughData: boolean;
}

// Deduplica por stripeSubscriptionId (no nulo) conservando la fila actualizada
// más recientemente; preserva las filas sin stripeSubscriptionId.
export function dedupeSubscriptionLifecycles(rows: Subscription[]): Subscription[] {
  const updatedAtMs = (r: Subscription) =>
    r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
  const byStripeId = new Map<string, Subscription>();
  const standalone: Subscription[] = [];
  for (const r of rows) {
    if (!r.stripeSubscriptionId) {
      standalone.push(r);
      continue;
    }
    const prev = byStripeId.get(r.stripeSubscriptionId);
    if (!prev || updatedAtMs(r) > updatedAtMs(prev)) {
      byStripeId.set(r.stripeSubscriptionId, r);
    }
  }
  return [...byStripeId.values(), ...standalone];
}

interface SubLifecycle {
  start: Date;
  churnDate: Date | null; // null = activa (nunca dada de baja)
}

function toLifecycle(s: Subscription): SubLifecycle | null {
  const startRaw = s.createdAt ?? s.currentPeriodStart ?? null;
  if (!startRaw) return null;
  const start = new Date(startRaw);

  const isChurned =
    s.status === "cancelled" ||
    s.status === "canceled" ||
    s.cancellationStatus === "cancelled" ||
    s.cancelAtPeriodEnd === true;

  if (!isChurned) {
    return { start, churnDate: null };
  }

  const churnRaw = s.currentPeriodEnd ?? s.cancellationRequestedAt ?? null;
  // Dada de baja pero sin fecha imputable: se excluye del cálculo.
  if (!churnRaw) return null;
  return { start, churnDate: new Date(churnRaw) };
}

export function computeChurnAndLtv(
  rows: Subscription[],
  arpuArs: number,
  arpuUsd: number,
  now: Date,
): ChurnLtvResult {
  const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
  const addMonths = (d: Date, m: number) =>
    new Date(d.getFullYear(), d.getMonth() + m, 1);

  const lifecycles = dedupeSubscriptionLifecycles(rows)
    .map(toLifecycle)
    .filter((l): l is SubLifecycle => l !== null);

  const currentMonthStart = startOfMonth(now);
  let monthsWithData = 0;
  let totalCancellations = 0;
  const monthlyRates: number[] = [];

  for (let i = 1; i <= CHURN_WINDOW_MONTHS; i++) {
    const mStart = addMonths(currentMonthStart, -i);
    const mEnd = addMonths(currentMonthStart, -i + 1);

    let baseAtStart = 0;
    let churnedInMonth = 0;
    for (const lc of lifecycles) {
      // Activa al inicio del mes: empezó antes del mes y no estaba dada de baja
      // todavía a esa fecha.
      const activeAtStart = lc.start < mStart && (!lc.churnDate || lc.churnDate >= mStart);
      if (activeAtStart) {
        baseAtStart++;
      }
      // Solo contamos como baja del mes a quienes ya formaban parte de la base
      // (empezaron antes del mes): churn de "logo" estricto, sin contar altas y
      // bajas dentro del mismo mes que nunca estuvieron en el denominador.
      if (lc.start < mStart && lc.churnDate && lc.churnDate >= mStart && lc.churnDate < mEnd) {
        churnedInMonth++;
      }
    }
    if (baseAtStart > 0) {
      monthsWithData++;
      monthlyRates.push(churnedInMonth / baseAtStart);
      totalCancellations += churnedInMonth;
    }
  }

  const insufficient = (monthlyRatePct: number | null = null): ChurnLtvResult => ({
    monthlyRatePct,
    avgLifetimeMonths: null,
    ltvArs: null,
    ltvUsd: null,
    cancellationsInWindow: totalCancellations,
    monthsWithData,
    windowMonths: CHURN_WINDOW_MONTHS,
    hasEnoughData: false,
  });

  const hasEnoughData =
    monthsWithData >= CHURN_MIN_MONTHS_WITH_DATA &&
    totalCancellations >= CHURN_MIN_CANCELLATIONS;
  if (!hasEnoughData) return insufficient();

  const avgRate =
    monthlyRates.reduce((a, b) => a + b, 0) / monthlyRates.length;
  // Sin churn observable no hay LTV finito derivable; conservamos la estimación.
  if (avgRate <= 0) return insufficient(0);

  return {
    monthlyRatePct: avgRate * 100,
    avgLifetimeMonths: 1 / avgRate,
    ltvArs: arpuArs / avgRate,
    ltvUsd: arpuUsd / avgRate,
    cancellationsInWindow: totalCancellations,
    monthsWithData,
    windowMonths: CHURN_WINDOW_MONTHS,
    hasEnoughData: true,
  };
}
