import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  parseTransactionInsertBody,
  parseTransactionUpdateBody,
  respondIfInvalid,
} from '../server/routes/transactionValidation';
import { INVOICE_NUMBER_FORMAT_MESSAGE } from '../shared/schema';

// True endpoint integration test: we mount the SAME validation factory
// (`parseTransactionInsertBody` / `parseTransactionUpdateBody` /
// `respondIfInvalid`) that the production `/api/transactions` POST and
// PATCH routes use, on a real Express server, and exercise it over HTTP
// with the global `fetch`. Auth/storage middlewares are stubbed because
// validation runs before them in the real route too — any change to the
// shared validation factory will be caught here without requiring a
// database connection.

function buildApp() {
  const app = express();
  app.use(express.json());

  app.post('/api/transactions', (req, res) => {
    const { allowOverdraft: _ignored, ...bodyData } = req.body || {};
    const parsed = parseTransactionInsertBody(bodyData);
    if (respondIfInvalid(res, parsed)) return;
    res.json({ success: true, data: parsed.data });
  });

  app.patch('/api/transactions/:id', (req, res) => {
    const parsed = parseTransactionUpdateBody(req.body);
    if (respondIfInvalid(res, parsed)) return;
    res.json({ success: true, data: parsed.data });
  });

  return app;
}

let server: Server;
let baseUrl: string;

before(async () => {
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
  await new Promise<void>(resolve => server.close(() => resolve()));
});

const validBody = {
  type: 'income',
  amount: '100',
  description: 'Venta',
  category: 'Ventas',
  date: '2026-01-15',
  imputationDate: '2026-01-15',
  status: 'completed',
};

async function postTx(body: any) {
  const res = await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as any };
}

async function patchTx(body: any) {
  const res = await fetch(`${baseUrl}/api/transactions/abc-123`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as any };
}

describe('POST /api/transactions invoiceNumber validation (integration)', () => {
  it('accepts a transaction with a canonical invoice number', async () => {
    const { status, body } = await postTx({ ...validBody, hasInvoice: true, invoiceNumber: '0001-00001234' });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.invoiceNumber, '0001-00001234');
  });

  it('accepts a transaction without an invoice', async () => {
    const { status } = await postTx({ ...validBody, hasInvoice: false });
    assert.equal(status, 200);
  });

  it('rejects shorthand "1-1" with HTTP 400 + clear message', async () => {
    const { status, body } = await postTx({ ...validBody, hasInvoice: true, invoiceNumber: '1-1' });
    assert.equal(status, 400);
    assert.equal(body.field, 'invoiceNumber');
    assert.equal(body.message, INVOICE_NUMBER_FORMAT_MESSAGE);
  });

  it('rejects whitespace-padded invoice numbers', async () => {
    const { status, body } = await postTx({ ...validBody, hasInvoice: true, invoiceNumber: ' 0001-00001234 ' });
    assert.equal(status, 400);
    assert.equal(body.field, 'invoiceNumber');
    assert.equal(body.message, INVOICE_NUMBER_FORMAT_MESSAGE);
  });

  it('rejects obviously malformed invoice numbers', async () => {
    const { status, body } = await postTx({ ...validBody, hasInvoice: true, invoiceNumber: 'no-es-un-numero' });
    assert.equal(status, 400);
    assert.equal(body.field, 'invoiceNumber');
  });

  it('rejects extra digits beyond PPPP-NNNNNNNN', async () => {
    const { status, body } = await postTx({ ...validBody, hasInvoice: true, invoiceNumber: '00001-00001234' });
    assert.equal(status, 400);
    assert.equal(body.field, 'invoiceNumber');
  });

  it('does not validate invoice format when hasInvoice is false', async () => {
    const { status } = await postTx({ ...validBody, hasInvoice: false, invoiceNumber: 'lo-que-sea' });
    assert.equal(status, 200);
  });

  it('cannot be bypassed by spoofing invoiceVoucherId in the payload', async () => {
    // A malicious caller tries to forge `invoiceVoucherId` to convince the
    // server the invoice is ARCA-emitted and skip the format check. The
    // payload schema strips that field, so the bad invoiceNumber is still
    // rejected.
    const { status, body } = await postTx({
      ...validBody,
      hasInvoice: true,
      invoiceNumber: 'totally-bogus',
      invoiceVoucherId: 'forged-by-attacker',
    });
    assert.equal(status, 400);
    assert.equal(body.field, 'invoiceNumber');
    assert.equal(body.message, INVOICE_NUMBER_FORMAT_MESSAGE);
  });

  it('strips client-provided invoiceVoucherId on accepted requests', async () => {
    const { status, body } = await postTx({
      ...validBody,
      hasInvoice: true,
      invoiceNumber: '0001-00001234',
      invoiceVoucherId: 'forged-by-attacker',
    });
    assert.equal(status, 200);
    assert.equal(body.data.invoiceVoucherId, undefined);
  });
});

describe('PATCH /api/transactions/:id invoiceNumber validation (integration)', () => {
  it('accepts a canonical invoice number', async () => {
    const { status } = await patchTx({ invoiceNumber: '0001-00001234' });
    assert.equal(status, 200);
  });

  it('rejects shorthand updates with HTTP 400 + clear message', async () => {
    const { status, body } = await patchTx({ invoiceNumber: '1-1' });
    assert.equal(status, 400);
    assert.equal(body.field, 'invoiceNumber');
    assert.equal(body.message, INVOICE_NUMBER_FORMAT_MESSAGE);
  });

  it('rejects whitespace-padded values on update', async () => {
    const { status, body } = await patchTx({ invoiceNumber: ' 0001-00001234 ' });
    assert.equal(status, 400);
    assert.equal(body.field, 'invoiceNumber');
  });

  it('accepts clearing the invoice number with null', async () => {
    const { status } = await patchTx({ invoiceNumber: null });
    assert.equal(status, 200);
  });
});
