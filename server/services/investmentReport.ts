// =============================================================================
// AIKESTAR - Reporte de Inversiones (para PDF visual por período)
// =============================================================================
// Arma el reporte completo de la cartera: resumen, distribución, detalle por
// posición y rendimiento del período elegido. Mezcla ARS y USD convirtiendo a
// ARS-equivalente con el dólar MEP (estándar para inversiones).
// =============================================================================
import type { InvestmentAssetType } from '@shared/schema';
import { INVESTMENT_ASSET_TYPE_LABELS } from '@shared/schema';
import { getPortfolio, type PortfolioRow } from './investmentService';
import { getHistoricalCloses, getQuotes, quoteKey } from './marketData';

export interface ReportPosition {
  name: string; symbol: string; assetType: string; assetTypeLabel: string; currency: string;
  quantity: number; buyPrice: number | null; currentPrice: number | null;
  currentValue: number | null; currentValueARS: number | null; weightPct: number | null;
  pnl: number | null; pnlPct: number | null;
  periodReturnPct: number | null; // rendimiento del activo en el período
}
export interface AllocationSlice { key: string; label: string; valueARS: number; pct: number; }
export interface InvestmentReport {
  asOf: number;
  period: { fromSec: number; toSec: number };
  mepRate: number | null; // 1 USD = X ARS (MEP) usado para convertir
  positions: ReportPosition[];
  totalsByCurrency: { currency: string; cost: number; currentValue: number; pnl: number; pnlPct: number | null }[];
  unified: { investedARS: number; valueARS: number; pnlARS: number; pnlPct: number | null };
  allocationByType: AllocationSlice[];
  allocationByCurrency: AllocationSlice[];
  bestPerformers: ReportPosition[];
  worstPerformers: ReportPosition[];
}

// Convierte un valor de su moneda a ARS-equivalente usando el MEP para USD.
function toARS(value: number, currency: string, mep: number | null): number | null {
  if (currency === 'ARS') return value;
  if (currency === 'USD') return mep != null ? value * mep : null;
  return null; // otras monedas: sin conversión disponible
}

// Cálculo puro del rendimiento del período a partir de los cierres.
export function computePeriodReturn(startClose: number | null, endClose: number | null): number | null {
  if (startClose == null || endClose == null || startClose === 0) return null;
  return ((endClose - startClose) / startClose) * 100;
}

// Reparte un total en porciones (allocation) con su porcentaje sobre el total.
export function buildAllocation(entries: { key: string; label: string; valueARS: number }[]): AllocationSlice[] {
  const total = entries.reduce((s, e) => s + e.valueARS, 0);
  return entries
    .filter((e) => e.valueARS > 0)
    .map((e) => ({ ...e, pct: total > 0 ? (e.valueARS / total) * 100 : 0 }))
    .sort((a, b) => b.valueARS - a.valueARS);
}

export async function getInvestmentReport(organizationId: string, fromSec: number, toSec: number): Promise<InvestmentReport> {
  const portfolio = await getPortfolio(organizationId);
  const rows = portfolio.rows;

  // Dólar MEP para convertir USD→ARS (estándar en inversiones).
  const mepMap = await getQuotes([{ symbol: 'bolsa', assetType: 'dolar' as InvestmentAssetType }]);
  const mepQuote = mepMap.get(quoteKey('bolsa', 'dolar'));
  const mepRate = mepQuote ? mepQuote.price : null;

  // Histórico para el rendimiento del período (Yahoo).
  const hist = await getHistoricalCloses(
    rows.map((r) => ({ symbol: r.investment.symbol, assetType: r.investment.assetType as InvestmentAssetType })),
    fromSec, toSec,
  );

  const positions: ReportPosition[] = rows.map((r: PortfolioRow) => {
    const inv = r.investment; const p = r.position;
    const currentValueARS = p.currentValue != null ? toARS(p.currentValue, p.currency, mepRate) : null;
    const h = hist.get(quoteKey(inv.symbol, inv.assetType));
    // endClose: si el período termina hoy usamos el precio actual; si no, el cierre histórico.
    const endClose = h?.endClose ?? p.currentPrice ?? null;
    const periodReturnPct = inv.assetType === 'dolar' ? null : computePeriodReturn(h?.startClose ?? null, endClose);
    return {
      name: inv.name, symbol: inv.symbol, assetType: inv.assetType,
      assetTypeLabel: INVESTMENT_ASSET_TYPE_LABELS[inv.assetType as InvestmentAssetType] || inv.assetType,
      currency: p.currency, quantity: p.quantity, buyPrice: p.buyPrice, currentPrice: p.currentPrice,
      currentValue: p.currentValue, currentValueARS, weightPct: null,
      pnl: p.pnl, pnlPct: p.pnlPct, periodReturnPct,
    };
  });

  // Pesos (% de la cartera en ARS-equivalente).
  const totalARS = positions.reduce((s, p) => s + (p.currentValueARS ?? 0), 0);
  for (const p of positions) p.weightPct = totalARS > 0 && p.currentValueARS != null ? (p.currentValueARS / totalARS) * 100 : null;

  // Distribución por tipo y por moneda.
  const byTypeMap = new Map<string, { label: string; valueARS: number }>();
  const byCurMap = new Map<string, number>();
  for (const p of positions) {
    const v = p.currentValueARS ?? 0;
    const t = byTypeMap.get(p.assetType) || { label: p.assetTypeLabel, valueARS: 0 };
    t.valueARS += v; byTypeMap.set(p.assetType, t);
    byCurMap.set(p.currency, (byCurMap.get(p.currency) || 0) + v);
  }
  const allocationByType = buildAllocation(Array.from(byTypeMap.entries()).map(([key, v]) => ({ key, label: v.label, valueARS: v.valueARS })));
  const allocationByCurrency = buildAllocation(Array.from(byCurMap.entries()).map(([key, valueARS]) => ({ key, label: key, valueARS })));

  // Total unificado en ARS-equivalente.
  const investedARS = portfolio.totals.reduce((s, t) => s + (toARS(t.cost, t.currency, mepRate) ?? 0), 0);
  const valueARS = totalARS;
  const pnlARS = valueARS - investedARS;
  const unified = { investedARS, valueARS, pnlARS, pnlPct: investedARS > 0 ? (pnlARS / investedARS) * 100 : null };

  // Mejores/peores del período (solo los que tienen rendimiento calculado).
  const withReturn = positions.filter((p) => p.periodReturnPct != null);
  const sorted = [...withReturn].sort((a, b) => (b.periodReturnPct as number) - (a.periodReturnPct as number));
  const bestPerformers = sorted.slice(0, 3);
  const worstPerformers = sorted.slice(-3).reverse().filter((p) => !bestPerformers.includes(p));

  return {
    asOf: Date.now(),
    period: { fromSec, toSec },
    mepRate,
    positions,
    totalsByCurrency: portfolio.totals,
    unified,
    allocationByType,
    allocationByCurrency,
    bestPerformers,
    worstPerformers,
  };
}
