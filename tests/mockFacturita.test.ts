import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mockEmitInvoice,
  mockEmitCreditNote,
  mockRegisterCuit,
  mockListSellingPoints,
  parseMockVoucher,
  MOCK_PDF_PATH_PREFIX,
} from '../server/services/mockFacturita';

const ctx = {
  cuit: '20111111112',
  environment: 'sandbox' as const,
  emitterIvaCondition: 'responsable_inscripto' as const,
};

describe('mockEmitInvoice', () => {
  it('produces a simulated invoice with mock-prefixed uuid and a mock-pdf URL', () => {
    const inv = mockEmitInvoice({
      ctx,
      sellingPoint: 1,
      docType: 'A',
      receiver: { taxId: '20222222223', name: 'Cliente', ivaCondition: 'responsable_inscripto', address: null, email: null },
      items: [{ description: 'Item', quantity: 1, unitPriceNet: 100, ivaAliquot: 21 }],
      date: new Date(),
      currency: 'ARS',
      exchangeRate: null,
      externalReference: 'tx-1',
      observations: null,
      nextVoucherNumber: 1,
      sellingPointNumber: 1,
    });
    assert.match(inv.uuid, /^mock-/);
    assert.equal(inv.pdfUrl, `${MOCK_PDF_PATH_PREFIX}${inv.uuid}`);
    assert.equal(inv.net, 100);
    assert.equal(inv.iva, 21);
    assert.equal(inv.total, 121);
    assert.equal(inv.docType, 'A');
    assert.match(inv.cae, /^\d{14}$/);
    assert.equal(inv.voucherNumber, '0001-00000001');
    assert.deepEqual(inv.raw, { simulated: true });
  });
});

describe('mockEmitCreditNote', () => {
  it('marks raw.simulated=true so callers can flag invoiceSimulated downstream', () => {
    const nc = mockEmitCreditNote({
      ctx,
      originalInvoiceUuid: 'mock-orig',
      originalDocType: 'A',
      date: new Date(),
      reason: 'Anulación',
      externalReference: 'tx-1',
      nextVoucherNumber: 5,
      sellingPointNumber: 3,
    });
    assert.match(nc.uuid, /^mock-nc-/);
    const raw = nc.raw;
    assert.ok(raw && typeof raw === 'object', 'raw must be an object');
    const rawObj = raw as Record<string, unknown>;
    assert.equal(rawObj.simulated, true);
    assert.equal(rawObj.reason, 'Anulación');
    // Credit note for an A invoice is also "A" doc-type per selectCreditNoteDocType
    assert.ok(nc.docType);
    assert.equal(nc.voucherNumber, '0003-00000005');
    assert.equal(nc.pdfUrl, `${MOCK_PDF_PATH_PREFIX}${nc.uuid}`);
  });
});

describe('mockRegisterCuit / mockListSellingPoints', () => {
  it('returns the requested CUIT and a default selling point', () => {
    const r = mockRegisterCuit({ cuit: '20111111112', sellingPoint: 7, claveFiscal: null, direccion: null, nombreDeFantasia: 'ACME' });
    assert.equal(r.cuit, '20111111112');
    assert.equal(r.ivaCondition, 'responsable_inscripto');
    assert.equal(r.sellingPoint?.number, 7);
  });

  it('lists known selling points and falls back to PV 1 when none', () => {
    const empty = mockListSellingPoints(ctx, []);
    assert.equal(empty.length, 1);
    assert.equal(empty[0].number, 1);

    const some = mockListSellingPoints(ctx, [3, 1, 2]);
    assert.deepEqual(some.map((s) => s.number), [1, 2, 3]);
    assert.ok(some.every((s) => s.active));
  });
});

describe('parseMockVoucher', () => {
  it('parses well-formed PPPP-NNNNNNNN and rejects everything else', () => {
    assert.deepEqual(parseMockVoucher('0001-00000001'), { pv: 1, n: 1 });
    assert.deepEqual(parseMockVoucher('0007-00000123'), { pv: 7, n: 123 });
    assert.equal(parseMockVoucher(''), null);
    assert.equal(parseMockVoucher(null), null);
    assert.equal(parseMockVoucher('not-a-voucher'), null);
    assert.equal(parseMockVoucher('1-1-1'), null);
  });
});
