// =============================================================================
// AIKESTAR - Sincronización de pedidos Tiendanube → movimientos financieros
// =============================================================================
// processOrder: idempotente por (connectionId, externalOrderId). Crea/asocia el
// cliente, crea el movimiento financiero (income) en la cuenta mapeada según el
// medio de pago, y guarda el vínculo de trazabilidad. processOrderCancelled
// revierte el movimiento. (Stock: Fase 2.)
// =============================================================================
import { db } from '../db';
import { eq, sql } from 'drizzle-orm';
import { accounts, transactions, type TiendanubeConnection } from '@shared/schema';
import { storage } from '../storage';
import { resolveClient, type ExternalCustomer } from './tiendanubeClientMatching';
import * as store from './tiendanubeStore';
import { decrementStockForOrder } from './tiendanubeProductSync';

// Extrae el gateway/medio de pago del pedido de Tiendanube.
export function extractGateway(order: any): string {
  return (
    order?.gateway ||
    order?.payment_details?.method ||
    order?.payment_method ||
    'desconocido'
  );
}

export function extractCustomer(order: any): ExternalCustomer | null {
  const c = order?.customer;
  if (!c) return null;
  return {
    id: String(c.id),
    name: c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Cliente',
    email: c.email ?? null,
    phone: c.phone ?? null,
    taxId: c.identification ?? c.document ?? null,
  };
}

export function isPaid(order: any): boolean {
  return order?.payment_status === 'paid' || !!order?.paid_at;
}

export interface ProcessResult {
  status: 'created' | 'skipped' | 'pending_mapping' | 'pending_client';
  transactionId?: string | null;
  clientId?: string | null;
}

// Procesa un pedido pagado (idempotente). Llamar tras confirmar el pedido
// re-consultándolo a la API de Tiendanube (anti-spoofing).
export async function processOrder(connection: TiendanubeConnection, order: any): Promise<ProcessResult> {
  const orderId = String(order.id);

  const existing = await store.getOrderLink(connection.id, orderId);
  if (existing?.transactionId) {
    return { status: 'skipped', transactionId: existing.transactionId };
  }
  if (!isPaid(order)) {
    // Pedido aún no pagado: registramos el vínculo sin movimiento.
    if (!existing) {
      await store.createOrderLink({
        connectionId: connection.id, organizationId: connection.organizationId,
        externalOrderId: orderId, orderNumber: String(order.number ?? ''),
        status: 'synced', totalAmount: String(order.total ?? '0'), currency: order.currency || 'ARS',
        gateway: extractGateway(order), rawSnapshot: order,
      });
    }
    return { status: 'skipped' };
  }

  const gateway = extractGateway(order);

  // Mapeo de pago → cuenta. Si no existe, lo creamos (autoDetected, sin cuenta)
  // para que aparezca en la tab Mapeo y el usuario lo asigne.
  let mapping = await store.getPaymentMappingForGateway(connection.id, gateway);
  if (!mapping) {
    mapping = await store.upsertPaymentMapping({
      connectionId: connection.id, organizationId: connection.organizationId,
      gatewayName: gateway, autoDetected: true,
    });
  }

  // Cliente
  const customer = extractCustomer(order);
  const match = customer ? await resolveClient(connection, customer) : { clientId: null };

  // Movimiento financiero (income). storage.createTransaction actualiza el balance
  // de la cuenta cuando status='completed' y hay accountId.
  const tx = await storage.createTransaction({
    organizationId: connection.organizationId,
    type: 'income',
    status: 'completed',
    amount: String(order.total ?? '0'),
    currency: order.currency || 'ARS',
    description: `Venta Tiendanube #${order.number ?? orderId}`,
    category: 'Ventas',
    date: new Date(order.paid_at || order.created_at || Date.now()),
    accountId: mapping.accountId ?? null,
    clientId: match.clientId ?? null,
    externalId: orderId,
    externalSource: 'tiendanube',
  } as any);

  // Vínculo de trazabilidad (upsert idempotente)
  if (existing) {
    await store.updateOrderLink(existing.id, {
      transactionId: tx.id, clientId: match.clientId ?? null, status: 'synced',
      totalAmount: String(order.total ?? '0'), currency: order.currency || 'ARS', gateway, rawSnapshot: order,
    });
  } else {
    await store.createOrderLink({
      connectionId: connection.id, organizationId: connection.organizationId,
      externalOrderId: orderId, orderNumber: String(order.number ?? ''),
      transactionId: tx.id, clientId: match.clientId ?? null, status: 'synced',
      totalAmount: String(order.total ?? '0'), currency: order.currency || 'ARS', gateway, rawSnapshot: order,
    });
  }

  // Stock: descuenta los productos vendidos (atómico + auditoría de movimientos).
  // Idempotente porque processOrder no re-entra para un pedido ya vinculado.
  try {
    await decrementStockForOrder(connection, order, tx.id);
  } catch (e: any) {
    console.error('[Tiendanube] error descontando stock:', e?.message || e);
  }

  await storage.createAuditLog({
    organizationId: connection.organizationId,
    userId: null,
    entityType: 'transaction',
    entityId: tx.id,
    action: 'create',
    newData: JSON.stringify({ source: 'tiendanube', orderId, gateway, amount: order.total }),
  } as any);

  if (!mapping.accountId) return { status: 'pending_mapping', transactionId: tx.id, clientId: match.clientId ?? null };
  if (match.clientId === null && customer) return { status: 'pending_client', transactionId: tx.id };
  return { status: 'created', transactionId: tx.id, clientId: match.clientId ?? null };
}

// Revierte el movimiento de un pedido cancelado.
export async function processOrderCancelled(connection: TiendanubeConnection, order: any): Promise<void> {
  const orderId = String(order.id);
  const link = await store.getOrderLink(connection.id, orderId);
  if (!link || link.status === 'cancelled' || !link.transactionId) return;

  const [tx] = await db.select().from(transactions).where(eq(transactions.id, link.transactionId)).limit(1);
  if (tx && tx.status === 'completed') {
    // Revierte el balance que el income había sumado.
    if (tx.accountId) {
      const amount = parseFloat(tx.amount);
      await db.update(accounts)
        .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) - ${amount})` })
        .where(eq(accounts.id, tx.accountId));
    }
    await db.update(transactions).set({ status: 'cancelled' }).where(eq(transactions.id, tx.id));
  }
  await store.updateOrderLink(link.id, { status: 'cancelled' });

  await storage.createAuditLog({
    organizationId: connection.organizationId,
    userId: null,
    entityType: 'transaction',
    entityId: link.transactionId,
    action: 'update',
    newData: JSON.stringify({ source: 'tiendanube', orderId, action: 'cancelled' }),
  } as any);
}
