import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { emitInvoice, emitCreditNote, FacturitaError } from '../server/services/facturita';

const ORIG_API_KEY = process.env.FACTURITA_API_KEY;
const ORIG_BASE = process.env.FACTURITA_BASE_URL_TEST;
const realFetch = globalThis.fetch;

type FetchCall = { url: string; method: string };
let calls: FetchCall[] = [];
let responder: (call: FetchCall) => { status: number; body: any } = () => ({ status: 200, body: {} });

beforeEach(() => {
  process.env.FACTURITA_API_KEY = 'test-key';
  process.env.FACTURITA_BASE_URL_TEST = 'https://api-test.example';
  calls = [];
  // @ts-expect-error: install stub
  globalThis.fetch = async (url: string, init: any) => {
    const call: FetchCall = { url: String(url), method: (init?.method || 'GET') as string };
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

const emitInput = {
  ctx,
  sellingPoint: 1,
  docType: 'FC' as const,
  receiver: {
    taxId: null,
    name: 'Consumidor Final',
    ivaCondition: 'consumidor_final' as const,
    address: null,
    email: null,
  },
  date: new Date('2026-05-19'),
  items: [{ description: 'Servicio', quantity: 1, unitPriceNet: 100, ivaAliquot: 0 }],
  currency: 'ARS',
  exchangeRate: null,
  externalReference: 'tx-tolerant-001',
  observations: null,
};

describe('emitInvoice tolerant parse (BAD_RESPONSE fallback)', () => {
  it('recovers from a wrapped { invoice: {...} } response without throwing BAD_RESPONSE', async () => {
    responder = () => ({
      status: 200,
      body: {
        invoice: {
          invoice_uuid: 'inv-uuid-wrapped',
          cae: '70123456789012',
          cae_expiration_date: '2026-06-30',
          voucher_id: 777,
          pdf_url: 'https://pdf.example/wrapped.pdf',
          price: 100,
          invoice_date: '2026-05-19',
          invoice_type: 'C',
          status: 'emitted',
          selling_point: 1,
          cuit: '20345343122',
        },
      },
    });

    const out = await emitInvoice(emitInput);
    assert.equal(out.uuid, 'inv-uuid-wrapped');
    assert.equal(out.cae, '70123456789012');
    assert.equal(out.voucherNumber, '777');
    assert.equal(out.pdfUrl, 'https://pdf.example/wrapped.pdf');
    assert.equal(calls.length, 1, 'should NOT retry — tolerant parse recovers in-place');
  });

  it('recovers from `uuid`/`cae_number` aliases at the top level', async () => {
    responder = () => ({
      status: 200,
      body: {
        uuid: 'inv-uuid-aliased',
        cae_number: '70999999999999',
        cae_expiration_date: '2026-07-15',
        voucher_id: 5,
        pdf_url: 'https://pdf.example/aliased.pdf',
        price: 100,
        invoice_date: '2026-05-19',
        invoice_type: 'C',
      },
    });

    const out = await emitInvoice(emitInput);
    assert.equal(out.uuid, 'inv-uuid-aliased');
    assert.equal(out.cae, '70999999999999');
    assert.equal(out.voucherNumber, '5');
  });

  it('still throws BAD_RESPONSE when neither uuid nor cae can be extracted', async () => {
    responder = () => ({
      status: 200,
      body: { status: 'pending', message: 'queued' },
    });

    await assert.rejects(
      () => emitInvoice(emitInput),
      (err: unknown) => {
        assert.ok(err instanceof FacturitaError);
        assert.equal((err as FacturitaError).code, 'BAD_RESPONSE');
        return true;
      },
    );
  });
});

describe('emitCreditNote tolerant parse (BAD_RESPONSE fallback)', () => {
  it('recovers from a wrapped { credit_note: {...} } response', async () => {
    responder = () => ({
      status: 200,
      body: {
        credit_note: {
          credit_note_uuid: 'nc-wrapped',
          cae: '70555555555555',
          cae_expiration_date: '2026-08-01',
          voucher_id: 42,
          pdf_url: 'https://pdf.example/nc.pdf',
          price: 200,
        },
      },
    });

    const out = await emitCreditNote({
      ctx,
      originalInvoiceUuid: 'inv-orig',
      originalDocType: 'FC',
      date: new Date('2026-05-19'),
      reason: 'Anulación de prueba',
      externalReference: 'tx-nc-tolerant-001',
    });

    assert.equal(out.uuid, 'nc-wrapped');
    assert.equal(out.cae, '70555555555555');
    assert.equal(out.voucherNumber, '42');
  });

  it('still throws BAD_RESPONSE when neither credit_note_uuid nor cae can be extracted', async () => {
    responder = () => ({
      status: 200,
      body: { status: 'queued' },
    });

    await assert.rejects(
      () => emitCreditNote({
        ctx,
        originalInvoiceUuid: 'inv-orig',
        originalDocType: 'FC',
        date: new Date('2026-05-19'),
        reason: 'Anulación de prueba',
        externalReference: 'tx-nc-tolerant-002',
      }),
      (err: unknown) => {
        assert.ok(err instanceof FacturitaError);
        assert.equal((err as FacturitaError).code, 'BAD_RESPONSE');
        return true;
      },
    );
  });
});
