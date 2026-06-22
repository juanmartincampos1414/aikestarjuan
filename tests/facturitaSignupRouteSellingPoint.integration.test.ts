import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Task #301 — Integración end-to-end del route `POST /api/invoicing/signup`
// para fijar el contrato: el route NO debe defaultear `selling_point` a un
// valor "razonable" (ej. 1) cuando ni el body ni la cuenta local lo
// especifican. El bug original (#300) vivía justo acá, en el route — el
// `?? 1` se había colado *después* de `data.sellingPoint ?? acc?.defaultSellingPoint`.
// Los tests unitarios de `registerCuit` (tests/facturitaSignupSellingPoint.test.ts)
// cubren el contrato a nivel servicio, pero no atrapan un default silencioso
// que se vuelva a meter a nivel route. Este archivo monta el route real
// sobre Express, stubea `fetch` al provider y verifica el payload que sale
// hacia Facturitas, además del fallback post-sync que corrige el default
// local si el PV elegido no aparece activo en ARCA.

// Boot-time env: el route requiere `INVOICING_ENABLED=true` (gate), crypto
// configurada (`requireInvoicingEnv`), `FACTURITA_API_KEY` (para que
// `isProviderConfigured()` sea true y `shouldUseSandboxMock('production')`
// devuelva false → ejecuta `registerCuit` real, no el mock).
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
process.env.INVOICING_ENCRYPTION_KEY ||= Buffer.alloc(32).toString('base64');
process.env.INVOICING_ENABLED = 'true';
process.env.FACTURITA_API_KEY = 'test-api-key';
delete process.env.INVOICING_SANDBOX_MOCK;

const { storage } = await import('../server/storage');
const { registerInvoicingRoutes } = await import('../server/routes/invoicing');

const ORG_ID = 'org-test-301';
const USER_ID = 'user-test-301';
const VALID_CUIT = '20111111112'; // checksum válido (usado también en tests unitarios)

interface CapturedRequest {
  url: string;
  method: string;
  body: any;
}

let captured: CapturedRequest[] = [];
let signupResponse: any = null;
let sellingPointsResponse: any = null;

const ORIG_FETCH = globalThis.fetch;

