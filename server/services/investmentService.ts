// =============================================================================
// AIKESTAR - Servicio de Inversiones
// =============================================================================
// CRUD de posiciones + armado de la cartera con cotizaciones en vivo y P&L.
// =============================================================================
import { db } from '../db';
import { and, eq, desc, isNull } from 'drizzle-orm';
import { marketInvestments, type MarketInvestment, type InvestmentAssetType } from '@shared/schema';
import { storage } from '../storage';
import { getQuotes, quoteKey, type Quote } from './marketData';

async function audit(orgId: string, userId: string | null, id: string, action: string, data: any) {
  await storage.createAuditLog({ organizationId: orgId, userId: userId ?? null, entityType: 'investment', entityId: id, action, newData: JSON.stringify(data) } as any).catch(() => {});
}

export interface Position {
  quantity: number;
  buyPrice: number | null;
  currentPrice: number | null;
  cost: number | null;        // quantity * buyPrice
  currentValue: number | null; // quantity * currentPrice
  pnl: number | null;          // currentValue - cost
  pnlPct: number | null;       // pnl / cost * 100
  dayChangePct: number | null; // variación del día del activo
  currency: string;
  quoteAsOf: number | null;
  quoteSource: string | null;
}

// Cálculo puro de una posición a partir del holding y su cotización. Testeable.
export function computePosition(
  holding: { quantity: string | number; buyPrice?: string | number | null; currency?: string | null },
  quote: Quote | null,
): Position {
  const quantity = parseFloat(String(holding.quantity ?? '0')) || 0;
  const buyPrice = holding.buyPrice != null && holding.buyPrice !== '' ? parseFloat(String(holding.buyPrice)) : null;
  const currentPrice = quote ? quote.price : null;
  const cost = buyPrice != null ? quantity * buyPrice : null;
  const currentValue = currentPrice != null ? quantity * currentPrice : null;
  const pnl = currentValue != null && cost != null ? currentValue - cost : null;
  const pnlPct = pnl != null && cost != null && cost !== 0 ? (pnl / cost) * 100 : null;
  return {
    quantity,
    buyPrice,
    currentPrice,
    cost,
    currentValue,
    pnl,
    pnlPct,
    dayChangePct: quote ? quote.changePct : null,
    currency: quote?.currency || holding.currency || 'ARS',
    quoteAsOf: quote ? quote.asOf : null,
    quoteSource: quote ? quote.source : null,
  };
}

export interface PortfolioRow { investment: MarketInvestment; position: Position; }
export interface CurrencyTotals { currency: string; cost: number; currentValue: number; pnl: number; pnlPct: number | null; }
export interface Portfolio { rows: PortfolioRow[]; totals: CurrencyTotals[]; }

// Agrega totales por moneda (no convierte entre monedas para no asumir un FX).
export function computeTotals(rows: PortfolioRow[]): CurrencyTotals[] {
  const byCur = new Map<string, { cost: number; currentValue: number }>();
  for (const r of rows) {
    const cur = r.position.currency || 'ARS';
    const t = byCur.get(cur) || { cost: 0, currentValue: 0 };
    if (r.position.cost != null) t.cost += r.position.cost;
    if (r.position.currentValue != null) t.currentValue += r.position.currentValue;
    byCur.set(cur, t);
  }
  return Array.from(byCur.entries()).map(([currency, t]) => {
    const pnl = t.currentValue - t.cost;
    return { currency, cost: t.cost, currentValue: t.currentValue, pnl, pnlPct: t.cost !== 0 ? (pnl / t.cost) * 100 : null };
  }).sort((a, b) => b.currentValue - a.currentValue);
}

export async function listInvestments(organizationId: string): Promise<MarketInvestment[]> {
  return db.select().from(marketInvestments)
    .where(and(eq(marketInvestments.organizationId, organizationId), isNull(marketInvestments.archivedAt)))
    .orderBy(desc(marketInvestments.createdAt));
}

export async function getPortfolio(organizationId: string): Promise<Portfolio> {
  const holdings = await listInvestments(organizationId);
  const quotes = await getQuotes(holdings.map((h) => ({ symbol: h.symbol, assetType: h.assetType as InvestmentAssetType })));
  const rows: PortfolioRow[] = holdings.map((h) => {
    const q = quotes.get(quoteKey(h.symbol, h.assetType)) ?? null;
    return { investment: h, position: computePosition(h, q) };
  });
  return { rows, totals: computeTotals(rows) };
}

export interface InvestmentInput {
  organizationId: string;
  name: string;
  symbol: string;
  assetType: InvestmentAssetType;
  quantity: string | number;
  buyPrice?: string | number | null;
  currency?: string | null;
  buyDate?: string | Date | null;
  broker?: string | null;
  notes?: string | null;
  createdBy?: string | null;
}

export async function createInvestment(input: InvestmentInput): Promise<MarketInvestment> {
  const [row] = await db.insert(marketInvestments).values({
    organizationId: input.organizationId,
    name: input.name,
    symbol: input.symbol,
    assetType: input.assetType,
    quantity: String(input.quantity ?? '0'),
    buyPrice: input.buyPrice != null && input.buyPrice !== '' ? String(input.buyPrice) : null,
    currency: input.currency || 'ARS',
    buyDate: input.buyDate ? new Date(input.buyDate) : null,
    broker: input.broker ?? null,
    notes: input.notes ?? null,
    createdBy: input.createdBy ?? null,
  }).returning();
  await audit(input.organizationId, input.createdBy ?? null, row.id, 'create', { name: row.name, symbol: row.symbol });
  return row;
}

export async function updateInvestment(id: string, organizationId: string, patch: Partial<InvestmentInput>, userId: string | null): Promise<MarketInvestment | undefined> {
  const set: any = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.symbol !== undefined) set.symbol = patch.symbol;
  if (patch.assetType !== undefined) set.assetType = patch.assetType;
  if (patch.quantity !== undefined) set.quantity = String(patch.quantity);
  if (patch.buyPrice !== undefined) set.buyPrice = patch.buyPrice != null && patch.buyPrice !== '' ? String(patch.buyPrice) : null;
  if (patch.currency !== undefined) set.currency = patch.currency || 'ARS';
  if (patch.buyDate !== undefined) set.buyDate = patch.buyDate ? new Date(patch.buyDate) : null;
  if (patch.broker !== undefined) set.broker = patch.broker ?? null;
  if (patch.notes !== undefined) set.notes = patch.notes ?? null;
  const [row] = await db.update(marketInvestments).set(set)
    .where(and(eq(marketInvestments.id, id), eq(marketInvestments.organizationId, organizationId))).returning();
  if (row) await audit(organizationId, userId, id, 'update', set);
  return row;
}

export async function deleteInvestment(id: string, organizationId: string, userId: string | null): Promise<boolean> {
  const [row] = await db.update(marketInvestments).set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(marketInvestments.id, id), eq(marketInvestments.organizationId, organizationId), isNull(marketInvestments.archivedAt)))
    .returning();
  if (row) await audit(organizationId, userId, id, 'delete', { name: row.name });
  return !!row;
}
