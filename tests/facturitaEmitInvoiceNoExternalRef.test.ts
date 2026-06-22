import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { emitInvoice, emitCreditNote } from '../server/services/facturita';

const ORIG_API_KEY = process.env.FACTURITA_API_KEY;
const ORIG_BASE = process.env.FACTURITA_BASE_URL_TEST;
const realFetch = globalThis.fetch;

type FetchCall = { url: string; method: string; body: any };
let calls: FetchCall[] = [];
let responder: (call: FetchCall) => { status: number; body: any } = () => ({ status: 200, body: {} });

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
    const call: FetchCall = { url: String(url), method: (init?.method || 'GET') as string, body: parsedBody };
    calls.push(call);
    const { status, body } = responder(call);
    const text = body == null ? '' : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
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

const okInvoiceResponse = {
  invoice_uuid: 'inv-uuid-xyz',
  cuit: '20345343122',
  selling_point: 1,
  invoice_type: 'C',
  status: 'emitted',
  invoice_date: '2026-05-19',
  price: 121,
  cae: '70123456789012',
  cae_expiration_date: '2026-06-30',
  voucher_id: 123,
  pdf_url: 'https://pdf.example/inv.pdf',
};

describe('emitInvoice POST body', () => {
  it('does NOT include external_reference even when input.externalReference is provided', async () => {
    responder = () => ({ status: 200, body: okInvoiceResponse });

    await emitInvoice({
      ctx,
      sellingPoint: 1,
      docType: 'FC',
      receiver: {
        taxId: null,
        name: 'Consumidor Final',
        ivaCondition: 'consumidor_final',
        address: null,
        email: null,
      },
      date: new Date('2026-05-19'),
      items: [{ description: 'Servicio', quantity: 1, unitPriceNet: 100, ivaAliquot: 0 }],
      currency: 'ARS',
      exchangeRate: null,
      externalReference: 'tx-bighmkt-001',
      observations: null,
    });

    assert.equal(calls.length, 1, 'should make exactly one POST');
    const post = calls[0];
    assert.equal(post.method, 'POST');
    assert.ok(post.url.endsWith('/invoices/'), `unexpected URL: ${post.url}`);
    assert.equal(
      post.body && typeof post.body === 'object' && 'external_reference' in post.body,
      false,
      `external_reference must NOT be present in POST body, got: ${JSON.stringify(post.body)}`,
    );
    assert.equal(post.body.cuit, '20345343122');
    assert.equal(post.body.invoice_type, 'C');
  });

  it('does NOT include external_reference for FB (Responsable Inscripto → Monotributo)', async () => {
    responder = () => ({ status: 200, body: { ...okInvoiceResponse, invoice_type: 'B' } });

    await emitInvoice({
      ctx: { ...ctx, emitterIvaCondition: 'responsable_inscripto' },
      sellingPoint: 1,
      docType: 'FB',
      receiver: {
        taxId: '20333333334',
        name: 'Cliente Monotributo',
        ivaCondition: 'monotributo',
        address: null,
        email: null,
      },
      date: new Date(),
      items: [{ description: 'Servicio', quantity: 1, unitPriceNet: 100, ivaAliquot: 21 }],
      currency: 'ARS',
      exchangeRate: null,
      externalReference: 'tx-fb-001',
      observations: null,
    });

    assert.equal(
      'external_reference' in (calls[0].body as object),
      false,
      `external_reference must NOT be present in FB POST body, got: ${JSON.stringify(calls[0].body)}`,
    );
    assert.equal(calls[0].body.invoice_type, 'B');
  });

  it('does NOT include external_reference for FA (Responsable Inscripto → RI)', async () => {
    responder = () => ({ status: 200, body: { ...okInvoiceResponse, invoice_type: 'A' } });

    await emitInvoice({
      ctx: { ...ctx, emitterIvaCondition: 'responsable_inscripto' },
      sellingPoint: 1,
      docType: 'FA',
      receiver: {
        taxId: '20222222223',
        name: 'Cliente SA',
        ivaCondition: 'responsable_inscripto',
        address: null,
        email: null,
      },
      date: new Date(),
      items: [{ description: 'Item', quantity: 1, unitPriceNet: 100, ivaAliquot: 21 }],
      currency: 'ARS',
      exchangeRate: null,
      externalReference: 'tx-ri-001',
      observations: null,
    });

    assert.equal(
      'external_reference' in (calls[0].body as object),
      false,
    );
  });
});

describe('emitCreditNote PATCH body', () => {
  it('does NOT include external_reference (regression for existing PATCH workaround)', async () => {
    responder = () => ({
      status: 200,
      body: {
        invoice_uuid: 'inv-orig',
        credit_note_uuid: 'nc-uuid-1',
        cae: '70999999999999',
        cae_expiration_date: '2026-06-30',
        voucher_id: 5,
        pdf_url: 'https://pdf.example/nc.pdf',
        price: 100,
      },
    });

    await emitCreditNote({
      ctx,
      originalInvoiceUuid: 'inv-orig',
      originalDocType: 'FC',
      date: new Date(),
      reason: 'Anulación de prueba',
      externalReference: 'tx-nc-001',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PATCH');
    assert.equal(
      'external_reference' in (calls[0].body as object),
      false,
      `external_reference must NOT be present in PATCH body, got: ${JSON.stringify(calls[0].body)}`,
    );
  });
});
