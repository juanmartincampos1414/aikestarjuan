// =============================================================================
// AIKESTAR - Servicio del CRM comercial
// =============================================================================
// Oportunidades + actividades (timeline). Integrado con presupuestos (quotes):
// crear quote → vincula/crea oportunidad; ganar/perder → mueve la etapa.
// =============================================================================
import { db } from '../db';
import { and, eq, desc, inArray } from 'drizzle-orm';
import {
  crmOpportunities, crmActivities, CRM_STAGES, workOrders, quotes,
  type CrmOpportunity, type CrmStage, type CrmActivityType,
} from '@shared/schema';
import { storage } from '../storage';

export function statusForStage(stage: CrmStage): 'open' | 'won' | 'lost' {
  if (stage === 'aprobado') return 'won';
  if (stage === 'perdido') return 'lost';
  return 'open';
}

// Helpers PUROS (sin DB) — reutilizados por getBoard/getCrmMetrics y testeables.
export function computeBoardColumns(opps: CrmOpportunity[]) {
  return CRM_STAGES.map((stage) => {
    const items = opps.filter(o => o.stage === stage);
    const total = items.reduce((acc, o) => acc + (parseFloat(o.estimatedValue ?? '0') || 0), 0);
    return { stage, count: items.length, total, items };
  });
}

export function computeMetrics(opps: CrmOpportunity[], now: Date = new Date()) {
  const open = opps.filter(o => o.status === 'open');
  const won = opps.filter(o => o.status === 'won').length;
  const lost = opps.filter(o => o.status === 'lost').length;
  const pipelineValue = open.reduce((acc, o) => acc + (parseFloat(o.estimatedValue ?? '0') || 0), 0);
  const closeRate = (won + lost) > 0 ? Math.round((won / (won + lost)) * 100) : 0;
  const overdueFollowups = open.filter(o => o.nextFollowupAt && new Date(o.nextFollowupAt) < now).length;
  return { activeOpportunities: open.length, pipelineValue, closeRate, overdueFollowups, won, lost };
}

async function audit(orgId: string, userId: string | null, entityId: string, action: string, data: any) {
  await storage.createAuditLog({
    organizationId: orgId, userId: userId ?? null,
    entityType: 'crm_opportunity', entityId, action, newData: JSON.stringify(data),
  } as any).catch(() => {});
}

// ── Oportunidades ─────────────────────────────────────────────────────────────
export async function createOpportunity(input: {
  organizationId: string; title: string; clientId?: string | null;
  contactName?: string | null; phone?: string | null; email?: string | null;
  description?: string | null; estimatedValue?: string | null; currency?: string;
  probability?: number; stage?: CrmStage; ownerUserId?: string | null;
  quoteId?: string | null; expectedCloseDate?: Date | null; nextFollowupAt?: Date | null;
  createdBy?: string | null;
}): Promise<CrmOpportunity> {
  const stage = (input.stage && CRM_STAGES.includes(input.stage)) ? input.stage : 'consulta';
  const [opp] = await db.insert(crmOpportunities).values({
    organizationId: input.organizationId,
    title: input.title,
    clientId: input.clientId ?? null,
    contactName: input.contactName ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    description: input.description ?? null,
    estimatedValue: input.estimatedValue ?? '0',
    currency: input.currency ?? 'ARS',
    probability: input.probability ?? 50,
    stage,
    status: statusForStage(stage),
    ownerUserId: input.ownerUserId ?? input.createdBy ?? null,
    quoteId: input.quoteId ?? null,
    expectedCloseDate: input.expectedCloseDate ?? null,
    nextFollowupAt: input.nextFollowupAt ?? null,
    createdBy: input.createdBy ?? null,
  }).returning();
  await audit(input.organizationId, input.createdBy ?? null, opp.id, 'create', { title: opp.title, stage });
  await addActivity({ opportunityId: opp.id, organizationId: input.organizationId, type: 'system', content: 'Oportunidad creada', createdByUserId: input.createdBy ?? null });
  return opp;
}

