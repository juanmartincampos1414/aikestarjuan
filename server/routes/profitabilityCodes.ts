import type { Express } from 'express';
import { storage } from '../storage';
import { requireAuth, requirePermission, sanitizeError } from './middleware';
import { insertProfitabilityCodeSchema } from '@shared/schema';

export function registerProfitabilityCodesRoutes(app: Express) {
  // List all codes for the current organization
  app.get('/api/profitability-codes', requireAuth, async (req: any, res) => {
    try {
      const activeOnly = req.query.activeOnly === 'true';
      const includeArchived = req.query.includeArchived === 'true'; // Task #363
      const codes = await storage.getProfitabilityCodesByOrganization(req.organizationId, activeOnly, includeArchived);
      res.json(codes);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Get one code (org-scoped)
  app.get('/api/profitability-codes/:id', requireAuth, async (req: any, res) => {
    try {
      const code = await storage.getProfitabilityCode(req.params.id);
      if (!code || code.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Código no encontrado' });
      }
      res.json(code);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Create
  app.post('/api/profitability-codes', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const parsed = insertProfitabilityCodeSchema.safeParse({
        ...req.body,
        organizationId: req.organizationId,
      });
      if (!parsed.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parsed.error.flatten() });
      }
      // Enforce case-insensitive uniqueness per organization (also enforced at DB level)
      const existing = await storage.findProfitabilityCodeByCode(req.organizationId, parsed.data.code);
      if (existing) {
        return res.status(409).json({ message: `Ya existe un código "${parsed.data.code}" en esta organización` });
      }
      const created = await storage.createProfitabilityCode(parsed.data);
      res.status(201).json(created);
    } catch (error: any) {
      if (String(error?.message || '').match(/duplicate key|unique constraint/i)) {
        return res.status(409).json({ message: 'Ya existe un código con ese identificador' });
      }
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Update
  app.patch('/api/profitability-codes/:id', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const existing = await storage.getProfitabilityCode(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Código no encontrado' });
      }
      // Strip organizationId from updates so callers can't move codes across orgs
      const { organizationId: _ignored, id: _ignoreId, createdAt: _ignoreCreated, ...rest } = req.body || {};
      const parsed = insertProfitabilityCodeSchema.partial().safeParse(rest);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parsed.error.flatten() });
      }
      // If renaming the code, check uniqueness collision
      if (parsed.data.code && parsed.data.code.toLowerCase() !== existing.code.toLowerCase()) {
        const collision = await storage.findProfitabilityCodeByCode(req.organizationId, parsed.data.code);
        if (collision && collision.id !== existing.id) {
          return res.status(409).json({ message: `Ya existe un código "${parsed.data.code}" en esta organización` });
        }
      }
      const updated = await storage.updateProfitabilityCode(req.params.id, parsed.data);
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Task #363: DELETE intenta borrar; si tiene historia → archiva. force=true (owner/admin) elimina o falla 409.
  app.delete('/api/profitability-codes/:id', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const existing = await storage.getProfitabilityCode(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Código no encontrado' });
      }
      const force = req.query.force === 'true' || req.query.force === true;
      if (force) {
        const role = (req as any).membership?.role as string | undefined;
        if (role !== 'owner' && role !== 'admin') {
          return res.status(403).json({ message: 'Solo propietarios y administradores pueden eliminar definitivamente' });
        }
      }
      try {
        const success = await storage.deleteProfitabilityCode(req.params.id);
        if (!success) return res.status(404).json({ message: 'Código no encontrado' });
        await storage.createAuditLog({
          organizationId: req.organizationId, userId: req.userId,
          entityType: 'profitability_code', entityId: req.params.id,
          action: force ? 'hard_deleted' : 'delete',
          previousData: JSON.stringify(existing),
          newData: force ? JSON.stringify({ forced: true }) : null,
        });
        return res.json({ success: true, deleted: true });
      } catch (delErr: any) {
        const code = delErr?.code || delErr?.cause?.code;
        if (code === '23503') {
          if (force) {
            return res.status(409).json({ message: 'No se puede eliminar definitivamente: el código está usado por movimientos o productos' });
          }
          const archived = await storage.archiveProfitabilityCode(req.params.id);
          await storage.createAuditLog({
            organizationId: req.organizationId, userId: req.userId,
            entityType: 'profitability_code', entityId: req.params.id, action: 'archived',
            previousData: JSON.stringify(existing),
            newData: archived ? JSON.stringify({ archivedAt: archived.archivedAt }) : null,
          });
          return res.json({ success: true, archived: true });
        }
        throw delErr;
      }
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Task #363: archivar / desarchivar código
  app.post('/api/profitability-codes/:id/archive', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const existing = await storage.getProfitabilityCode(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Código no encontrado' });
      }
      const archived = await storage.archiveProfitabilityCode(req.params.id);
      await storage.createAuditLog({
        organizationId: req.organizationId, userId: req.userId,
        entityType: 'profitability_code', entityId: req.params.id, action: 'archived',
        previousData: JSON.stringify(existing),
        newData: archived ? JSON.stringify({ archivedAt: archived.archivedAt }) : null,
      });
      res.json({ success: true, code: archived });
    } catch (error: any) { res.status(500).json({ message: sanitizeError(error) }); }
  });

  app.post('/api/profitability-codes/:id/unarchive', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const existing = await storage.getProfitabilityCode(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Código no encontrado' });
      }
      const restored = await storage.unarchiveProfitabilityCode(req.params.id);
      await storage.createAuditLog({
        organizationId: req.organizationId, userId: req.userId,
        entityType: 'profitability_code', entityId: req.params.id, action: 'unarchived',
        previousData: JSON.stringify(existing),
        newData: restored ? JSON.stringify({ archivedAt: null }) : null,
      });
      res.json({ success: true, code: restored });
    } catch (error: any) { res.status(500).json({ message: sanitizeError(error) }); }
  });
}
