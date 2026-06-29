// =============================================================================
// AIKESTAR - Rutas de Inversiones
// =============================================================================
import type { Express, Response } from 'express';
import { requireAuth, requirePermission } from './middleware';
import { INVESTMENT_ASSET_TYPES, type InvestmentAssetType } from '@shared/schema';
import * as investments from '../services/investmentService';
import { getInvestmentReport } from '../services/investmentReport';
import { searchSymbols, resolveQuote } from '../services/marketData';

function parseAssetType(v: any): InvestmentAssetType {
  return (INVESTMENT_ASSET_TYPES as readonly string[]).includes(v) ? v : 'otro';
}

export function registerInvestmentRoutes(app: Express): void {
  // Cartera con cotizaciones en vivo + totales por moneda.
  app.get('/api/market-investments', requireAuth, async (req: any, res: Response) => {
    try { res.json(await investments.getPortfolio(req.organizationId)); }
    catch (e) { res.status(500).json({ message: 'No se pudieron cargar las inversiones' }); }
  });

  // Autocompletado de símbolos en el alta de inversiones.
  app.get('/api/market-investments/search', requireAuth, async (req: any, res: Response) => {
    try {
      const results = await searchSymbols(String(req.query.q || ''), parseAssetType(req.query.type));
      res.json({ results });
    } catch { res.json({ results: [] }); }
  });

  // Validación de un símbolo: ¿se consigue cotización? (para avisar antes de guardar).
  app.get('/api/market-investments/resolve', requireAuth, async (req: any, res: Response) => {
    try {
      const symbol = String(req.query.symbol || '').trim();
      if (!symbol) return res.json({ found: false });
      const q = await resolveQuote(symbol, parseAssetType(req.query.assetType));
      res.json(q ? { found: true, price: q.price, currency: q.currency, source: q.source } : { found: false });
    } catch { res.json({ found: false }); }
  });

  // Reporte por período (para el PDF visual de Reportes → Inversiones).
  app.get('/api/market-investments/report', requireAuth, async (req: any, res: Response) => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const parse = (v: any, fallback: number) => {
        if (!v) return fallback;
        const t = Math.floor(new Date(String(v)).getTime() / 1000);
        return Number.isFinite(t) ? t : fallback;
      };
      const fromSec = parse(req.query.from, now - 30 * 86400);
      const toSec = parse(req.query.to, now);
      res.json(await getInvestmentReport(req.organizationId, fromSec, toSec));
    } catch (e) { res.status(500).json({ message: 'No se pudo generar el reporte de inversiones' }); }
  });

  app.post('/api/market-investments', requireAuth, requirePermission('transactions:create'), async (req: any, res: Response) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim();
      const symbol = String(b.symbol || '').trim();
      if (!name || !symbol) return res.status(400).json({ message: 'Nombre y símbolo son obligatorios' });
      const row = await investments.createInvestment({
        organizationId: req.organizationId, name, symbol, assetType: parseAssetType(b.assetType),
        quantity: b.quantity ?? '0', buyPrice: b.buyPrice ?? null, currency: b.currency || 'ARS',
        buyDate: b.buyDate || null, broker: b.broker || null, notes: b.notes || null, createdBy: req.userId,
      });
      res.json(row);
    } catch { res.status(500).json({ message: 'No se pudo crear la inversión' }); }
  });

  app.patch('/api/market-investments/:id', requireAuth, requirePermission('transactions:create'), async (req: any, res: Response) => {
    try {
      const b = req.body || {};
      const patch: any = {};
      for (const k of ['name', 'symbol', 'quantity', 'buyPrice', 'currency', 'buyDate', 'broker', 'notes']) {
        if (b[k] !== undefined) patch[k] = b[k];
      }
      if (b.assetType !== undefined) patch.assetType = parseAssetType(b.assetType);
      const row = await investments.updateInvestment(req.params.id, req.organizationId, patch, req.userId);
      if (!row) return res.status(404).json({ message: 'No encontrada' });
      res.json(row);
    } catch { res.status(500).json({ message: 'No se pudo actualizar' }); }
  });

  app.delete('/api/market-investments/:id', requireAuth, requirePermission('transactions:create'), async (req: any, res: Response) => {
    try {
      const ok = await investments.deleteInvestment(req.params.id, req.organizationId, req.userId);
      if (!ok) return res.status(404).json({ message: 'No encontrada' });
      res.json({ ok: true });
    } catch { res.status(500).json({ message: 'No se pudo eliminar' }); }
  });
}