export async function getOpportunity(id: string): Promise<CrmOpportunity | undefined> {
  const [row] = await db.select().from(crmOpportunities).where(eq(crmOpportunities.id, id)).limit(1);
  return row;
}

export async function listOpportunities(organizationId: string, filters?: { ownerUserId?: string; q?: string; status?: string }): Promise<CrmOpportunity[]> {
  let rows = await db.select().from(crmOpportunities)
    .where(eq(crmOpportunities.organizationId, organizationId))
    .orderBy(desc(crmOpportunities.updatedAt));
  if (filters?.ownerUserId) rows = rows.filter(r => r.ownerUserId === filters.ownerUserId);
  if (filters?.status) rows = rows.filter(r => r.status === filters.status);
  if (filters?.q) {
    const t = filters.q.toLowerCase();
    rows = rows.filter(r => (r.title || '').toLowerCase().includes(t) || (r.contactName || '').toLowerCase().includes(t));
  }
  return rows;
}

export async function updateOpportunity(id: string, patch: Partial<typeof crmOpportunities.$inferInsert>, userId?: string | null): Promise<CrmOpportunity | undefined> {
  const [row] = await db.update(crmOpportunities).set({ ...patch, updatedAt: new Date() }).where(eq(crmOpportunities.id, id)).returning();
  if (row) await audit(row.organizationId, userId ?? null, id, 'update', patch);
  return row;
}

export async function moveStage(id: string, newStage: CrmStage, userId?: string | null): Promise<CrmOpportunity | undefined> {
  if (!CRM_STAGES.includes(newStage)) throw new Error('Etapa inválida');
  const opp = await getOpportunity(id);
  if (!opp) return undefined;
  if (opp.stage === newStage) return opp;
  const [row] = await db.update(crmOpportunities)
    .set({ stage: newStage, status: statusForStage(newStage), updatedAt: new Date() })
    .where(eq(crmOpportunities.id, id)).returning();
  await addActivity({ opportunityId: id, organizationId: opp.organizationId, type: 'stage_change', content: `${opp.stage} → ${newStage}`, createdByUserId: userId ?? null });
  await audit(opp.organizationId, userId ?? null, id, 'move_stage', { from: opp.stage, to: newStage });
  return row;
}

// ── Actividades (timeline) ────────────────────────────────────────────────────
export async function addActivity(input: {
  opportunityId: string; organizationId: string; type: CrmActivityType | string;
  content?: string | null; scheduledAt?: Date | null; createdByUserId?: string | null;
}) {
  const [row] = await db.insert(crmActivities).values({
    opportunityId: input.opportunityId, organizationId: input.organizationId,
    type: input.type, content: input.content ?? null,
    scheduledAt: input.scheduledAt ?? null, createdByUserId: input.createdByUserId ?? null,
  }).returning();
  // Si la actividad agenda un próximo contacto, lo reflejamos en la oportunidad.
  if (input.scheduledAt) {
    await db.update(crmOpportunities).set({ nextFollowupAt: input.scheduledAt, updatedAt: new Date() }).where(eq(crmOpportunities.id, input.opportunityId));
  }
  return row;
}

export async function getActivities(opportunityId: string) {
  return db.select().from(crmActivities).where(eq(crmActivities.opportunityId, opportunityId)).orderBy(desc(crmActivities.createdAt));
}

// ── Board (Kanban) ────────────────────────────────────────────────────────────
export async function getBoard(organizationId: string, filters?: { ownerUserId?: string; q?: string }) {
  const opps = await listOpportunities(organizationId, filters);
  return { columns: computeBoardColumns(opps) };
}

// ── Hooks de presupuestos (quotes) ────────────────────────────────────────────
async function findByQuote(quoteId: string): Promise<CrmOpportunity | undefined> {
  const [row] = await db.select().from(crmOpportunities).where(eq(crmOpportunities.quoteId, quoteId)).limit(1);
  return row;
}

