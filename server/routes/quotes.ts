import type { Express } from 'express';
import { z } from 'zod';
import { storage } from '../storage';
import { requireAuth, requirePermission, sanitizeError } from './middleware';
import { insertQuoteSchema, type InsertQuoteItem } from '@shared/schema';
import * as crm from '../services/crmService';
import * as workOrders from '../services/workOrderService';

// Task #481: line items (productos/servicios) sent alongside a quote.
// `productId` is optional/nullable so a line can be free-text (un servicio sin
// producto del catálogo). Quantities/prices arrive as numbers or strings.
const quoteItemInputSchema = z.object({
  productId: z.string().min(1).nullable().optional(),
  description: z.string().nullable().optional(),
  quantity: z.union([z.string(), z.number()]),
  unitPrice: z.union([z.string(), z.number()]),
  profitabilityCodeId: z.string().min(1).nullable().optional(),
});
const quoteItemsInputSchema = z.array(quoteItemInputSchema);

type BuiltQuoteItems = { items: Omit<InsertQuoteItem, 'quoteId'>[]; amount: string };

// Validate raw line items, check product/profitability ownership and compute
// the quote total from the items. Throws an Error (message-friendly) on any
// invalid input so the route can map it to a 400.
async function buildQuoteItems(
  organizationId: string,
  rawItems: unknown,
): Promise<BuiltQuoteItems> {
  const parsed = quoteItemsInputSchema.safeParse(rawItems);
  if (!parsed.success) {
    throw new Error('Renglones inválidos');
  }
  const lines = parsed.data;
  if (lines.length === 0) return { items: [], amount: '0' };

  // Resolve org catalogs once for ownership validation + description defaults.
  const products = await storage.getProductsByOrganization(organizationId);
  const codes = await storage.getProfitabilityCodesByOrganization(organizationId);
  const productById = new Map(products.map((p) => [p.id, p]));
  const codeIds = new Set(codes.map((c) => c.id));

  let total = 0;
  const items: Omit<InsertQuoteItem, 'quoteId'>[] = [];
  for (const line of lines) {
    const qty = parseFloat(String(line.quantity));
    const price = parseFloat(String(line.unitPrice));
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error('Cada renglón necesita una cantidad mayor a 0');
    }
    if (!Number.isFinite(price) || price < 0) {
      throw new Error('Cada renglón necesita un precio unitario válido');
    }
    let productId: string | null = line.productId ?? null;
    if (productId) {
      const product = productById.get(productId);
      if (!product) {
        throw new Error('Uno de los productos seleccionados no es válido');
      }
    }
    let codeId: string | null = line.profitabilityCodeId ?? null;
    if (codeId && !codeIds.has(codeId)) {
      throw new Error('Uno de los códigos de rentabilidad no es válido');
    }
    const desc = (line.description ?? '').trim();
    const resolvedDesc = desc || (productId ? productById.get(productId)?.name ?? null : null);
    if (!productId && !resolvedDesc) {
      throw new Error('Cada renglón necesita un producto o una descripción');
    }
    total += qty * price;
    items.push({
      organizationId,
      productId,
      description: resolvedDesc,
      quantity: String(qty),
      unitPrice: String(price),
      profitabilityCodeId: codeId,
    });
  }
  return { items, amount: total.toFixed(2) };
}

