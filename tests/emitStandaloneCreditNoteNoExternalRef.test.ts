import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { emitStandaloneCreditNote } from '../server/services/facturita';

const ORIG_API_KEY = process.env.FACTURITA_API_KEY;
const ORIG_BASE = process.env.FACTURITA_BASE_URL_TEST;
const realFetch = globalThis.fetch;

type FetchCall = { url: string; method: string; body: any };
let calls: FetchCall[] = [];

beforeEach(() => {
  process.env.FACTURITA_API_KEY = 'test-key';
  process.env.FACTURITA_BASE_URL_TEST = 'https://api-test.example';
  calls = [];
  // @ts-expect-error: install stub
  globalThis.fetch = async (url: string, init: any) => {
    let parsedBody: any = null;
    if (init?.body) {
      try { parsedBody = JSON.parse(init.body as string); } catch { parsedBody = init.body; }
    }
    const method = (init?.method || 'GET') as string;
    const call: FetchCall = { url: String(url), method, body: parsedBody };
    calls.push(call);

    if (method === 'POST' && /\/invoices\/?$/.test(String(url))) {
      return new Response(
        JSON.stringify({
          invoice_uuid: 'shadow-uuid-1',
          cuit: '20345343122',
          selling_point: 1,
          invoice_type: 'C',
          status: 'emitted',
          invoice_date: '2026-05-19',
          price: 121,
          cae: '70123456789012',
          cae_expiration_date: '2026-06-30',
          voucher_id: 999,
          pdf_url: 'https://pdf.example/shadow.pdf',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (method === 'PATCH' && /\/invoices\/?$/.test(String(url))) {
      return new Response(
        JSON.stringify({
          invoice_uuid: 'shadow-uuid-1',
          credit_note_uuid: 'nc-uuid-1',
          cae: '70999999999999',
          cae_expiration_date: '2026-06-30',
          voucher_id: 5,
          pdf_url: 'https://pdf.example/nc.pdf',
          price: 121,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  if (ORIG_API_KEY === undefined) delete process.env.FACTURITA_API_KEY;
  else process.env.FACTURITA_API_KEY = ORIG_API_KEY;
  if (ORIG_BASE === undefined) delete process.env.FACTURITA_BASE_URL_TEST;
  else process.env.FACTURITA_BASE_URL_TEST = ORIG_BASE;
  globalThis.fetch = realFetch;
});

const ctx = {
  cuit: '20345343122',
  environment: 'sandbox' as const,
  emitterIvaCondition: 'monotributo' as const,
};

describe('emitStandaloneCreditNote', () => {
  it('shadow factura POST does NOT include external_reference even when caller provides one', async () => {
    const result = await emitStandaloneCreditNote({
      ctx,
      sellingPoint: 1,
      docType: 'NCC',
      receiver: {
        taxId: null,
        name: 'Proveedor Test',
        ivaCondition: 'consumidor_final',
        address: null,
        email: null,
      },
      date: new Date('2026-05-19'),
      items: [{ description: 'Servicio', quantity: 1, unitPriceNet: 100, ivaAliquot: 0 }],
      currency: 'ARS',
      exchangeRate: null,
      externalReference: 'tx-nc-standalone-001',
      observations: 'Anulación proveedor',
    });

    const posts = calls.filter((c) => c.method === 'POST');
    assert.ok(posts.length >= 1, 'expected at least one POST for the shadow factura');
    for (const post of posts) {
      assert.equal(
        post.body && typeof post.body === 'object' && 'external_reference' in post.body,
        false,
        `external_reference must NOT be present in any POST body; got: ${JSON.stringify(post.body)}`,
      );
    }

    const patches = calls.filter((c) => c.method === 'PATCH');
    assert.equal(patches.length, 1, 'expected exactly one PATCH for the NC');
    assert.equal(
      patches[0].body && typeof patches[0].body === 'object' && 'external_reference' in patches[0].body,
      false,
      `external_reference must NOT be present in PATCH body; got: ${JSON.stringify(patches[0].body)}`,
    );

    assert.equal(result.uuid, 'nc-uuid-1');
    assert.equal(result.docType, 'NCC');
  });
});