// Al crear un presupuesto: si no hay oportunidad vinculada, la creamos en
// "presupuesto_preparacion"; si ya existe, la movemos a esa etapa.
export async function onQuoteCreated(quote: any, userId?: string | null): Promise<void> {
  if (!quote?.id) return;
  const existing = await findByQuote(quote.id);
  if (existing) {
    if (existing.stage === 'consulta' || existing.stage === 'visita') await moveStage(existing.id, 'presupuesto_preparacion', userId);
    return;
  }
  await createOpportunity({
    organizationId: quote.organizationId,
    title: quote.title || 'Presupuesto',
    clientId: quote.clientId ?? null,
    contactName: quote.clientName ?? null,
    estimatedValue: String(quote.amount ?? '0'),
    currency: quote.currency ?? 'ARS',
    stage: 'presupuesto_preparacion',
    quoteId: quote.id,
    createdBy: userId ?? quote.createdBy ?? null,
  });
}

export async function onQuoteWon(quote: any, userId?: string | null): Promise<void> {
  if (!quote?.id) return;
  const opp = await findByQuote(quote.id);
  if (opp && opp.stage !== 'aprobado') await moveStage(opp.id, 'aprobado', userId);
}

export async function onQuoteLost(quote: any, userId?: string | null): Promise<void> {
  if (!quote?.id) return;
  const opp = await findByQuote(quote.id);
  if (opp && opp.stage !== 'perdido') await moveStage(opp.id, 'perdido', userId);
}

// ── Métricas para el dashboard ────────────────────────────────────────────────
export async function getCrmMetrics(organizationId: string) {
  const opps = await db.select().from(crmOpportunities).where(eq(crmOpportunities.organizationId, organizationId));
  return computeMetrics(opps);
}

// Eventos para el calendario: visitas/seguimientos agendados, vencimientos de
// presupuestos y órdenes de trabajo programadas (en un rango opcional).
export interface CalendarEvent { kind: 'activity' | 'quote_due' | 'work_order'; title: string; date: string; refId: string; meta?: any; }

export async function getCalendarEvents(organizationId: string, from?: Date, to?: Date): Promise<CalendarEvent[]> {
  const inRange = (d: Date | null | undefined) => !!d && (!from || d >= from) && (!to || d <= to);
  const events: CalendarEvent[] = [];

  const acts = await db.select().from(crmActivities).where(eq(crmActivities.organizationId, organizationId));
  for (const a of acts) {
    if (a.scheduledAt && inRange(a.scheduledAt)) {
      events.push({ kind: 'activity', title: `${a.type === 'visit' ? 'Visita' : 'Seguimiento'}: ${a.content || ''}`.trim(), date: new Date(a.scheduledAt).toISOString(), refId: a.opportunityId, meta: { type: a.type } });
    }
  }

  const qs = await db.select().from(quotes).where(eq(quotes.organizationId, organizationId));
  for (const q of qs) {
    if (q.status === 'pending' && q.validUntil && inRange(q.validUntil)) {
      events.push({ kind: 'quote_due', title: `Vence presupuesto: ${q.title}`, date: new Date(q.validUntil).toISOString(), refId: q.id });
    }
  }

  const orders = await db.select().from(workOrders).where(eq(workOrders.organizationId, organizationId));
  for (const o of orders) {
    if (o.scheduledDate && inRange(o.scheduledDate) && o.status !== 'cobrado') {
      events.push({ kind: 'work_order', title: `Trabajo: ${o.title}`, date: new Date(o.scheduledDate).toISOString(), refId: o.id, meta: { status: o.status, priority: o.priority } });
    }
  }

  return events.sort((a, b) => a.date.localeCompare(b.date));
}

// Seguimientos vencidos (para recordatorios / cron).
export async function getOverdueFollowups(organizationId: string): Promise<CrmOpportunity[]> {
  const now = new Date();
  const opps = await db.select().from(crmOpportunities)
    .where(and(eq(crmOpportunities.organizationId, organizationId), eq(crmOpportunities.status, 'open')));
  return opps.filter(o => o.nextFollowupAt && new Date(o.nextFollowupAt) < now);
}
