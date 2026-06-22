import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInvoicingError } from '../server/routes/invoicing';
import { FacturitaError } from '../server/services/facturita';

describe('classifyInvoicingError — 400/422 emit bifurcation', () => {
  it('treats "Unknown field" as schema-shape error and returns friendly fallback (not verbatim)', () => {
    const err = new FacturitaError('json: {"external_reference":["Unknown field."]}', {
      status: 400,
    });
    const { code, message } = classifyInvoicingError(err, 'emit');
    assert.equal(code, 'VALIDATION');
    assert.ok(
      !/Unknown field/i.test(message),
      `friendly fallback must not leak "Unknown field"; got: ${message}`,
    );
    assert.ok(
      !/external_reference/i.test(message),
      `friendly fallback must not leak the raw key; got: ${message}`,
    );
    assert.ok(
      !/[\{\[]/.test(message),
      `friendly fallback must not contain raw JSON braces; got: ${message}`,
    );
  });

  it('treats a pure JSON-shaped string as schema-shape error', () => {
    const err = new FacturitaError('{"items":[{"unit_price":"required"}]}', {
      status: 422,
    });
    const { code, message } = classifyInvoicingError(err, 'emit');
    assert.equal(code, 'VALIDATION');
    assert.ok(!/[\{\[]/.test(message));
    assert.ok(!/unit_price/i.test(message));
  });

  it('treats "missing required field" wording as schema-shape error', () => {
    const err = new FacturitaError('Missing required field: invoice_type', { status: 422 });
    const { code, message } = classifyInvoicingError(err, 'emit');
    assert.equal(code, 'VALIDATION');
    assert.ok(!/invoice_type/i.test(message));
  });

  it('surfaces actionable Spanish validation message verbatim (after brand scrub) for 400', () => {
    const raw = 'Ítem 1: unit_price 999999 supera el máximo permitido para monotributistas (613492)';
    const err = new FacturitaError(raw, { status: 400 });
    const { code, message } = classifyInvoicingError(err, 'emit');
    assert.equal(code, 'VALIDATION');
    assert.equal(message, raw);
  });

  it('surfaces actionable Spanish validation message verbatim for 422', () => {
    const raw = 'buyer_iva inválido para condición Responsable Inscripto';
    const err = new FacturitaError(raw, { status: 422 });
    const { code, message } = classifyInvoicingError(err, 'emit');
    assert.equal(code, 'VALIDATION');
    assert.equal(message, raw);
  });

  it('scrubs brand mentions from verbatim validation messages', () => {
    const err = new FacturitaError('Facturita rechazó el item: cantidad inválida', { status: 422 });
    const { code, message } = classifyInvoicingError(err, 'emit');
    assert.equal(code, 'VALIDATION');
    assert.ok(!/facturit/i.test(message), `brand must be scrubbed; got: ${message}`);
    assert.ok(/ARCA/.test(message));
  });

  it('400 emit without raw message falls through to generic handler (no schema-shape branch)', () => {
    const err = new FacturitaError('', { status: 400 });
    const { code, message } = classifyInvoicingError(err, 'emit');
    assert.equal(code, 'GENERIC');
    assert.ok(typeof message === 'string' && message.length > 0);
    assert.ok(!/[\{\[]/.test(message));
  });

  it('422 emit without raw message falls through to generic handler', () => {
    const err = new FacturitaError('', { status: 422 });
    const { code, message } = classifyInvoicingError(err, 'emit');
    assert.equal(code, 'GENERIC');
    assert.ok(typeof message === 'string' && message.length > 0);
    assert.ok(!/[\{\[]/.test(message));
  });

  it('does not apply the 400/422 emit bifurcation outside of emit context', () => {
    const err = new FacturitaError('Unknown field "external_reference"', { status: 400 });
    const { message } = classifyInvoicingError(err, 'sync');
    assert.ok(
      !/No se pudo emitir la factura electrónica/.test(message),
      'sync context should not get the emit-specific friendly fallback',
    );
  });
});
