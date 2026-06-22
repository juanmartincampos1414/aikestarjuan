// =============================================================================
// AIKESTAR - Rutas de Órdenes de Trabajo
// =============================================================================
import type { Express, Response } from 'express';
import { requireAuth, requirePermission } from './middleware';
import * as wo from '../services/workOrderService';
import { WORK_ORDER_STATES, type WorkOrderState } from '@shared/schema';

export function registerWorkOrderRoutes(app: Express): void {
  app.get('/api/work-orders', requireAuth, requirePermission('workorders:read'), async (req: any, res: Response) => {
    try { res.json(await wo.listWorkOrders(req.organizationId, { status: req.query.status, priority: req.query.priority })); }
    catch { res.status(500).json({ message: 'Error' }); }
  });

  app.get('/api/work-orders/metrics', requireAuth, requirePermission('workorders:read'), async (req: any, res: Response) => {
    try { res.json(await wo.getOpsMetrics(req.organizationId)); } catch { res.status(500).json({ message: 'Error' }); }
  });

  app.get('/api/work-orders/:id', requireAuth, requirePermission('workorders:read'), async (req: any, res: Response) => {
    try {
      const detail = await wo.getDetail(req.params.id);
      if (!detail || detail.workOrder.organizationId !== req.organizationId) return res.status(404).json({ message: 'No encontrada' });
      res.json(detail);
    } catch { res.status(500).json({ message: 'Error' }); }
  });

  app.post('/api/work-orders', requireAuth, requirePermission('workorders:write'), async (req: any, res: Response) => {
    try {
      const b = req.body || {};
      if (!b.title) return res.status(400).json({ message: 'El título es requerido' });
      const created = await wo.createWorkOrder({
        organizationId: req.organizationId, title: b.title, clientId: b.clientId || null,
        ownerUserId: b.ownerUserId || req.userId, priority: b.priority || 'medium',
        scheduledDate: b.scheduledDate ? new Date(b.scheduledDate) : null, createdBy: req.userId,
      });
      res.json(created);
    } catch { res.status(500).json({ message: 'No se pudo crear la orden' }); }
  });

  async function ownGuard(req: any, res: Response): Promise<boolean> {
    const order = await wo.getWorkOrder(req.params.id);
    if (!order || order.organizationId !== req.organizationId) { res.status(404).json({ message: 'No encontrada' }); return false; }
    return true;
  }

  app.patch('/api/work-orders/:id', requireAuth, requirePermission('workorders:write'), async (req: any, res: Response) => {
    try {
      if (!(await ownGuard(req, res))) return;
      const b = req.body || {};
      const patch: any = {};
      for (const k of ['title', 'priority', 'technicalNotes', 'clientId', 'ownerUserId']) if (b[k] !== undefined) patch[k] = b[k];
      if (b.hoursWorked !== undefined) patch.hoursWorked = String(b.hoursWorked);
      if (b.scheduledDate !== undefined) patch.scheduledDate = b.scheduledDate ? new Date(b.scheduledDate) : null;
      res.json(await wo.updateWorkOrder(req.params.id, patch, req.userId));
    } catch { res.status(500).json({ message: 'Error' }); }
  });

  app.post('/api/work-orders/:id/transition', requireAuth, requirePermission('workorders:write'), async (req: any, res: Response) => {
    try {
      if (!(await ownGuard(req, res))) return;
      const status = req.body?.status as WorkOrderState;
      if (!WORK_ORDER_STATES.includes(status)) return res.status(400).json({ message: 'Estado inválido' });
      res.json(await wo.transition(req.params.id, status, req.userId));
    } catch { res.status(500).json({ message: 'Error' }); }
  });

  app.post('/api/work-orders/:id/assignments', requireAuth, requirePermission('workorders:write'), async (req: any, res: Response) => {
    try { if (!(await ownGuard(req, res))) return; res.json(await wo.addAssignment(req.params.id, req.body?.employeeId, req.userId)); }
    catch { res.status(500).json({ message: 'Error' }); }
  });
  app.delete('/api/work-orders/assignments/:assignId', requireAuth, requirePermission('workorders:write'), async (req: any, res: Response) => {
    try { await wo.removeAssignment(req.params.assignId); res.json({ ok: true }); } catch { res.status(500).json({ message: 'Error' }); }
  });

  app.post('/api/work-orders/:id/materials', requireAuth, requirePermission('workorders:write'), async (req: any, res: Response) => {
    try {
      if (!(await ownGuard(req, res))) return;
      const b = req.body || {};
      if (!b.description) return res.status(400).json({ message: 'Descripción requerida' });
      res.json(await wo.addMaterial(req.params.id, { description: b.description, quantity: b.quantity != null ? String(b.quantity) : '1', unitCost: b.unitCost != null ? String(b.unitCost) : '0', productId: b.productId || null }, req.userId));
    } catch { res.status(500).json({ message: 'Error' }); }
  });
  app.delete('/api/work-orders/materials/:matId', requireAuth, requirePermission('workorders:write'), async (req: any, res: Response) => {
    try { await wo.removeMaterial(req.params.matId); res.json({ ok: true }); } catch { res.status(500).json({ message: 'Error' }); }
  });

  app.post('/api/work-orders/:id/photos', requireAuth, requirePermission('workorders:write'), async (req: any, res: Response) => {
    try {
      if (!(await ownGuard(req, res))) return;
      const url = String(req.body?.url || '').trim();
      if (!/^https?:\/\//.test(url)) return res.status(400).json({ message: 'URL de imagen inválida' });
      res.json(await wo.addPhoto(req.params.id, url, req.body?.caption || null, req.userId));
    } catch { res.status(500).json({ message: 'Error' }); }
  });
  app.delete('/api/work-orders/photos/:photoId', requireAuth, requirePermission('workorders:write'), async (req: any, res: Response) => {
    try { await wo.removePhoto(req.params.photoId); res.json({ ok: true }); } catch { res.status(500).json({ message: 'Error' }); }
  });
}
