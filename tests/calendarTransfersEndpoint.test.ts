import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { storage } from '../server/storage';
import { calendarHandler } from '../server/routes/transactions';

// Real-endpoint integration test for `GET /api/transactions/calendar`.
//
// We mount the SAME exported `calendarHandler` the production route uses on a
// tiny Express server. The auth/subscription middleware is intentionally
// stubbed (it is covered by other integration tests and would require a full
// session + Stripe subscription fixture that has nothing to do with the
// calendar's transfer-deduplication contract). All data is created through
// the real `storage` module against the real database, so the handler runs
// the actual SQL filter (`getTransactionsByOrganization` with `dateField:
// 'imputation'`) and the actual deduplication code path used in production.
//
// This guards the four properties the unit tests in
// `tests/calendarBucketing.test.ts` simulate in isolation:
//   (a) one entry per transfer pair in `groupedByDay[].transactions`
//   (b) day totals do NOT include the transfer amount
//   (c) `transferCount` and `summary.transferTransactions` are correct
//   (d) cancelled transfer pairs do not surface in the day list

let server: Server;
let baseUrl: string;
let organizationId: string;
let cajaId: string;
let bancoId: string;

const DAY_ISO = '2026-04-15T15:00:00.000Z'; // 12:00 ART -> day key 2026-04-15
const RANGE_START = '2026-04-01T03:00:00.000Z'; // 00:00 ART
const RANGE_END = '2026-05-01T02:59:59.999Z'; // 23:59:59.999 ART of last day

before(async () => {
  const org = await storage.createOrganization({
    name: `calendar-transfers-test-${Date.now()}`,
    type: 'business',
    country: 'AR',
    defaultCurrency: 'ARS',
  });
  organizationId = org.id;

  const caja = await storage.createAccount({
    name: 'Caja Test',
    type: 'cash',
    currency: 'ARS',
    balance: '0',
    organizationId,
  });
  cajaId = caja.id;

  const banco = await storage.createAccount({
    name: 'Banco Test',
    type: 'bank',
    currency: 'ARS',
    balance: '0',
    organizationId,
  });
  bancoId = banco.id;

  // Live transfer pair: caja -> banco, 1000 ARS
  const livePairId = `pair-live-${Date.now()}`;
  await storage.createTransaction({
    type: 'transfer_out',
    amount: '1000',
    currency: 'ARS',
    description: 'Transferencia Caja -> Banco',
    category: 'Transferencia',
    date: new Date(DAY_ISO),
    imputationDate: new Date(DAY_ISO),
    accountId: cajaId,
    organizationId,
    status: 'completed',
    transferPairId: livePairId,
  });
  await storage.createTransaction({
    type: 'transfer_in',
    amount: '1000',
    currency: 'ARS',
    description: 'Transferencia Caja -> Banco',
    category: 'Transferencia',
    date: new Date(DAY_ISO),
    imputationDate: new Date(DAY_ISO),
    accountId: bancoId,
    organizationId,
    status: 'completed',
    transferPairId: livePairId,
  });

  // Cancelled transfer pair: must NOT appear in the day list at all.
  const cancelledPairId = `pair-cancelled-${Date.now()}`;
  await storage.createTransaction({
    type: 'transfer_out',
    amount: '999',
    currency: 'ARS',
    description: 'Transferencia anulada',
    category: 'Transferencia',
    date: new Date(DAY_ISO),
    imputationDate: new Date(DAY_ISO),
    accountId: cajaId,
    organizationId,
    status: 'cancelled',
    transferPairId: cancelledPairId,
  });
  await storage.createTransaction({
    type: 'transfer_in',
    amount: '999',
    currency: 'ARS',
    description: 'Transferencia anulada',
    category: 'Transferencia',
    date: new Date(DAY_ISO),
    imputationDate: new Date(DAY_ISO),
    accountId: bancoId,
    organizationId,
    status: 'cancelled',
    transferPairId: cancelledPairId,
  });

  // One real income on the same day, so we can verify totals are NOT
  // contaminated by the transfer amount.
  await storage.createTransaction({
    type: 'income',
    amount: '5000',
    currency: 'ARS',
    description: 'Venta del día',
    category: 'Ventas',
    date: new Date(DAY_ISO),
    imputationDate: new Date(DAY_ISO),
    accountId: cajaId,
    organizationId,
    status: 'completed',
  });

  const app = express();
  app.use((req: any, _res, next) => {
    // Stub the auth layer the same way the real `requireAuth` would: by the
    // time the handler runs, `req.organizationId` is the only thing it reads.
    req.organizationId = organizationId;
    next();
  });
  app.get('/api/transactions/calendar', calendarHandler);

  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>(resolve => server?.close(() => resolve()));
  if (organizationId) {
    // Cascade deletes the accounts and the transactions we created.
    await storage.deleteOrganization(organizationId);
  }
});

