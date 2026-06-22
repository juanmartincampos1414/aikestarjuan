// =============================================================================
// AIKESTAR - Acceso a datos de la integración Tiendanube
// =============================================================================
// Auto-contenido (no infla IStorage). Opera sobre las tablas tiendanube_*.
// =============================================================================
import { db } from '../db';
import { and, eq, desc } from 'drizzle-orm';
import {
  tiendanubeConnections,
  tiendanubePaymentMappings,
  tiendanubeWebhookEvents,
  tiendanubeOrderLinks,
  tiendanubeClientMatches,
  type TiendanubeConnection,
  type InsertTiendanubeConnection,
  type TiendanubePaymentMapping,
  type TiendanubeOrderLink,
  type TiendanubeClientMatch,
} from '@shared/schema';

// ── Conexiones ───────────────────────────────────────────────────────────────
export async function getConnectionByOrg(organizationId: string): Promise<TiendanubeConnection | undefined> {
  const [row] = await db.select().from(tiendanubeConnections)
    .where(eq(tiendanubeConnections.organizationId, organizationId)).limit(1);
  return row;
}

export async function getConnectionById(id: string): Promise<TiendanubeConnection | undefined> {
  const [row] = await db.select().from(tiendanubeConnections).where(eq(tiendanubeConnections.id, id)).limit(1);
  return row;
}

export async function getConnectionByStoreId(storeId: string): Promise<TiendanubeConnection | undefined> {
  const [row] = await db.select().from(tiendanubeConnections)
    .where(eq(tiendanubeConnections.storeId, storeId)).limit(1);
  return row;
}

export async function getAllConnections(): Promise<TiendanubeConnection[]> {
  return db.select().from(tiendanubeConnections).where(eq(tiendanubeConnections.status, 'connected'));
}

export async function upsertConnection(data: InsertTiendanubeConnection): Promise<TiendanubeConnection> {
  const existing = await getConnectionByOrg(data.organizationId);
  if (existing) {
    const [row] = await db.update(tiendanubeConnections)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(tiendanubeConnections.id, existing.id)).returning();
    return row;
  }
  const [row] = await db.insert(tiendanubeConnections).values(data).returning();
  return row;
}

export async function updateConnection(id: string, patch: Partial<InsertTiendanubeConnection> & { lastSyncAt?: Date; lastError?: string | null }): Promise<void> {
  await db.update(tiendanubeConnections).set({ ...patch, updatedAt: new Date() }).where(eq(tiendanubeConnections.id, id));
}

export async function deleteConnection(id: string): Promise<void> {
  await db.delete(tiendanubeConnections).where(eq(tiendanubeConnections.id, id));
}

// ── Mapeos de pago ───────────────────────────────────────────────────────────
export async function getPaymentMappings(connectionId: string): Promise<TiendanubePaymentMapping[]> {
  return db.select().from(tiendanubePaymentMappings).where(eq(tiendanubePaymentMappings.connectionId, connectionId));
}

export async function getPaymentMappingForGateway(connectionId: string, gatewayName: string): Promise<TiendanubePaymentMapping | undefined> {
  const [row] = await db.select().from(tiendanubePaymentMappings)
    .where(and(eq(tiendanubePaymentMappings.connectionId, connectionId), eq(tiendanubePaymentMappings.gatewayName, gatewayName))).limit(1);
  return row;
}

export async function upsertPaymentMapping(input: {
  connectionId: string; organizationId: string; gatewayName: string;
  accountId?: string | null; paymentMethodId?: string | null; autoDetected?: boolean;
}): Promise<TiendanubePaymentMapping> {
  const existing = await getPaymentMappingForGateway(input.connectionId, input.gatewayName);
  if (existing) {
    const [row] = await db.update(tiendanubePaymentMappings)
      .set({ accountId: input.accountId ?? null, paymentMethodId: input.paymentMethodId ?? null, autoDetected: input.autoDetected ?? false, updatedAt: new Date() })
      .where(eq(tiendanubePaymentMappings.id, existing.id)).returning();
    return row;
  }
  const [row] = await db.insert(tiendanubePaymentMappings).values({
    connectionId: input.connectionId, organizationId: input.organizationId, gatewayName: input.gatewayName,
    accountId: input.accountId ?? null, paymentMethodId: input.paymentMethodId ?? null, autoDetected: input.autoDetected ?? false,
  }).returning();
  return row;
}

