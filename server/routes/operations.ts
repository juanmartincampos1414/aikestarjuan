import type { Express } from "express";
import { storage } from "../storage";
import { db } from "../db";
import { requireAuth, requirePermission, sanitizeError } from "./middleware";
import { stashForUndo } from "../services/undoTrash";
import { transactions } from "@shared/schema";
import { eq, and, gte, lte } from "drizzle-orm";

type ContactBulkEntity = 'client' | 'supplier';

// Importación masiva de clientes / proveedores desde Excel. Espeja el flujo de
// productos (/api/products/bulk-import): parseo en el navegador, el front manda
// las filas como JSON, acá validamos con header tolerante (NFD-strip,
// lowercase, trim, escaneo de 20 filas), match por CUIT y si no por nombre
// exacto, y devolvemos un preview cuando dryRun !== false. La lógica es idéntica
// para ambas entidades salvo el campo "tipo" (clientType vs supplierType, el
// primero con etiquetas mapeables, el segundo texto libre).
async function handleContactBulkImport(req: any, res: any, entity: ContactBulkEntity) {
  try {
    const {
      insertClientSchema,
      insertSupplierSchema,
      TAX_IVA_CONDITIONS,
      TAX_IVA_CONDITION_LABELS,
      CLIENT_TYPES,
      CLIENT_TYPE_LABELS,
    } = await import('@shared/schema');

    const isClient = entity === 'client';
    const schema = isClient ? insertClientSchema : insertSupplierSchema;
    const typeField = isClient ? 'clientType' : 'supplierType';
    const typeHeader = isClient ? 'Tipo de cliente' : 'Tipo de proveedor';

    const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    const dryRun = req.body?.dryRun !== false;
    if (!rawRows) return res.status(400).json({ message: 'No se recibieron filas' });
    if (rawRows.length === 0) return res.status(400).json({ message: 'El archivo no tiene filas' });
    if (rawRows.length > 2000) return res.status(400).json({ message: 'Demasiadas filas (máximo 2000)' });

    const normalizeKey = (s: any): string =>
      String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

    // Etiqueta / código de condición de IVA (acepta el código directo, la
    // etiqueta de la app y algunos sinónimos frecuentes).
    const ivaMap = new Map<string, string>();
    for (const code of TAX_IVA_CONDITIONS) {
      ivaMap.set(normalizeKey(code), code);
      ivaMap.set(normalizeKey(TAX_IVA_CONDITION_LABELS[code]), code);
    }
    ivaMap.set(normalizeKey('monotributista'), 'monotributo');
    ivaMap.set(normalizeKey('responsable inscripto'), 'responsable_inscripto');

    // Etiqueta / código de tipo de cliente (solo aplica a clientes; el tipo de
    // proveedor es texto libre).
    const clientTypeMap = new Map<string, string>();
    for (const t of CLIENT_TYPES) {
      clientTypeMap.set(normalizeKey(t), t);
      clientTypeMap.set(normalizeKey(CLIENT_TYPE_LABELS[t]), t);
    }

    const CANONICAL_HEADERS = [
      'Nombre', 'Email', 'Teléfono', 'CUIT/CUIL', 'Condición IVA', typeHeader, 'Dirección', 'Notas',
    ] as const;

    const HEADER_SCAN_ROWS = 20;
    const detectedKeysSet = new Set<string>();
    const scanLimit = Math.min(rawRows.length, HEADER_SCAN_ROWS);
    for (let i = 0; i < scanLimit; i++) {
      const row = rawRows[i];
      if (row && typeof row === 'object') {
        for (const k of Object.keys(row)) detectedKeysSet.add(k);
      }
    }
    const firstRowKeys = Array.from(detectedKeysSet);
    const normalizedToActual = new Map<string, string>();
    for (const k of firstRowKeys) normalizedToActual.set(normalizeKey(k), k);
    const headerIndex = new Map<string, string>();
    for (const canonical of CANONICAL_HEADERS) {
      const actual = normalizedToActual.get(normalizeKey(canonical));
      if (actual !== undefined) headerIndex.set(canonical, actual);
    }
    const getCol = (raw: any, canonical: string): any => {
      const actualKey = headerIndex.get(canonical);
      if (actualKey !== undefined) return raw[actualKey];
      return raw[canonical];
    };

    if (!headerIndex.has('Nombre')) {
      return res.status(400).json({
        message: "No detectamos la columna 'Nombre' en el archivo. Descargá la plantilla desde el modal de importación y usala como base.",
        code: 'MISSING_NAME_COLUMN',
        detectedHeaders: firstRowKeys,
      });
    }

    const existing: Array<{ id: string; name: string; taxId: string | null }> = isClient
      ? await storage.getClientsByOrganization(req.organizationId, false, false)
      : await storage.getSuppliersByOrganization(req.organizationId, false, false);
    const byTaxId = new Map<string, typeof existing[number]>();
    const byName = new Map<string, typeof existing[number]>();
    for (const c of existing) {
      if (c.taxId && c.taxId.trim()) byTaxId.set(c.taxId.trim().toLowerCase(), c);
      byName.set(c.name.trim().toLowerCase(), c);
    }

    const norm = (v: any): string => (v == null ? '' : String(v).trim());
    const isValidEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

    type RowResult = {
      rowNumber: number;
      status: 'new' | 'update' | 'error';
      name: string;
      taxId: string;
      matchBy?: 'taxId' | 'name' | null;
      existingId?: string | null;
      errors: string[];
      payload?: any;
      appliedId?: string | null;
    };

    const results: RowResult[] = [];

    rawRows.forEach((raw: any, idx: number) => {
      const rowNumber = idx + 2; // la fila 1 es el encabezado
      const errors: string[] = [];

      const name = norm(getCol(raw, 'Nombre'));
      const taxId = norm(getCol(raw, 'CUIT/CUIL'));
      const email = norm(getCol(raw, 'Email'));
      const phone = norm(getCol(raw, 'Teléfono'));
      const address = norm(getCol(raw, 'Dirección'));
      const notes = norm(getCol(raw, 'Notas'));
      const ivaRaw = norm(getCol(raw, 'Condición IVA'));
      const typeRaw = norm(getCol(raw, typeHeader));

      if (!name) errors.push('Falta el nombre');
      if (email && !isValidEmail(email)) errors.push(`Email inválido: "${email}"`);

      let ivaCondition: string | null = null;
      if (ivaRaw) {
        const code = ivaMap.get(normalizeKey(ivaRaw));
        // Si la condición de IVA no se reconoce (o viene vacía), la dejamos sin
        // valor y NO rompemos la fila (requisito de la tarea).
        if (code) ivaCondition = code;
      }

      let typeValue: string | null = null;
      if (typeRaw) {
        typeValue = isClient ? (clientTypeMap.get(normalizeKey(typeRaw)) || typeRaw) : typeRaw;
      }

      let match = taxId ? byTaxId.get(taxId.toLowerCase()) : undefined;
      let matchBy: 'taxId' | 'name' | null = match ? 'taxId' : null;
      if (!match && name) {
        match = byName.get(name.toLowerCase());
        if (match) matchBy = 'name';
      }

      const payload: any = {
        organizationId: req.organizationId,
        name,
        email: email || null,
        phone: phone || null,
        address: address || null,
        taxId: taxId || null,
        ivaCondition,
        notes: notes || null,
      };
      payload[typeField] = typeValue;

      if (errors.length === 0) {
        const parsed = schema.safeParse(payload);
        if (!parsed.success) {
          for (const e of parsed.error.errors) {
            const field = e.path?.[0] ? String(e.path[0]) : '';
            errors.push(field ? `${field}: ${e.message}` : e.message);
          }
        }
      }

      const status: RowResult['status'] = errors.length > 0 ? 'error' : (match ? 'update' : 'new');

      results.push({
        rowNumber,
        status,
        name,
        taxId,
        matchBy: status === 'error' ? null : matchBy,
        existingId: match?.id || null,
        errors,
        payload: status === 'error' ? undefined : payload,
      });
    });

    const summary = {
      total: results.length,
      new: results.filter(r => r.status === 'new').length,
      update: results.filter(r => r.status === 'update').length,
      errors: results.filter(r => r.status === 'error').length,
      applied: 0,
    };

    if (dryRun) return res.json({ dryRun: true, summary, rows: results });

    const applyErrors: { rowNumber: number; message: string }[] = [];
    for (const r of results) {
      if (r.status === 'error' || !r.payload) continue;
      try {
        if (r.status === 'update' && r.existingId) {
          const updates = { ...r.payload };
          delete updates.organizationId;
          const updated = isClient
            ? await storage.updateClient(r.existingId, updates)
            : await storage.updateSupplier(r.existingId, updates);
          if (updated) {
            r.appliedId = updated.id;
            summary.applied += 1;
            await storage.createAuditLog({
              organizationId: req.organizationId,
              userId: req.userId,
              entityType: entity,
              entityId: updated.id,
              action: 'update',
              previousData: null,
              newData: JSON.stringify(updated),
            });
          } else {
            r.status = 'error';
            r.errors.push('No se pudo actualizar');
            applyErrors.push({ rowNumber: r.rowNumber, message: 'No se pudo actualizar' });
          }
        } else {
          const parsed = schema.safeParse(r.payload);
          if (!parsed.success) {
            r.status = 'error';
            r.errors.push('Datos inválidos en el guardado');
            applyErrors.push({ rowNumber: r.rowNumber, message: 'Datos inválidos' });
            continue;
          }
          const created = isClient
            ? await storage.createClient(parsed.data as any)
            : await storage.createSupplier(parsed.data as any);
          r.appliedId = created.id;
          summary.applied += 1;
          await storage.createAuditLog({
            organizationId: req.organizationId,
            userId: req.userId,
            entityType: entity,
            entityId: created.id,
            action: 'create',
            previousData: null,
            newData: JSON.stringify(created),
          });
        }
      } catch (e: any) {
        r.status = 'error';
        const msg = sanitizeError(e);
        r.errors.push(msg);
        applyErrors.push({ rowNumber: r.rowNumber, message: msg });
      }
    }

    summary.errors = results.filter(r => r.status === 'error').length;
    res.json({ dryRun: false, summary, rows: results, applyErrors });
  } catch (error: any) {
    res.status(500).json({ message: sanitizeError(error) });
  }
}

