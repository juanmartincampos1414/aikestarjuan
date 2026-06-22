import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCA_INVOICE_NUMBER_REGEX,
  normalizeArcaInvoiceNumber,
  isValidArcaInvoiceNumber,
} from '../shared/schema';

describe('normalizeArcaInvoiceNumber', () => {
  it('returns empty for null/undefined/empty', () => {
    assert.equal(normalizeArcaInvoiceNumber(undefined), '');
    assert.equal(normalizeArcaInvoiceNumber(null), '');
    assert.equal(normalizeArcaInvoiceNumber(''), '');
  });

  it('strips leading, trailing and internal whitespace', () => {
    assert.equal(normalizeArcaInvoiceNumber('  0001-00001234  '), '0001-00001234');
    assert.equal(normalizeArcaInvoiceNumber('0001 - 00001234'), '0001-00001234');
    assert.equal(normalizeArcaInvoiceNumber('00 01-000 012 34'), '0001-00001234');
    assert.equal(normalizeArcaInvoiceNumber('\t0001-00001234\n'), '0001-00001234');
  });

  it('pads with leading zeros when the user types a short numeric form', () => {
    assert.equal(normalizeArcaInvoiceNumber('1-1'), '0001-00000001');
    assert.equal(normalizeArcaInvoiceNumber('12-34'), '0012-00000034');
    assert.equal(normalizeArcaInvoiceNumber('1-12345678'), '0001-12345678');
  });

  it('does not pad when either side is too long', () => {
    assert.equal(normalizeArcaInvoiceNumber('00001-00000001'), '00001-00000001');
    assert.equal(normalizeArcaInvoiceNumber('0001-123456789'), '0001-123456789');
  });

  it('returns cleaned string when sides are not purely numeric', () => {
    assert.equal(normalizeArcaInvoiceNumber('A001-00001234'), 'A001-00001234');
    assert.equal(normalizeArcaInvoiceNumber('0001-1234ABCD'), '0001-1234ABCD');
  });

  it('normalizes en/em dashes to a regular hyphen', () => {
    assert.equal(normalizeArcaInvoiceNumber('0001–00001234'), '0001-00001234');
    assert.equal(normalizeArcaInvoiceNumber('0001—00001234'), '0001-00001234');
  });
});

describe('ARCA_INVOICE_NUMBER_REGEX', () => {
  it('matches the canonical PPPP-NNNNNNNN form', () => {
    assert.ok(ARCA_INVOICE_NUMBER_REGEX.test('0001-00001234'));
    assert.ok(ARCA_INVOICE_NUMBER_REGEX.test('9999-99999999'));
  });

  it('rejects malformed strings', () => {
    assert.equal(ARCA_INVOICE_NUMBER_REGEX.test('001-00001234'), false);
    assert.equal(ARCA_INVOICE_NUMBER_REGEX.test('0001-1234567'), false);
    assert.equal(ARCA_INVOICE_NUMBER_REGEX.test('0001 00001234'), false);
    assert.equal(ARCA_INVOICE_NUMBER_REGEX.test('A001-00001234'), false);
    assert.equal(ARCA_INVOICE_NUMBER_REGEX.test(''), false);
  });
});

describe('isValidArcaInvoiceNumber', () => {
  it('rejects null/undefined/empty (the helper requires a value)', () => {
    assert.equal(isValidArcaInvoiceNumber(undefined), false);
    assert.equal(isValidArcaInvoiceNumber(null), false);
    assert.equal(isValidArcaInvoiceNumber(''), false);
  });

  it('accepts the canonical format', () => {
    assert.equal(isValidArcaInvoiceNumber('0001-00001234'), true);
  });

  it('accepts inputs that are valid after normalization', () => {
    assert.equal(isValidArcaInvoiceNumber('  0001-00001234  '), true);
    assert.equal(isValidArcaInvoiceNumber('0001 - 00001234'), true);
    assert.equal(isValidArcaInvoiceNumber('1-1'), true);
    assert.equal(isValidArcaInvoiceNumber('12-345'), true);
  });

  it('rejects clearly invalid formats', () => {
    const cases = [
      'abc',
      '1234',
      '0001/00001234',
      '0001-1234ABCD',
      '00001-00000001',
      '0001-123456789',
      '-00001234',
      '0001-',
    ];
    for (const c of cases) {
      assert.equal(isValidArcaInvoiceNumber(c), false, `expected ${c} to be rejected`);
    }
  });
});
