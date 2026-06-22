/**
 * Verifies that when `FACTURITA_CORRELATION_KEY` is configured to a
 * non-legacy field name, the emit + reconcile flow uses that key end-to-end:
 *
 *  1. emitInvoice/emitCreditNote forward the local tx id under the new key
 *     in the POST/PATCH body.
 *  2. tryReconcileInvoice and attempt 1 of tryReconcileCreditNote query
 *     `GET /invoices/?<new_key>=` and successfully match the comprobante
 *     after a BAD_RESPONSE response from the emission call.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  emitInvoice,
  emitCreditNote,
  tryReconcileInvoice,
  tryReconcileCreditNote,
  FacturitaError,
} from '../server/services/facturita';

const ORIG_API_KEY = process.env.FACTURITA_API_KEY;
const ORIG_BASE = process.env.FACTURITA_BASE_URL_TEST;
const ORIG_CORR = process.env.FACTURITA_CORRELATION_KEY;
const realFetch = globalThis.fetch;

const NEW_KEY = 'api_user_reference';

type FetchCall = { url: string; method: string; body: any };
let calls: FetchCall[] = [];
let responder: (call: FetchCall) => { status: number; body: any } = () => ({ status: 200, body: {} });

beforeEach(() => {
  process.env.FACTURITA_API_KEY = 'test-key';
  process.env.FACTURITA_BASE_URL_TEST = 'https://api-test.example';
  process.env.FACTURITA_CORRELATION_KEY = NEW_KEY;
  calls = [];
  // @ts-expect-error: install stub
  globalThis.fetch = async (url: string, init: any) => {
    let parsedBody: any = null;
    if (init?.body) {
      try { parsedBody = JSON.parse(init.body as string); } catch { parsedBody = init.body; }
    }
    calls.push({ url: String(url), method: (init?.method || 'GET') as string, body: parsedBody });
    const { status, body } = responder(calls[calls.length - 1]);
    const text = body == null ? '' : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  if (ORIG_API_KEY === undefined) delete process.env.FACTURITA_API_KEY;
  else process.env.FACTURITA_API_KEY = ORIG_API_KEY;
  if (ORIG_BASE === undefined) delete process.env.FACTURITA_BASE_URL_TEST;
  else process.env.FACTURITA_BASE_URL_TEST = ORIG_BASE;
  if (ORIG_CORR === undefined) delete process.env.FACTURITA_CORRELATION_KEY;
  else process.env.FACTURITA_CORRELATION_KEY = ORIG_CORR;
  globalThis.fetch = realFetch;
});

const ctx = {
  cuit: '20345343122',
  environment: 'sandbox' as const,
  emitterIvaCondition: 'monotributo' as const,
};

describe('emit + reconcile via FACTURITA_CORRELATION_KEY', () => {
  it('forwards externalReference under the configured key on POST /invoices/', async () => {
    responder = () => ({
      status: 200,
      body: {
        invoice_uuid: 'inv-ok',
        cae: '70123456789012',
        cae_expiration_date: '2026-06-30',
        voucher_id: 1,
        pdf_url: 'https://pdf.example/ok.pdf',
        price: 100,
        invoice_date: '2026-05-19',
      },
    });

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
      externalReference: 'tx-new-key-001',
      observations: null,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(
      calls[0].body[NEW_KEY],
      'tx-new-key-001',
      `expected ${NEW_KEY} in POST body, got: ${JSON.stringify(calls[0].body)}`,
    );
    assert.equal('external_reference' in calls[0].body, false);
  });

  it('forwards externalReference under the configured key on PATCH /invoices/ (NC)', async () => {
    responder = () => ({
      status: 200,
      body: {
        credit_note_uuid: 'nc-ok',
        cae: '70999999999999',
        cae_expiration_date: '2026-07-15',
        voucher_id: 5,
        pdf_url: 'https://pdf.example/nc.pdf',
        price: 100,
      },
    });

    await emitCreditNote({
      ctx,
      originalInvoiceUuid: 'inv-orig',
      originalDocType: 'FC',
      date: new Date('2026-05-19'),
      reason: 'Anulación',
      externalReference: 'tx-new-key-nc-001',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PATCH');
    assert.equal(calls[0].body[NEW_KEY], 'tx-new-key-nc-001');
    assert.equal('external_reference' in calls[0].body, false);
  });

  it('tryReconcileInvoice recovers a factura via the new key after BAD_RESPONSE', async () => {
    // Simulate BAD_RESPONSE on POST (empty body) and a populated listing
    // when GET ?<NEW_KEY>= is queried with the same externalReference.
    const externalReference = 'tx-bad-response-001';
    responder = (call) => {
      if (call.method === 'GET' && call.url.includes(`?${NEW_KEY}=`)) {
        return {
          status: 200,
          body: [
            {
              invoice_uuid: 'inv-recovered',
              cae: '70111111111111',
              cae_expiration_date: '2026-06-30',
              voucher_id: 999,
              pdf_url: 'https://pdf.example/recovered.pdf',
              price: 250,
              invoice_date: '2026-05-19',
              invoice_type: 'C',
            },
          ],
        };
      }
      // POST returns a malformed body (no invoice_uuid / cae) → BAD_RESPONSE
      return { status: 200, body: { status: 'queued' } };
    };

    await assert.rejects(
      () => emitInvoice({
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
        items: [{ description: 'Servicio', quantity: 1, unitPriceNet: 250, ivaAliquot: 0 }],
        currency: 'ARS',
        exchangeRate: null,
        externalReference,
        observations: null,
      }),
      (err: unknown) => {
        assert.ok(err instanceof FacturitaError);
        assert.equal((err as FacturitaError).code, 'BAD_RESPONSE');
        return true;
      },
    );

    // Reset call log to focus on the reconciliation path.
    calls = [];

    const recovered = await tryReconcileInvoice({
      ctx,
      externalReference,
    });

    assert.ok(recovered, 'reconciliation should match by the new key');
    assert.equal(recovered!.uuid, 'inv-recovered');
    assert.equal(recovered!.cae, '70111111111111');
    assert.equal(recovered!.voucherNumber, '999');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes(`?${NEW_KEY}=`), `expected listing query by ${NEW_KEY}, got: ${calls[0].url}`);
  });

  it('tryReconcileCreditNote attempt 1 matches the NC via the new key', async () => {
    responder = (call) => {
      if (call.url.includes(`?${NEW_KEY}=`)) {
        return {
          status: 200,
          body: [
            {
              credit_note_uuid: 'nc-recovered',
              cae: '70222222222222',
              cae_expiration_date: '2026-07-15',
              voucher_id: 321,
              pdf_url: 'https://pdf.example/nc-recovered.pdf',
              price: 250,
              invoice_uuid: 'inv-orig-aaa',
              status: 'EMITTED',
            },
          ],
        };
      }
      return { status: 404, body: null };
    };

    const out = await tryReconcileCreditNote({
      ctx,
      originalInvoiceUuid: 'inv-orig-aaa',
      originalDocType: 'FC',
      externalReference: 'tx-bad-response-nc-001',
    });

    assert.ok(out, 'reconciliation should recover the NC via the new key');
    assert.equal(out!.uuid, 'nc-recovered');
    assert.equal(out!.cae, '70222222222222');
    assert.equal(out!.voucherNumber, '321');
    assert.equal(calls.length, 1, 'should NOT need to fall through to attempt 2');
    assert.ok(calls[0].url.includes(`?${NEW_KEY}=`));
  });

  it('tryReconcileInvoice returns null when no correlation key is configured', async () => {
    delete process.env.FACTURITA_CORRELATION_KEY;
    const out = await tryReconcileInvoice({
      ctx,
      externalReference: 'whatever',
    });
    assert.equal(out, null);
    assert.equal(calls.length, 0, 'must not call the provider when key is unset');
  });
});