export function registerOperationRoutes(app: Express) {
  app.post('/api/clients/bulk-import', requireAuth, requirePermission('transactions:create'), (req: any, res) =>
    handleContactBulkImport(req, res, 'client'));
  app.post('/api/suppliers/bulk-import', requireAuth, requirePermission('transactions:create'), (req: any, res) =>
    handleContactBulkImport(req, res, 'supplier'));

  // Client routes
  app.get('/api/clients', requireAuth, async (req: any, res) => {
    try {
      const activeOnly = req.query.activeOnly === 'true';
      const includeArchived = req.query.includeArchived === 'true'; // Task #363
      const clients = await storage.getClientsByOrganization(req.organizationId, activeOnly, includeArchived);
      res.json(clients);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/clients/:id', requireAuth, async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.id);
      if (!client || client.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Cliente no encontrado' });
      }
      res.json(client);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/clients', requireAuth, requirePermission('transactions:create'), async (req: any, res) => {
    try {
      const { insertClientSchema } = await import('@shared/schema');
      const parsed = insertClientSchema.safeParse({
        ...req.body,
        organizationId: req.organizationId,
      });
      if (!parsed.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parsed.error.errors });
      }
      // Enforce org-scoped plan ownership when assigning a subscription plan
      if (parsed.data.subscriberPlanId) {
        const plan = await storage.getSubscriptionPlan(parsed.data.subscriberPlanId, req.organizationId);
        if (!plan) {
          return res.status(400).json({ message: 'Plan de suscripción inválido para tu organización' });
        }
      }
      const client = await storage.createClient(parsed.data);
      
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'client',
        entityId: client.id,
        action: 'create',
        previousData: null,
        newData: JSON.stringify(client),
      });

      // Task #315 — Si el cliente es un suscriptor con datos suficientes,
      // generamos su cobro del mes en el acto. Best-effort: si falla, el
      // alta del cliente sigue siendo exitosa (el cron diario de las 02:15
      // va a recuperar el caso).
      if (client.clientType === 'suscriptores') {
        try {
          const { tryGenerateCurrentMonthCharge } = await import('../services/subscriptionBilling');
          const chargeResult = await tryGenerateCurrentMonthCharge(client);
          if (chargeResult.outcome === 'generated') {
            await storage.createAuditLog({
              organizationId: req.organizationId,
              userId: req.userId,
              entityType: 'client',
              entityId: client.id,
              action: 'client_create_auto_charge',
              previousData: null,
              newData: JSON.stringify({
                transactionId: chargeResult.result.transactionId,
                amount: chargeResult.result.amount,
                currency: chargeResult.result.currency,
                month: chargeResult.result.month,
              }),
            });
          } else if (chargeResult.outcome === 'skipped') {
            // Soporte/observabilidad: dejamos rastro estructurado del motivo
            // por el que NO se generó el cobro automático. Pedido del code
            // review #1 — sin esto, cuando el usuario llama porque "no se
            // generó nada", no hay forma de saber si fue por falta de
            // datos, por before_start, etc.
            console.info('[clients POST] auto-charge skipped', { clientId: client.id, reason: chargeResult.reason });
          } else if (chargeResult.outcome === 'error') {
            console.error('[clients POST] auto-charge error outcome', { clientId: client.id });
          }
        } catch (chargeErr) {
          console.error('[clients POST] auto-charge side-effect failed for client', client.id, chargeErr);
        }
      }

      res.json(client);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.patch('/api/clients/:id', requireAuth, requirePermission('transactions:edit'), async (req: any, res) => {
    try {
      const previousClient = await storage.getClient(req.params.id);
      if (!previousClient || previousClient.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Cliente no encontrado' });
      }
      
      const { updateClientSchema } = await import('@shared/schema');
      const parseResult = updateClientSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parseResult.error.errors });
      }
      // Enforce org-scoped plan ownership on update
      if (parseResult.data.subscriberPlanId) {
        const plan = await storage.getSubscriptionPlan(parseResult.data.subscriberPlanId, req.organizationId);
        if (!plan) {
          return res.status(400).json({ message: 'Plan de suscripción inválido para tu organización' });
        }
      }
      
      const client = await storage.updateClient(req.params.id, parseResult.data);
      if (!client) {
        return res.status(404).json({ message: 'Cliente no encontrado' });
      }
      
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'client',
        entityId: client.id,
        action: 'update',
        previousData: previousClient ? JSON.stringify(previousClient) : null,
        newData: JSON.stringify(client),
      });

      // Task #315 — Mismo disparo que en POST. La idempotencia (claim
      // atómico de `subscriberLastBilledMonth`) garantiza que ediciones
      // repetidas en el mismo mes no generen cobros duplicados, así que
      // podemos llamarlo siempre que el cliente sea suscriptor — sin
      // hacer diff de campos. Casos cubiertos: el usuario asigna plan +
      // cantidad recién ahora, baja el `subscriberStartMonth` al mes
      // actual, o reactiva un cliente que estaba inactivo.
      if (client.clientType === 'suscriptores') {
        try {
          const { tryGenerateCurrentMonthCharge } = await import('../services/subscriptionBilling');
          const chargeResult = await tryGenerateCurrentMonthCharge(client);
          if (chargeResult.outcome === 'generated') {
            await storage.createAuditLog({
              organizationId: req.organizationId,
              userId: req.userId,
              entityType: 'client',
              entityId: client.id,
              action: 'client_update_auto_charge',
              previousData: null,
              newData: JSON.stringify({
                transactionId: chargeResult.result.transactionId,
                amount: chargeResult.result.amount,
                currency: chargeResult.result.currency,
                month: chargeResult.result.month,
              }),
            });
          } else if (chargeResult.outcome === 'skipped') {
            console.info('[clients PATCH] auto-charge skipped', { clientId: client.id, reason: chargeResult.reason });
          } else if (chargeResult.outcome === 'error') {
            console.error('[clients PATCH] auto-charge error outcome', { clientId: client.id });
          }
        } catch (chargeErr) {
          console.error('[clients PATCH] auto-charge side-effect failed for client', client.id, chargeErr);
        }
      }

      res.json(client);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Task #363: DELETE intenta borrar; si hay FK violation, archiva.
  // Con ?force=true (owner/admin) hace hard-delete o falla con 409 si tiene historia.
  app.delete('/api/clients/:id', requireAuth, requirePermission('transactions:delete'), async (req: any, res) => {
    try {
      const previousClient = await storage.getClient(req.params.id);
      if (!previousClient || previousClient.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Cliente no encontrado' });
      }
      const force = req.query.force === 'true' || req.query.force === true;
      if (force) {
        const role = (req as any).membership?.role as string | undefined;
        if (role !== 'owner' && role !== 'admin') {
          return res.status(403).json({ message: 'Solo propietarios y administradores pueden eliminar definitivamente' });
        }
      }

      try {
        const success = await storage.deleteClient(req.params.id);
        if (!success) {
          return res.status(404).json({ message: 'Cliente no encontrado' });
        }
        // Task #363: hard-delete (force=true) es irreversible, no genera undoKey.
        const undoKey = force ? undefined : stashForUndo('client', req.params.id, previousClient, req.organizationId, req.userId);
        await storage.createAuditLog({
          organizationId: req.organizationId,
          userId: req.userId,
          entityType: 'client',
          entityId: req.params.id,
          action: force ? 'hard_deleted' : 'delete',
          previousData: previousClient ? JSON.stringify(previousClient) : null,
          newData: force ? JSON.stringify({ forced: true }) : null,
        });
        return res.json({ success: true, deleted: true, forced: force, undoKey });
      } catch (delErr: any) {
        const code = delErr?.code || delErr?.cause?.code;
        if (code === '23503') {
          if (force) {
            return res.status(409).json({ message: 'No se puede eliminar definitivamente: el cliente tiene movimientos asociados' });
          }
          // Fallback: archivar
          const archived = await storage.archiveClient(req.params.id);
          await storage.createAuditLog({
            organizationId: req.organizationId,
            userId: req.userId,
            entityType: 'client',
            entityId: req.params.id,
            action: 'archived',
            previousData: previousClient ? JSON.stringify(previousClient) : null,
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

  // Task #363: archivar / desarchivar cliente
  app.post('/api/clients/:id/archive', requireAuth, requirePermission('transactions:delete'), async (req: any, res) => {
    try {
      const existing = await storage.getClient(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Cliente no encontrado' });
      }
      const archived = await storage.archiveClient(req.params.id);
      await storage.createAuditLog({
        organizationId: req.organizationId, userId: req.userId,
        entityType: 'client', entityId: req.params.id, action: 'archived',
        previousData: JSON.stringify(existing),
        newData: archived ? JSON.stringify({ archivedAt: archived.archivedAt }) : null,
      });
      res.json({ success: true, client: archived });
    } catch (error: any) { res.status(500).json({ message: sanitizeError(error) }); }
  });

  app.post('/api/clients/:id/unarchive', requireAuth, requirePermission('transactions:delete'), async (req: any, res) => {
    try {
      const existing = await storage.getClient(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Cliente no encontrado' });
      }
      const restored = await storage.unarchiveClient(req.params.id);
      await storage.createAuditLog({
        organizationId: req.organizationId, userId: req.userId,
        entityType: 'client', entityId: req.params.id, action: 'unarchived',
        previousData: JSON.stringify(existing),
        newData: restored ? JSON.stringify({ archivedAt: null }) : null,
      });
      res.json({ success: true, client: restored });
    } catch (error: any) { res.status(500).json({ message: sanitizeError(error) }); }
  });

  // Subscription plans (per organization) — owners/admins only
  app.get('/api/subscription-plans', requireAuth, async (req: any, res) => {
    try {
      const activeOnly = req.query.activeOnly === 'true';
      const plans = await storage.getSubscriptionPlans(req.organizationId, activeOnly);
      res.json(plans);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/subscription-plans', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const { insertSubscriptionPlanSchema } = await import('@shared/schema');
      const parsed = insertSubscriptionPlanSchema.safeParse({
        ...req.body,
        organizationId: req.organizationId,
      });
      if (!parsed.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parsed.error.errors });
      }
      const plan = await storage.createSubscriptionPlan(parsed.data);
      res.json(plan);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.patch('/api/subscription-plans/:id', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const existing = await storage.getSubscriptionPlan(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Plan no encontrado' });
      }
      const { updateSubscriptionPlanSchema } = await import('@shared/schema');
      const parsed = updateSubscriptionPlanSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parsed.error.errors });
      }
      const plan = await storage.updateSubscriptionPlan(req.params.id, parsed.data as any);
      res.json(plan);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.delete('/api/subscription-plans/:id', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const existing = await storage.getSubscriptionPlan(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Plan no encontrado' });
      }
      await storage.deleteSubscriptionPlan(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Generate the current-month subscription charge for a subscriber client
  app.post('/api/clients/:id/generate-subscription-charge', requireAuth, requirePermission('transactions:create'), async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.id);
      if (!client || client.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Cliente no encontrado' });
      }
      if (client.clientType !== 'suscriptores') {
        return res.status(400).json({ message: 'El cliente no es de tipo Suscriptores' });
      }
      const { generateChargeForClient } = await import('../services/subscriptionBilling');
      const force = req.body?.force === true;
      const month = typeof req.body?.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.body.month) ? req.body.month : undefined;
      const result = await generateChargeForClient(client, { force, month });
      if (!result.generated) {
        const reasons: Record<string, string> = {
          not_subscriber: 'El cliente no es de tipo Suscriptores.',
          no_quantity: 'Falta indicar la cantidad de suscriptores en el cliente.',
          no_price: 'Falta indicar un precio (plan o sobreescritura por cliente).',
          already_billed: `Ya se generó el cobro del mes ${result.month}. Volvé a generarlo con "Forzar".`,
          before_start: `La suscripción comienza en ${client.subscriberStartMonth}.`,
          invalid_plan: 'El plan de suscripción ya no existe o no pertenece a esta organización.',
        };
        return res.status(409).json({
          message: reasons[result.reason || ''] || 'No se pudo generar el cobro.',
          code: result.reason,
          reason: result.reason,
          month: result.month,
        });
      }
      res.json({ ...result, transaction: { id: result.transactionId, amount: result.amount, currency: result.currency } });
    } catch (error: any) {
      console.error('[GenerateCharge] Error:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/clients/:clientId/invoice-email-prefs', requireAuth, async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.clientId);
      if (!client || client.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Cliente no encontrado' });
      }
      const prefs = await storage.getClientInvoiceEmailPrefs(req.params.clientId);
      res.json(prefs || { clientId: req.params.clientId, defaultCcEmails: [], sendCopyToSelf: false });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.put('/api/clients/:clientId/invoice-email-prefs', requireAuth, requirePermission('transactions:edit'), async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.clientId);
      if (!client || client.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Cliente no encontrado' });
      }
      const { updateClientInvoiceEmailPrefsSchema } = await import('@shared/schema');
      const parseResult = updateClientInvoiceEmailPrefsSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parseResult.error.errors });
      }
      const existing = await storage.getClientInvoiceEmailPrefs(req.params.clientId);
      const saved = await storage.upsertClientInvoiceEmailPrefs(
        req.organizationId,
        req.params.clientId,
        {
          defaultCcEmails: parseResult.data.defaultCcEmails ?? existing?.defaultCcEmails ?? [],
          sendCopyToSelf: parseResult.data.sendCopyToSelf ?? existing?.sendCopyToSelf ?? false,
        }
      );
      res.json(saved);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/clients/:id/employees', requireAuth, async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.id);
      if (!client || client.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Cliente no encontrado' });
      }
      const allocs = await storage.getAllocationsByClient(req.params.id);
      const enriched = await Promise.all(allocs.map(async (a) => {
        const emp = await storage.getEmployee(a.employeeId);
        if (!emp || emp.organizationId !== req.organizationId) return null;
        return {
          employeeId: emp.id,
          fullName: emp.fullName,
          contractType: emp.contractType,
          grossSalary: emp.grossSalary,
          currency: emp.currency,
          status: emp.status,
          projectId: a.projectId || '',
          projectName: a.projectName || '',
          percentage: a.percentage,
          commissionRate: a.commissionRate || '0',
        };
      }));
      res.json(enriched.filter(Boolean));
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/allocations/by-organization', requireAuth, async (req: any, res) => {
    try {
      const allocs = await storage.getAllocationsWithEmployeesByOrganization(req.organizationId);
      const grouped: Record<string, Array<{ grossSalary: string; currency: string; percentage: string; commissionRate: string }>> = {};
      for (const a of allocs) {
        if (a.employeeStatus !== 'active') continue;
        if (!grouped[a.clientId]) grouped[a.clientId] = [];
        grouped[a.clientId].push({
          grossSalary: a.grossSalary,
          currency: a.currency,
          percentage: a.percentage,
          commissionRate: a.commissionRate,
        });
      }
      res.json(grouped);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/employees/:id/profitability', requireAuth, async (req: any, res) => {
    try {
      const emp = await storage.getEmployee(req.params.id);
      if (!emp || emp.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Empleado no encontrado' });
      }
      const allocs = await storage.getAllocationsByEmployee(req.params.id);
      const grossSalary = parseFloat(emp.grossSalary || '0');
      const txs = await storage.getTransactionsByOrganization(req.organizationId);
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

      const clientBreakdown = await Promise.all(allocs.map(async (a) => {
        const client = await storage.getClient(a.clientId);
        if (!client || client.organizationId !== req.organizationId) return null;
        const pct = parseFloat(a.percentage) || 0;
        const commRate = parseFloat(a.commissionRate || '0') || 0;
        const costProportion = (grossSalary * pct) / 100;
        const clientTxs = txs.filter(t => {
          if (t.clientId !== a.clientId) return false;
          if (a.projectId && t.projectId && t.projectId !== a.projectId) return false;
          if (a.projectId && !t.projectId) return false;
          const d = new Date(t.date);
          return d >= monthStart && d <= monthEnd;
        });
        const revenueTxs = clientTxs
          .filter(t => (t.type === 'income' || (t.type === 'receivable' && t.status === 'completed')) && !(t.description || '').startsWith('[CANCELACIÓN]'));
        const clientRevenue = revenueTxs
          .reduce((sum, t) => sum + (parseFloat(t.amount || '0')), 0);
        const employeeRevenue = (clientRevenue * pct) / 100;
        const commission = (employeeRevenue * commRate) / 100;
        return {
          clientId: client.id,
          clientName: client.name,
          projectId: a.projectId || '',
          projectName: a.projectName || '',
          percentage: a.percentage,
          commissionRate: a.commissionRate || '0',
          costProportion: costProportion.toFixed(2),
          clientTotalRevenue: clientRevenue.toFixed(2),
          employeeRevenue: employeeRevenue.toFixed(2),
          commission: commission.toFixed(2),
          transactions: revenueTxs.map(t => ({
            date: t.date,
            amount: parseFloat(t.amount || '0').toFixed(2),
            description: t.description || t.category || '',
            transactionNumber: t.transactionNumber || '',
          })),
        };
      }));

      const breakdown = clientBreakdown.filter(Boolean);
      const totalCommissions = breakdown.reduce((s, b) => s + parseFloat(b!.commission), 0);
      const totalEarnings = grossSalary + totalCommissions;

      res.json({
        employeeId: emp.id,
        fullName: emp.fullName,
        grossSalary: emp.grossSalary,
        currency: emp.currency,
        period: monthStart.toISOString().slice(0, 7),
        totalCommissions: totalCommissions.toFixed(2),
        totalEarnings: totalEarnings.toFixed(2),
        clients: breakdown,
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Supplier routes
  app.get('/api/suppliers', requireAuth, async (req: any, res) => {
    try {
      const activeOnly = req.query.activeOnly === 'true';
      const includeArchived = req.query.includeArchived === 'true'; // Task #363
      const suppliers = await storage.getSuppliersByOrganization(req.organizationId, activeOnly, includeArchived);
      res.json(suppliers);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/suppliers/:id', requireAuth, async (req: any, res) => {
    try {
      const supplier = await storage.getSupplier(req.params.id);
      if (!supplier || supplier.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Proveedor no encontrado' });
      }
      res.json(supplier);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/suppliers', requireAuth, requirePermission('transactions:create'), async (req: any, res) => {
    try {
      const supplier = await storage.createSupplier({
        ...req.body,
        organizationId: req.organizationId,
      });
      
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'supplier',
        entityId: supplier.id,
        action: 'create',
        previousData: null,
        newData: JSON.stringify(supplier),
      });
      
      res.json(supplier);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.patch('/api/suppliers/:id', requireAuth, requirePermission('transactions:edit'), async (req: any, res) => {
    try {
      const previousSupplier = await storage.getSupplier(req.params.id);
      if (!previousSupplier || previousSupplier.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Proveedor no encontrado' });
      }
      
      const { updateSupplierSchema } = await import('@shared/schema');
      const parseResult = updateSupplierSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parseResult.error.errors });
      }
      
      const supplier = await storage.updateSupplier(req.params.id, parseResult.data);
      if (!supplier) {
        return res.status(404).json({ message: 'Proveedor no encontrado' });
      }
      
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'supplier',
        entityId: supplier.id,
        action: 'update',
        previousData: previousSupplier ? JSON.stringify(previousSupplier) : null,
        newData: JSON.stringify(supplier),
      });
      
      res.json(supplier);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Per-supplier invoice email preferences (CC list, BCC self).
  app.get('/api/suppliers/:supplierId/invoice-email-prefs', requireAuth, async (req: any, res) => {
    try {
      const supplier = await storage.getSupplier(req.params.supplierId);
      if (!supplier || supplier.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Proveedor no encontrado' });
      }
      const prefs = await storage.getSupplierInvoiceEmailPrefs(req.params.supplierId);
      res.json(prefs || { defaultCcEmails: [], sendCopyToSelf: false });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.put('/api/suppliers/:supplierId/invoice-email-prefs', requireAuth, requirePermission('transactions:edit'), async (req: any, res) => {
    try {
      const supplier = await storage.getSupplier(req.params.supplierId);
      if (!supplier || supplier.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Proveedor no encontrado' });
      }
      const { defaultCcEmails, sendCopyToSelf } = req.body || {};
      const isValidEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((e || '').trim());
      const ccArr = Array.isArray(defaultCcEmails)
        ? defaultCcEmails.map((s: any) => String(s).trim()).filter((s: string) => s.length > 0)
        : [];
      for (const cc of ccArr) {
        if (!isValidEmail(cc)) {
          return res.status(400).json({ message: `Email CC inválido: ${cc}` });
        }
      }
      const updated = await storage.upsertSupplierInvoiceEmailPrefs(req.organizationId, req.params.supplierId, {
        defaultCcEmails: ccArr,
        sendCopyToSelf: !!sendCopyToSelf,
      });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Task #363
  app.delete('/api/suppliers/:id', requireAuth, requirePermission('transactions:delete'), async (req: any, res) => {
    try {
      const previousSupplier = await storage.getSupplier(req.params.id);
      if (!previousSupplier || previousSupplier.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Proveedor no encontrado' });
      }
      const force = req.query.force === 'true' || req.query.force === true;
      if (force) {
        const role = (req as any).membership?.role as string | undefined;
        if (role !== 'owner' && role !== 'admin') {
          return res.status(403).json({ message: 'Solo propietarios y administradores pueden eliminar definitivamente' });
        }
      }
      try {
        const success = await storage.deleteSupplier(req.params.id);
        if (!success) {
          return res.status(404).json({ message: 'Proveedor no encontrado' });
        }
        // Task #363: hard-delete (force=true) es irreversible, no genera undoKey.
        const undoKey = force ? undefined : stashForUndo('supplier', req.params.id, previousSupplier, req.organizationId, req.userId);
        await storage.createAuditLog({
          organizationId: req.organizationId, userId: req.userId,
          entityType: 'supplier', entityId: req.params.id,
          action: force ? 'hard_deleted' : 'delete',
          previousData: JSON.stringify(previousSupplier),
          newData: force ? JSON.stringify({ forced: true }) : null,
        });
        return res.json({ success: true, deleted: true, forced: force, undoKey });
      } catch (delErr: any) {
        const code = delErr?.code || delErr?.cause?.code;
        if (code === '23503') {
          if (force) {
            return res.status(409).json({ message: 'No se puede eliminar definitivamente: el proveedor tiene movimientos asociados' });
          }
          const archived = await storage.archiveSupplier(req.params.id);
          await storage.createAuditLog({
            organizationId: req.organizationId, userId: req.userId,
            entityType: 'supplier', entityId: req.params.id, action: 'archived',
            previousData: JSON.stringify(previousSupplier),
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

  app.post('/api/suppliers/:id/archive', requireAuth, requirePermission('transactions:delete'), async (req: any, res) => {
    try {
      const existing = await storage.getSupplier(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Proveedor no encontrado' });
      }
      const archived = await storage.archiveSupplier(req.params.id);
      await storage.createAuditLog({
        organizationId: req.organizationId, userId: req.userId,
        entityType: 'supplier', entityId: req.params.id, action: 'archived',
        previousData: JSON.stringify(existing),
        newData: archived ? JSON.stringify({ archivedAt: archived.archivedAt }) : null,
      });
      res.json({ success: true, supplier: archived });
    } catch (error: any) { res.status(500).json({ message: sanitizeError(error) }); }
  });

  app.post('/api/suppliers/:id/unarchive', requireAuth, requirePermission('transactions:delete'), async (req: any, res) => {
    try {
      const existing = await storage.getSupplier(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Proveedor no encontrado' });
      }
      const restored = await storage.unarchiveSupplier(req.params.id);
      await storage.createAuditLog({
        organizationId: req.organizationId, userId: req.userId,
        entityType: 'supplier', entityId: req.params.id, action: 'unarchived',
        previousData: JSON.stringify(existing),
        newData: restored ? JSON.stringify({ archivedAt: null }) : null,
      });
      res.json({ success: true, supplier: restored });
    } catch (error: any) { res.status(500).json({ message: sanitizeError(error) }); }
  });

  // Product routes
  app.get('/api/products', requireAuth, async (req: any, res) => {
    try {
      const activeOnly = req.query.activeOnly === 'true';
      const products = await storage.getProductsByOrganization(req.organizationId, activeOnly);
      res.json(products);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/products/:id', requireAuth, async (req: any, res) => {
    try {
      const product = await storage.getProduct(req.params.id);
      if (!product || product.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Producto no encontrado' });
      }
      res.json(product);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  const productFieldLabels: Record<string, string> = {
    name: 'Nombre',
    productType: 'Tipo',
    description: 'Descripción',
    sku: 'SKU',
    barcode: 'Código de barras',
    category: 'Categoría',
    costPrice: 'Precio de costo',
    costCurrency: 'Moneda de costo',
    salePrice: 'Precio de venta',
    purchaseDate: 'Fecha de compra',
    usefulLifeMonths: 'Vida útil (meses)',
    currentValue: 'Valor actual',
    stock: 'Stock',
    minStock: 'Stock mínimo',
  };

  function formatProductErrors(errors: any[]): string {
    const fields = errors
      .map((e: any) => {
        const field = e.path?.[0];
        const label = field ? (productFieldLabels[field] || field) : '';
        return label;
      })
      .filter((v: string, i: number, arr: string[]) => v && arr.indexOf(v) === i);
    if (fields.length === 0) return 'Verificá que los datos ingresados sean correctos.';
    return `Verificá los siguientes campos: ${fields.join(', ')}.`;
  }

  app.post('/api/products', requireAuth, requirePermission('transactions:create'), async (req: any, res) => {
    try {
      const { insertProductSchema } = await import('@shared/schema');
      const parseResult = insertProductSchema.safeParse({
        ...req.body,
        organizationId: req.organizationId,
      });
      if (!parseResult.success) {
        return res.status(400).json({ message: formatProductErrors(parseResult.error.errors), errors: parseResult.error.errors });
      }
      // Validate defaultProfitabilityCodeId belongs to the same org
      if (parseResult.data.defaultProfitabilityCodeId) {
        const code = await storage.getProfitabilityCode(parseResult.data.defaultProfitabilityCodeId);
        if (!code || code.organizationId !== req.organizationId) {
          return res.status(400).json({ message: 'Código de rentabilidad inválido' });
        }
      }
      // SKU único por organización (case-insensitive, ignora espacios)
      const newSku = (parseResult.data.sku || '').trim();
      if (newSku) {
        const existing = await storage.getProductsByOrganization(req.organizationId, false);
        const duplicate = existing.find(p => (p.sku || '').trim().toLowerCase() === newSku.toLowerCase());
        if (duplicate) {
          return res.status(400).json({ message: `Ya existe un producto con el SKU "${newSku}" (${duplicate.name}). Usá un SKU distinto.` });
        }
      }
      const product = await storage.createProduct(parseResult.data);
      
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'product',
        entityId: product.id,
        action: 'create',
        previousData: null,
        newData: JSON.stringify(product),
      });
      
      res.json(product);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Bulk import products from Excel
  app.post('/api/products/bulk-import', requireAuth, requirePermission('transactions:create'), async (req: any, res) => {
    try {
      const { insertProductSchema } = await import('@shared/schema');
      const { PRODUCT_TYPE_LABELS, PRODUCT_TYPES, CURRENCIES } = await import('@shared/schema');

      const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : null;
      const dryRun = req.body?.dryRun !== false;
      if (!rawRows) {
        return res.status(400).json({ message: 'No se recibieron filas' });
      }
      if (rawRows.length === 0) {
        return res.status(400).json({ message: 'El archivo no tiene filas' });
      }
      if (rawRows.length > 2000) {
        return res.status(400).json({ message: 'Demasiadas filas (máximo 2000)' });
      }

      // Normalize: build label -> code map for product type
      const labelToType = new Map<string, string>();
      for (const t of PRODUCT_TYPES) {
        labelToType.set(PRODUCT_TYPE_LABELS[t].toLowerCase(), t);
        labelToType.set(t.toLowerCase(), t);
      }

      // Build tolerant header index from the first rows of the spreadsheet.
      // We normalize each actual key (NFD-strip diacritics, trim, lowercase)
      // and map it to the canonical column name we expect. This lets the
      // user upload a file with "nombre", "NOMBRE", "Nombre " (trailing
      // space) or "Categoria" (no tilde) without us throwing "Falta el
      // nombre" en cada fila.
      //
      // Task #336 — Antes solo mirábamos `Object.keys(rawRows[0])`. Con
      // nuestro frontend actual (sheet_to_json con defval: '') eso alcanza
      // porque todas las keys aparecen en la primera fila. Pero si en el
      // futuro entra otra fuente (otro cliente, otro parser, una integración)
      // que omita keys vacías en la primera fila, podríamos disparar un falso
      // 'MISSING_NAME_COLUMN' aunque el archivo sí tenga la columna. Tomamos
      // la unión de keys de las primeras 20 filas para cubrir ese caso.
      const CANONICAL_HEADERS = [
        'Tipo', 'Nombre', 'SKU', 'Código de barras', 'Categoría', 'Moneda',
        'Costo', 'Precio de venta', 'Stock', 'Stock mínimo', 'Unidad', 'IVA', 'Descripción',
      ] as const;
      const VALID_IVA_ALIQUOTS = new Set(['0', '2.5', '5', '10.5', '21', '27']);
      const normalizeKey = (s: any): string =>
        String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
      const HEADER_SCAN_ROWS = 20;
      const detectedKeysSet = new Set<string>();
      const scanLimit = Math.min(rawRows.length, HEADER_SCAN_ROWS);
      for (let i = 0; i < scanLimit; i++) {
        const row = rawRows[i];
        if (row && typeof row === 'object') {
          for (const k of Object.keys(row)) detectedKeysSet.add(k);
        }
      }
      const firstRowKeys = Array.from(detectedKeysSet);
      const normalizedToActual = new Map<string, string>();
      for (const k of firstRowKeys) {
        normalizedToActual.set(normalizeKey(k), k);
      }
      const headerIndex = new Map<string, string>();
      for (const canonical of CANONICAL_HEADERS) {
        const actual = normalizedToActual.get(normalizeKey(canonical));
        if (actual !== undefined) headerIndex.set(canonical, actual);
      }
      const getCol = (raw: any, canonical: typeof CANONICAL_HEADERS[number]): any => {
        const actualKey = headerIndex.get(canonical);
        if (actualKey !== undefined) return raw[actualKey];
        return raw[canonical];
      };

      if (!headerIndex.has('Nombre')) {
        return res.status(400).json({
          message: "No detectamos la columna 'Nombre' en el archivo. Descargá la plantilla desde el modal de importación y usala como base.",
          code: 'MISSING_NAME_COLUMN',
          detectedHeaders: firstRowKeys,
        });
      }

      // Existing products for match
      const existing = await storage.getProductsByOrganization(req.organizationId, false);
      const bySku = new Map<string, typeof existing[number]>();
      const byName = new Map<string, typeof existing[number]>();
      for (const p of existing) {
        if (p.sku) bySku.set(p.sku.trim().toLowerCase(), p);
        byName.set(p.name.trim().toLowerCase(), p);
      }

      const norm = (v: any): string => (v == null ? '' : String(v).trim());
      const parseNum = (v: any): { ok: boolean; value: string } => {
        const s = norm(v);
        if (s === '') return { ok: true, value: '' };
        const n = Number(String(s).replace(',', '.'));
        if (!isFinite(n) || isNaN(n)) return { ok: false, value: '' };
        return { ok: true, value: String(n) };
      };

      type RowResult = {
        rowNumber: number;
        status: 'new' | 'update' | 'error';
        name: string;
        sku: string;
        matchBy?: 'sku' | 'name' | null;
        existingId?: string | null;
        errors: string[];
        payload?: any;
        appliedId?: string | null;
      };

      const results: RowResult[] = [];

      rawRows.forEach((raw: any, idx: number) => {
        const rowNumber = idx + 2; // header is row 1
        const errors: string[] = [];

        const name = norm(getCol(raw, 'Nombre'));
        const sku = norm(getCol(raw, 'SKU'));
        const tipoRaw = norm(getCol(raw, 'Tipo'));
        const productType = tipoRaw ? labelToType.get(tipoRaw.toLowerCase()) : 'product';

        if (!name) errors.push('Falta el nombre');
        if (tipoRaw && !productType) errors.push(`Tipo inválido: "${tipoRaw}"`);

        const costCurrencyRaw = norm(getCol(raw, 'Moneda')) || 'ARS';
        const costCurrency = costCurrencyRaw.toUpperCase();
        if (!(CURRENCIES as readonly string[]).includes(costCurrency)) {
          errors.push(`Moneda inválida: "${costCurrencyRaw}"`);
        }

        const costParsed = parseNum(getCol(raw, 'Costo'));
        if (!costParsed.ok) errors.push('Costo inválido');
        const saleParsed = parseNum(getCol(raw, 'Precio de venta'));
        if (!saleParsed.ok) errors.push('Precio de venta inválido');
        const stockParsed = parseNum(getCol(raw, 'Stock'));
        if (!stockParsed.ok) errors.push('Stock inválido');
        const minStockParsed = parseNum(getCol(raw, 'Stock mínimo'));
        if (!minStockParsed.ok) errors.push('Stock mínimo inválido');

        // Match
        let match = sku ? bySku.get(sku.toLowerCase()) : undefined;
        let matchBy: 'sku' | 'name' | null = match ? 'sku' : null;
        if (!match && name) {
          match = byName.get(name.toLowerCase());
          if (match) matchBy = 'name';
        }

        const payload: any = {
          organizationId: req.organizationId,
          name,
          productType: productType || 'product',
          sku: sku || null,
          barcode: norm(getCol(raw, 'Código de barras')) || null,
          category: norm(getCol(raw, 'Categoría')) || null,
          costCurrency,
          description: norm(getCol(raw, 'Descripción')) || null,
        };
        if (costParsed.value !== '') payload.costPrice = costParsed.value;
        if (saleParsed.value !== '') payload.salePrice = saleParsed.value;
        if (stockParsed.value !== '') payload.stock = stockParsed.value;
        if (minStockParsed.value !== '') payload.minStock = minStockParsed.value;
        const unit = norm(getCol(raw, 'Unidad'));
        if (unit) payload.unit = unit;
        const ivaRaw = norm(getCol(raw, 'IVA'));
        if (ivaRaw) {
          const ivaNorm = String(Number(ivaRaw.replace('%', '').replace(',', '.')));
          if (!VALID_IVA_ALIQUOTS.has(ivaNorm)) {
            errors.push(`IVA inválido: "${ivaRaw}" (valores: 0, 2.5, 5, 10.5, 21, 27)`);
          } else {
            payload.ivaAliquot = ivaNorm;
          }
        }

        // Validate with schema (only when no upstream errors that would mask)
        if (errors.length === 0) {
          const parsed = insertProductSchema.safeParse(payload);
          if (!parsed.success) {
            for (const e of parsed.error.errors) {
              const field = e.path?.[0] ? String(e.path[0]) : '';
              errors.push(field ? `${field}: ${e.message}` : e.message);
            }
          }
        }

        const status: RowResult['status'] = errors.length > 0 ? 'error' : (match ? 'update' : 'new');

        results.push({
          rowNumber,
          status,
          name,
          sku,
          matchBy: status === 'error' ? null : matchBy,
          existingId: match?.id || null,
          errors,
          payload: status === 'error' ? undefined : payload,
        });
      });

      const summary = {
        total: results.length,
        new: results.filter(r => r.status === 'new').length,
        update: results.filter(r => r.status === 'update').length,
        errors: results.filter(r => r.status === 'error').length,
        applied: 0,
      };

      if (dryRun) {
        return res.json({ dryRun: true, summary, rows: results });
      }

      // Apply changes
      const applyErrors: { rowNumber: number; message: string }[] = [];
      for (const r of results) {
        if (r.status === 'error' || !r.payload) continue;
        try {
          if (r.status === 'update' && r.existingId) {
            const updates = { ...r.payload };
            delete updates.organizationId;
            const updated = await storage.updateProduct(r.existingId, updates);
            if (updated) {
              r.appliedId = updated.id;
              summary.applied += 1;
              await storage.createAuditLog({
                organizationId: req.organizationId,
                userId: req.userId,
                entityType: 'product',
                entityId: updated.id,
                action: 'update',
                previousData: null,
                newData: JSON.stringify(updated),
              });
            } else {
              r.status = 'error';
              r.errors.push('No se pudo actualizar');
              applyErrors.push({ rowNumber: r.rowNumber, message: 'No se pudo actualizar' });
            }
          } else {
            const parsed = insertProductSchema.safeParse(r.payload);
            if (!parsed.success) {
              r.status = 'error';
              r.errors.push('Datos inválidos en el guardado');
              applyErrors.push({ rowNumber: r.rowNumber, message: 'Datos inválidos' });
              continue;
            }
            const created = await storage.createProduct(parsed.data);
            r.appliedId = created.id;
            summary.applied += 1;
            await storage.createAuditLog({
              organizationId: req.organizationId,
              userId: req.userId,
              entityType: 'product',
              entityId: created.id,
              action: 'create',
              previousData: null,
              newData: JSON.stringify(created),
            });
          }
        } catch (e: any) {
          r.status = 'error';
          const msg = sanitizeError(e);
          r.errors.push(msg);
          applyErrors.push({ rowNumber: r.rowNumber, message: msg });
        }
      }

      // Recount after apply (errors may have increased)
      summary.errors = results.filter(r => r.status === 'error').length;

      res.json({ dryRun: false, summary, rows: results, applyErrors });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.patch('/api/products/:id', requireAuth, requirePermission('transactions:edit'), async (req: any, res) => {
    try {
      const previousProduct = await storage.getProduct(req.params.id);
      if (!previousProduct || previousProduct.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Producto no encontrado' });
      }
      
      const { updateProductSchema } = await import('@shared/schema');
      const parseResult = updateProductSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ message: formatProductErrors(parseResult.error.errors), errors: parseResult.error.errors });
      }

      // Validate defaultProfitabilityCodeId belongs to the same org
      if (parseResult.data.defaultProfitabilityCodeId) {
        const code = await storage.getProfitabilityCode(parseResult.data.defaultProfitabilityCodeId);
        if (!code || code.organizationId !== req.organizationId) {
          return res.status(400).json({ message: 'Código de rentabilidad inválido' });
        }
      }
      // SKU único por organización (case-insensitive). Ignora el producto que estamos editando.
      if (parseResult.data.sku !== undefined) {
        const newSku = (parseResult.data.sku || '').trim();
        if (newSku) {
          const existing = await storage.getProductsByOrganization(req.organizationId, false);
          const duplicate = existing.find(p => p.id !== req.params.id && (p.sku || '').trim().toLowerCase() === newSku.toLowerCase());
          if (duplicate) {
            return res.status(400).json({ message: `Ya existe un producto con el SKU "${newSku}" (${duplicate.name}). Usá un SKU distinto.` });
          }
        }
      }
      
      const product = await storage.updateProduct(req.params.id, parseResult.data as any);
      if (!product) {
        return res.status(404).json({ message: 'Producto no encontrado' });
      }
      
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'product',
        entityId: product.id,
        action: 'update',
        previousData: previousProduct ? JSON.stringify(previousProduct) : null,
        newData: JSON.stringify(product),
      });
      
      res.json(product);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Task #348 — Bulk delete de productos. Best-effort por id, audit log
  // por cada eliminación, sin sistema de undo (fuera de scope).
  app.post('/api/products/bulk-delete', requireAuth, requirePermission('transactions:delete'), async (req: any, res) => {
    try {
      const role = req.membership?.role;
      if (role !== 'owner' && role !== 'admin') {
        return res.status(403).json({
          message: 'Solo dueño o administrador pueden eliminar productos en bloque',
          code: 'FORBIDDEN_ROLE',
          userRole: role,
        });
      }
      const { ids, force } = req.body || {};
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: 'Debés enviar al menos un id' });
      }
      if (ids.length > 200) {
        return res.status(400).json({ message: 'No podés eliminar más de 200 productos en una sola operación' });
      }
      if (!ids.every((id: any) => typeof id === 'string' && id.length > 0)) {
        return res.status(400).json({ message: 'Lista de ids inválida' });
      }

      // Task #361: el flag `force` permite saltar el guard de "tiene stock"
      // cuando el dueño/admin necesita limpiar un catálogo importado mal.
      // La FK stock_movements.product_id está ON DELETE CASCADE, así que los
      // movimientos de stock se borran solos. La referencia desde transactions
      // sigue protegida por la FK y se reporta como `in_use`.
      const forceDelete = force === true;

      const uniqueIds = Array.from(new Set(ids as string[]));
      const deleted: string[] = [];
      const skipped: { id: string; reason: string }[] = [];

      for (const id of uniqueIds) {
        try {
          const previousProduct = await storage.getProduct(id);
          if (!previousProduct || previousProduct.organizationId !== req.organizationId) {
            skipped.push({ id, reason: 'not_found' });
            continue;
          }
          const productType = (previousProduct as any).productType || 'product';
          const stockNum = parseFloat((previousProduct as any).stock || '0') || 0;
          if (!forceDelete && productType !== 'asset' && stockNum > 0) {
            skipped.push({ id, reason: 'has_stock' });
            continue;
          }
          const success = await storage.deleteProduct(id);
          if (!success) {
            skipped.push({ id, reason: 'delete_failed' });
            continue;
          }
          await storage.createAuditLog({
            organizationId: req.organizationId,
            userId: req.userId,
            entityType: 'product',
            entityId: id,
            action: 'delete',
            previousData: JSON.stringify(previousProduct),
            newData: forceDelete ? JSON.stringify({ forced: true, hadStock: stockNum }) : null,
          });
          deleted.push(id);
        } catch (itemErr: any) {
          const msg = String(itemErr?.message || '');
          // Producto referenciado por movimientos u otras tablas
          if (msg.includes('foreign key') || msg.includes('violates foreign key')) {
            skipped.push({ id, reason: 'in_use' });
          } else {
            console.error(`[BulkDeleteProducts] error on ${id}:`, itemErr);
            skipped.push({ id, reason: 'error' });
          }
        }
      }

      res.json({ deleted, skipped });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.delete('/api/products/:id', requireAuth, requirePermission('transactions:delete'), async (req: any, res) => {
    try {
      const previousProduct = await storage.getProduct(req.params.id);
      if (!previousProduct || previousProduct.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Producto no encontrado' });
      }
      
      const undoKey = stashForUndo('product', req.params.id, previousProduct, req.organizationId, req.userId);

      const success = await storage.deleteProduct(req.params.id);
      if (!success) {
        return res.status(404).json({ message: 'Producto no encontrado' });
      }
      
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'product',
        entityId: req.params.id,
        action: 'delete',
        previousData: previousProduct ? JSON.stringify(previousProduct) : null,
        newData: null,
      });
      
      res.json({ success: true, undoKey });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Stock movements
  app.get('/api/products/:id/movements', requireAuth, async (req: any, res) => {
    try {
      const product = await storage.getProduct(req.params.id);
      if (!product || product.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Producto no encontrado' });
      }
      const movements = await storage.getStockMovementsByProduct(req.params.id);
      res.json(movements);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/products/:id/movements', requireAuth, requirePermission('transactions:create'), async (req: any, res) => {
    try {
      const product = await storage.getProduct(req.params.id);
      if (!product) {
        return res.status(404).json({ message: 'Producto no encontrado' });
      }

      const { type, quantity, reason } = req.body;
      const currentStock = parseFloat(product.stock);
      const qty = parseFloat(quantity);
      
      let newStock: number;
      if (type === 'entry') {
        newStock = currentStock + qty;
      } else if (type === 'exit') {
        newStock = currentStock - qty;
      } else {
        newStock = qty;
      }

      const movement = await storage.createStockMovement({
        productId: req.params.id,
        organizationId: req.organizationId,
        type,
        quantity: String(qty),
        previousStock: String(currentStock),
        newStock: String(newStock),
        reason,
        createdBy: req.userId,
      });

      await storage.updateProduct(req.params.id, { stock: String(newStock) });

      res.json(movement);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Asset routes
  app.get('/api/assets', requireAuth, async (req: any, res) => {
    try {
      const activeOnly = req.query.active === 'true';
      const assets = await storage.getAssetsByOrganization(req.organizationId, activeOnly);
      res.json(assets);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/assets/:id', requireAuth, async (req: any, res) => {
    try {
      const asset = await storage.getAsset(req.params.id);
      if (!asset || asset.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Activo no encontrado' });
      }
      res.json(asset);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/assets', requireAuth, requirePermission('accounts:create'), async (req: any, res) => {
    try {
      const asset = await storage.createAsset({
        ...req.body,
        organizationId: req.organizationId,
      });
      res.status(201).json(asset);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.patch('/api/assets/:id', requireAuth, requirePermission('accounts:edit'), async (req: any, res) => {
    try {
      const asset = await storage.getAsset(req.params.id);
      if (!asset || asset.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Activo no encontrado' });
      }
      const updated = await storage.updateAsset(req.params.id, req.body);
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.delete('/api/assets/:id', requireAuth, requirePermission('accounts:delete'), async (req: any, res) => {
    try {
      const asset = await storage.getAsset(req.params.id);
      if (!asset || asset.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Activo no encontrado' });
      }
      await storage.deleteAsset(req.params.id);
      res.json({ message: 'Activo eliminado' });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/assets/depreciation', requireAuth, requirePermission('accounts:edit'), async (req: any, res) => {
    try {
      const { processDepreciationForOrganization } = await import('../services/depreciation');
      const results = await processDepreciationForOrganization(req.organizationId);
      res.json({
        message: `Depreciación calculada para ${results.length} activos`,
        results,
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Investment routes
  app.get('/api/investments', requireAuth, async (req: any, res) => {
    try {
      const activeOnly = req.query.active === 'true';
      const investments = await storage.getInvestmentsByOrganization(req.organizationId, activeOnly);
      res.json(investments);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/investments', requireAuth, requirePermission('accounts:create'), async (req: any, res) => {
    try {
      const investment = await storage.createInvestment({
        ...req.body,
        organizationId: req.organizationId,
      });
      res.status(201).json(investment);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.patch('/api/investments/:id', requireAuth, requirePermission('accounts:edit'), async (req: any, res) => {
    try {
      const investment = await storage.getInvestment(req.params.id);
      if (!investment || investment.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Inversión no encontrada' });
      }
      const updated = await storage.updateInvestment(req.params.id, req.body);
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.delete('/api/investments/:id', requireAuth, requirePermission('accounts:delete'), async (req: any, res) => {
    try {
      const investment = await storage.getInvestment(req.params.id);
      if (!investment || investment.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Inversión no encontrada' });
      }
      await storage.deleteInvestment(req.params.id);
      res.json({ message: 'Inversión eliminada' });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Audit log routes
  app.get('/api/audit-logs', requireAuth, async (req: any, res) => {
    try {
      const limit = parseInt(req.query.limit) || 100;
      const logs = await storage.getAuditLogsByOrganization(req.organizationId, limit);
      res.json(logs);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/audit-logs/:entityType/:entityId', requireAuth, async (req: any, res) => {
    try {
      const logs = await storage.getAuditLogsByEntity(req.params.entityType, req.params.entityId);
      res.json(logs);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Exchange rates endpoint - fetches real-time rates from DolarApi.com
  app.get('/api/exchange-rates', requireAuth, async (req: any, res) => {
    try {
      const organization = await storage.getOrganization(req.organizationId);
      const country = organization?.country || 'AR';
      
      let rates: any = { usdToLocal: 1050, eurToLocal: 1150, source: 'default', timestamp: new Date().toISOString() };
      
      if (country === 'AR') {
        const [dolarRes, euroRes] = await Promise.all([
          fetch('https://dolarapi.com/v1/dolares/blue').then(r => r.json()).catch(() => null),
          fetch('https://dolarapi.com/v1/cotizaciones/eur').then(r => r.json()).catch(() => null)
        ]);
        
        if (dolarRes && dolarRes.venta) {
          rates.usdToLocal = dolarRes.venta;
          rates.usdBuy = dolarRes.compra;
          rates.usdSell = dolarRes.venta;
          rates.source = 'Dólar Blue';
          rates.timestamp = dolarRes.fechaActualizacion || new Date().toISOString();
        }
        
        if (euroRes && euroRes.venta) {
          rates.eurToLocal = euroRes.venta;
          rates.eurBuy = euroRes.compra;
          rates.eurSell = euroRes.venta;
        }
      } else if (country === 'MX') {
        const response = await fetch('https://dolarapi.com/v1/cotizaciones/mxn').then(r => r.json()).catch(() => null);
        if (response && response.venta) {
          rates.usdToLocal = response.venta;
          rates.source = 'Dólar oficial';
        }
      }
      
      res.json(rates);
    } catch (error: any) {
      console.error('Exchange rates error:', error);
      res.json({ usdToLocal: 1050, eurToLocal: 1150, source: 'fallback', timestamp: new Date().toISOString() });
    }
  });

  app.get('/api/employees/payroll-summary', requireAuth, async (req: any, res) => {
    try {
      const employees = await storage.getEmployeesByOrganization(req.organizationId, true);
      const org = await storage.getOrganization(req.organizationId);
      const payrollPayDay = org?.payrollPayDay || null;

      const byCurrency: Record<string, { total: number; employees: { id: string; fullName: string; grossSalary: string; currency: string }[] }> = {};
      for (const emp of employees) {
        const currency = emp.currency || 'ARS';
        if (!byCurrency[currency]) byCurrency[currency] = { total: 0, employees: [] };
        const salary = parseFloat(emp.grossSalary) || 0;
        byCurrency[currency].total += salary;
        byCurrency[currency].employees.push({
          id: emp.id,
          fullName: emp.fullName,
          grossSalary: emp.grossSalary,
          currency,
        });
      }

      let nextPayDate: string | null = null;
      let payrollStatus: 'not_configured' | 'pending' | 'overdue' | 'paid' = 'not_configured';
      if (payrollPayDay && employees.length > 0) {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const thisMonthPayDay = new Date(now.getFullYear(), now.getMonth(), payrollPayDay);

        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        const existingPayroll = await db.select().from(transactions)
          .where(and(
            eq(transactions.organizationId, req.organizationId),
            eq(transactions.type, 'expense'),
            eq(transactions.category, 'Sueldos'),
            eq(transactions.status, 'completed'),
            gte(transactions.date, monthStart),
            lte(transactions.date, monthEnd),
          ));
        const paidCurrencies = new Set(existingPayroll.map(t => {
          const c = t.currency || 'ARS';
          return (c === 'USD_CASH' || c.toUpperCase().includes('USD')) ? 'USD' : c;
        }));
        const allCurrencies = Object.keys(byCurrency).map(c => (c === 'USD_CASH' || c.toUpperCase().includes('USD')) ? 'USD' : c);
        const allPaid = allCurrencies.length > 0 && allCurrencies.every(c => paidCurrencies.has(c));

        if (allPaid) {
          const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, payrollPayDay);
          nextPayDate = nextMonth.toISOString();
          payrollStatus = 'paid';
        } else if (today <= thisMonthPayDay) {
          nextPayDate = thisMonthPayDay.toISOString();
          payrollStatus = 'pending';
        } else {
          const anyPriorPayroll = await db.select({ id: transactions.id }).from(transactions)
            .where(and(
              eq(transactions.organizationId, req.organizationId),
              eq(transactions.type, 'expense'),
              eq(transactions.category, 'Sueldos'),
              eq(transactions.status, 'completed'),
            ))
            .limit(1);

          if (anyPriorPayroll.length === 0) {
            const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, payrollPayDay);
            nextPayDate = nextMonth.toISOString();
            payrollStatus = 'pending';
          } else {
            nextPayDate = thisMonthPayDay.toISOString();
            payrollStatus = 'overdue';
          }
        }
      }

      res.json({
        totalEmployees: employees.length,
        byCurrency,
        payrollPayDay,
        nextPayDate,
        payrollStatus,
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/organization/payroll-settings', requireAuth, async (req: any, res) => {
    try {
      const org = await storage.getOrganization(req.organizationId);
      res.json({ payrollPayDay: org?.payrollPayDay || null });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.patch('/api/organization/payroll-settings', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const rawDay = req.body?.payrollPayDay;
      const payrollPayDay = typeof rawDay === 'number' ? rawDay : parseInt(rawDay, 10);
      if (!Number.isInteger(payrollPayDay) || payrollPayDay < 1 || payrollPayDay > 28) {
        return res.status(400).json({ message: 'El día de pago debe ser entre 1 y 28' });
      }
      const org = await storage.updateOrganization(req.organizationId, { payrollPayDay });
      res.json({ payrollPayDay: org?.payrollPayDay });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/payroll/pay', requireAuth, requirePermission('transactions:create'), async (req: any, res) => {
    try {
      const { accountId } = req.body;
      if (!accountId || typeof accountId !== 'string') {
        return res.status(400).json({ message: 'Seleccioná una cuenta para el pago' });
      }

      const account = await storage.getAccount(accountId);
      if (!account || account.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Cuenta no encontrada' });
      }

      const employees = await storage.getEmployeesByOrganization(req.organizationId, true);
      if (employees.length === 0) {
        return res.status(400).json({ message: 'No hay empleados activos' });
      }

      const accountCurrency = account.currency || 'ARS';
      const normalizedAccountCurrency = (accountCurrency === 'USD_CASH' || accountCurrency.toUpperCase().includes('USD')) ? 'USD' : accountCurrency;
      
      let payAmount = 0;
      const paidEmployeeNames: string[] = [];
      for (const emp of employees) {
        const currency = emp.currency || 'ARS';
        const normalizedC = (currency === 'USD_CASH' || currency.toUpperCase().includes('USD')) ? 'USD' : currency;
        const salary = parseFloat(emp.grossSalary) || 0;
        if (salary > 0 && normalizedC === normalizedAccountCurrency) {
          payAmount += salary;
          paidEmployeeNames.push(emp.fullName);
        }
      }

      if (payAmount <= 0) {
        return res.status(400).json({ message: `No hay sueldos en la moneda de la cuenta seleccionada (${accountCurrency})` });
      }

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      const existingPayroll = await db.select().from(transactions)
        .where(and(
          eq(transactions.organizationId, req.organizationId),
          eq(transactions.type, 'expense'),
          eq(transactions.category, 'Sueldos'),
          eq(transactions.status, 'completed'),
          eq(transactions.currency, accountCurrency),
          gte(transactions.date, monthStart),
          lte(transactions.date, monthEnd),
        ))
        .limit(1);
      if (existingPayroll.length > 0) {
        return res.status(400).json({ message: `Los sueldos en ${accountCurrency} de este mes ya fueron pagados` });
      }

      const transaction = await storage.createTransaction({
        type: 'expense',
        amount: payAmount.toFixed(2),
        currency: accountCurrency,
        description: `Pago de sueldos - ${paidEmployeeNames.length} empleado${paidEmployeeNames.length !== 1 ? 's' : ''} [Mensual]`,
        category: 'Sueldos',
        date: now,
        imputationDate: now,
        accountId,
        organizationId: req.organizationId,
        createdBy: req.userId,
        hasInvoice: false,
        status: 'completed',
        completedBy: req.userId,
        completedAt: now,
      });

      res.json({
        transaction,
        paidAmount: payAmount,
        currency: accountCurrency,
        employeeCount: paidEmployeeNames.length,
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/employees', requireAuth, async (req: any, res) => {
    try {
      const activeOnly = req.query.activeOnly === 'true';
      const employees = await storage.getEmployeesByOrganization(req.organizationId, activeOnly);
      const clients = await storage.getClientsByOrganization(req.organizationId, false);
      const clientMap = new Map(clients.map(c => [c.id, c.name]));
      const enriched = await Promise.all(employees.map(async (emp) => {
        const allocs = await storage.getAllocationsByEmployee(emp.id);
        return {
          ...emp,
          allocations: allocs.map(a => ({
            clientId: a.clientId,
            clientName: clientMap.get(a.clientId) || 'Desconocido',
            projectName: a.projectName || '',
            percentage: a.percentage,
            commissionRate: a.commissionRate || '0',
          })),
        };
      }));
      res.json(enriched);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/employees/:id', requireAuth, async (req: any, res) => {
    try {
      const employee = await storage.getEmployee(req.params.id);
      if (!employee || employee.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Empleado no encontrado' });
      }
      res.json(employee);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/employees', requireAuth, requirePermission('transactions:create'), async (req: any, res) => {
    try {
      const { createEmployeeSchema } = await import('@shared/schema');
      const parseResult = createEmployeeSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parseResult.error.errors });
      }
      const employee = await storage.createEmployee({
        ...parseResult.data,
        organizationId: req.organizationId,
      });
      
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'employee',
        entityId: employee.id,
        action: 'create',
        previousData: null,
        newData: JSON.stringify(employee),
      });
      
      res.json(employee);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.patch('/api/employees/:id', requireAuth, requirePermission('transactions:edit'), async (req: any, res) => {
    try {
      const previousEmployee = await storage.getEmployee(req.params.id);
      if (!previousEmployee || previousEmployee.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Empleado no encontrado' });
      }
      
      const { updateEmployeeSchema } = await import('@shared/schema');
      const parseResult = updateEmployeeSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parseResult.error.errors });
      }
      
      const employee = await storage.updateEmployee(req.params.id, parseResult.data);
      if (!employee) {
        return res.status(404).json({ message: 'Empleado no encontrado' });
      }
      
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'employee',
        entityId: employee.id,
        action: 'update',
        previousData: previousEmployee ? JSON.stringify(previousEmployee) : null,
        newData: JSON.stringify(employee),
      });
      
      res.json(employee);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.delete('/api/employees/:id', requireAuth, requirePermission('transactions:delete'), async (req: any, res) => {
    try {
      const previousEmployee = await storage.getEmployee(req.params.id);
      if (!previousEmployee || previousEmployee.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Empleado no encontrado' });
      }
      
      const undoKey = stashForUndo('employee', req.params.id, previousEmployee, req.organizationId, req.userId);

      const success = await storage.deleteEmployee(req.params.id);
      if (!success) {
        return res.status(404).json({ message: 'Empleado no encontrado' });
      }
      
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'employee',
        entityId: req.params.id,
        action: 'delete',
        previousData: previousEmployee ? JSON.stringify(previousEmployee) : null,
        newData: null,
      });
      
      res.json({ success: true, undoKey });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/employees/:id/allocations', requireAuth, async (req: any, res) => {
    try {
      const employee = await storage.getEmployee(req.params.id);
      if (!employee || employee.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Empleado no encontrado' });
      }
      const allocations = await storage.getAllocationsByEmployee(req.params.id);
      res.json(allocations);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.put('/api/employees/:id/allocations', requireAuth, requirePermission('transactions:edit'), async (req: any, res) => {
    try {
      const employee = await storage.getEmployee(req.params.id);
      if (!employee || employee.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Empleado no encontrado' });
      }
      const incoming = req.body.allocations || [];
      if (incoming.length > 0) {
        const orgClients = await storage.getClientsByOrganization(req.organizationId, false);
        const orgClientIds = new Set(orgClients.map(c => c.id));
        for (const alloc of incoming) {
          if (!orgClientIds.has(alloc.clientId)) {
            return res.status(400).json({ message: `Cliente ${alloc.clientId} no pertenece a esta organización` });
          }
          if (alloc.projectId) {
            const project = await storage.getProject(alloc.projectId);
            if (!project || project.clientId !== alloc.clientId) {
              return res.status(400).json({ message: `Proyecto ${alloc.projectId} no pertenece al cliente seleccionado` });
            }
          }
        }
      }
      const allocations = await storage.setAllocationsForEmployee(req.params.id, incoming);
      res.json(allocations);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/clients/:clientId/projects', requireAuth, async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.clientId);
      if (!client || client.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Cliente no encontrado' });
      }
      const projects = await storage.getProjectsByClient(req.params.clientId);
      res.json(projects);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/clients/:clientId/projects', requireAuth, requirePermission('transactions:create'), async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.clientId);
      if (!client || client.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Cliente no encontrado' });
      }
      const { name, description } = req.body;
      if (!name || !name.trim()) {
        return res.status(400).json({ message: 'El nombre del proyecto es requerido' });
      }
      const project = await storage.createProject({
        clientId: req.params.clientId,
        organizationId: req.organizationId,
        name: name.trim(),
        description: description?.trim() || null,
      });
      res.status(201).json(project);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.patch('/api/clients/:clientId/projects/:projectId', requireAuth, requirePermission('transactions:edit'), async (req: any, res) => {
    try {
      const project = await storage.getProject(req.params.projectId);
      if (!project || project.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Proyecto no encontrado' });
      }
      const updates: any = {};
      if (req.body.name !== undefined) updates.name = req.body.name.trim();
      if (req.body.description !== undefined) updates.description = req.body.description?.trim() || null;
      if (req.body.isActive !== undefined) updates.isActive = req.body.isActive;
      const updated = await storage.updateProject(req.params.projectId, updates);
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.delete('/api/clients/:clientId/projects/:projectId', requireAuth, requirePermission('transactions:delete'), async (req: any, res) => {
    try {
      const project = await storage.getProject(req.params.projectId);
      if (!project || project.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Proyecto no encontrado' });
      }
      await storage.deleteProject(req.params.projectId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
}