export function registerQuoteRoutes(app: Express) {
  // List quotes for the current organization (optional ?status=)
  app.get('/api/quotes', requireAuth, async (req: any, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const list = await storage.getQuotesByOrganization(req.organizationId, status);
      // Task #481: attach line items (productos/servicios) per quote in one batch.
      const items = await storage.getQuoteItemsByQuoteIds(list.map((q) => q.id));
      const itemsByQuote = new Map<string, typeof items>();
      for (const it of items) {
        const arr = itemsByQuote.get(it.quoteId) || [];
        arr.push(it);
        itemsByQuote.set(it.quoteId, arr);
      }
      res.json(list.map((q) => ({ ...q, items: itemsByQuote.get(q.id) || [] })));
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Get one quote (org-scoped)
  app.get('/api/quotes/:id', requireAuth, async (req: any, res) => {
    try {
      const quote = await storage.getQuote(req.params.id);
      if (!quote || quote.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Presupuesto no encontrado' });
      }
      const items = await storage.getQuoteItems(quote.id);
      res.json({ ...quote, items });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Create a quote
  app.post('/api/quotes', requireAuth, requirePermission('transactions:create'), async (req: any, res) => {
    try {
      const parsed = insertQuoteSchema.safeParse({
        ...req.body,
        organizationId: req.organizationId,
        createdBy: req.userId,
      });
      if (!parsed.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parsed.error.flatten() });
      }
      // Validate clientId belongs to org if provided
      if (parsed.data.clientId) {
        const client = await storage.getClient(parsed.data.clientId);
        if (!client || client.organizationId !== req.organizationId) {
          return res.status(400).json({ message: 'El cliente seleccionado no es válido' });
        }
      }
      // Task #481: optional line items. When present, the quote total is derived
      // from the items (the sent `amount` is ignored). Empty/absent keeps legacy
      // single-amount behavior.
      let built: BuiltQuoteItems | null = null;
      if (Array.isArray(req.body?.items) && req.body.items.length > 0) {
        try {
          built = await buildQuoteItems(req.organizationId, req.body.items);
        } catch (e: any) {
          return res.status(400).json({ message: e?.message || 'Renglones inválidos' });
        }
      }
      const created = await storage.createQuote(
        built ? { ...parsed.data, amount: built.amount } : parsed.data,
      );
      if (built && built.items.length > 0) {
        await storage.createQuoteItems(built.items.map((it) => ({ ...it, quoteId: created.id })));
      }
      const items = await storage.getQuoteItems(created.id);
      // CRM: vincular/crear oportunidad (no bloqueante).
      crm.onQuoteCreated(created, req.userId).catch((e) => console.error('[CRM] onQuoteCreated:', e?.message || e));
      res.status(201).json({ ...created, items });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Update a quote
  app.patch('/api/quotes/:id', requireAuth, requirePermission('transactions:create'), async (req: any, res) => {
    try {
      const existing = await storage.getQuote(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Presupuesto no encontrado' });
      }
      // Status transitions go through the dedicated win/lose/reopen endpoints so
      // the state machine (and its derived fields) stays consistent. Strip it here.
      const { organizationId: _o, id: _i, createdAt: _c, createdBy: _cb, status: _s, items: _items, ...rest } = req.body || {};
      const parsed = insertQuoteSchema.partial().safeParse(rest);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parsed.error.flatten() });
      }
      if (parsed.data.clientId) {
        const client = await storage.getClient(parsed.data.clientId);
        if (!client || client.organizationId !== req.organizationId) {
          return res.status(400).json({ message: 'El cliente seleccionado no es válido' });
        }
      }
      // Task #481: when `items` is sent, replace the quote's line items. A
      // non-empty array derives the total from the items; an empty array clears
      // them and falls back to the legacy single amount sent in the body. When
      // `items` is absent, the existing items are left untouched.
      const updates: any = { ...parsed.data };
      let built: BuiltQuoteItems | null = null;
      const hasItemsKey = Array.isArray(_items);
      if (hasItemsKey && _items.length > 0) {
        try {
          built = await buildQuoteItems(req.organizationId, _items);
        } catch (e: any) {
          return res.status(400).json({ message: e?.message || 'Renglones inválidos' });
        }
        updates.amount = built.amount;
      }
      const updated = await storage.updateQuote(req.params.id, updates);
      if (hasItemsKey) {
        await storage.deleteQuoteItems(req.params.id);
        if (built && built.items.length > 0) {
          await storage.createQuoteItems(built.items.map((it) => ({ ...it, quoteId: req.params.id })));
        }
      }
      const items = await storage.getQuoteItems(req.params.id);
      res.json({ ...updated, items });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Delete a quote (does NOT delete a linked movement)
  app.delete('/api/quotes/:id', requireAuth, requirePermission('transactions:create'), async (req: any, res) => {
    try {
      const existing = await storage.getQuote(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Presupuesto no encontrado' });
      }
      const ok = await storage.deleteQuote(req.params.id);
      if (!ok) return res.status(404).json({ message: 'Presupuesto no encontrado' });
      res.json({ success: true, deleted: true });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Mark a quote as won, linking it to an already-created transaction.
  // The frontend creates the movement via POST /api/transactions (reusing all
  // the existing side effects) and then sends its id here.
  app.post('/api/quotes/:id/win', requireAuth, requirePermission('transactions:create'), async (req: any, res) => {
    try {
      const existing = await storage.getQuote(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Presupuesto no encontrado' });
      }
      const { transactionId } = req.body || {};
      if (!transactionId || typeof transactionId !== 'string') {
        return res.status(400).json({ message: 'Falta el movimiento asociado' });
      }
      // Idempotent: if the quote was already won (e.g. a retry after the network
      // dropped the previous success response), return it as-is instead of
      // re-marking it. This is what lets the client safely retry the win step.
      if (existing.status === 'won') {
        return res.json(existing);
      }
      if (existing.status !== 'pending') {
        return res.status(409).json({ message: 'El presupuesto no está pendiente' });
      }
      const tx = await storage.getTransaction(transactionId);
      if (!tx || tx.organizationId !== req.organizationId) {
        return res.status(400).json({ message: 'El movimiento asociado no es válido' });
      }
      const updated = await storage.markQuoteWon(req.params.id, transactionId);
      if (!updated) {
        // Lost the race against a concurrent transition.
        return res.status(409).json({ message: 'El presupuesto cambió de estado' });
      }
      // CRM: mover la oportunidad a "Aprobado" + generar la Orden de Trabajo (no bloqueante).
      crm.onQuoteWon(updated, req.userId).catch((e) => console.error('[CRM] onQuoteWon:', e?.message || e));
      workOrders.createFromQuote(updated, req.userId).catch((e) => console.error('[WO] createFromQuote:', e?.message || e));
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Mark a quote as lost (only from pending)
  app.post('/api/quotes/:id/lose', requireAuth, requirePermission('transactions:create'), async (req: any, res) => {
    try {
      const existing = await storage.getQuote(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Presupuesto no encontrado' });
      }
      if (existing.status !== 'pending') {
        return res.status(409).json({ message: 'Solo se puede marcar como perdido un presupuesto pendiente' });
      }
      const updated = await storage.markQuoteLost(req.params.id);
      if (!updated) {
        return res.status(409).json({ message: 'El presupuesto cambió de estado' });
      }
      // CRM: mover la oportunidad a "Perdido" (no bloqueante).
      crm.onQuoteLost(updated, req.userId).catch((e) => console.error('[CRM] onQuoteLost:', e?.message || e));
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Reopen a lost quote back to pending (clears derived fields)
  app.post('/api/quotes/:id/reopen', requireAuth, requirePermission('transactions:create'), async (req: any, res) => {
    try {
      const existing = await storage.getQuote(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Presupuesto no encontrado' });
      }
      if (existing.status !== 'lost') {
        return res.status(409).json({ message: 'Solo se puede reabrir un presupuesto perdido' });
      }
      const updated = await storage.reopenQuote(req.params.id);
      if (!updated) {
        return res.status(409).json({ message: 'El presupuesto cambió de estado' });
      }
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
}
