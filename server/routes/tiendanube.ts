// =============================================================================
// AIKESTAR - Rutas de la integración Tiendanube
// =============================================================================
import type { Express, Request, Response } from 'express';
import crypto from 'crypto';
import { storage } from '../storage';
import { requireAuth, getOrganizationPlanLimits } from './middleware';
import * as tn from '../lib/tiendanube';
import { encryptToken, decryptToken } from '../lib/tiendanubeCrypto';
import { getAppBaseUrl } from '../lib/mercadopago';
import * as store from '../services/tiendanubeStore';
import { processOrder, processOrderCancelled } from '../services/tiendanubeSync';
import { processProductWebhook, syncCatalog, getSyncProgress } from '../services/tiendanubeProductSync';
import { type PlanType } from '@shared/schema';

const ALLOWED_PLANS: PlanType[] = ['team', 'business', 'enterprise'];
const WEBHOOK_EVENTS = [
  'order/created', 'order/paid', 'order/cancelled',
  'product/created', 'product/updated', 'product/deleted',
];

// ¿La org tiene plan habilitado para Tiendanube?
async function orgHasAccess(organizationId: string): Promise<boolean> {
  const { planType } = await getOrganizationPlanLimits(organizationId, storage);
  return ALLOWED_PLANS.includes(planType as PlanType);
}

async function isOwner(userId: string, organizationId: string): Promise<boolean> {
  const m = await storage.getMembershipByUserAndOrg(userId, organizationId);
  return m?.role === 'owner';
}

