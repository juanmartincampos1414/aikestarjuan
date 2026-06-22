import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import {
  renderMockInvoicePdfToDoc,
  renderMockInvoicePdfToBuffer,
  resolveMockInvoiceDocMeta,
  type MockInvoicePdfContext,
} from '../server/services/mockInvoicePdf';
import type { Transaction } from '@shared/schema';

function makeTx(overrides: Partial<Transaction & Record<string, any>> = {}): Transaction & Record<string, any> {
  return {
    id: 'tx-1',
    description: 'Servicios prestados',
    amount: '121.00',
    currency: 'ARS',
    invoiceDocType: 'FA',
    invoiceVoucherId: '0001-00000001',
    invoiceEmittedAt: new Date('2026-01-15T12:00:00Z'),
    invoiceEmitterCuit: '20111111112',
    invoiceTaxId: '20222222223',
    invoiceNetAmount: '100.00',
    invoiceIvaAmount: '21.00',
    invoiceIvaAliquot: '21',
    invoiceOtherTaxes: '0',
    invoiceCae: '12345678901234',
    invoiceCaeExpirationDate: new Date('2026-02-15T12:00:00Z'),
    invoiceUuid: 'mock-abc',
    ...overrides,
  } as any;
}

function makeCtx(overrides: Partial<MockInvoicePdfContext> = {}): MockInvoicePdfContext {
  return {
    tx: makeTx(),
    acc: {
      razonSocial: 'ACME SA',
      cuit: '20111111112',
      ivaCondition: 'responsable_inscripto',
    } as any,
    isCreditNote: false,
    emitterTaxProfile: null,
    receptorName: 'Cliente',
    receptorAddress: 'Calle 123',
    receptorIvaCondition: 'responsable_inscripto',
    ...overrides,
  };
}

describe('resolveMockInvoiceDocMeta', () => {
  it('maps FA to letter A / code 001 / FACTURA', () => {
    const meta = resolveMockInvoiceDocMeta(makeTx({ invoiceDocType: 'FA' }), false);
    assert.equal(meta.letter, 'A');
    assert.equal(meta.code, '001');
    assert.equal(meta.title, 'FACTURA');
  });

  it('promotes a credit note derived from FA to NCA (letter A / code 003 / NOTA DE CRÉDITO)', () => {
    const meta = resolveMockInvoiceDocMeta(makeTx({ invoiceDocType: 'FA' }), true);
    assert.equal(meta.letter, 'A');
    assert.equal(meta.code, '003');
    assert.equal(meta.title, 'NOTA DE CRÉDITO');
  });

  it('keeps NCA as-is when already persisted', () => {
    const meta = resolveMockInvoiceDocMeta(makeTx({ invoiceDocType: 'NCA' }), true);
    assert.equal(meta.letter, 'A');
    assert.equal(meta.code, '003');
    assert.equal(meta.title, 'NOTA DE CRÉDITO');
  });
});

describe('renderMockInvoicePdfToBuffer', () => {
  it('produces a valid PDF buffer (>1KB, starts with %PDF) for an FA invoice', async () => {
    const buf = await renderMockInvoicePdfToBuffer(makeCtx());
    assert.ok(Buffer.isBuffer(buf), 'must return a Buffer');
    assert.ok(buf.length > 1024, `buffer too small: ${buf.length} bytes`);
    assert.equal(buf.subarray(0, 4).toString('ascii'), '%PDF');
  });

  it('produces a valid PDF buffer for a credit note derived from FA', async () => {
    const buf = await renderMockInvoicePdfToBuffer(
      makeCtx({ tx: makeTx({ invoiceDocType: 'FA' }), isCreditNote: true }),
    );
    assert.ok(buf.length > 1024);
    assert.equal(buf.subarray(0, 4).toString('ascii'), '%PDF');
  });
});

describe('renderMockInvoicePdfToDoc — watermark does not strand the flow cursor in the middle', () => {
  it('does not leave doc.y stuck around pageH/2 after rendering', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 28 });
    // Drain so PDFKit does not buffer indefinitely.
    doc.on('data', () => {});
    renderMockInvoicePdfToDoc(doc, makeCtx());
    const pageH = doc.page.height;
    // The previous bug rendered the watermark with `doc.text(..., 0, pageH/2)`,
    // which left the flow cursor anchored near the middle of the page and
    // compressed the body. With absolute positioning everywhere, the cursor
    // should track the last drawn element (the footer disclaimer near the
    // bottom). Assert it is NOT stranded in the middle band.
    const middleLo = pageH * 0.35;
    const middleHi = pageH * 0.65;
    assert.ok(
      doc.y < middleLo || doc.y > middleHi,
      `doc.y (${doc.y}) is in the middle band [${middleLo}, ${middleHi}] — ` +
        'a regression likely means the watermark used flow text and pushed the cursor down.',
    );
    doc.end();
  });
});
