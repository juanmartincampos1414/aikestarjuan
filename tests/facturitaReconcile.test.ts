import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tryReconcileCreditNote } from '../server/services/facturita';

const ORIG_API_KEY = process.env.FACTURITA_API_KEY;
const ORIG_BASE = process.env.FACTURITA_BASE_URL_TEST;
const ORIG_CORR = process.env.FACTURITA_CORRELATION_KEY;
const realFetch = globalThis.fetch;

type FetchCall = { url: string; method?: string };
let calls: FetchCall[] = [];
let responder: (call: FetchCall) => { status: number; body: any } = () => ({ status: 404, body: null });

beforeEach(() => {
  process.env.FACTURITA_API_KEY = 'test-key';
  process.env.FACTURITA_BASE_URL_TEST = 'https://api-test.example';
  // Existing tests exercise the listing-based reconciliation path; restore
  // that path by configuring `external_reference` as the correlation key.
  process.env.FACTURITA_CORRELATION_KEY = 'external_reference';
  calls = [];
  // @ts-expect-error: install stub
  globalThis.fetch = async (url: string, init: any) => {
    const call = { url: String(url), method: (init?.method || 'GET') as string };
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
  if (ORIG_CORR === undefined) delete process.env.FACTURITA_CORRELATION_KEY;
  else process.env.FACTURITA_CORRELATION_KEY = ORIG_CORR;
  globalThis.fetch = realFetch;
});

const baseInput = {
  ctx: {
    cuit: '20111111112',
    environment: 'sandbox' as const,
    emitterIvaCondition: 'responsable_inscripto' as const,
  },
  originalInvoiceUuid: 'inv-uuid-aaa',
  originalDocType: 'FA' as const,
  externalReference: 'tx-123',
};

describe('tryReconcileCreditNote', () => {
  it('returns NC found by listing endpoint matched on invoice_uuid (NCA from FA)', async () => {
    responder = (call) => {
      if (call.url.includes('/invoices/?external_reference=')) {
        return {
          status: 200,
          body: [
            { credit_note_uuid: 'other', cae: 'X', invoice_uuid: 'unrelated' },
            {
              credit_note_uuid: 'nc-uuid-1',
              cae: '70123456789012',
              cae_expiration_date: '2026-06-30',
              voucher_id: 4567,
              pdf_url: 'https://pdf.example/nc.pdf',
              price: 1500,
              invoice_uuid: 'inv-uuid-aaa',
              status: 'EMITTED',
            },
          ],
        };
      }
      return { status: 404, body: null };
    };
    const out = await tryReconcileCreditNote(baseInput);
    assert.ok(out, 'should reconcile');
    assert.equal(out!.uuid, 'nc-uuid-1');
    assert.equal(out!.cae, '70123456789012');
    assert.equal(out!.voucherNumber, '4567');
    assert.equal(out!.pdfUrl, 'https://pdf.example/nc.pdf');
    assert.equal(out!.docType, 'NCA');
    assert.equal(out!.total, 1500);
    assert.equal(calls.length, 1);
  });

  it('falls back to GET /invoices/{uuid} when listing returns no match', async () => {
    let stage = 0;
    responder = (call) => {
      stage++;
      if (stage === 1) {
        // listing returns empty
        return { status: 200, body: [] };
      }
      // second call: GET /invoices/{uuid}
      assert.ok(call.url.includes('/invoices/inv-uuid-aaa'));
      return {
        status: 200,
        body: {
          invoice_uuid: 'inv-uuid-aaa',
          status: 'cancelled',
          price: 999,
          credit_note_uuid: 'nc-uuid-2',
          credit_note_cae: '70999999999999',
          credit_note_cae_expiration_date: '2026-07-15',
          credit_note_voucher_id: 88,
          credit_note_pdf_url: 'https://pdf.example/nc2.pdf',
        },
      };
    };
    const out = await tryReconcileCreditNote(baseInput);
    assert.ok(out);
    assert.equal(out!.uuid, 'nc-uuid-2');
    assert.equal(out!.cae, '70999999999999');
    assert.equal(out!.voucherNumber, '88');
    assert.equal(out!.pdfUrl, 'https://pdf.example/nc2.pdf');
    assert.equal(calls.length, 2);
  });

  it('returns null when neither endpoint finds a confirmed NC', async () => {
    responder = (call) => {
      if (call.url.includes('?external_reference=')) {
        return { status: 200, body: [] };
      }
      return { status: 200, body: { invoice_uuid: 'inv-uuid-aaa', status: 'active' } };
    };
    const out = await tryReconcileCreditNote(baseInput);
    assert.equal(out, null);
    assert.equal(calls.length, 2);
  });

  it('returns null and swallows errors on 404/5xx/network failures', async () => {
    responder = () => ({ status: 404, body: null });
    const out = await tryReconcileCreditNote(baseInput);
    assert.equal(out, null);
  });

  it('skips list match if credit_note_uuid or cae is missing/empty', async () => {
    responder = (call) => {
      if (call.url.includes('?external_reference=')) {
        return {
          status: 200,
          body: [
            { credit_note_uuid: '', cae: 'X', invoice_uuid: 'inv-uuid-aaa' },
            { credit_note_uuid: 'present', cae: null, invoice_uuid: 'inv-uuid-aaa' },
          ],
        };
      }
      return { status: 200, body: {} };
    };
    const out = await tryReconcileCreditNote(baseInput);
    assert.equal(out, null);
  });

  it('matches alternative reference fields (fk_invoice_uuid)', async () => {
    responder = (call) => {
      if (call.url.includes('?external_reference=')) {
        return {
          status: 200,
          body: [
            {
              credit_note_uuid: 'nc-fk',
              cae: 'C',
              fk_invoice_uuid: 'inv-uuid-aaa',
              voucher_id: 1,
            },
          ],
        };
      }
      return { status: 404, body: null };
    };
    const out = await tryReconcileCreditNote(baseInput);
    assert.ok(out);
    assert.equal(out!.uuid, 'nc-fk');
  });
});