export function registerTiendanubeRoutes(app: Express): void {
  // ── Estado de la conexión ──────────────────────────────────────────────────
  app.get('/api/tiendanube/status', requireAuth, async (req: any, res: Response) => {
    try {
      const enabled = tn.isTiendanubeEnabled();
      const hasAccess = await orgHasAccess(req.organizationId);
      const conn = await store.getConnectionByOrg(req.organizationId);
      const pending = conn ? await store.countPendingMatches(req.organizationId) : 0;
      res.json({
        enabled,
        hasAccess,
        isOwner: await isOwner(req.userId, req.organizationId),
        connection: conn ? {
          id: conn.id, storeId: conn.storeId, storeName: conn.storeName, storeUrl: conn.storeUrl,
          status: conn.status, connectedAt: conn.connectedAt, lastSyncAt: conn.lastSyncAt, lastError: conn.lastError,
        } : null,
        pendingClients: pending,
      });
    } catch (e: any) {
      res.status(500).json({ message: 'No se pudo obtener el estado de Tiendanube' });
    }
  });

  // ── Iniciar conexión (owner + plan) → URL de autorización OAuth ─────────────
  app.get('/api/tiendanube/connect', requireAuth, async (req: any, res: Response) => {
    try {
      if (!tn.isTiendanubeEnabled()) return res.status(503).json({ message: 'La integración con Tiendanube no está disponible.' });
      if (!(await orgHasAccess(req.organizationId))) return res.status(403).json({ message: 'Tu plan no incluye la integración con Tiendanube.' });
      if (!(await isOwner(req.userId, req.organizationId))) return res.status(403).json({ message: 'Solo el propietario puede conectar Tiendanube.' });

      const state = crypto.randomBytes(16).toString('hex');
      req.session.tiendanubeOAuth = { state, organizationId: req.organizationId };
      res.json({ authorizeUrl: tn.getAuthorizeUrl(state) });
    } catch (e: any) {
      res.status(500).json({ message: 'No se pudo iniciar la conexión' });
    }
  });

  // ── Callback OAuth (navegación del navegador con la sesión) ─────────────────
  app.get('/api/tiendanube/callback', async (req: Request, res: Response) => {
    const redirect = (q: string) => res.redirect(`/settings?tab=integrations&tiendanube=${q}`);
    try {
      const code = String(req.query.code || '');
      const state = String(req.query.state || '');
      const saved = (req.session as any)?.tiendanubeOAuth;
      if (!code || !state || !saved || saved.state !== state) return redirect('error_state');
      delete (req.session as any).tiendanubeOAuth;

      const token = await tn.exchangeCodeForToken(code);
      const storeId = String(token.user_id);

      // Datos de la tienda (best-effort)
      let storeName: string | undefined, storeUrl: string | undefined;
      try {
        const s = await tn.getStore(storeId, token.access_token);
        storeName = s?.name?.es || s?.name || undefined;
        storeUrl = s?.url_with_protocol || s?.url || undefined;
      } catch { /* no bloquea */ }

      const conn = await store.upsertConnection({
        organizationId: saved.organizationId,
        storeId,
        storeName: storeName ?? null,
        storeUrl: storeUrl ?? null,
        accessTokenEncrypted: encryptToken(token.access_token),
        scope: token.scope ?? null,
        status: 'connected',
        connectedByUserId: (req.session as any)?.userId ?? null,
        connectedAt: new Date(),
      } as any);

      // Registrar webhooks (best-effort; el job de respaldo cubre faltantes)
      const webhookUrl = `${getAppBaseUrl()}/api/tiendanube/webhook`;
      for (const ev of WEBHOOK_EVENTS) {
        try { await tn.registerWebhook(storeId, token.access_token, ev, webhookUrl); } catch { /* ignora */ }
      }
      await store.updateConnection(conn.id, { lastError: null });
      redirect('connected');
    } catch (e: any) {
      console.error('[Tiendanube] callback error:', e?.message || e);
      redirect('error');
    }
  });

  // ── Desconectar (owner) ─────────────────────────────────────────────────────
  app.post('/api/tiendanube/disconnect', requireAuth, async (req: any, res: Response) => {
    try {
      if (!(await isOwner(req.userId, req.organizationId))) return res.status(403).json({ message: 'Solo el propietario puede desconectar Tiendanube.' });
      const conn = await store.getConnectionByOrg(req.organizationId);
      if (conn) await store.deleteConnection(conn.id);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ message: 'No se pudo desconectar' });
    }
  });

  // ── Mapeo de medios de pago ─────────────────────────────────────────────────
  app.get('/api/tiendanube/payment-mappings', requireAuth, async (req: any, res: Response) => {
    try {
      const conn = await store.getConnectionByOrg(req.organizationId);
      if (!conn) return res.json({ mappings: [] });
      res.json({ mappings: await store.getPaymentMappings(conn.id) });
    } catch { res.status(500).json({ message: 'Error' }); }
  });

  app.put('/api/tiendanube/payment-mappings', requireAuth, async (req: any, res: Response) => {
    try {
      const conn = await store.getConnectionByOrg(req.organizationId);
      if (!conn) return res.status(400).json({ message: 'No hay tienda conectada' });
      const { gatewayName, accountId, paymentMethodId } = req.body || {};
      if (!gatewayName) return res.status(400).json({ message: 'gatewayName requerido' });
      const mapping = await store.upsertPaymentMapping({
        connectionId: conn.id, organizationId: req.organizationId,
        gatewayName, accountId: accountId || null, paymentMethodId: paymentMethodId || null, autoDetected: false,
      });
      res.json({ mapping });
    } catch { res.status(500).json({ message: 'Error guardando mapeo' }); }
  });

  // ── Clientes pendientes de revisión ─────────────────────────────────────────
  app.get('/api/tiendanube/pending-clients', requireAuth, async (req: any, res: Response) => {
    try {
      res.json({ pending: await store.getPendingClientMatches(req.organizationId) });
    } catch { res.status(500).json({ message: 'Error' }); }
  });

  app.post('/api/tiendanube/pending-clients/:id/resolve', requireAuth, async (req: any, res: Response) => {
    try {
      const match = await store.getClientMatch(req.params.id);
      if (!match || match.organizationId !== req.organizationId) return res.status(404).json({ message: 'No encontrado' });
      const { action, clientId } = req.body || {}; // 'link' (a clientId existente) | 'create_new' | 'reject'
      if (action === 'link' && clientId) {
        await store.resolveClientMatch(match.id, 'approved', clientId, req.userId);
      } else if (action === 'create_new') {
        const data: any = match.externalData || {};
        const created = await storage.createClient({
          organizationId: req.organizationId, name: data.name || 'Cliente Tiendanube',
          email: data.email || null, phone: data.phone || null, taxId: data.taxId || null,
          externalId: match.externalCustomerId, externalSource: 'tiendanube',
        } as any);
        await store.resolveClientMatch(match.id, 'approved', created.id, req.userId);
      } else {
        await store.resolveClientMatch(match.id, 'rejected', null, req.userId);
      }
      res.json({ success: true });
    } catch { res.status(500).json({ message: 'Error resolviendo' }); }
  });

  // ── Sincronización de catálogo (import inicial / re-sync manual) ────────────
  app.post('/api/tiendanube/sync/catalog', requireAuth, async (req: any, res: Response) => {
    try {
      if (!(await isOwner(req.userId, req.organizationId))) return res.status(403).json({ message: 'Solo el propietario puede sincronizar el catálogo.' });
      const conn = await store.getConnectionByOrg(req.organizationId);
      if (!conn) return res.status(400).json({ message: 'No hay tienda conectada' });
      // Corre en background; el progreso se consulta aparte.
      syncCatalog(conn).catch((e) => console.error('[Tiendanube] syncCatalog:', e?.message || e));
      res.json({ started: true });
    } catch { res.status(500).json({ message: 'No se pudo iniciar la sincronización' }); }
  });

  app.get('/api/tiendanube/sync/progress', requireAuth, async (req: any, res: Response) => {
    try {
      const conn = await store.getConnectionByOrg(req.organizationId);
      if (!conn) return res.json({ status: 'idle', total: 0, done: 0 });
      res.json(getSyncProgress(conn.id));
    } catch { res.status(500).json({ message: 'Error' }); }
  });

  // ── Logs de webhooks ────────────────────────────────────────────────────────
  app.get('/api/tiendanube/logs', requireAuth, async (req: any, res: Response) => {
    try { res.json({ logs: await store.getWebhookLogs(req.organizationId) }); }
    catch { res.status(500).json({ message: 'Error' }); }
  });

  // ── Webhook (HMAC, idempotente) ─────────────────────────────────────────────
  // Exento de CSRF (ver server/index.ts). Verifica firma sobre el body crudo.
  app.post('/api/tiendanube/webhook', async (req: Request, res: Response) => {
    const raw = (req as any).rawBody as Buffer | undefined;
    const signature = req.header('x-linkedstore-hmac-sha256') || undefined;

    // Verificación HMAC (anti-spoofing nivel 1)
    if (!raw || !tn.verifyWebhookHmac(raw, signature)) {
      return res.status(401).json({ message: 'Firma inválida' });
    }
    res.status(200).json({ received: true }); // responder rápido; procesar async

    try {
      const body = JSON.parse(raw.toString('utf8'));
      const event = String(body.event || '');
      const storeId = String(body.store_id || '');
      const resourceId = String(body.id || '');
      if (!event || !storeId || !resourceId) return;

      const conn = await store.getConnectionByStoreId(storeId);
      if (!conn) { console.warn('[Tiendanube] webhook sin conexión para store', storeId); return; }

      // Idempotencia: si ya lo vimos, salir.
      const isNew = await store.claimWebhookEvent({
        connectionId: conn.id, organizationId: conn.organizationId,
        event, externalResourceId: resourceId,
        payloadHash: crypto.createHash('sha256').update(raw).digest('hex'),
      });
      if (!isNew) return;

      try {
        const token = decryptToken(conn.accessTokenEncrypted);
        if (event.startsWith('order/')) {
          // Re-consultar el pedido a la API (anti-spoofing nivel 2)
          const order = await tn.getOrder(storeId, token, resourceId);
          if (event === 'order/cancelled') {
            await processOrderCancelled(conn, order);
          } else {
            await processOrder(conn, order);
          }
        } else if (event.startsWith('product/')) {
          await processProductWebhook(conn, event, resourceId);
        }
        await store.markWebhookEvent(conn.id, event, resourceId, 'processed');
        await store.updateConnection(conn.id, { lastSyncAt: new Date(), lastError: null });
      } catch (procErr: any) {
        await store.markWebhookEvent(conn.id, event, resourceId, 'failed', procErr?.message || String(procErr));
        await store.updateConnection(conn.id, { lastError: procErr?.message || 'Error procesando webhook' });
        console.error('[Tiendanube] error procesando webhook:', procErr?.message || procErr);
      }
    } catch (e: any) {
      console.error('[Tiendanube] webhook parse error:', e?.message || e);
    }
  });
}