async function getCalendar(query: Record<string, string>): Promise<{ status: number; body: any }> {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${baseUrl}/api/transactions/calendar?${qs}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

describe('GET /api/transactions/calendar — transfer surfacing (integration with real storage)', () => {
  it('returns ONE entry per transfer pair in groupedByDay[].transactions (deduped)', async () => {
    const { status, body } = await getCalendar({
      startDate: RANGE_START,
      endDate: RANGE_END,
      groupBy: 'day',
    });
    assert.equal(status, 200);
    const day = body.groupedByDay.find((d: any) => d.date === '2026-04-15');
    assert.ok(day, 'expected a bucket for 2026-04-15');
    const transferRows = day.transactions.filter(
      (t: any) => t.type === 'transfer_in' || t.type === 'transfer_out',
    );
    // Live pair surfaces as ONE entry (the canonical transfer_out side).
    // The cancelled pair must be dropped entirely.
    assert.equal(transferRows.length, 1, 'one transfer entry per pair, cancelled excluded');
    const transferRow = transferRows[0];
    assert.equal(transferRow.type, 'transfer_out', 'transfer_out is preferred as the canonical side');
    assert.equal(transferRow.amount, '1000.00');
    assert.equal(transferRow.transferCounterpart?.account?.name, 'Banco Test',
      'the destination account is exposed as transferCounterpart so the UI can render "origen → destino"');
  });

  it('does NOT include the transfer amount in the day money totals', async () => {
    const { body } = await getCalendar({
      startDate: RANGE_START,
      endDate: RANGE_END,
      groupBy: 'day',
    });
    const day = body.groupedByDay.find((d: any) => d.date === '2026-04-15');
    assert.ok(day);
    // Only the 5000 ARS income — never +1000 from the transfer, never -1000.
    assert.equal(day.totalIncomeARS, 5000);
    assert.equal(day.totalExpenseARS, 0);
    assert.equal(day.totalIncomeUSD, 0);
    assert.equal(day.totalExpenseUSD, 0);
    // `count` is the live (non-transfer, non-cancelled) tx count: just the income.
    assert.equal(day.count, 1, 'transfers do not inflate the live count');
  });

  it('reports transferCount per day and summary.transferTransactions correctly', async () => {
    const { body } = await getCalendar({
      startDate: RANGE_START,
      endDate: RANGE_END,
      groupBy: 'day',
    });
    const day = body.groupedByDay.find((d: any) => d.date === '2026-04-15');
    assert.ok(day);
    // 1 live pair = 1 transferCount on the day; the cancelled pair is dropped.
    assert.equal(day.transferCount, 1);
    // Summary mirrors the day-level counter.
    assert.equal(body.summary.transferTransactions, 1);
    // Real money totals stay clean of transfer noise.
    assert.equal(body.summary.totalIncome, 5000);
    assert.equal(body.summary.totalExpense, 0);
  });

  it('drops cancelled transfer pairs from the day list entirely', async () => {
    const { body } = await getCalendar({
      startDate: RANGE_START,
      endDate: RANGE_END,
      groupBy: 'day',
    });
    const day = body.groupedByDay.find((d: any) => d.date === '2026-04-15');
    assert.ok(day);
    // No tx in the day list should reference the cancelled pair amount (999)
    // nor have status 'cancelled' for a transfer type.
    const cancelledTransferLeak = day.transactions.find(
      (t: any) => (t.type === 'transfer_in' || t.type === 'transfer_out') && t.status === 'cancelled',
    );
    assert.equal(cancelledTransferLeak, undefined,
      'cancelled transfers must not surface in the day list, even when includeCancelled is off');
    const wrongAmountLeak = day.transactions.find(
      (t: any) => (t.type === 'transfer_in' || t.type === 'transfer_out') && t.amount === '999.00',
    );
    assert.equal(wrongAmountLeak, undefined, 'cancelled transfer amount (999) must not leak through');
  });
});
