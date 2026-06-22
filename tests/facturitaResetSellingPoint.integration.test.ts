import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Task #313 — Integración del nuevo route `POST /api/invoicing/selling-points/reset`.
//
// Contrato:
//   1. Limpia `defaultSellingPoint` de la cuenta local (lo deja `null`) ANTES
//      de tocar al provider. Eso elimina el cache que reproducía el bug del
//      cliente del agency (defaultSellingPoint = 1 colgado de un alta vieja).
//   2. Pide a Facturitas el listado real de puntos de venta y reemplaza el
//      cache local con esa lista.
//   3. Registra un audit log con la acción `invoicing_reset_selling_point`.
//   4. Devuelve `{ sellingPoints, activeCount }` para que la UI pueda
//      decirle al usuario cuántos PVs activos existen ahora en ARCA.
//
// El reset es semánticamente equivalente a "olvidate de lo que sabías del
// PV de esta cuenta y volvé a preguntarle a ARCA": útil cuando el usuario
// cambió la configuración en ARCA y nuestro cache se quedó atrás.

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
process.env.INVOICING_ENCRYPTION_KEY ||= Buffer.alloc(32).toString('base64');
process.env.INVOICING_ENABLED = 'true';
process.env.FACTURITA_API_KEY = 'test-api-key';
delete process.env.INVOICING_SANDBOX_MOCK;

const { storage } = await import('../server/storage');
const { registerInvoicingRoutes } = await import('../server/routes/invoicing');

const ORG_ID = 'org-test-313';
const USER_ID = 'user-test-313';
const VALID_CUIT = '20111111112';

interface CapturedRequest { url: string; method: string; body: any }

const ORIG_FETCH = globalThis.fetch;
let captured: CapturedRequest[] = [];
let sellingPointsResponse: any[] = [];

function installFetchStub() {
  captured = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    let parsedBody: any = null;
    if (init?.body) {
      try { parsedBody = JSON.parse(String(init.body)); } catch { parsedBody = init.body; }
    }
    captured.push({ url, method: init?.method || 'GET', body: parsedBody });
    if (url.includes('/selling-points/cuit/')) {
      return new Response(JSON.stringify(sellingPointsResponse), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return ORIG_FETCH(input, init);
  }) as typeof fetch;
}

const ORIG_STORAGE: Record<string, any> = {};
let upsertCalls: any[] = [];
let replaceSellingPointsCalls: any[] = [];
let auditLogCalls: any[] = [];
let storedAccount: any = null;
let storedSellingPoints: any[] = [];

function stubStorage(opts: { defaultSellingPoint?: number | null; isActive?: boolean; existingSellingPoints?: any[] } = {}) {
  storedAccount = {
    id: 'acc-1', cuit: VALID_CUIT, razonSocial: 'EMISOR',
    ivaCondition: 'monotributo', environment: 'production',
    defaultSellingPoint: opts.defaultSellingPoint ?? 1,
    isActive: opts.isActive ?? true, isSimulated: false,
  };
  storedSellingPoints = opts.existingSellingPoints ?? [{ number: 1, description: 'PV 1', isActive: true }];

  const methods: Record<string, any> = {
    getUser: async () => ({ id: USER_ID, deletedAt: null }),
    getSubscriptionByUserId: async () => ({ status: 'active' }),
    getOrganizationOwner: async () => ({ id: USER_ID }),
    getMembershipByUserAndOrg: async () => ({ role: 'owner', userId: USER_ID, organizationId: ORG_ID }),
    getInvoicingAccount: async () => storedAccount,
    upsertInvoicingAccount: async (_org: string, patch: any) => {
      upsertCalls.push({ ...patch });
      storedAccount = { ...(storedAccount ?? {}), ...patch };
      return storedAccount;
    },
    getSellingPointsByOrganization: async () => storedSellingPoints,
    replaceSellingPoints: async (_org: string, list: any[]) => {
      replaceSellingPointsCalls.push(list);
      storedSellingPoints = list.map((sp, i) => ({ id: `sp-${i}`, organizationId: ORG_ID, ...sp }));
      return storedSellingPoints;
    },
    createAuditLog: async (entry: any) => { auditLogCalls.push(entry); return entry; },
  };
  for (const [k, v] of Object.entries(methods)) {
    if (!(k in ORIG_STORAGE)) ORIG_STORAGE[k] = (storage as any)[k];
    (storage as any)[k] = v;
  }
}

