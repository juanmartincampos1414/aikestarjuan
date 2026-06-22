import type { Subscription } from "@shared/schema";
import { dedupeSubscriptionLifecycles } from "./churnLtv";

// Gasto de adquisición por mes que consume el CAC. Antes era estrictamente la
// tabla acquisition_spend (carga manual); ahora puede ser la mezcla de carga
// manual + derivado de transacciones etiquetadas (Task #433). Solo se necesitan
// el mes y el monto en ARS.
type MonthlySpend = { month: string; amountArs: number | string };

// CAC real (costo de adquisición de cliente) calculado a partir del gasto de
// adquisición registrado por mes (tabla acquisition_spend) y las altas reales
// de la tabla subscriptions.
//
// Decisiones clave (Task #424):
//   - Solo se consideran los meses que tienen gasto registrado. Por cada uno se
//     cuentan las altas (suscripciones cuyo createdAt cae en ese mes). El CAC es
//     "blended": total de gasto / total de altas en esos meses. Así un mes con
//     gasto pero sin altas igual suma al numerador (costo sin retorno), que es
//     el comportamiento correcto y no infla el CAC artificialmente.
//   - Las altas se deduplican por stripeSubscriptionId con la misma lógica que
//     el churn, para no contar dos veces filas duplicadas del webhook.
//   - El gasto se carga en ARS; el equivalente en USD se deriva con el tipo de
//     cambio configurable (usdArsRate), igual que el resto de los KPIs.
//   - hasEnoughData = hay al menos un mes con gasto > 0 y al menos un alta en
//     esos meses. Si no, el frontend cae a la estimación.

export interface CacResult {
  cacArs: number | null;
  cacUsd: number | null;
  totalSpendArs: number;
  totalSignups: number;
  monthsWithSpend: number;
  hasEnoughData: boolean;
}

// 'YYYY-MM' de una fecha en UTC. Usamos getUTC* para que el mes calendario sea
// determinista y no dependa de la zona horaria del servidor.
function monthKey(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function computeRealCac(
  spends: MonthlySpend[],
  subscriptions: Subscription[],
  usdArsRate: number,
): CacResult {
  const empty: CacResult = {
    cacArs: null,
    cacUsd: null,
    totalSpendArs: 0,
    totalSignups: 0,
    monthsWithSpend: 0,
    hasEnoughData: false,
  };

  // Mapa mes -> gasto (sumando por si hubiera duplicados, aunque month es PK).
  const spendByMonth = new Map<string, number>();
  for (const s of spends) {
    const amount = Number(s.amountArs);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    spendByMonth.set(s.month, (spendByMonth.get(s.month) || 0) + amount);
  }

  const monthsWithSpend = spendByMonth.size;
  if (monthsWithSpend === 0) return empty;

  const totalSpendArs = Array.from(spendByMonth.values()).reduce((a, b) => a + b, 0);

  // Altas por mes (deduplicadas), solo contando los meses que tienen gasto.
  let totalSignups = 0;
  for (const sub of dedupeSubscriptionLifecycles(subscriptions)) {
    if (!sub.createdAt) continue;
    const key = monthKey(new Date(sub.createdAt));
    if (spendByMonth.has(key)) {
      totalSignups++;
    }
  }

  if (totalSignups <= 0) {
    return { ...empty, totalSpendArs, monthsWithSpend };
  }

  const cacArs = totalSpendArs / totalSignups;
  const cacUsd = usdArsRate > 0 ? cacArs / usdArsRate : 0;

  return {
    cacArs,
    cacUsd,
    totalSpendArs,
    totalSignups,
    monthsWithSpend,
    hasEnoughData: true,
  };
}
