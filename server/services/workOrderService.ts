// =============================================================================
// AIKESTAR - Servicio de Órdenes de Trabajo
// =============================================================================
// La OT nace de un presupuesto aprobado. Estados, asignaciones (empleados),
// materiales, fotos (URL) y timeline operativo con trazabilidad completa.
// =============================================================================
import { db } from '../db';
import { and, eq, desc } from 'drizzle-orm';
import {
  workOrders, workOrderAssignments, workOrderMaterials, workOrderPhotos, workOrderTimeline,
  employees, WORK_ORDER_STATES, WORK_ORDER_STATE_LABELS,
  type WorkOrder, type WorkOrderState,
} from '@shared/schema';
import { storage } from '../storage';

async function addTimeline(workOrderId: string, event: string, detail: any, userId: string | null) {
  await db.insert(workOrderTimeline).values({ workOrderId, event, detail: detail ?? null, createdByUserId: userId ?? null }).catch(() => {});
}
async function audit(orgId: string, userId: string | null, id: string, action: string, data: any) {
  await storage.createAuditLog({ organizationId: orgId, userId: userId ?? null, entityType: 'work_order', entityId: id, action, newData: JSON.stringify(data) } as any).catch(() => {});
}

// ── Crear desde presupuesto ganado (idempotente por quoteId) ─────────────────
export async function createFromQuote(quote: any, userId?: string | null): Promise<WorkOrder | undefined> {
  if (!quote?.id) return undefined;
  const [existing] = await db.select().from(workOrders).where(eq(workOrders.quoteId, quote.id)).limit(1);
  if (existing) return existing;
  const [wo] = await db.insert(workOrders).values({
    organizationId: quote.organizationId,
    quoteId: quote.id,
    clientId: quote.clientId ?? null,
    title: quote.title || 'Orden de trabajo',
    ownerUserId: userId ?? quote.createdBy ?? null,
    status: 'pendiente',
    priority: 'medium',
    createdBy: userId ?? null,
  }).returning();
  await addTimeline(wo.id, 'created', { fromQuote: quote.id }, userId ?? null);
  await audit(quote.organizationId, userId ?? null, wo.id, 'create', { title: wo.title, fromQuote: quote.id });
  return wo;
}

export async function createWorkOrder(input: {
  organizationId: string; title: string; clientId?: string | null; ownerUserId?: string | null;
  priority?: string; scheduledDate?: Date | null; createdBy?: string | null;
}): Promise<WorkOrder> {
  const [wo] = await db.insert(workOrders).values({
    organizationId: input.organizationId, title: input.title, clientId: input.clientId ?? null,
    ownerUserId: input.ownerUserId ?? input.createdBy ?? null, status: 'pendiente',
    priority: input.priority ?? 'medium', scheduledDate: input.scheduledDate ?? null, createdBy: input.createdBy ?? null,
  }).returning();
  await addTimeline(wo.id, 'created', null, input.createdBy ?? null);
  return wo;
}

export async function getWorkOrder(id: string): Promise<WorkOrder | undefined> {
  const [row] = await db.select().from(workOrders).where(eq(workOrders.id, id)).limit(1);
  return row;
}

export async function listWorkOrders(organizationId: string, filters?: { status?: string; priority?: string }): Promise<WorkOrder[]> {
  let rows = await db.select().from(workOrders).where(eq(workOrders.organizationId, organizationId)).orderBy(desc(workOrders.updatedAt));
  if (filters?.status) rows = rows.filter(r => r.status === filters.status);
  if (filters?.priority) rows = rows.filter(r => r.priority === filters.priority);
  return rows;
}

export async function updateWorkOrder(id: string, patch: Partial<typeof workOrders.$inferInsert>, userId?: string | null): Promise<WorkOrder | undefined> {
  const [row] = await db.update(workOrders).set({ ...patch, updatedAt: new Date() }).where(eq(workOrders.id, id)).returning();
  if (row) await audit(row.organizationId, userId ?? null, id, 'update', patch);
  return row;
}

// ── Transición de estado (+ timeline + automatización) ────────────────────────
export function isValidState(s: string): s is WorkOrderState { return (WORK_ORDER_STATES as readonly string[]).includes(s); }