let server: Server;
let baseUrl = '';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.session = { userId: USER_ID, organizationId: ORG_ID, destroy: (cb: any) => cb && cb() };
    next();
  });
  registerInvoicingRoutes(app);
  return app;
}

before(async () => {
  await new Promise<void>((resolve) => {
    server = buildApp().listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

after(async () => {
  for (const [k, v] of Object.entries(ORIG_STORAGE)) (storage as any)[k] = v;
  globalThis.fetch = ORIG_FETCH;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  installFetchStub();
  upsertCalls = [];
  replaceSellingPointsCalls = [];
  auditLogCalls = [];
  sellingPointsResponse = [];
});

afterEach(() => { globalThis.fetch = ORIG_FETCH; });

async function postReset() {
  const res = await fetch(`${baseUrl}/api/invoicing/selling-points/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  let json: any = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

describe('POST /api/invoicing/selling-points/reset (Task #313)', () => {
  it('limpia el defaultSellingPoint cacheado y re-consulta ARCA', async () => {
    stubStorage({ defaultSellingPoint: 1 });
    sellingPointsResponse = [
      { id: 10, selling_point: 4, business_name: 'PV 4', status: 'active' },
      { id: 11, selling_point: 9, business_name: 'PV 9', status: 'inactive' },
    ];

    const { status, body } = await postReset();
    assert.equal(status, 200, JSON.stringify(body));

    // El primer upsert debe limpiar el default (null), ANTES de pegarle al provider.
    assert.ok(upsertCalls.length >= 1, 'esperaba al menos un upsert');
    assert.equal(
      upsertCalls[0].defaultSellingPoint, null,
      `primer upsert debe limpiar el default; upserts: ${JSON.stringify(upsertCalls)}`,
    );

    // Cache local reemplazado con lo que devolvió ARCA.
    const lastReplace = replaceSellingPointsCalls[replaceSellingPointsCalls.length - 1];
    assert.ok(Array.isArray(lastReplace), 'esperaba replaceSellingPoints');
    assert.deepEqual(
      lastReplace.map((sp: any) => ({ number: sp.number, isActive: sp.isActive })),
      [{ number: 4, isActive: true }, { number: 9, isActive: false }],
    );

    // Respuesta: PVs + activeCount.
    assert.equal(body.activeCount, 1);
    assert.ok(Array.isArray(body.sellingPoints));

    // Audit log con la acción correcta y el default previo en previousData.
    const audit = auditLogCalls.find(a => a.action === 'invoicing_reset_selling_point');
    assert.ok(audit, `esperaba audit log invoicing_reset_selling_point; calls: ${JSON.stringify(auditLogCalls.map(a => a.action))}`);
    assert.equal(JSON.parse(audit.previousData).defaultSellingPoint, 1);
    assert.equal(JSON.parse(audit.newData).defaultSellingPoint, null);
  });

  it('rechaza el reset si la cuenta está desactivada', async () => {
    stubStorage({ defaultSellingPoint: 1, isActive: false });

    const { status, body } = await postReset();
    assert.equal(status, 400, JSON.stringify(body));
    // No debe haber tocado nada.
    assert.equal(upsertCalls.length, 0);
    assert.equal(replaceSellingPointsCalls.length, 0);
    assert.equal(auditLogCalls.length, 0);
  });

  it('rechaza el reset si todavía no hay cuenta configurada', async () => {
    stubStorage({});
    storedAccount = null;

    const { status, body } = await postReset();
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(upsertCalls.length, 0);
  });

  it('soporta una respuesta vacía de ARCA (estado vacío)', async () => {
    stubStorage({ defaultSellingPoint: 1 });
    sellingPointsResponse = [];

    const { status, body } = await postReset();
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.activeCount, 0);
    assert.deepEqual(body.sellingPoints, []);
    // El default igualmente quedó nulleado y el cache reemplazado por [].
    assert.equal(upsertCalls[0].defaultSellingPoint, null);
    const lastReplace = replaceSellingPointsCalls[replaceSellingPointsCalls.length - 1];
    assert.deepEqual(lastReplace, []);
  });
});