function installFetchStub() {
  captured = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    let parsedBody: any = null;
    if (init?.body) {
      try { parsedBody = JSON.parse(String(init.body)); } catch { parsedBody = init.body; }
    }
    captured.push({ url, method: init?.method || 'GET', body: parsedBody });

    if (url.endsWith('/signup/')) {
      return new Response(JSON.stringify(signupResponse), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/selling-points/cuit/')) {
      return new Response(JSON.stringify(sellingPointsResponse ?? []), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    // Cualquier otra URL (típicamente nuestro propio servidor Express en
    // 127.0.0.1) pasa al fetch original para no romper la request HTTP del
    // test.
    return ORIG_FETCH(input, init);
  }) as typeof fetch;
}

// Storage doubles: capturamos los upserts para verificar el fallback
// post-sync de `defaultSellingPoint`.
const ORIG_STORAGE: Record<string, any> = {};
let upsertCalls: any[] = [];
let replaceSellingPointsCalls: any[] = [];
let storedAccount: any = null;

function stubStorage(opts: { defaultSellingPoint?: number | null } = {}) {
  storedAccount = opts.defaultSellingPoint != null
    ? {
        id: 'acc-1', cuit: VALID_CUIT, razonSocial: 'EMISOR',
        ivaCondition: 'monotributo', environment: 'production',
        defaultSellingPoint: opts.defaultSellingPoint, isActive: true, isSimulated: false,
      }
    : null;

  const methods: Record<string, any> = {
    // Auth + permisos.
    getUser: async () => ({ id: USER_ID, deletedAt: null }),
    getSubscriptionByUserId: async () => ({ status: 'active' }),
    getOrganizationOwner: async () => ({ id: USER_ID }),
    getMembershipByUserAndOrg: async () => ({ role: 'owner', userId: USER_ID, organizationId: ORG_ID }),
    // Endpoint.
    getInvoicingAccount: async () => storedAccount,
    upsertInvoicingAccount: async (_org: string, patch: any) => {
      upsertCalls.push(patch);
      storedAccount = { ...(storedAccount ?? {}), ...patch };
      return storedAccount;
    },
    replaceSellingPoints: async (_org: string, list: any[]) => {
      replaceSellingPointsCalls.push(list);
      return list;
    },
    createAuditLog: async (entry: any) => entry,
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
    req.session = {
      userId: USER_ID,
      organizationId: ORG_ID,
      destroy: (cb: any) => cb && cb(),
    };
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
  signupResponse = {
    cuit: VALID_CUIT,
    iva_condition: 'monotributo',
    name: 'Emisor Test',
    selling_point: { selling_point: 4, business_name: 'PV 4', status: 'active' },
  };
  sellingPointsResponse = [];
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

async function postSignup(body: any) {
  const res = await fetch(`${baseUrl}/api/invoicing/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: any = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

function findSignupPost(): CapturedRequest {
  const req = captured.find(r => r.method === 'POST' && r.url.endsWith('/signup/'));
  assert.ok(req, `esperaba un POST a /signup/; capturados: ${JSON.stringify(captured.map(c => ({ m: c.method, u: c.url })))}`);
  return req!;
}

describe('POST /api/invoicing/signup — no fuerza punto de venta (Task #301)', () => {
  it('omite `selling_point` del POST a Facturitas cuando ni el body ni la cuenta local traen uno', async () => {
    stubStorage({ defaultSellingPoint: null });

    const { status, body } = await postSignup({
      cuit: VALID_CUIT,
      claveFiscal: 'CF',
      environment: 'production',
      // sin sellingPoint
    });
    assert.equal(status, 200, JSON.stringify(body));

    const signupReq = findSignupPost();
    assert.equal(signupReq.body.cuit, VALID_CUIT);
    assert.equal(signupReq.body.clave_fiscal, 'CF');
    assert.equal(
      Object.prototype.hasOwnProperty.call(signupReq.body, 'selling_point'),
      false,
      `el body NO debe contener selling_point cuando no hay default; body: ${JSON.stringify(signupReq.body)}`,
    );
  });

  it('incluye `selling_point` en el POST cuando el body lo trae explícito', async () => {
    stubStorage({ defaultSellingPoint: null });

    const { status } = await postSignup({
      cuit: VALID_CUIT,
      claveFiscal: 'CF',
      environment: 'production',
      sellingPoint: 7,
    });
    assert.equal(status, 200);

    const signupReq = findSignupPost();
    assert.equal(signupReq.body.selling_point, 7);
  });

  it('NO reusa `defaultSellingPoint` cacheado en una re-configuración (Task #313)', async () => {
    // Caso Juan (mayo 2026): la cuenta local quedó con `defaultSellingPoint = 1`
    // de un alta vieja. El usuario re-configura sin elegir explícitamente un
    // PV. ANTES el route pisaba el payload con el cacheado (1) y ARCA volvía
    // a quedar mal. Contrato nuevo: si el usuario no manda `sellingPoint` en
    // este intento, OMITIMOS `selling_point` del body y dejamos que ARCA
    // elija el correcto. El post-signup sync re-deriva el default local.
    stubStorage({ defaultSellingPoint: 1 });

    const { status } = await postSignup({
      cuit: VALID_CUIT,
      claveFiscal: 'CF',
      environment: 'production',
      // sin sellingPoint en el body → NO debe caer al cacheado
    });
    assert.equal(status, 200);

    const signupReq = findSignupPost();
    assert.equal(
      Object.prototype.hasOwnProperty.call(signupReq.body, 'selling_point'),
      false,
      `el body NO debe reutilizar el defaultSellingPoint cacheado; body: ${JSON.stringify(signupReq.body)}`,
    );
  });

  it('fallback post-sync: tras signup sin PV explícito, deriva `defaultSellingPoint` del primer PV activo que devuelve listSellingPoints', async () => {
    stubStorage({ defaultSellingPoint: null });

    // signup devuelve PV 1 (lo que pasaba antes del fix: ARCA elige 1 por
    // default), pero la realidad de ARCA — capturada por listSellingPoints —
    // es que el único PV activo es el 4. El route debe corregir el default
    // local a 4 en el segundo upsert.
    signupResponse = {
      cuit: VALID_CUIT,
      iva_condition: 'monotributo',
      name: 'Emisor Test',
      selling_point: { selling_point: 1, business_name: 'PV 1', status: 'active' },
    };
    sellingPointsResponse = [
      { id: 10, selling_point: 4, business_name: 'PV 4', status: 'active' },
      { id: 11, selling_point: 9, business_name: 'PV 9', status: 'inactive' },
    ];

    const { status } = await postSignup({
      cuit: VALID_CUIT,
      claveFiscal: 'CF',
      environment: 'production',
    });
    assert.equal(status, 200);

    // El upsert post-sync debe haber corregido el default a 4 (primer activo).
    const corrected = upsertCalls.find(c => c.defaultSellingPoint === 4);
    assert.ok(
      corrected,
      `esperaba un upsert con defaultSellingPoint=4 derivado del único PV activo; upserts: ${JSON.stringify(upsertCalls)}`,
    );
    // Y la lista de selling points cacheada localmente debe reflejar lo que
    // devolvió el provider (no solo el PV que vino con el signup).
    const lastReplace = replaceSellingPointsCalls[replaceSellingPointsCalls.length - 1];
    assert.ok(Array.isArray(lastReplace) && lastReplace.some((sp: any) => sp.number === 4 && sp.isActive));
  });
});