// ── Eventos de webhook (idempotencia) ────────────────────────────────────────
// Inserta el evento; devuelve true si es NUEVO (no procesado antes), false si ya existía.
export async function claimWebhookEvent(input: {
  connectionId: string | null; organizationId: string | null; event: string;
  externalResourceId: string; payloadHash?: string | null;
}): Promise<boolean> {
  const inserted = await db.insert(tiendanubeWebhookEvents).values({
    connectionId: input.connectionId, organizationId: input.organizationId,
    event: input.event, externalResourceId: input.externalResourceId,
    payloadHash: input.payloadHash ?? null, status: 'received',
  }).onConflictDoNothing().returning({ id: tiendanubeWebhookEvents.id });
  return inserted.length > 0;
}

export async function markWebhookEvent(connectionId: string | null, event: string, externalResourceId: string, status: 'processed' | 'failed' | 'skipped', error?: string | null): Promise<void> {
  await db.update(tiendanubeWebhookEvents)
    .set({ status, error: error ?? null, processedAt: new Date() })
    .where(and(
      connectionId ? eq(tiendanubeWebhookEvents.connectionId, connectionId) : eq(tiendanubeWebhookEvents.event, event),
      eq(tiendanubeWebhookEvents.event, event),
      eq(tiendanubeWebhookEvents.externalResourceId, externalResourceId),
    ));
}

export async function getWebhookLogs(organizationId: string, limit = 50) {
  return db.select().from(tiendanubeWebhookEvents)
    .where(eq(tiendanubeWebhookEvents.organizationId, organizationId))
    .orderBy(desc(tiendanubeWebhookEvents.receivedAt)).limit(limit);
}

// ── Vínculos de pedidos ──────────────────────────────────────────────────────
export async function getOrderLink(connectionId: string, externalOrderId: string): Promise<TiendanubeOrderLink | undefined> {
  const [row] = await db.select().from(tiendanubeOrderLinks)
    .where(and(eq(tiendanubeOrderLinks.connectionId, connectionId), eq(tiendanubeOrderLinks.externalOrderId, externalOrderId))).limit(1);
  return row;
}

export async function createOrderLink(data: typeof tiendanubeOrderLinks.$inferInsert): Promise<TiendanubeOrderLink> {
  const [row] = await db.insert(tiendanubeOrderLinks).values(data).onConflictDoNothing().returning();
  if (row) return row;
  return (await getOrderLink(data.connectionId, data.externalOrderId))!;
}

export async function updateOrderLink(id: string, patch: Partial<typeof tiendanubeOrderLinks.$inferInsert>): Promise<void> {
  await db.update(tiendanubeOrderLinks).set({ ...patch, updatedAt: new Date() }).where(eq(tiendanubeOrderLinks.id, id));
}

// ── Cola de matching de clientes ─────────────────────────────────────────────
export async function createClientMatch(data: typeof tiendanubeClientMatches.$inferInsert): Promise<TiendanubeClientMatch> {
  const [row] = await db.insert(tiendanubeClientMatches).values(data).returning();
  return row;
}

export async function getPendingClientMatches(organizationId: string): Promise<TiendanubeClientMatch[]> {
  return db.select().from(tiendanubeClientMatches)
    .where(and(eq(tiendanubeClientMatches.organizationId, organizationId), eq(tiendanubeClientMatches.status, 'pending')))
    .orderBy(desc(tiendanubeClientMatches.createdAt));
}

export async function getClientMatch(id: string): Promise<TiendanubeClientMatch | undefined> {
  const [row] = await db.select().from(tiendanubeClientMatches).where(eq(tiendanubeClientMatches.id, id)).limit(1);
  return row;
}

export async function resolveClientMatch(id: string, status: 'approved' | 'rejected' | 'auto_linked', resolvedClientId: string | null, userId: string | null): Promise<void> {
  await db.update(tiendanubeClientMatches)
    .set({ status, resolvedClientId, resolvedByUserId: userId, resolvedAt: new Date() })
    .where(eq(tiendanubeClientMatches.id, id));
}

export async function countPendingMatches(organizationId: string): Promise<number> {
  const rows = await getPendingClientMatches(organizationId);
  return rows.length;
}
