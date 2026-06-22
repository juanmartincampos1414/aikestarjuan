// =============================================================================
// AIKESTAR - Reconciliación de respaldo de Tiendanube
// =============================================================================
// Red de seguridad ante webhooks perdidos: cada 30 min recorre las conexiones
// activas, trae los pedidos recientes y procesa los que falten (processOrder es
// idempotente, así que no duplica). Misma filosofía que la red de seguridad de
// MercadoPago.
// =============================================================================
import * as cron from 'node-cron';
import pLimit from 'p-limit';
import { getAllConnections } from './tiendanubeStore';
import { decryptToken } from '../lib/tiendanubeCrypto';
import * as tn from '../lib/tiendanube';
import { processOrder } from './tiendanubeSync';
import { isTiendanubeEnabled } from '../lib/tiendanube';

let job: ReturnType<typeof cron.schedule> | null = null;

async function reconcileOnce(): Promise<void> {
  if (!isTiendanubeEnabled()) return;
  const connections = await getAllConnections();
  if (connections.length === 0) return;

  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const limit = pLimit(3);

  await Promise.all(connections.map((conn) => limit(async () => {
    try {
      const token = decryptToken(conn.accessTokenEncrypted);
      const orders = await tn.getRecentOrders(conn.storeId, token, sinceIso);
      for (const order of orders) {
        try { await processOrder(conn, order); } catch (e: any) {
          console.error(`[TiendanubeReconcile] orden ${order?.id} conn ${conn.id}:`, e?.message || e);
        }
      }
    } catch (e: any) {
      console.error(`[TiendanubeReconcile] conn ${conn.id}:`, e?.message || e);
    }
  })));
}

export function startTiendanubeReconcileCron(): void {
  if (job) return;
  // Cada 30 minutos.
  job = cron.schedule('*/30 * * * *', () => {
    reconcileOnce().catch((e) => console.error('[TiendanubeReconcile] error:', e?.message || e));
  });
  console.log('[TiendanubeReconcile] cron de reconciliación iniciado (cada 30 min)');
}

// Exportado para tests / disparo manual.
export { reconcileOnce };
