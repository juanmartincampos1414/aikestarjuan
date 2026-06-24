// =============================================================================
// AIKESTAR - Servicio de Remitos (comprobante de entrega)
// =============================================================================
// Genera remitos manuales o desde un presupuesto / orden de trabajo. El descuento
// de stock es configurable por remito (stockApplied). Espejo del patrón de quotes.
// =============================================================================
import { db } from '../db';
import { and, eq, sql, desc, count } from 'drizzle-orm';
import {
  remitos, remitoItems, products, stockMovements, quotes, quoteItems, workOrders, workOrderMaterials,
  type Remito,
} from '@shared/schema';
import { storage } from '../storage';

async function audit(orgId: string, userId: string | null, id: string, action: string, data: any) {
  await storage.createAuditLog({ organizationId: orgId, userId: userId ?? null, entityType: 'remito', entityId: id, action, newData: JSON.stringify(data) } as any).catch(() => {});
}

// Numeración por organización: 0001-00000001 (punto de venta fijo 0001).
export function formatRemitoNumber(existingCount: number): string {
  return `0001-${(existingCount + 1).toString().padStart(8, '0')}`;
}
async function nextNumber(organizationId: string): Promise<string> {
  const [{ c }] = await db.select({ c: count() }).from(remitos).where(eq(remitos.organizationId, organizationId));
  return formatRemitoNumber(Number(c));
}

export interface RemitoItemInput { description: string; quantity?: string | number; productId?: string | null; unitPrice?: string | number | null; }

// Descuenta stock (salida) de los ítems con producto. Atómico por fila + movimiento auditado.
async function applyStockExit(organizationId: string, items: RemitoItemInput[], reason: string, userId: string | null) {
  for (const it of items) {
    if (!it.productId) continue;
    const qty = parseFloat(String(it.quantity ?? '1')) || 0;
    if (qty <= 0) continue;
    const [updated] = await db.update(products)
      .set({ stock: sql`(CAST(${products.stock} AS DECIMAL) - ${qty})`, updatedAt: new Date() })
      .where(and(eq(products.id, it.productId), eq(products.organizationId, organizationId)))
      .returning({ stock: products.stock });
    if (!updated) continue;
    const newStock = parseFloat(String(updated.stock ?? '0'));
    await storage.createStockMovement({
      productId: it.productId, organizationId, type: 'exit', quantity: String(qty),
      previousStock: String(newStock + qty), newStock: String(newStock), reason, createdBy: userId,
    } as any).catch(() => {});
  }
}

async function restoreStock(organizationId: string, remitoId: string, reason: string, userId: string | null) {
  const items = await db.select().from(remitoItems).where(eq(remitoItems.remitoId, remitoId));
  for (const it of items) {
    if (!it.productId) continue;
    const qty = parseFloat(String(it.quantity ?? '1')) || 0;
    if (qty <= 0) continue;
    const [updated] = await db.update(products)
      .set({ stock: sql`(CAST(${products.stock} AS DECIMAL) + ${qty})`, updatedAt: new Date() })
      .where(eq(products.id, it.productId)).returning({ stock: products.stock });
    if (!updated) continue;
    const newStock = parseFloat(String(updated.stock ?? '0'));
    await storage.createStockMovement({
      productId: it.productId, organizationId, type: 'entry', quantity: String(qty),
      previousStock: String(newStock - qty), newStock: String(newStock), reason, createdBy: userId,
    } as any).catch(() => {});
  }
}

