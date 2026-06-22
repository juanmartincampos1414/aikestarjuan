import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerCuit } from '../server/services/facturita';
import { mockRegisterCuit } from '../server/services/mockFacturita';

// Task #300 — Cuando el usuario no eligió un PV específico y la cuenta local
// no tiene un `defaultSellingPoint`, el route handler de `POST
// /api/invoicing/signup` pasa `sellingPoint: undefined` a `registerCuit`. El
// contrato de `registerCuit` es OMITIR el campo `selling_point` del body del
// POST a Facturitas cuando la entrada es falsy. Estos tests fijan ese
// contrato para evitar que un default silencioso (como el `?? 1` que
// removimos) se vuelva a colar.
//
// Caso reportado en producción (mayo 2026, monotributista): nuestro signup
// mandaba `selling_point: 1` por default y Facturitas/ARCA lo respetaban,
// dejando al cliente con un PV equivocado.

interface CapturedRequest {
  url: string;
  method: string;
  body: any;
}

const ORIG_FETCH = globalThis.fetch;
const ORIG_API_KEY = process.env.FACTURITA_API_KEY;
const ORIG_API_BASE = process.env.FACTURITA_API_BASE;

let captured: CapturedRequest[] = [];

function installFetchStub(responseBody: unknown) {
  captured = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    let parsedBody: any = null;
    if (init?.body) {
      try { parsedBody = JSON.parse(String(init.body)); } catch { parsedBody = init.body; }
    }
    captured.push({ url, method: init?.method || 'GET', body: parsedBody });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.FACTURITA_API_KEY = 'test-api-key';
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  if (ORIG_API_KEY === undefined) delete process.env.FACTURITA_API_KEY;
  else process.env.FACTURITA_API_KEY = ORIG_API_KEY;
  if (ORIG_API_BASE === undefined) delete process.env.FACTURITA_API_BASE;
  else process.env.FACTURITA_API_BASE = ORIG_API_BASE;
});

describe('registerCuit — payload de selling_point en el alta', () => {
  it('omite `selling_point` del body cuando la entrada es undefined', async () => {
    installFetchStub({
      cuit: '20111111112',
      iva_condition: 'monotributo',
      name: 'Emisor Test',
      selling_point: { selling_point: 4, status: 'active' },
    });

    await registerCuit({
      cuit: '20111111112',
      claveFiscal: 'CF',
      // sellingPoint: undefined → no debe ir en el payload
      environment: 'production',
    });

    assert.equal(captured.length, 1, 'esperaba exactamente un POST al provider');
    const req = captured[0];
    assert.equal(req.method, 'POST');
    assert.ok(req.url.endsWith('/signup/'), `URL inesperada: ${req.url}`);
    assert.equal(req.body.cuit, '20111111112');
    assert.equal(req.body.clave_fiscal, 'CF');
    assert.equal(
      Object.prototype.hasOwnProperty.call(req.body, 'selling_point'),
      false,
      `el body NO debe contener selling_point cuando la entrada es undefined; body: ${JSON.stringify(req.body)}`,
    );
  });

  it('incluye `selling_point` en el body cuando el usuario lo eligió', async () => {
    installFetchStub({
      cuit: '20111111112',
      iva_condition: 'monotributo',
      name: 'Emisor Test',
      selling_point: { selling_point: 7, status: 'active' },
    });

    await registerCuit({
      cuit: '20111111112',
      claveFiscal: 'CF',
      sellingPoint: 7,
      environment: 'production',
    });

    assert.equal(captured.length, 1);
    const req = captured[0];
    assert.equal(req.body.selling_point, 7);
  });

  it('omite `selling_point` cuando se pasa explícitamente 0 (falsy, defensivo)', async () => {
    installFetchStub({
      cuit: '20111111112',
      iva_condition: 'monotributo',
      name: 'Emisor Test',
      selling_point: null,
    });

    await registerCuit({
      cuit: '20111111112',
      claveFiscal: 'CF',
      sellingPoint: 0, // defensivo: 0 nunca es un PV válido y debe omitirse
      environment: 'production',
    });

    assert.equal(
      Object.prototype.hasOwnProperty.call(captured[0].body, 'selling_point'),
      false,
    );
  });
});

describe('mockRegisterCuit — tolera selling_point ausente', () => {
  it('sintetiza un PV razonable cuando la entrada no trae sellingPoint', () => {
    const r = mockRegisterCuit({
      cuit: '20111111112',
      claveFiscal: null,
      direccion: null,
      nombreDeFantasia: 'ACME',
      // sellingPoint: undefined
    });
    assert.equal(r.cuit, '20111111112');
    assert.ok(r.sellingPoint, 'mock siempre devuelve un sellingPoint para mantener el simulador funcional');
    assert.equal(typeof r.sellingPoint!.number, 'number');
    assert.ok(r.sellingPoint!.number > 0);
  });

  it('respeta el sellingPoint elegido cuando viene definido', () => {
    const r = mockRegisterCuit({
      cuit: '20111111112',
      claveFiscal: null,
      direccion: null,
      nombreDeFantasia: 'ACME',
      sellingPoint: 9,
    });
    assert.equal(r.sellingPoint?.number, 9);
  });
});
