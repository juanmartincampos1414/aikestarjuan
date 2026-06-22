import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  normalizeInvoiceNumber,
  validateInvoiceNumber,
  INVOICE_NUMBER_FORMAT_ERROR,
} from '../client/src/components/transaction-wizard/utils';

// Mirror the schema used by client/src/pages/transactions.tsx so the cross-field
// validation rule for invoice numbers is exercised in unit tests.
const transactionBaseSchema = z.object({
  type: z.enum(['income', 'expense', 'payable', 'receivable']),
  amount: z.string().min(1, 'El monto es requerido'),
  description: z.string().min(3, 'La descripción es requerida'),
  category: z.string().min(1, 'La categoría es requerida'),
  accountId: z.string().min(1, 'La cuenta es requerida'),
  date: z.string(),
  hasInvoice: z.boolean().default(false),
  invoiceType: z.string().optional(),
  invoiceNumber: z.string().optional(),
});

const transactionSchema = transactionBaseSchema.superRefine((data, ctx) => {
  if (!data.hasInvoice) return;
  const raw = (data.invoiceNumber ?? '').trim();
  if (!raw) return;
  if (!validateInvoiceNumber(raw)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['invoiceNumber'],
      message: INVOICE_NUMBER_FORMAT_ERROR,
    });
  }
});

const baseValid = {
  type: 'income' as const,
  amount: '1000',
  description: 'Venta de prueba',
  category: 'Ventas',
  accountId: 'acc-1',
  date: '2026-04-22',
};

describe('transactions.tsx invoice helpers (re-exports)', () => {
  it('normalizeInvoiceNumber pads and trims like the shared helper', () => {
    assert.equal(normalizeInvoiceNumber('  1-1  '), '0001-00000001');
    assert.equal(normalizeInvoiceNumber('0001 - 00001234'), '0001-00001234');
    assert.equal(normalizeInvoiceNumber('0001–00001234'), '0001-00001234');
  });

  it('validateInvoiceNumber accepts canonical and normalizable inputs', () => {
    assert.equal(validateInvoiceNumber('0001-00001234'), true);
    assert.equal(validateInvoiceNumber('1-1'), true);
    assert.equal(validateInvoiceNumber('  0001-00001234  '), true);
  });

  it('validateInvoiceNumber rejects invalid inputs', () => {
    assert.equal(validateInvoiceNumber(''), false);
    assert.equal(validateInvoiceNumber('abc'), false);
    assert.equal(validateInvoiceNumber('0001/00001234'), false);
    assert.equal(validateInvoiceNumber('0001-1234ABCD'), false);
  });
});

describe('transactions.tsx form schema invoice cross-field validation', () => {
  it('passes when hasInvoice is false (invoice fields are ignored)', () => {
    const result = transactionSchema.safeParse({
      ...baseValid,
      hasInvoice: false,
      invoiceType: '',
      invoiceNumber: 'not-a-valid-number',
    });
    assert.equal(result.success, true);
  });

  it('passes when hasInvoice is true but invoiceNumber is empty (optional)', () => {
    const result = transactionSchema.safeParse({
      ...baseValid,
      hasInvoice: true,
      invoiceType: 'A',
      invoiceNumber: '',
    });
    assert.equal(result.success, true);
  });

  it('passes when hasInvoice is true and invoiceNumber has the canonical format', () => {
    const result = transactionSchema.safeParse({
      ...baseValid,
      hasInvoice: true,
      invoiceType: 'A',
      invoiceNumber: '0001-00001234',
    });
    assert.equal(result.success, true);
  });

  it('passes when invoiceNumber needs normalization but is valid after it', () => {
    const result = transactionSchema.safeParse({
      ...baseValid,
      hasInvoice: true,
      invoiceType: 'B',
      invoiceNumber: '  0001 - 00001234  ',
    });
    assert.equal(result.success, true);
  });

  it('fails with inline error when invoiceNumber is malformed', () => {
    const result = transactionSchema.safeParse({
      ...baseValid,
      hasInvoice: true,
      invoiceType: 'A',
      invoiceNumber: 'INVALID',
    });
    assert.equal(result.success, false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'invoiceNumber');
      assert.ok(issue, 'expected an issue on invoiceNumber');
      assert.equal(issue!.message, INVOICE_NUMBER_FORMAT_ERROR);
    }
  });

  it('fails when invoiceNumber has letters in the digit groups', () => {
    const result = transactionSchema.safeParse({
      ...baseValid,
      hasInvoice: true,
      invoiceType: 'A',
      invoiceNumber: '0001-1234ABCD',
    });
    assert.equal(result.success, false);
  });

  it('fails when invoiceNumber uses the wrong separator', () => {
    const result = transactionSchema.safeParse({
      ...baseValid,
      hasInvoice: true,
      invoiceType: 'A',
      invoiceNumber: '0001/00001234',
    });
    assert.equal(result.success, false);
  });
});
