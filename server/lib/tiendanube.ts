// =============================================================================
// AIKESTAR - Cliente de la API de Tiendanube (OAuth2 + REST + webhooks)
// =============================================================================
// Docs: https://tiendanube.github.io/api-documentation/
// - OAuth: el comercio instala la app y vuelve al redirect con ?code=. Se canjea
//   en POST https://www.tiendanube.com/apps/authorize/token → { access_token, user_id (store_id), scope }.
//   Los tokens NO expiran; "renovar" = reconectar.
// - API REST: https://api.tiendanube.com/v1/{store_id}/...  con header
//   `Authentication: bearer <token>` y `User-Agent` con contacto (requerido).
// - Webhooks: firmados HMAC-SHA256 (hex) del body crudo con el client_secret,
//   en el header `x-linkedstore-hmac-sha256`.
//
// Env: TIENDANUBE_CLIENT_ID, TIENDANUBE_CLIENT_SECRET, TIENDANUBE_ENABLED.
// =============================================================================
import crypto from 'crypto';

const API_BASE = 'https://api.tiendanube.com/v1';
const TOKEN_URL = 'https://www.tiendanube.com/apps/authorize/token';
const USER_AGENT = 'Aikestar (ai@aikestar.com)';

export function isTiendanubeEnabled(): boolean {
  return (
    process.env.TIENDANUBE_ENABLED === 'true' &&
    !!process.env.TIENDANUBE_CLIENT_ID &&
    !!process.env.TIENDANUBE_CLIENT_SECRET
  );
}

function getClientId(): string {
  const id = process.env.TIENDANUBE_CLIENT_ID;
  if (!id) throw new Error('TIENDANUBE_CLIENT_ID no está configurado');
  return id;
}
function getClientSecret(): string {
  const s = process.env.TIENDANUBE_CLIENT_SECRET;
  if (!s) throw new Error('TIENDANUBE_CLIENT_SECRET no está configurado');
  return s;
}

// URL a la que se manda al comercio para autorizar la app. `state` viaja de ida
// y vuelta para validar CSRF en el callback.
export function getAuthorizeUrl(state: string): string {
  const clientId = getClientId();
  const params = new URLSearchParams({ state });
  return `https://www.tiendanube.com/apps/${clientId}/authorize?${params.toString()}`;
}

export interface TiendanubeTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  user_id: number; // = store_id
}

export async function exchangeCodeForToken(code: string): Promise<TiendanubeTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({
      client_id: getClientId(),
      client_secret: getClientSecret(),
      grant_type: 'authorization_code',
      code,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Tiendanube token exchange falló (${res.status}): ${body.slice(0, 200)}`);
  }
  return (await res.json()) as TiendanubeTokenResponse;
}

// Verifica la firma HMAC-SHA256 (hex) del body crudo del webhook.
export function verifyWebhookHmac(rawBody: string | Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', getClientSecret())
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Request REST autenticado. `path` empieza con '/', ej. '/orders/123'.
async function request<T = any>(
  storeId: string,
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ data: T; linkHeader: string | null }> {
  const res = await fetch(`${API_BASE}/${storeId}${path}`, {
    method,
    headers: {
      Authentication: `bearer ${token}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tiendanube API ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = res.status === 204 ? (null as any) : await res.json();
  return { data: data as T, linkHeader: res.headers.get('link') };
}

export async function getOrder(storeId: string, token: string, orderId: string | number): Promise<any> {
  const { data } = await request(storeId, token, 'GET', `/orders/${orderId}`);
  return data;
}

export async function getStore(storeId: string, token: string): Promise<any> {
  const { data } = await request(storeId, token, 'GET', `/store`);
  return data;
}

export async function getProduct(storeId: string, token: string, productId: string | number): Promise<any> {
  const { data } = await request(storeId, token, 'GET', `/products/${productId}`);
  return data;
}

// Recorre TODAS las páginas de un recurso de lista (productos, pedidos), siguiendo
// los headers Link `rel="next"`. `onPage` recibe cada lote.
export async function paginateAll(
  storeId: string,
  token: string,
  resourcePath: string, // ej. '/products'
  onPage: (items: any[]) => Promise<void>,
  perPage = 50,
): Promise<number> {
  let path: string | null = `${resourcePath}?per_page=${perPage}&page=1`;
  let total = 0;
  while (path) {
    const { data, linkHeader }: { data: any[]; linkHeader: string | null } =
      await request<any[]>(storeId, token, 'GET', path);
    const items = Array.isArray(data) ? data : [];
    if (items.length > 0) {
      await onPage(items);
      total += items.length;
    }
    path = parseNextLink(linkHeader);
  }
  return total;
}

// Extrae el path relativo del header Link rel="next" (o null si no hay).
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',');
  for (const part of parts) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) {
      try {
        const url = new URL(m[1]);
        return `${url.pathname.replace(/^\/v1\/[^/]+/, '')}${url.search}`;
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Registra un webhook en la tienda. Idempotente del lado de Tiendanube si ya existe
// (devuelve error 422 que ignoramos).
export async function registerWebhook(
  storeId: string,
  token: string,
  event: string,
  url: string,
): Promise<void> {
  try {
    await request(storeId, token, 'POST', '/webhooks', { event, url });
  } catch (err: any) {
    if (!String(err?.message || '').includes('422')) throw err;
  }
}

export async function listWebhooks(storeId: string, token: string): Promise<any[]> {
  const { data } = await request<any[]>(storeId, token, 'GET', '/webhooks');
  return Array.isArray(data) ? data : [];
}

export async function deleteWebhook(storeId: string, token: string, webhookId: string | number): Promise<void> {
  await request(storeId, token, 'DELETE', `/webhooks/${webhookId}`);
}

// Pedidos recientes (para el job de reconciliación de respaldo).
export async function getRecentOrders(storeId: string, token: string, sinceIso: string): Promise<any[]> {
  const { data } = await request<any[]>(
    storeId,
    token,
    'GET',
    `/orders?created_at_min=${encodeURIComponent(sinceIso)}&per_page=50`,
  );
  return Array.isArray(data) ? data : [];
}
