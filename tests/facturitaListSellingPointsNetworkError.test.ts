import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { listSellingPoints, FacturitaError } from '../server/services/facturita';

const ORIG_API_KEY = process.env.FACTURITA_API_KEY;
const ORIG_BASE = process.env.FACTURITA_BASE_URL_PROD;
const ORIG_BASE_TEST = process.env.FACTURITA_BASE_URL_TEST;
const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.FACTURITA_API_KEY = 'test-key';
  process.env.FACTURITA_BASE_URL_PROD = 'https://api-prod.example';
  process.env.FACTURITA_BASE_URL_TEST = 'https://api-test.example';
});

afterEach(() => {
  if (ORIG_API_KEY === undefined) delete process.env.FACTURITA_API_KEY;
  else process.env.FACTURITA_API_KEY = ORIG_API_KEY;
  if (ORIG_BASE === undefined) delete process.env.FACTURITA_BASE_URL_PROD;
  else process.env.FACTURITA_BASE_URL_PROD = ORIG_BASE;
  if (ORIG_BASE_TEST === undefined) delete process.env.FACTURITA_BASE_URL_TEST;
  else process.env.FACTURITA_BASE_URL_TEST = ORIG_BASE_TEST;
  globalThis.fetch = realFetch;
});

const ctx = {
  cuit: '20345343122',
  environment: 'production' as const,
  emitterIvaCondition: 'monotributo' as const,
};

describe('listSellingPoints — regression: no fabricated PV on network error', () => {
  it('propagates NETWORK error in production instead of returning a fake PV 1', async () => {
    // @ts-expect-error: stub fetch to simulate a transient network failure.
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };

    await assert.rejects(
      () => listSellingPoints(ctx),
      (err: unknown) => {
        assert.ok(err instanceof FacturitaError, 'should reject with FacturitaError');
        assert.equal((err as FacturitaError).code, 'NETWORK');
        return true;
      },
    );
  });

  it('propagates NETWORK error in sandbox too (let the route decide mock fallback)', async () => {
    // @ts-expect-error: stub fetch
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const sandboxCtx = { ...ctx, environment: 'sandbox' as const };

    await assert.rejects(
      () => listSellingPoints(sandboxCtx),
      (err: unknown) => err instanceof FacturitaError && (err as FacturitaError).code === 'NETWORK',
    );
  });

  it('still returns [] on a real 404 from the provider (CUIT unknown)', async () => {
    // @ts-expect-error: stub fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });

    const result = await listSellingPoints(ctx);
    assert.deepEqual(result, []);
  });

  it('returns the real PV list when the provider responds OK', async () => {
    // @ts-expect-error: stub fetch
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify([
          { id: 10, selling_point: 4, business_name: 'Casa Central', status: 'active' },
          { id: 11, selling_point: 7, address: 'Sucursal Norte', status: 'inactive' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const result = await listSellingPoints(ctx);
    assert.equal(result.length, 2);
    assert.equal(result[0].number, 4);
    assert.equal(result[0].active, true);
    assert.equal(result[1].number, 7);
    assert.equal(result[1].active, false);
    assert.ok(!result.some((sp) => sp.number === 1), 'must NOT contain a synthetic PV 1');
  });
});
