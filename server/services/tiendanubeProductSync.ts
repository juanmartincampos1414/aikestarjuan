// =============================================================================
// AIKESTAR - Sincronización de catálogo y stock de Tiendanube
// =============================================================================
// - syncCatalog: import inicial paginado (con progreso) y re-sync manual.
// - processProductWebhook: product/created|updated|deleted.
// - decrementStockForOrder: descuenta stock atómicamente al vender, con auditoría.
// =============================================================================
import { db } from '../db';
import { and, eq, sql } from 'drizzle-orm';
import { products, type Product, type TiendanubeConnection } from '@shared/schema';
import { storage } from '../storage';
import * as tn from '../lib/tiendanube';
import { decryptToken } from '../lib/tiendanubeCrypto';
import pLimit from 'p-limit';
import pRetry from 'p-retry';

// ── Mapeo de un producto de Tiendanube a campos de Aikestar ──────────────────
function localized(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return v.es || v.pt || v.en || Object.values(v)[0] || '';
}

export interface MappedProduct {
  externalId: string;
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  salePrice: string;
  stock: string;
  imageUrl: string | null;
}

// La imagen principal de un producto de Tiendanube viene en `images[0].src`
// (ordenadas por `position`). Tomamos la de menor posición.
function firstImageUrl(p: any): string | null {
  const imgs = Array.isArray(p?.images) ? p.images : [];
  if (imgs.length === 0) return null;
  const sorted = [...imgs].sort((a, b) => (a?.position ?? 999) - (b?.position ?? 999));
  return sorted[0]?.src ?? null;
}

export function mapTiendanubeProduct(p: any): MappedProduct {
  const variant = Array.isArray(p?.variants) && p.variants.length > 0 ? p.variants[0] : {};
  return {
    externalId: String(p.id),
    name: localized(p.name) || 'Producto Tiendanube',
    description: localized(p.description) || null,
    sku: variant.sku ?? null,
    barcode: variant.barcode ?? null,
    salePrice: String(variant.price ?? p.price ?? '0'),
    stock: String(variant.stock ?? '0'),
    imageUrl: firstImageUrl(p),
  };
}

// ── Upsert de un producto sincronizado ───────────────────────────────────────
async function findByExternalId(organizationId: string, externalId: string): Promise<Product | undefined> {
  const [row] = await db.select().from(products)
    .where(and(eq(products.organizationId, organizationId), eq(products.externalSource, 'tiendanube'), eq(products.externalId, externalId)))
    .limit(1);
  return row;
}

export async function upsertProduct(connection: TiendanubeConnection, tnProduct: any): Promise<void> {
  const m = mapTiendanubeProduct(tnProduct);
  const existing = await findByExternalId(connection.organizationId, m.externalId);
  if (existing) {
    await storage.updateProduct(existing.id, {
      name: m.name, description: m.description, sku: m.sku, barcode: m.barcode,
      salePrice: m.salePrice, stock: m.stock, imageUrl: m.imageUrl,
    } as any);
  } else {
    await storage.createProduct({
      organizationId: connection.organizationId,
      name: m.name, description: m.description, sku: m.sku, barcode: m.barcode,
      salePrice: m.salePrice, stock: m.stock, imageUrl: m.imageUrl,
      productType: 'product',
      externalId: m.externalId, externalSource: 'tiendanube',
    } as any);
  }
}

// Producto borrado en Tiendanube → desactivamos el local (no lo eliminamos).
export async function deactivateProduct(connection: TiendanubeConnection, externalId: string): Promise<void> {
  const existing = await findByExternalId(connection.organizationId, externalId);
  if (existing) await storage.updateProduct(existing.id, { isActive: false } as any);
}

// ── Progreso del import (en memoria, por conexión) ───────────────────────────
export interface SyncProgress { status: 'idle' | 'running' | 'done' | 'error'; total: number; done: number; error?: string; }
const progressByConnection = new Map<string, SyncProgress>();

export function getSyncProgress(connectionId: string): SyncProgress {
  return progressByConnection.get(connectionId) || { status: 'idle', total: 0, done: 0 };
}

// Import inicial / re-sync. Corre en background; el progreso se lee aparte.
export async function syncCatalog(connection: TiendanubeConnection): Promise<void> {
  if (getSyncProgress(connection.id).status === 'running') return;
  progressByConnection.set(connection.id, { status: 'running', total: 0, done: 0 });
  const token = decryptToken(connection.accessTokenEncrypted);
  const limit = pLimit(4);
  try {
    await tn.paginateAll(connection.storeId, token, '/products', async (items) => {
      const prog = getSyncProgress(connection.id);
      prog.total += items.length;
      await Promise.all(items.map((p) => limit(() =>
        pRetry(() => upsertProduct(connection, p), { retries: 2 })
          .then(() => { getSyncProgress(connection.id).done += 1; })
          .catch((e) => console.error(`[TiendanubeCatalog] producto ${p?.id}:`, e?.message || e))
      )));
    });
    progressByConnection.set(connection.id, { ...getSyncProgress(connection.id), status: 'done' });
  } catch (e: any) {
    progressByConnection.set(connection.id, { ...getSyncProgress(connection.id), status: 'error', error: e?.message || String(e) });
    throw e;
  }
}

// ── Webhook de producto ───────────────────────────────────────────────────────
export async function processProductWebhook(connection: TiendanubeConnection, event: string, productId: string): Promise<void> {
  const token = decryptToken(connection.accessTokenEncrypted);
  if (event === 'product/deleted') {
    await deactivateProduct(connection, productId);
    return;
  }
  const product = await tn.getProduct(connection.storeId, token, productId);
  await upsertProduct(connection, product);
}

// ── Descuento de stock al vender (atómico + auditoría) ───────────────────────
// Recorre los renglones del pedido; por cada producto sincronizado descuenta su
// stock con un UPDATE atómico (stock = stock - qty) y registra el movimiento.
export async function decrementStockForOrder(
  connection: TiendanubeConnection,
  order: any,
  transactionId: string | null,
  userId: string | null = null,
): Promise<void> {
  const items: any[] = Array.isArray(order?.products) ? order.products : [];
  for (const it of items) {
    const externalId = String(it.product_id ?? it.id ?? '');
    const qty = parseFloat(String(it.quantity ?? '0'));
    if (!externalId || !(qty > 0)) continue;

    const product = await findByExternalId(connection.organizationId, externalId);
    if (!product) continue; // producto no sincronizado: no tocamos stock

    // UPDATE atómico a nivel de fila; .returning() nos da el nuevo stock.
    const [updated] = await db.update(products)
      .set({ stock: sql`(CAST(${products.stock} AS DECIMAL) - ${qty})`, updatedAt: new Date() })
      .where(eq(products.id, product.id))
      .returning({ stock: products.stock });

    const newStock = parseFloat(String(updated?.stock ?? '0'));
    const previousStock = newStock + qty;

    await storage.createStockMovement({
      productId: product.id,
      organizationId: connection.organizationId,
      type: 'exit',
      quantity: String(qty),
      previousStock: String(previousStock),
      newStock: String(newStock),
      reason: `Venta Tiendanube #${order.number ?? order.id}`,
      transactionId: transactionId ?? null,
      createdBy: userId,
    } as any);
  }
}
