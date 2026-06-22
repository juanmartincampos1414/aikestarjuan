import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  isInvoicingServerEnabled,
  requireInvoicingEnabled,
} from '../server/routes/invoicing';

// Integration tests for the server-side `INVOICING_ENABLED` feature flag.
// We mount the same `requireInvoicingEnabled` middleware used by the real
// invoicing routes onto a tiny Express app and exercise it under both
// flag states. The middleware is the single chokepoint that gates every
// mutation/provider-call endpoint, so testing it in isolation is enough
// to guarantee the server stays "off" when the env var is unset.

function buildApp() {
  const app = express();
  app.use(express.json());

  // Stand-ins for the real protected endpoints. They do not require auth
  // here on purpose: the feature-flag middleware runs first in the real
  // routes and must reject unconditionally regardless of credentials.
  const handler = (_req: any, res: any) => res.status(200).json({ ok: true });

  app.put('/api/invoicing/account', requireInvoicingEnabled, handler);
  app.post('/api/invoicing/validate-cuit', requireInvoicingEnabled, handler);
  app.post('/api/invoicing/signup', requireInvoicingEnabled, handler);
  app.post('/api/invoicing/deactivate', requireInvoicingEnabled, handler);
  app.post('/api/invoicing/selling-points/sync', requireInvoicingEnabled, handler);
  app.post('/api/invoicing/transactions/:id/emit', requireInvoicingEnabled, handler);
  app.post('/api/invoicing/transactions/:id/send-pdf', requireInvoicingEnabled, handler);
  app.post('/api/invoicing/transactions/:id/credit-note', requireInvoicingEnabled, handler);

  // Read-only / historical endpoints stay open even when the flag is OFF
  // (intentional decision documented in replit.md). We don't gate them
  // with the middleware to mirror what the real routes do.
  app.get('/api/invoicing/account', handler);
  app.get('/api/invoicing/invoices', handler);
  app.get('/api/invoicing/mock-pdf/:uuid', handler);

  return app;
}

let server: Server;
let baseUrl: string;
let originalFlag: string | undefined;

before(async () => {
  originalFlag = process.env.INVOICING_ENABLED;
  const app = buildApp();
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  if (originalFlag === undefined) {
    delete process.env.INVOICING_ENABLED;
  } else {
    process.env.INVOICING_ENABLED = originalFlag;
  }
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  delete process.env.INVOICING_ENABLED;
});

afterEach(() => {
  delete process.env.INVOICING_ENABLED;
});

async function call(method: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : '{}',
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as any };
}

describe('isInvoicingServerEnabled()', () => {
  it('returns false when INVOICING_ENABLED is unset', () => {
    delete process.env.INVOICING_ENABLED;
    assert.equal(isInvoicingServerEnabled(), false);
  });

  it('returns false when INVOICING_ENABLED is set to "false"', () => {
    process.env.INVOICING_ENABLED = 'false';
    assert.equal(isInvoicingServerEnabled(), false);
  });

  it('returns false for any truthy-ish value other than "true"', () => {
    for (const v of ['1', 'yes', 'TRUE', 'on', '']) {
      process.env.INVOICING_ENABLED = v;
      assert.equal(isInvoicingServerEnabled(), false, `value=${JSON.stringify(v)}`);
    }
  });

  it('returns true only when INVOICING_ENABLED is exactly "true"', () => {
    process.env.INVOICING_ENABLED = 'true';
    assert.equal(isInvoicingServerEnabled(), true);
  });
});

describe('Server-side INVOICING_ENABLED gate — flag OFF (default)', () => {
  const writeEndpoints: { method: string; path: string }[] = [
    { method: 'PUT', path: '/api/invoicing/account' },
    { method: 'POST', path: '/api/invoicing/validate-cuit' },
    { method: 'POST', path: '/api/invoicing/signup' },
    { method: 'POST', path: '/api/invoicing/deactivate' },
    { method: 'POST', path: '/api/invoicing/selling-points/sync' },
    { method: 'POST', path: '/api/invoicing/transactions/tx-1/emit' },
    { method: 'POST', path: '/api/invoicing/transactions/tx-1/send-pdf' },
    { method: 'POST', path: '/api/invoicing/transactions/tx-1/credit-note' },
  ];

  for (const { method, path } of writeEndpoints) {
    it(`responds 403 with explanatory message on ${method} ${path}`, async () => {
      const r = await call(method, path);
      assert.equal(r.status, 403);
      assert.equal(r.body.message, 'Facturación electrónica deshabilitada');
    });
  }

  it('keeps GET /api/invoicing/account accessible (status check)', async () => {
    const r = await call('GET', '/api/invoicing/account');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  it('keeps GET /api/invoicing/invoices accessible (historical listing)', async () => {
    const r = await call('GET', '/api/invoicing/invoices');
    assert.equal(r.status, 200);
  });

  it('keeps GET /api/invoicing/mock-pdf/:uuid accessible (view prior simulated PDFs)', async () => {
    const r = await call('GET', '/api/invoicing/mock-pdf/some-uuid');
    assert.equal(r.status, 200);
  });
});

describe('Server-side INVOICING_ENABLED gate — flag ON', () => {
  beforeEach(() => {
    process.env.INVOICING_ENABLED = 'true';
  });

  const writeEndpoints: { method: string; path: string }[] = [
    { method: 'PUT', path: '/api/invoicing/account' },
    { method: 'POST', path: '/api/invoicing/validate-cuit' },
    { method: 'POST', path: '/api/invoicing/signup' },
    { method: 'POST', path: '/api/invoicing/deactivate' },
    { method: 'POST', path: '/api/invoicing/selling-points/sync' },
    { method: 'POST', path: '/api/invoicing/transactions/tx-1/emit' },
    { method: 'POST', path: '/api/invoicing/transactions/tx-1/send-pdf' },
    { method: 'POST', path: '/api/invoicing/transactions/tx-1/credit-note' },
  ];

  for (const { method, path } of writeEndpoints) {
    it(`forwards ${method} ${path} to the handler (200 OK)`, async () => {
      const r = await call(method, path);
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
    });
  }
});
