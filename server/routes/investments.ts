// =============================================================================
// AIKESTAR - Rutas de Inversiones
// =============================================================================
import type { Express, Response } from 'express';
import { requireAuth, requirePermission } from './middleware';
import { INVESTMENT_ASSET_TYPES, type InvestmentAssetType } from '@shared/schema';
import * as investments from '../services/investmentService';

function parseAssetType(v: any): InvestmentAssetType {
  return (INVESTMENT_ASSET_TYPES as readonly string[]).includes(v) ? v : 'otro';
}

export function registerInvestmentRoutes(app: Express): void {
  // Cartera con cotizaciones en vivo + totales por moneda.
  app.get('/api/market-investments', requireAuth, async (req: any, res: Response) => {
    try { res.json(await investments.getPortfolio(req.organizationId)); }
    catch (e) { res.status(500).json({ message: 'No se pudieron cargar las inversiones' }); }
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
