// =============================================================================
// AIKESTAR - Rutas del CRM comercial
// =============================================================================
import type { Express, Response } from 'express';
import { requireAuth, requirePermission } from './middleware';
import * as crm from '../services/crmService';
import { runCrmCommand } from '../services/crmAiAgent';
import { CRM_STAGES, type CrmStage } from '@shared/schema';

export function registerCrmRoutes(app: Express): void {
  // Comando en lenguaje natural → acciones sobre el CRM (IA con tool-calling).
  app.post('/api/ai/command', requireAuth, requirePermission('crm:write'), async (req: any, res: Response) => {
    try {
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ message: 'Escribí qué querés hacer.' });
      const result = await runCrmCommand(text, { organizationId: req.organizationId, userId: req.userId });
      res.json(result);
    } catch (e: any) {
      console.error('[CRM/AI] command error:', e?.message || e);
      res.status(500).json({ message: 'No pude procesar el comando. Probá de nuevo.' });
    }
  });

  // Board Kanban (agrupado por etapa, con contador y total $)
  app.get('/api/crm/board', requireAuth, requirePermission('crm:read'), async (req: any, res: Response) => {
    try {
      const board = await crm.getBoard(req.organizationId, {
        ownerUserId: req.query.owner || undefined,
        q: req.query.q || undefined,
      });
      res.json(board);
    } catch (e: any) { res.status(500).json({ message: 'No se pudo cargar el CRM' }); }
  });

  app.get('/api/crm/metrics', requireAuth, requirePermission('crm:read'), async (req: any, res: Response) => {
    try { res.json(await crm.getCrmMetrics(req.organizationId)); }
    catch { res.status(500).json({ message: 'Error' }); }
  });

  // Eventos para el calendario (visitas/seguimientos, vencimientos, trabajos programados).
  app.get('/api/calendar/crm-events', requireAuth, requirePermission('crm:read'), async (req: any, res: Response) => {
    try {
      const from = req.query.from ? new Date(req.query.from) : undefined;
      const to = req.query.to ? new Date(req.query.to) : undefined;
      res.json(await crm.getCalendarEvents(req.organizationId, from, to));
    } catch { res.status(500).json({ message: 'Error' }); }
  });

  app.get('/api/crm/opportunities', requireAuth, requirePermission('crm:read'), async (req: any, res: Response) => {
    try {
      res.json(await crm.listOpportunities(req.organizationId, { ownerUserId: req.query.owner, q: req.query.q, status: req.query.status }));
    } catch { res.status(500).json({ message: 'Error' }); }
  });

  app.get('/api/crm/opportunities/:id', requireAuth, requirePermission('crm:read'), async (req: any, res: Response) => {
    try {
      const opp = await crm.getOpportunity(req.params.id);
      if (!opp || opp.organizationId !== req.organizationId) return res.status(404).json({ message: 'No encontrada' });
      const activities = await crm.getActivities(opp.id);
      res.json({ opportunity: opp, activities });
    } catch { res.status(500).json({ message: 'Error' }); }
  });

  app.post('/api/crm/opportunities', requireAuth, requirePermission('crm:write'), async (req: any, res: Response) => {
    try {
      const b = req.body || {};
      if (!b.title || String(b.title).trim().length < 2) return res.status(400).json({ message: 'El título es requerido' });
      const opp = await crm.createOpportunity({
        organizationId: req.organizationId,
        title: b.title, clientId: b.clientId || null, contactName: b.contactName || null,
        phone: b.phone || null, email: b.email || null, description: b.description || null,
        estimatedValue: b.estimatedValue != null ? String(b.estimatedValue) : '0',
        currency: b.currency || 'ARS', probability: b.probability ?? 50,
        stage: b.stage, ownerUserId: b.ownerUserId || req.userId,
        expectedCloseDate: b.expectedCloseDate ? new Date(b.expectedCloseDate) : null,
        nextFollowupAt: b.nextFollowupAt ? new Date(b.nextFollowupAt) : null,
        createdBy: req.userId,
      });
      res.json(opp);
    } catch (e: any) { res.status(500).json({ message: 'No se pudo crear la oportunidad' }); }
  });

  app.patch('/api/crm/opportunities/:id', requireAuth, requirePermission('crm:write'), async (req: any, res: Response) => {
    try {
      const opp = await crm.getOpportunity(req.params.id);
      if (!opp || opp.organizationId !== req.organizationId) return res.status(404).json({ message: 'No encontrada' });
      const b = req.body || {};
      const patch: any = {};
      for (const k of ['title', 'contactName', 'phone', 'email', 'description', 'clientId', 'currency', 'probability', 'ownerUserId', 'lostReason']) {
        if (b[k] !== undefined) patch[k] = b[k];
      }
      if (b.estimatedValue !== undefined) patch.estimatedValue = String(b.estimatedValue);
      if (b.expectedCloseDate !== undefined) patch.expectedCloseDate = b.expectedCloseDate ? new Date(b.expectedCloseDate) : null;
      if (b.nextFollowupAt !== undefined) patch.nextFollowupAt = b.nextFollowupAt ? new Date(b.nextFollowupAt) : null;
      res.json(await crm.updateOpportunity(req.params.id, patch, req.userId));
    } catch { res.status(500).json({ message: 'Error' }); }
  });

  app.post('/api/crm/opportunities/:id/move', requireAuth, requirePermission('crm:write'), async (req: any, res: Response) => {
    try {
      const stage = req.body?.stage as CrmStage;
      if (!CRM_STAGES.includes(stage)) return res.status(400).json({ message: 'Etapa inválida' });
      const opp = await crm.getOpportunity(req.params.id);
      if (!opp || opp.organizationId !== req.organizationId) return res.status(404).json({ message: 'No encontrada' });
      res.json(await crm.moveStage(req.params.id, stage, req.userId));
    } catch { res.status(500).json({ message: 'Error' }); }
  });

  app.post('/api/crm/opportunities/:id/activities', requireAuth, requirePermission('crm:write'), async (req: any, res: Response) => {
    try {
      const opp = await crm.getOpportunity(req.params.id);
      if (!opp || opp.organizationId !== req.organizationId) return res.status(404).json({ message: 'No encontrada' });
      const b = req.body || {};
      const act = await crm.addActivity({
        opportunityId: opp.id, organizationId: req.organizationId,
        type: b.type || 'note', content: b.content || null,
        scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : null,
        createdByUserId: req.userId,
      });
      res.json(act);
    } catch { res.status(500).json({ message: 'Error' }); }
  });
}