export async function transition(id: string, newStatus: WorkOrderState, userId?: string | null): Promise<WorkOrder | undefined> {
  if (!isValidState(newStatus)) throw new Error('Estado inválido');
  const wo = await getWorkOrder(id);
  if (!wo) return undefined;
  if (wo.status === newStatus) return wo;
  const patch: any = { status: newStatus, updatedAt: new Date() };
  if (newStatus === 'en_ejecucion' && !wo.executionDate) patch.executionDate = new Date();
  const [row] = await db.update(workOrders).set(patch).where(eq(workOrders.id, id)).returning();
  await addTimeline(id, 'status_change', { from: wo.status, to: newStatus }, userId ?? null);
  await audit(wo.organizationId, userId ?? null, id, 'transition', { from: wo.status, to: newStatus });

  // Automatización: al finalizar, sugerir facturación (notificación al responsable).
  if (newStatus === 'finalizado') {
    try {
      const owner = wo.ownerUserId ? { id: wo.ownerUserId } : await storage.getOrganizationOwner(wo.organizationId);
      if (owner) {
        await storage.createNotification({
          userId: owner.id, organizationId: wo.organizationId, type: 'workorder_finished',
          priority: 'info', title: 'Orden finalizada', message: `La orden "${wo.title}" se finalizó. ¿La facturamos?`, source: 'auto',
        } as any);
      }
    } catch { /* no bloquea */ }
  }
  return row;
}

// ── Asignaciones (empleados) ──────────────────────────────────────────────────
export async function addAssignment(workOrderId: string, employeeId: string, userId?: string | null) {
  const [row] = await db.insert(workOrderAssignments).values({ workOrderId, employeeId }).returning();
  await addTimeline(workOrderId, 'assignment_added', { employeeId }, userId ?? null);
  return row;
}
export async function removeAssignment(id: string) { await db.delete(workOrderAssignments).where(eq(workOrderAssignments.id, id)); }

// ── Materiales ────────────────────────────────────────────────────────────────
export async function addMaterial(workOrderId: string, input: { description: string; quantity?: string; unitCost?: string; productId?: string | null }, userId?: string | null) {
  const [row] = await db.insert(workOrderMaterials).values({
    workOrderId, description: input.description, quantity: input.quantity ?? '1', unitCost: input.unitCost ?? '0', productId: input.productId ?? null,
  }).returning();
  await addTimeline(workOrderId, 'material_added', { description: input.description, quantity: input.quantity }, userId ?? null);
  return row;
}
export async function removeMaterial(id: string) { await db.delete(workOrderMaterials).where(eq(workOrderMaterials.id, id)); }

// ── Fotos (URL) ───────────────────────────────────────────────────────────────
export async function addPhoto(workOrderId: string, url: string, caption: string | null, userId?: string | null) {
  const [row] = await db.insert(workOrderPhotos).values({ workOrderId, url, caption: caption ?? null, createdBy: userId ?? null }).returning();
  await addTimeline(workOrderId, 'photo_added', { url }, userId ?? null);
  return row;
}
export async function removePhoto(id: string) { await db.delete(workOrderPhotos).where(eq(workOrderPhotos.id, id)); }

// ── Detalle completo ──────────────────────────────────────────────────────────
export async function getDetail(id: string) {
  const wo = await getWorkOrder(id);
  if (!wo) return undefined;
  const assigns = await db.select({
    id: workOrderAssignments.id, employeeId: workOrderAssignments.employeeId,
    fullName: employees.fullName,
  }).from(workOrderAssignments)
    .leftJoin(employees, eq(workOrderAssignments.employeeId, employees.id))
    .where(eq(workOrderAssignments.workOrderId, id));
  const materials = await db.select().from(workOrderMaterials).where(eq(workOrderMaterials.workOrderId, id));
  const photos = await db.select().from(workOrderPhotos).where(eq(workOrderPhotos.workOrderId, id));
  const timeline = await db.select().from(workOrderTimeline).where(eq(workOrderTimeline.workOrderId, id)).orderBy(desc(workOrderTimeline.createdAt));
  return { workOrder: wo, assignments: assigns, materials, photos, timeline };
}

// ── Métricas de operaciones (dashboard) ───────────────────────────────────────
export function computeOpsMetrics(orders: WorkOrder[], now: Date = new Date()) {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  const pending = orders.filter(o => o.status === 'pendiente' || o.status === 'programado' || o.status === 'esperando_materiales').length;
  const todayScheduled = orders.filter(o => o.scheduledDate && new Date(o.scheduledDate) >= startOfDay && new Date(o.scheduledDate) < endOfDay).length;
  const inProgress = orders.filter(o => o.status === 'en_ejecucion').length;
  const finished = orders.filter(o => o.status === 'finalizado').length;
  const pendingInvoicing = orders.filter(o => o.status === 'finalizado').length;
  return { pending, todayScheduled, inProgress, finished, pendingInvoicing };
}

export async function getOpsMetrics(organizationId: string) {
  const orders = await db.select().from(workOrders).where(eq(workOrders.organizationId, organizationId));
  return computeOpsMetrics(orders);
}
