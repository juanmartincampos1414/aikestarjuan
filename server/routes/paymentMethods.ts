import type { Express } from 'express';
import { z } from 'zod';
import { storage } from '../storage';
import { requireAuth, requirePermission, sanitizeError } from './middleware';
import {
  insertPaymentMethodSchema,
  insertPaymentMethodConceptSchema,
  MAX_PAYMENT_METHOD_CONCEPTS,
} from '@shared/schema';

// Schema used to receive a payment method along with its concepts in a single
// payload. Concepts arrive without a paymentMethodId because the parent does
// not exist yet (or, on PATCH, we ignore the supplied id and replace).
const conceptInputSchema = insertPaymentMethodConceptSchema
  .omit({ paymentMethodId: true })
  .superRefine((data, ctx) => {
    if (data.kind === 'percentage') {
      const num = Number(data.value);
      if (!Number.isFinite(num) || num <= 0 || num > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: 'El porcentaje debe estar entre 0.0001 y 100',
        });
      }
    } else if (data.kind === 'fixed') {
      const num = Number(data.value);
      if (!Number.isFinite(num) || num <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: 'El monto fijo debe ser mayor que 0',
        });
      }
    }
  });

const conceptsArraySchema = z
  .array(conceptInputSchema)
  .max(MAX_PAYMENT_METHOD_CONCEPTS, `Máximo ${MAX_PAYMENT_METHOD_CONCEPTS} conceptos por medio de cobro`);

const createPaymentMethodSchema = insertPaymentMethodSchema
  .omit({ organizationId: true })
  .extend({
    concepts: conceptsArraySchema.default([]),
  });

const updatePaymentMethodSchema = insertPaymentMethodSchema
  .omit({ organizationId: true })
  .partial()
  .extend({
    concepts: conceptsArraySchema.optional(),
  });

export function registerPaymentMethodsRoutes(app: Express) {
  // List all payment methods for the current organization (with concepts)
  app.get('/api/payment-methods', requireAuth, async (req: any, res) => {
    try {
      const activeOnly = req.query.activeOnly === 'true';
      const methods = await storage.getPaymentMethodsByOrganization(req.organizationId, activeOnly);
      res.json(methods);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Get one payment method (org-scoped)
  app.get('/api/payment-methods/:id', requireAuth, async (req: any, res) => {
    try {
      const method = await storage.getPaymentMethodWithConcepts(req.params.id);
      if (!method || method.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Medio de cobro no encontrado' });
      }
      res.json(method);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Create
  app.post('/api/payment-methods', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const parsed = createPaymentMethodSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parsed.error.flatten() });
      }
      const { concepts, ...methodData } = parsed.data;
      const created = await storage.createPaymentMethodWithConcepts(
        { ...methodData, organizationId: req.organizationId },
        concepts.map((c, idx) => ({ ...c, position: c.position ?? idx })),
      );
      res.status(201).json(created);
    } catch (error: any) {
      if (String(error?.message || '').match(/duplicate key|unique constraint/i)) {
        return res.status(409).json({ message: 'Ya existe un medio de cobro con ese nombre en esta organización' });
      }
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Update (PATCH): updates the parent fields and (if `concepts` is present)
  // replaces the concept list atomically.
  app.patch('/api/payment-methods/:id', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const existing = await storage.getPaymentMethodWithConcepts(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Medio de cobro no encontrado' });
      }
      const { organizationId: _ignored, id: _ignoreId, createdAt: _ignoreCreated, ...rest } = req.body || {};
      const parsed = updatePaymentMethodSchema.safeParse(rest);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parsed.error.flatten() });
      }
      const { concepts, ...updates } = parsed.data;
      const conceptsForStorage = concepts === undefined
        ? undefined
        : concepts.map((c, idx) => ({ ...c, position: c.position ?? idx }));
      const updated = await storage.updatePaymentMethodWithConcepts(
        req.params.id,
        updates,
        conceptsForStorage,
      );
      res.json(updated);
    } catch (error: any) {
      if (String(error?.message || '').match(/duplicate key|unique constraint/i)) {
        return res.status(409).json({ message: 'Ya existe un medio de cobro con ese nombre en esta organización' });
      }
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Delete: hard-delete cascades concepts. Existing transactions keep their
  // payment_method_id pointer (FK is deliberately not enforced) so historical
  // data resolves as "Medio eliminado" at read time.
  app.delete('/api/payment-methods/:id', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const existing = await storage.getPaymentMethodWithConcepts(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Medio de cobro no encontrado' });
      }
      await storage.deletePaymentMethod(req.params.id);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
}
