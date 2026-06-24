// =============================================================================
// AIKESTAR - Rutas de Remitos
// =============================================================================
import type { Express, Response } from 'express';
import { requireAuth, requirePermission } from './middleware';
import * as remitos from '../services/remitoService';

export function registerRemitoRoutes(app: Express): void {
  app.get('/api/remitos', requireAuth, async (req: any, res: Response) => {
    try { res.json(await remitos.listRemitos(req.organizationId)); } catch { res.status(500).json({ message: 'Error' }); }
  });

  app.get('/api/remitos/:id', requireAuth, async (req: any, res: Response) => {
    try {
      const r = await remitos.getRemito(req.params.id);
      if (!r || r.remito.organizationId !== req.organizationId) return res.status(404).json({ message: 'No encontrado' });
      res.json(r);
    } catch { res.status(500).json({ message: 'Error' }); }
  });

  // Crear manual
  app.post('/api/remitos', requireAuth, requirePermission('transactions:create'), async (req: any, res: Response) => {
    try {
      const b = req.body || {};
      const items = Array.isArray(b.items) ? b.items.filter((it: any) => it && it.description) : [];
      if (items.length === 0) return res.status(400).json({ message: 'Agregá al menos un ítem' });
      const remito = await remitos.createRemito({
        organizationId: req.organizationId, clientId: b.clientId || null, clientName: b.clientName || null,
        notes: b.notes || null, items, applyStock: !!b.applyStock, createdBy: req.userId,
      });
      res.json(remito);
    } catch (e: any) { res.status(500).json({ message: 'No se pudo crear el remito' }); }
  });

  // Generar desde un presupuesto
  app.post('/api/remitos/from-quote/:quoteId', requireAuth, requirePermission('transactions:create'), async (req: any, res: Response) => {
    try {
      const remito = await remitos.createFromQuote(req.params.quoteId, req.organizationId, !!req.body?.applyStock, req.userId);
      if (!remito) return res.status(404).json({ message: 'Presupuesto no encontrado' });
      res.json(remito);
    } catch { res.status(500).json({ message: 'No se pudo generar el remito' }); }
  });

  // Generar desde una orden de trabajo (materiales)
  app.post('/api/remitos/from-work-order/:workOrderId', requireAuth, requirePermission('transactions:create'), async (req: any, res: Response) => {
    try {
      const remito = await remitos.createFromWorkOrder(req.params.workOrderId, req.organizationId, !!req.body?.applyStock, req.userId);
      if (!remito) return res.status(404).json({ message: 'Orden no encontrada' });
      res.json(remito);
    } catch { res.status(500).json({ message: 'No se pudo generar el remito' }); }
  });

  app.post('/api/remitos/:id/cancel', requireAuth, requirePermission('transactions:create'), async (req: any, res: Response) => {
    try { res.json(await remitos.cancelRemito(req.params.id, req.organizationId, req.userId)); }
    catch { res.status(500).json({ message: 'Error' }); }
  });
}
