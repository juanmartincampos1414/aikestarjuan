import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scrubFacturitaResponseForLog } from '../server/services/facturita';

describe('scrubFacturitaResponseForLog', () => {
  it('returns { value: null } for null/undefined input', () => {
    assert.deepEqual(scrubFacturitaResponseForLog(null), { value: null });
    assert.deepEqual(scrubFacturitaResponseForLog(undefined), { value: null });
  });

  it('wraps primitives in { value }', () => {
    assert.deepEqual(scrubFacturitaResponseForLog('boom'), { value: 'boom' });
    assert.deepEqual(scrubFacturitaResponseForLog(42), { value: 42 });
    assert.deepEqual(scrubFacturitaResponseForLog(false), { value: false });
  });

  it('preserves typical BAD_RESPONSE payload fields', () => {
    const raw = {
      status: 'PENDING',
      fk_invoice_id: 12345,
      price: 4810.5,
      message: 'CAE no disponible aún',
      credit_note_uuid: '',
      cae: null,
    };
    const out = scrubFacturitaResponseForLog(raw);
    assert.equal(out.status, 'PENDING');
    assert.equal(out.fk_invoice_id, 12345);
    assert.equal(out.price, 4810.5);
    assert.equal(out.message, 'CAE no disponible aún');
    assert.equal(out.credit_note_uuid, '');
    assert.equal(out.cae, null);
  });

  it('redacts credential-like keys at the top level', () => {
    const raw = {
      credit_note_uuid: 'abc',
      api_key: 'sk_live_xxxxx',
      'X-API-KEY': 'sk_live_yyyyy',
      authorization: 'Bearer abc',
      token: 't',
      secret: 's',
      password: 'p',
      clave_fiscal: 'CF123',
    };
    const out = scrubFacturitaResponseForLog(raw);
    assert.equal(out.credit_note_uuid, 'abc');
    assert.equal(out.api_key, '[REDACTED]');
    assert.equal(out['X-API-KEY'], '[REDACTED]');
    assert.equal(out.authorization, '[REDACTED]');
    assert.equal(out.token, '[REDACTED]');
    assert.equal(out.secret, '[REDACTED]');
    assert.equal(out.password, '[REDACTED]');
    assert.equal(out.clave_fiscal, '[REDACTED]');
  });

  it('redacts credential-like keys one level deep', () => {
    const raw = {
      provider: { name: 'facturitas', apiKey: 'sk_xxx', api_key: 'sk_yyy' },
    };
    const out = scrubFacturitaResponseForLog(raw) as any;
    assert.equal(out.provider.name, 'facturitas');
    assert.equal(out.provider.apiKey, '[REDACTED]');
    assert.equal(out.provider.api_key, '[REDACTED]');
  });

  it('truncates very long strings to avoid blowing up audit_logs', () => {
    const huge = 'x'.repeat(5000);
    const out = scrubFacturitaResponseForLog({ html: huge }) as any;
    assert.ok(out.html.endsWith('…[truncated]'));
    assert.ok(out.html.length < 5000);
  });

  it('caps arrays at 50 items and scrubs each element', () => {
    const raw = {
      items: Array.from({ length: 100 }, (_, i) => ({ idx: i, api_key: 'leak' })),
    };
    const out = scrubFacturitaResponseForLog(raw) as any;
    assert.equal(out.items.length, 50);
    assert.equal(out.items[0].idx, 0);
    assert.equal(out.items[0].api_key, '[REDACTED]');
  });

  it('drops deeply nested objects to [object] to bound size', () => {
    const raw = { wrap: { deep: { even_deeper: { a: 1 } } } };
    const out = scrubFacturitaResponseForLog(raw) as any;
    assert.equal(out.wrap.deep, '[object]');
  });

  it('produces JSON.stringify-able output', () => {
    const raw = { credit_note_uuid: '', status: 'X', cae: null, nested: { a: 1 } };
    const out = scrubFacturitaResponseForLog(raw);
    assert.doesNotThrow(() => JSON.stringify(out));
  });
});
