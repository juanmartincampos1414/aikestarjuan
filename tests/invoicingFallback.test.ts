import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FacturitaError } from '../server/services/facturita';
import {
  isProviderConfigured,
  isSandboxMockForced,
  shouldUseSandboxMock,
  isMockFallbackEligible,
  checkCreditNoteProductionGuard,
  shouldUseMockForCreditNote,
  buildCreditNoteUpdatePatch,
  authorizeMockPdfAccess,
} from '../server/services/invoicingFallback';

const ORIG_API_KEY = process.env.FACTURITA_API_KEY;
const ORIG_FORCE = process.env.INVOICING_SANDBOX_MOCK;

beforeEach(() => {
  delete process.env.FACTURITA_API_KEY;
  delete process.env.INVOICING_SANDBOX_MOCK;
});
afterEach(() => {
  if (ORIG_API_KEY === undefined) delete process.env.FACTURITA_API_KEY;
  else process.env.FACTURITA_API_KEY = ORIG_API_KEY;
  if (ORIG_FORCE === undefined) delete process.env.INVOICING_SANDBOX_MOCK;
  else process.env.INVOICING_SANDBOX_MOCK = ORIG_FORCE;
});

describe('isProviderConfigured / isSandboxMockForced', () => {
  it('returns false by default and true when env vars are set', () => {
    assert.equal(isProviderConfigured(), false);
    assert.equal(isSandboxMockForced(), false);
    process.env.FACTURITA_API_KEY = 'abc';
    process.env.INVOICING_SANDBOX_MOCK = '1';
    assert.equal(isProviderConfigured(), true);
    assert.equal(isSandboxMockForced(), true);
  });
});

describe('shouldUseSandboxMock', () => {
  it('production NEVER uses the mock, regardless of env vars', () => {
    assert.equal(shouldUseSandboxMock('production'), false);
    process.env.INVOICING_SANDBOX_MOCK = '1';
    assert.equal(shouldUseSandboxMock('production'), false);
    process.env.FACTURITA_API_KEY = 'abc';
    assert.equal(shouldUseSandboxMock('production'), false);
    delete process.env.FACTURITA_API_KEY;
    assert.equal(shouldUseSandboxMock('production'), false);
  });

  it('sandbox uses the mock when no API key is configured', () => {
    assert.equal(shouldUseSandboxMock('sandbox'), true);
  });

  it('sandbox does NOT use the mock when API key is configured and not forced', () => {
    process.env.FACTURITA_API_KEY = 'abc';
    assert.equal(shouldUseSandboxMock('sandbox'), false);
  });

  it('sandbox uses the mock when explicitly forced even with API key', () => {
    process.env.FACTURITA_API_KEY = 'abc';
    process.env.INVOICING_SANDBOX_MOCK = '1';
    assert.equal(shouldUseSandboxMock('sandbox'), true);
  });
});

describe('isMockFallbackEligible', () => {
  it('production is NEVER eligible for mock fallback', () => {
    for (const status of [404, 500, 502, 503, 504]) {
      assert.equal(
        isMockFallbackEligible('production', new FacturitaError('x', { status })),
        false,
        `production should not fall back on ${status}`,
      );
    }
    assert.equal(
      isMockFallbackEligible('production', new FacturitaError('x', { code: 'NETWORK', status: 502 })),
      false,
    );
  });

  it('sandbox is eligible for NETWORK errors', () => {
    assert.equal(
      isMockFallbackEligible('sandbox', new FacturitaError('x', { code: 'NETWORK', status: 502 })),
      true,
    );
  });

  it('sandbox is eligible for 404/502/503/504', () => {
    for (const status of [404, 502, 503, 504]) {
      assert.equal(
        isMockFallbackEligible('sandbox', new FacturitaError('x', { status })),
        true,
        `sandbox should fall back on ${status}`,
      );
    }
  });

  it('sandbox is NOT eligible for non-fallback statuses', () => {
    for (const status of [400, 401, 403, 409, 422, 500]) {
      assert.equal(
        isMockFallbackEligible('sandbox', new FacturitaError('x', { status })),
        false,
        `sandbox should not fall back on ${status}`,
      );
    }
  });

  it('sandbox is NOT eligible for non-FacturitaError values', () => {
    assert.equal(isMockFallbackEligible('sandbox', new Error('boom')), false);
    assert.equal(isMockFallbackEligible('sandbox', 'string error'), false);
    assert.equal(isMockFallbackEligible('sandbox', null), false);
  });
});

describe('checkCreditNoteProductionGuard', () => {
  it('blocks cancellation of a simulated invoice in production with a 409', () => {
    const r = checkCreditNoteProductionGuard('production', true);
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.match(r.message ?? '', /modo de pruebas/);
  });

  it('allows real invoice cancellations in production', () => {
    assert.deepEqual(checkCreditNoteProductionGuard('production', false), { ok: true });
  });

  it('does not block sandbox at all', () => {
    assert.deepEqual(checkCreditNoteProductionGuard('sandbox', true), { ok: true });
    assert.deepEqual(checkCreditNoteProductionGuard('sandbox', false), { ok: true });
  });
});

