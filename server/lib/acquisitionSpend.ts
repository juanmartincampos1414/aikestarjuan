import type { Transaction, BusinessSettings, MonthlyAcquisitionSpend } from "@shared/schema";
import { getArgentinaMonth } from "@shared/constants";

// Task #433: deriva el gasto de adquisición por mes calendario a partir de
// transacciones etiquetadas (en lugar de cargarlo a mano). Una transacción
// cuenta como gasto de adquisición si es un gasto real (type 'expense', no
// cancelado) y su cuenta, categoría o código de análisis está entre los
// seleccionados en la configuración del panel admin.
//
// Decisiones clave:
//   - Solo se suman gastos reales ya ejecutados (type 'expense'); los
//     compromisos a pagar ('payable') todavía no son plata gastada y por eso
//     no entran en el CAC.
//   - El criterio de etiqueta es OR: alcanza con que la cuenta O la categoría O
//     el código de análisis coincida. Si la config no tiene ninguna etiqueta,
//     no se deriva nada (no se suma todo el gasto por error).
//   - Los importes se llevan a ARS: ARS tal cual, USD/USD_CASH por el tipo de
//     cambio; otras monedas se ignoran (no hay feed de FX) para no subestimar
//     ni inventar valores.
//   - El mes se calcula en hora de Argentina (mismo criterio que el calendario
//     de movimientos del producto).

export interface AcquisitionDerivationConfig {
  enabled: boolean;
  orgId: string | null;
  accountIds: string[];
  categories: string[];
  profitabilityCodeIds: string[];
}

export function configFromSettings(
  settings: BusinessSettings | undefined,
): AcquisitionDerivationConfig {
  return {
    enabled: settings?.acquisitionAutoEnabled ?? false,
    orgId: settings?.acquisitionOrgId ?? null,
    accountIds: settings?.acquisitionAccountIds ?? [],
    categories: settings?.acquisitionCategories ?? [],
    profitabilityCodeIds: settings?.acquisitionProfitabilityCodeIds ?? [],
  };
}

export function configHasTags(config: AcquisitionDerivationConfig): boolean {
  return (
    config.accountIds.length > 0 ||
    config.categories.length > 0 ||
    config.profitabilityCodeIds.length > 0
  );
}

function txMatchesConfig(
  tx: Transaction,
  config: AcquisitionDerivationConfig,
  itemCodeIds?: string[],
): boolean {
  if (tx.accountId && config.accountIds.includes(tx.accountId)) return true;
  if (tx.category && config.categories.includes(tx.category)) return true;
  if (tx.profitabilityCodeId && config.profitabilityCodeIds.includes(tx.profitabilityCodeId)) return true;
  // Ventas multi-producto guardan el código por renglón en transaction_items y
  // dejan el campo legacy de la transacción en null. Consideramos también esos
  // códigos para no subcontar los casos código-específicos (#477).
  if (itemCodeIds && itemCodeIds.some((id) => config.profitabilityCodeIds.includes(id))) return true;
  return false;
}

// Agrupa los códigos de rentabilidad por transacción a partir de los renglones
// (transaction_items), descartando los nulos. Útil para que la derivación
// considere el match por código en ventas/compras multi-producto.
export function buildItemCodesByTx(
  items: { transactionId: string; profitabilityCodeId: string | null }[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const it of items) {
    if (!it.profitabilityCodeId) continue;
    const arr = map.get(it.transactionId) || [];
    arr.push(it.profitabilityCodeId);
    map.set(it.transactionId, arr);
  }
  return map;
}

// Suma los gastos etiquetados por mes calendario (ARS). Devuelve un mapa
// mes 'YYYY-MM' -> monto en ARS. Las transacciones deben venir ya filtradas por
// organización; aquí se aplica el filtro de etiquetas, tipo y conversión.
export function deriveAcquisitionSpendByMonth(
  transactions: Transaction[],
  config: AcquisitionDerivationConfig,
  usdArsRate: number,
  itemCodesByTx?: Map<string, string[]>,
): Map<string, number> {
  const byMonth = new Map<string, number>();
  if (!configHasTags(config)) return byMonth;

  for (const tx of transactions) {
    if (tx.type !== 'expense') continue;
    if (tx.status === 'cancelled') continue;
    if (!txMatchesConfig(tx, config, itemCodesByTx?.get(tx.id))) continue;

    const raw = Number(tx.amount);
    if (!Number.isFinite(raw) || raw <= 0) continue;

    const currency = (tx.currency || 'ARS').toUpperCase();
    let amountArs: number;
    if (currency === 'ARS') {
      amountArs = raw;
    } else if (currency === 'USD' || currency === 'USD_CASH') {
      amountArs = usdArsRate > 0 ? raw * usdArsRate : 0;
    } else {
      // Sin tipo de cambio para otras monedas: se ignora (no se inventa valor).
      continue;
    }
    if (amountArs <= 0) continue;

    const key = getArgentinaMonth(new Date(tx.date));
    byMonth.set(key, (byMonth.get(key) || 0) + amountArs);
  }

  return byMonth;
}

// Combina el gasto manual (tabla acquisition_spend) con el derivado de las
// transacciones etiquetadas. La carga manual de un mes tiene prioridad y
// REEMPLAZA al derivado de ese mes, de modo que nunca se duplica el gasto ya
// cargado a mano. Los meses que solo tienen derivado usan el derivado.
export function mergeAcquisitionSpend(
  manual: { month: string; amountArs: number | string }[],
  derived: Map<string, number>,
): MonthlyAcquisitionSpend[] {
  const result = new Map<string, MonthlyAcquisitionSpend>();

  for (const [month, amountArs] of derived.entries()) {
    if (amountArs > 0) {
      result.set(month, { month, amountArs, source: 'auto' });
    }
  }

  for (const m of manual) {
    const amount = Number(m.amountArs);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    // Manual gana: reemplaza el derivado de ese mes.
    result.set(m.month, { month: m.month, amountArs: amount, source: 'manual' });
  }

  return Array.from(result.values()).sort((a, b) => (a.month < b.month ? 1 : -1));
}
