import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  insertTransactionSchema,
  updateTransactionSchema,
  INVOICE_NUMBER_FORMAT_MESSAGE,
} from '../shared/schema';

const baseValidTx = {
  organizationId: 'org-1',
  type: 'income',
  amount: '100',
  description: 'Venta',
  category: 'Ventas',
  date: '2026-01-15',
  imputationDate: '2026-01-15',
  status: 'completed',
};

function findInvoiceIssue(err: z.ZodError) {
  return err.errors.find(e => e.path?.[0] === 'invoiceNumber');
}

describe('insertTransactionSchema invoiceNumber format', () => {
  it('accepts a transaction without an invoice', () => {
    insertTransactionSchema.parse({ ...baseValidTx, hasInvoice: false });
  });

  it('accepts hasInvoice with no invoiceNumber yet', () => {
    insertTransactionSchema.parse({ ...baseValidTx, hasInvoice: true });
  });

  it('accepts the canonical PPPP-NNNNNNNN form', () => {
    const parsed = insertTransactionSchema.parse({
      ...baseValidTx,
      hasInvoice: true,
      invoiceNumber: '0001-00001234',
    });
    assert.equal(parsed.invoiceNumber, '0001-00001234');
  });

  it('rejects ANY surrounding whitespace (strict raw match)', () => {
    for (const invoiceNumber of [' 0001-00001234', '0001-00001234 ', '  0001-00001234  ']) {
      const result = insertTransactionSchema.safeParse({
        ...baseValidTx,
        hasInvoice: true,
        invoiceNumber,
      });
      assert.equal(result.success, false, `expected "${invoiceNumber}" to be rejected`);
      if (!result.success) {
        assert.equal(findInvoiceIssue(result.error)!.message, INVOICE_NUMBER_FORMAT_MESSAGE);
      }
    }
  });

  it('rejects shorthand and partially-padded numbers', () => {
    const cases = ['1-1', '01-1', '0001-1', '0001 - 00001234', '00 01-000 012 34'];
    for (const invoiceNumber of cases) {
      const result = insertTransactionSchema.safeParse({
        ...baseValidTx,
        hasInvoice: true,
        invoiceNumber,
      });
      assert.equal(result.success, false, `expected ${invoiceNumber} to be rejected`);
    }
  });

  it('rejects clearly malformed strings', () => {
    const cases = ['abc', '1234', '0001/00001234', '0001-1234ABCD', '0001-123456789', '00001-00000001'];
    for (const invoiceNumber of cases) {
      const result = insertTransactionSchema.safeParse({
        ...baseValidTx,
        hasInvoice: true,
        invoiceNumber,
      });
      assert.equal(result.success, false, `expected ${invoiceNumber} to be rejected`);
    }
  });

  it('does not validate the format when hasInvoice is false', () => {
    insertTransactionSchema.parse({
      ...baseValidTx,
      hasInvoice: false,
      invoiceNumber: 'garbage',
    });
  });

  it('treats null/empty invoiceNumber as not-provided', () => {
    insertTransactionSchema.parse({
      ...baseValidTx,
      hasInvoice: true,
      invoiceNumber: null,
    });
    insertTransactionSchema.parse({
      ...baseValidTx,
      hasInvoice: true,
      invoiceNumber: '',
    });
  });
});

describe('updateTransactionSchema invoiceNumber format', () => {
  it('accepts updates that do not touch invoiceNumber', () => {
    updateTransactionSchema.parse({ description: 'updated' });
  });

  it('accepts a canonical invoice number on update', () => {
    updateTransactionSchema.parse({ invoiceNumber: '0001-00001234' });
  });

  it('rejects shorthand on update', () => {
    const result = updateTransactionSchema.safeParse({ invoiceNumber: '1-1' });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(findInvoiceIssue(result.error)!.message, INVOICE_NUMBER_FORMAT_MESSAGE);
    }
  });

  it('rejects whitespace-padded invoice numbers on update', () => {
    const result = updateTransactionSchema.safeParse({ invoiceNumber: ' 0001-00001234 ' });
    assert.equal(result.success, false);
  });

  it('accepts clearing the invoice number with null or empty string', () => {
    updateTransactionSchema.parse({ invoiceNumber: null });
    updateTransactionSchema.parse({ invoiceNumber: '' });
  });

  it('rejects malformed invoice numbers on update', () => {
    const cases = ['abc', '0001/00001234', '0001-1234ABCD', '00001-00000001'];
    for (const invoiceNumber of cases) {
      const result = updateTransactionSchema.safeParse({ invoiceNumber });
      assert.equal(result.success, false, `expected ${invoiceNumber} to be rejected`);
      if (!result.success) {
        assert.equal(findInvoiceIssue(result.error)!.message, INVOICE_NUMBER_FORMAT_MESSAGE);
      }
    }
  });
});