describe('shouldUseMockForCreditNote', () => {
  it('production never uses the mock, even for simulated invoices', () => {
    assert.equal(shouldUseMockForCreditNote('production', true), false);
    assert.equal(shouldUseMockForCreditNote('production', false), false);
  });

  it('sandbox uses the mock when the original was simulated, regardless of API key', () => {
    process.env.FACTURITA_API_KEY = 'abc';
    assert.equal(shouldUseMockForCreditNote('sandbox', true), true);
  });

  it('sandbox uses the real provider for real invoices when API key is set', () => {
    process.env.FACTURITA_API_KEY = 'abc';
    assert.equal(shouldUseMockForCreditNote('sandbox', false), false);
  });

  it('sandbox falls back to mock for real invoices when no API key', () => {
    assert.equal(shouldUseMockForCreditNote('sandbox', false), true);
  });
});

describe('buildCreditNoteUpdatePatch', () => {
  it('always marks invoiceSimulated=true when the mock was used', () => {
    const patch = buildCreditNoteUpdatePatch('nc-uuid-1', true);
    assert.equal(patch.invoiceCreditNoteUuid, 'nc-uuid-1');
    assert.equal(patch.invoiceEmissionStatus, 'cancelled');
    assert.equal(patch.invoiceSimulated, true);
  });

  it('does NOT touch invoiceSimulated when the real provider was used', () => {
    const patch = buildCreditNoteUpdatePatch('nc-uuid-2', false);
    assert.equal(patch.invoiceCreditNoteUuid, 'nc-uuid-2');
    assert.equal(patch.invoiceEmissionStatus, 'cancelled');
    assert.ok(!('invoiceSimulated' in patch), 'invoiceSimulated must not be present');
  });
});

describe('authorizeMockPdfAccess', () => {
  const ORG = 'org-1';
  const OTHER_ORG = 'org-2';
  const validUuid = 'mock-abc_DEF-123';

  const baseTx = {
    organizationId: ORG,
    invoiceUuid: validUuid,
    invoiceCreditNoteUuid: null,
    invoiceSimulated: true,
  };

  it('rejects malformed/empty uuids with 400', () => {
    const badStrings: string[] = ['', 'has space', 'with/slash', 'has$dollar'];
    for (const bad of badStrings) {
      const r = authorizeMockPdfAccess(bad, baseTx, ORG);
      assert.equal(r.ok, false, `expected ${bad} to be rejected`);
      assert.equal(r.status, 400);
    }
    const undef = authorizeMockPdfAccess(undefined, baseTx, ORG);
    assert.equal(undef.ok, false);
    assert.equal(undef.status, 400);
    const nul = authorizeMockPdfAccess(null, baseTx, ORG);
    assert.equal(nul.ok, false);
    assert.equal(nul.status, 400);
  });

  it('returns 404 when the transaction is missing', () => {
    const r = authorizeMockPdfAccess(validUuid, null, ORG);
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  });

  it('rejects UUIDs from another organization with a generic 404 (no leak)', () => {
    const tx = { ...baseTx, organizationId: OTHER_ORG };
    const r = authorizeMockPdfAccess(validUuid, tx, ORG);
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.equal(r.message, 'Comprobante no encontrado');
  });

  it('rejects when the uuid does not match invoice or credit note on the tx', () => {
    const tx = { ...baseTx, invoiceUuid: 'someone-else', invoiceCreditNoteUuid: null };
    const r = authorizeMockPdfAccess(validUuid, tx, ORG);
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  });

  it('rejects non-simulated comprobantes with a generic 404', () => {
    const tx = { ...baseTx, invoiceSimulated: false };
    const r = authorizeMockPdfAccess(validUuid, tx, ORG);
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.equal(r.message, 'Comprobante no encontrado');
  });

  it('rejects when invoiceSimulated is null/undefined (treats as not simulated)', () => {
    const tx = { ...baseTx, invoiceSimulated: null };
    assert.equal(authorizeMockPdfAccess(validUuid, tx, ORG).ok, false);
    const tx2 = { ...baseTx, invoiceSimulated: undefined };
    assert.equal(authorizeMockPdfAccess(validUuid, tx2, ORG).ok, false);
  });

  it('allows access when uuid matches the invoice on a simulated tx in the same org', () => {
    const r = authorizeMockPdfAccess(validUuid, baseTx, ORG);
    assert.deepEqual(r, { ok: true });
  });

  it('allows access when uuid matches the credit-note uuid on a simulated tx', () => {
    const tx = {
      ...baseTx,
      invoiceUuid: 'orig-invoice-uuid',
      invoiceCreditNoteUuid: validUuid,
    };
    const r = authorizeMockPdfAccess(validUuid, tx, ORG);
    assert.deepEqual(r, { ok: true });
  });
});