export async function createRemito(input: {
  organizationId: string; clientId?: string | null; clientName?: string | null; notes?: string | null;
  items: RemitoItemInput[]; applyStock?: boolean; linkedQuoteId?: string | null; linkedWorkOrderId?: string | null;
  createdBy?: string | null;
}): Promise<Remito> {
  const number = await nextNumber(input.organizationId);
  const [remito] = await db.insert(remitos).values({
    organizationId: input.organizationId, number,
    clientId: input.clientId ?? null, clientName: input.clientName ?? null, notes: input.notes ?? null,
    linkedQuoteId: input.linkedQuoteId ?? null, linkedWorkOrderId: input.linkedWorkOrderId ?? null,
    stockApplied: !!input.applyStock, createdBy: input.createdBy ?? null,
  }).returning();

  if (input.items.length > 0) {
    await db.insert(remitoItems).values(input.items.map((it) => ({
      remitoId: remito.id, organizationId: input.organizationId, productId: it.productId ?? null,
      description: it.description, quantity: String(it.quantity ?? '1'),
      unitPrice: it.unitPrice != null ? String(it.unitPrice) : null,
    })));
  }

  if (input.applyStock) {
    await applyStockExit(input.organizationId, input.items, `Remito ${number}`, input.createdBy ?? null);
  }
  await audit(input.organizationId, input.createdBy ?? null, remito.id, 'create', { number, applyStock: !!input.applyStock });
  return remito;
}

export async function createFromQuote(quoteId: string, organizationId: string, applyStock: boolean, userId: string | null): Promise<Remito | undefined> {
  const [q] = await db.select().from(quotes).where(and(eq(quotes.id, quoteId), eq(quotes.organizationId, organizationId))).limit(1);
  if (!q) return undefined;
  const items = await db.select().from(quoteItems).where(eq(quoteItems.quoteId, quoteId));
  const mapped: RemitoItemInput[] = items.length > 0
    ? items.map((it) => ({ description: it.description || 'Ítem', quantity: it.quantity, productId: it.productId, unitPrice: it.unitPrice }))
    : [{ description: q.title, quantity: '1', unitPrice: q.amount }];
  return createRemito({ organizationId, clientId: q.clientId, clientName: q.clientName, items: mapped, applyStock, linkedQuoteId: q.id, createdBy: userId });
}

export async function createFromWorkOrder(workOrderId: string, organizationId: string, applyStock: boolean, userId: string | null): Promise<Remito | undefined> {
  const [w] = await db.select().from(workOrders).where(and(eq(workOrders.id, workOrderId), eq(workOrders.organizationId, organizationId))).limit(1);
  if (!w) return undefined;
  const mats = await db.select().from(workOrderMaterials).where(eq(workOrderMaterials.workOrderId, workOrderId));
  const mapped: RemitoItemInput[] = mats.map((m) => ({ description: m.description, quantity: m.quantity, productId: m.productId, unitPrice: m.unitCost }));
  if (mapped.length === 0) mapped.push({ description: w.title, quantity: '1' });
  return createRemito({ organizationId, clientId: w.clientId, items: mapped, applyStock, linkedWorkOrderId: w.id, createdBy: userId });
}

export async function getRemito(id: string) {
  const [remito] = await db.select().from(remitos).where(eq(remitos.id, id)).limit(1);
  if (!remito) return undefined;
  const items = await db.select().from(remitoItems).where(eq(remitoItems.remitoId, id));
  return { remito, items };
}

export async function listRemitos(organizationId: string): Promise<Remito[]> {
  return db.select().from(remitos).where(eq(remitos.organizationId, organizationId)).orderBy(desc(remitos.date));
}

export async function cancelRemito(id: string, organizationId: string, userId: string | null): Promise<Remito | undefined> {
  const [remito] = await db.select().from(remitos).where(and(eq(remitos.id, id), eq(remitos.organizationId, organizationId))).limit(1);
  if (!remito || remito.status === 'anulado') return remito;
  if (remito.stockApplied) {
    await restoreStock(organizationId, id, `Anulación remito ${remito.number}`, userId);
  }
  const [row] = await db.update(remitos).set({ status: 'anulado', updatedAt: new Date() }).where(eq(remitos.id, id)).returning();
  await audit(organizationId, userId, id, 'cancel', { number: remito.number });
  return row;
}
