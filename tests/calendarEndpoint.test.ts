import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Real DB-backed integration test for /api/transactions/calendar.
//
// We exercise the SAME route module the production server mounts
// (`registerTransactionRoutes`), the SAME storage instance (`server/storage`),
// and the SAME Drizzle queries against the real Postgres pointed to by
// DATABASE_URL. No filtering or bucketing logic is reimplemented in the test
// — rows are inserted via Drizzle and the assertions read whatever the real
// SQL + route returns.
//
// Only the auth-related storage methods are stubbed (getUser /
// getSubscriptionByUserId / getOrganizationOwner / getMembershipByUserAndOrg)
// so we don't need to seed a real subscription/membership row to pass
// requireAuth. The methods this test cares about
// (getTransactionsByOrganization, getAccountsByOrganization) remain the real
// production implementations.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run the calendar endpoint integration tests');
}

const { db } = await import('../server/db');
const { storage } = await import('../server/storage');
const { registerTransactionRoutes } = await import('../server/routes/transactions');
const { organizations, users, accounts, transactions } = await import('../shared/schema');
const { eq } = await import('drizzle-orm');

const ORG_NAME = `__test_calendar_org_${process.pid}_${Date.now()}`;
const USER_EMAIL = `__test_calendar_user_${process.pid}_${Date.now()}@example.test`;

let ORG_ID: string;
let USER_ID: string;
let ACC_ARS_ID: string;
let ACC_USD_ID: string;

const ORIG_STORAGE: Record<string, any> = {};

function stubAuthOnly() {
  const methods: Record<string, any> = {
    getUser: async (id: string) => (id === USER_ID ? { id: USER_ID, deletedAt: null } : null),
    getSubscriptionByUserId: async (_id: string) => ({ status: 'active' }),
    getOrganizationOwner: async (_org: string) => ({ id: USER_ID }),
    getMembershipByUserAndOrg: async (_u: string, _o: string) => ({
      role: 'owner', userId: USER_ID, organizationId: ORG_ID,
    }),
  };
  for (const [k, v] of Object.entries(methods)) {
    if (!(k in ORIG_STORAGE)) ORIG_STORAGE[k] = (storage as any)[k];
    (storage as any)[k] = v;
  }
}

let server: Server;
let baseUrl: string;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.session = {
      userId: USER_ID,
      organizationId: ORG_ID,
      destroy: (cb: any) => cb && cb(),
    };
    next();
  });
  registerTransactionRoutes(app);
  return app;
}

before(async () => {
  // Seed a dedicated user, organization, and two accounts. We use generated
  // ids so we can clean up exactly these rows in `after`.
  const [user] = await db.insert(users).values({
    email: USER_EMAIL,
    name: 'Test Calendar User',
    password: 'unused-test-password-hash',
  }).returning();
  USER_ID = user.id;

  const [org] = await db.insert(organizations).values({
    name: ORG_NAME,
    type: 'business',
    country: 'AR',
    defaultCurrency: 'ARS',
  }).returning();
  ORG_ID = org.id;

  const [accArs] = await db.insert(accounts).values({
    name: 'Caja ARS test',
    type: 'cash',
    currency: 'ARS',
    organizationId: ORG_ID,
  }).returning();
  ACC_ARS_ID = accArs.id;

  const [accUsd] = await db.insert(accounts).values({
    name: 'Caja USD test',
    type: 'cash',
    currency: 'USD',
    organizationId: ORG_ID,
  }).returning();
  ACC_USD_ID = accUsd.id;

  stubAuthOnly();
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
  // Cascade from organizations.id deletes accounts and transactions; then
  // remove the standalone user row. Restore monkey-patched storage methods.
  try { if (ORG_ID) await db.delete(organizations).where(eq(organizations.id, ORG_ID)); } catch {}
  try { if (USER_ID) await db.delete(users).where(eq(users.id, USER_ID)); } catch {}
  for (const [k, v] of Object.entries(ORIG_STORAGE)) (storage as any)[k] = v;
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  // Intentionally do NOT call pool.end() here: the pool is shared across the
  // process and ending it would break any other DB-backed test file that runs
  // in the same node:test run.
});

beforeEach(async () => {
  // Each test starts from an empty transactions table for our org.
  await db.delete(transactions).where(eq(transactions.organizationId, ORG_ID));
});

type TxSeed = {
  id?: string;
  type: 'income' | 'expense' | 'receivable' | 'payable' | 'transfer_in' | 'transfer_out';
  status?: 'completed' | 'scheduled' | 'cancelled';
  amount?: string;
  currency?: 'ARS' | 'USD';
  imputationDate: Date;
  accountId?: string;
  transferPairId?: string;
};

async function seedTx(rows: TxSeed[]) {
  await db.insert(transactions).values(
    rows.map(r => ({
      ...(r.id ? { id: r.id } : {}),
      type: r.type,
      amount: r.amount ?? '1000',
      currency: r.currency ?? 'ARS',
      description: `seed-${r.type}-${r.id ?? ''}`,
      category: 'test',
      date: r.imputationDate,
      imputationDate: r.imputationDate,
      accountId: r.accountId ?? ((r.currency ?? 'ARS') === 'USD' ? ACC_USD_ID : ACC_ARS_ID),
      organizationId: ORG_ID,
      status: r.status ?? 'completed',
      ...(r.transferPairId ? { transferPairId: r.transferPairId } : {}),
    })),
  );
}

async function getCalendar(qs: Record<string, string>) {
  const url = new URL(`${baseUrl}/api/transactions/calendar`);
  for (const [k, v] of Object.entries(qs)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  let json: any = {};
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}

// May 2026 in Argentina time (UTC-3): from 2026-05-01 00:00 ART (= 2026-05-01
// 03:00 UTC) to 2026-06-01 00:00 ART (= 2026-06-01 03:00 UTC), encoded as the
// inclusive end instant the client actually sends.
const MAY_START = '2026-05-01T03:00:00.000Z';
const MAY_END = '2026-06-01T02:59:59.999Z';

describe('GET /api/transactions/calendar — real DB integration', () => {
  it('buckets a normal mixed day with ARS+USD and excludes cancelled by default', async () => {
    await seedTx([
      { id: 't-inc-ars', type: 'income', amount: '1000', currency: 'ARS',
        imputationDate: new Date('2026-05-15T15:00:00Z') },
      { id: 't-exp-ars', type: 'expense', amount: '300', currency: 'ARS',
        imputationDate: new Date('2026-05-15T15:00:00Z') },
      { id: 't-inc-usd', type: 'income', amount: '50', currency: 'USD',
        imputationDate: new Date('2026-05-15T15:00:00Z') },
      { id: 't-cancelled', type: 'income', status: 'cancelled', amount: '999', currency: 'ARS',
        imputationDate: new Date('2026-05-15T15:00:00Z') },
      // Internal transfers must not show up in totals.
      { id: 't-tin', type: 'transfer_in', amount: '100', currency: 'ARS',
        imputationDate: new Date('2026-05-15T15:00:00Z') },
      { id: 't-tout', type: 'transfer_out', amount: '100', currency: 'ARS',
        imputationDate: new Date('2026-05-15T15:00:00Z') },
    ]);

    const { status, body } = await getCalendar({
      startDate: MAY_START, endDate: MAY_END, groupBy: 'day',
    });
    assert.equal(status, 200);
    const day = body.groupedByDay.find((d: any) => d.date === '2026-05-15');
    assert.ok(day, 'must have a 2026-05-15 bucket');
    assert.equal(day.totalIncomeARS, 1000, 'cancelled income must NOT be counted');
    assert.equal(day.totalIncomeUSD, 50);
    assert.equal(day.totalExpenseARS, 300);
    assert.equal(day.count, 3, 'live count excludes transfers and cancelled');
    assert.equal(day.cancelledCount, 0, 'cancelled not surfaced unless includeCancelled=1');
    // Transfers are surfaced in the day list under their own `transferCount`,
    // never inside `count`/totals. The orphan pair (no transferPairId) keeps
    // both legs as separate orphan entries → 2 transfer entries here.
    assert.equal(day.transferCount, 2, 'orphan transfers appear under transferCount, not count');
    assert.equal(body.summary.cancelledTransactions, 1);
    const ids = day.transactions.map((t: any) => t.id);
    assert.ok(!ids.includes('t-cancelled'), `cancelled tx must not appear; got ${JSON.stringify(ids)}`);
  });

  it('opt-in includeCancelled=true surfaces cancelled tx in the day list (still not in totals)', async () => {
    await seedTx([
      { id: 't-live', type: 'income', amount: '1000', currency: 'ARS',
        imputationDate: new Date('2026-05-10T15:00:00Z') },
      { id: 't-cx', type: 'income', status: 'cancelled', amount: '777', currency: 'ARS',
        imputationDate: new Date('2026-05-10T15:00:00Z') },
    ]);

    const { status, body } = await getCalendar({
      startDate: MAY_START, endDate: MAY_END, groupBy: 'day', includeCancelled: '1',
    });
    assert.equal(status, 200);
    const day = body.groupedByDay.find((d: any) => d.date === '2026-05-10');
    assert.ok(day);
    assert.equal(day.totalIncomeARS, 1000, 'cancelled never counts towards money totals');
    assert.equal(day.cancelledCount, 1);
    assert.ok(day.transactions.some((t: any) => t.id === 't-cx'));
  });

  it('end-of-month ART boundary: April 30 23:59 ART (= May 1 02:59 UTC) stays in April, not May', async () => {
    // The whole point of this test: a UTC-naive filter would push this tx
    // into May because its underlying instant is "2026-05-01 02:59 UTC". The
    // calendar must keep it in April because in Argentina time it's still
    // April 30. This regression would only surface in the real SQL filter
    // (gte/lte against COALESCE(imputation_date, date)) plus the route's
    // Argentina-time bucketing.
    const lateApril = new Date('2026-05-01T02:59:00.000Z'); // = 2026-04-30 23:59 ART
    await seedTx([
      { id: 't-april-late', type: 'income', amount: '1234', currency: 'ARS',
        imputationDate: lateApril },
      { id: 't-may-1st', type: 'income', amount: '5', currency: 'ARS',
        imputationDate: new Date('2026-05-01T15:00:00Z') },
    ]);

    const may = await getCalendar({ startDate: MAY_START, endDate: MAY_END, groupBy: 'day' });
    assert.equal(may.status, 200);
    const dates = may.body.groupedByDay.map((d: any) => d.date);
    assert.ok(!dates.includes('2026-04-30'), 'April 30 must not appear in the May calendar');
    assert.ok(!may.body.groupedByDay.some((d: any) =>
      d.transactions.some((t: any) => t.id === 't-april-late')),
      'late-April tx must not leak into May');
    const mayDay = may.body.groupedByDay.find((d: any) => d.date === '2026-05-01');
    assert.ok(mayDay);
    assert.equal(mayDay.totalIncomeARS, 5, 'only the May 1 tx counts in May');

    // And the same tx DOES belong to April when we ask for April.
    const APR_START = '2026-04-01T03:00:00.000Z';
    const APR_END = '2026-05-01T02:59:59.999Z';
    const apr = await getCalendar({ startDate: APR_START, endDate: APR_END, groupBy: 'day' });
    assert.equal(apr.status, 200);
    const aprDay = apr.body.groupedByDay.find((d: any) => d.date === '2026-04-30');
    assert.ok(aprDay, 'late-April tx must appear under 2026-04-30');
    assert.equal(aprDay.totalIncomeARS, 1234);
  });

  it('surfaces scheduled receivables/payables as pending* without double-counting', async () => {
    await seedTx([
      { id: 't-recv', type: 'receivable', status: 'scheduled', amount: '700', currency: 'ARS',
        imputationDate: new Date('2026-05-20T15:00:00Z') },
      { id: 't-pay', type: 'payable', status: 'scheduled', amount: '200', currency: 'USD',
        imputationDate: new Date('2026-05-20T15:00:00Z') },
    ]);

    const { status, body } = await getCalendar({
      startDate: MAY_START, endDate: MAY_END, groupBy: 'day',
    });
    assert.equal(status, 200);
    const day = body.groupedByDay.find((d: any) => d.date === '2026-05-20');
    assert.ok(day);
    assert.equal(day.pendingReceivableARS, 700);
    assert.equal(day.pendingPayableUSD, 200);
    assert.equal(day.totalIncomeARS, 0, 'a scheduled receivable is NOT income yet');
    assert.equal(day.pendingCount, 2);
    assert.equal(day.hasPending, true);
  });

  it('orphanTransfers === 0 when both legs share transferPairId and live in the queried window', async () => {
    const pairId = `pair-ok-${Date.now()}`;
    await seedTx([
      { id: 't-out-ok', type: 'transfer_out', amount: '500', currency: 'ARS',
        accountId: ACC_ARS_ID, transferPairId: pairId,
        imputationDate: new Date('2026-05-12T15:00:00Z') },
      { id: 't-in-ok', type: 'transfer_in', amount: '500', currency: 'ARS',
        accountId: ACC_USD_ID, transferPairId: pairId,
        imputationDate: new Date('2026-05-12T15:00:00Z') },
    ]);

    const { status, body } = await getCalendar({
      startDate: MAY_START, endDate: MAY_END, groupBy: 'day',
    });
    assert.equal(status, 200);
    assert.equal(body.summary.orphanTransfers, 0,
      'a complete pair within the window must NOT count as orphan');
    // The pair is deduped to a single transfer entry.
    assert.equal(body.summary.transferTransactions, 1,
      'a complete pair must be deduped to one transfer entry');
    const day = body.groupedByDay.find((d: any) => d.date === '2026-05-12');
    assert.ok(day);
    assert.equal(day.transferCount, 1, 'deduped pair shows once in the day list');
  });

  it('a legacy pair without transferPairId surfaces BOTH legs as orphans', async () => {
    await seedTx([
      { id: 't-out-legacy', type: 'transfer_out', amount: '200', currency: 'ARS',
        accountId: ACC_ARS_ID,
        imputationDate: new Date('2026-05-14T15:00:00Z') },
      { id: 't-in-legacy', type: 'transfer_in', amount: '200', currency: 'ARS',
        accountId: ACC_USD_ID,
        imputationDate: new Date('2026-05-14T15:00:00Z') },
    ]);

    const { status, body } = await getCalendar({
      startDate: MAY_START, endDate: MAY_END, groupBy: 'day',
    });
    assert.equal(status, 200);
    assert.equal(body.summary.orphanTransfers, 2,
      'both legacy legs (no transferPairId) must be flagged as orphans');
    const day = body.groupedByDay.find((d: any) => d.date === '2026-05-14');
    assert.ok(day);
    assert.equal(day.transferCount, 2,
      'legacy orphans appear individually in the day list, not deduped');
  });

  it('one leg in the window with the counterpart OUTSIDE the window is NOT an orphan', async () => {
    // The transfer happened in late April (transfer_out) and the counterpart
    // (transfer_in) clears on May 5. When we query May only the in-leg is in
    // the result set, but the route must look up the missing counterpart in
    // the DB and confirm the pair is complete → not an orphan.
    const pairId = `pair-cross-month-${Date.now()}`;
    await seedTx([
      { id: 't-out-april', type: 'transfer_out', amount: '750', currency: 'ARS',
        accountId: ACC_ARS_ID, transferPairId: pairId,
        imputationDate: new Date('2026-04-28T15:00:00Z') },
      { id: 't-in-may', type: 'transfer_in', amount: '750', currency: 'ARS',
        accountId: ACC_USD_ID, transferPairId: pairId,
        imputationDate: new Date('2026-05-05T15:00:00Z') },
    ]);

    const { status, body } = await getCalendar({
      startDate: MAY_START, endDate: MAY_END, groupBy: 'day',
    });
    assert.equal(status, 200);
    assert.equal(body.summary.orphanTransfers, 0,
      'a single in-window leg whose counterpart exists outside the window is NOT an orphan');
  });

  it('a single leg with NO counterpart anywhere in the org is an orphan', async () => {
    const pairId = `pair-truly-orphan-${Date.now()}`;
    await seedTx([
      { id: 't-out-only', type: 'transfer_out', amount: '900', currency: 'ARS',
        accountId: ACC_ARS_ID, transferPairId: pairId,
        imputationDate: new Date('2026-05-18T15:00:00Z') },
    ]);

    const { status, body } = await getCalendar({
      startDate: MAY_START, endDate: MAY_END, groupBy: 'day',
    });
    assert.equal(status, 200);
    assert.equal(body.summary.orphanTransfers, 1,
      'a lone leg with no counterpart anywhere in the org must be flagged as orphan');
    const day = body.groupedByDay.find((d: any) => d.date === '2026-05-18');
    assert.ok(day);
    assert.equal(day.transferCount, 1);
  });

  it('a cancelled counterpart does NOT save the pair from being orphan', async () => {
    // The counterpart row exists in the DB but is cancelled — the helper must
    // ignore cancelled counterparts because they no longer move money. The
    // surviving leg is therefore an orphan.
    const pairId = `pair-cx-counterpart-${Date.now()}`;
    await seedTx([
      { id: 't-out-live', type: 'transfer_out', amount: '420', currency: 'ARS',
        accountId: ACC_ARS_ID, transferPairId: pairId,
        imputationDate: new Date('2026-05-22T15:00:00Z') },
      { id: 't-in-cancelled', type: 'transfer_in', status: 'cancelled', amount: '420', currency: 'ARS',
        accountId: ACC_USD_ID, transferPairId: pairId,
        imputationDate: new Date('2026-05-22T15:00:00Z') },
    ]);

    const { status, body } = await getCalendar({
      startDate: MAY_START, endDate: MAY_END, groupBy: 'day',
    });
    assert.equal(status, 200);
    assert.equal(body.summary.orphanTransfers, 1,
      'a cancelled counterpart leaves the live leg as an orphan');
  });

  // ---------------------------------------------------------------------
  // Orphan-transfer coverage for `groupBy=month` and the default (no
  // groupBy) flat response. The `groupBy=day` path above already covers
  // the three orphan scenarios — these tests guarantee the SAME counts
  // are surfaced by the other two response shapes, so a future refactor
  // of the summary-building code can't silently drop the field on either
  // format.
  // ---------------------------------------------------------------------

  it('groupBy=month — legacy pair without transferPairId surfaces both legs as orphans', async () => {
    await seedTx([
      { id: 't-out-legacy-m', type: 'transfer_out', amount: '200', currency: 'ARS',
        accountId: ACC_ARS_ID,
        imputationDate: new Date('2026-05-14T15:00:00Z') },
      { id: 't-in-legacy-m', type: 'transfer_in', amount: '200', currency: 'ARS',
        accountId: ACC_USD_ID,
        imputationDate: new Date('2026-05-14T15:00:00Z') },
    ]);

    const { status, body } = await getCalendar({
      startDate: MAY_START, endDate: MAY_END, groupBy: 'month',
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.groupedByMonth), 'month view returns groupedByMonth array');
    assert.equal(body.summary.orphanTransfers, 2,
      'month view must report both legacy legs as orphans');
  });

  it('groupBy=month — a lone leg with no counterpart anywhere is an orphan', async () => {
    const pairId = `pair-truly-orphan-month-${Date.now()}`;
    await seedTx([
      { id: 't-out-only-m', type: 'transfer_out', amount: '900', currency: 'ARS',
        accountId: ACC_ARS_ID, transferPairId: pairId,
        imputationDate: new Date('2026-05-18T15:00:00Z') },
    ]);

    const { status, body } = await getCalendar({
      startDate: MAY_START, endDate: MAY_END, groupBy: 'month',
    });
    assert.equal(status, 200);
    assert.equal(body.summary.orphanTransfers, 1,
      'month view must flag a lone leg with no counterpart as orphan');
  });

  it('groupBy=month — a cross-month pair (counterpart outside window) is NOT an orphan', async () => {
    const pairId = `pair-cross-month-mview-${Date.now()}`;
    await seedTx([
      { id: 't-out-april-m', type: 'transfer_out', amount: '750', currency: 'ARS',
        accountId: ACC_ARS_ID, transferPairId: pairId,
        imputationDate: new Date('2026-04-28T15:00:00Z') },
      { id: 't-in-may-m', type: 'transfer_in', amount: '750', currency: 'ARS',
        accountId: ACC_USD_ID, transferPairId: pairId,
        imputationDate: new Date('2026-05-05T15:00:00Z') },
    ]);

    const { status, body } = await getCalendar({
      startDate: MAY_START, endDate: MAY_END, groupBy: 'month',
    });
    assert.equal(status, 200);
    assert.equal(body.summary.orphanTransfers, 0,
      'month view must not flag a single in-window leg whose counterpart exists outside as orphan');
  });

  it('default response (no groupBy) — legacy pair without transferPairId surfaces both legs as orphans', async () => {
    await seedTx([
      { id: 't-out-legacy-d', type: 'transfer_out', amount: '200', currency: 'ARS',
        accountId: ACC_ARS_ID,
        imputationDate: new Date('2026-05-14T15:00:00Z') },
      { id: 't-in-legacy-d', type: 'transfer_in', amount: '200', currency: 'ARS',
        accountId: ACC_USD_ID,
        imputationDate: new Date('2026-05-14T15:00:00Z') },
    ]);

    const { status, body } = await getCalendar({
      startDate: MAY_START, endDate: MAY_END,
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.transactions), 'default response returns flat transactions array');
    assert.equal(body.summary.orphanTransfers, 2,
      'default response must report both legacy legs as orphans');
  });

  it('default response (no groupBy) — a lone leg with no counterpart anywhere is an orphan', async () => {
    const pairId = `pair-truly-orphan-default-${Date.now()}`;
    await seedTx([
      { id: 't-out-only-d', type: 'transfer_out', amount: '900', currency: 'ARS',
        accountId: ACC_ARS_ID, transferPairId: pairId,
        imputationDate: new Date('2026-05-18T15:00:00Z') },
    ]);

    const { status, body } = await getCalendar({
      startDate: MAY_START, endDate: MAY_END,
    });
    assert.equal(status, 200);
    assert.equal(body.summary.orphanTransfers, 1,
      'default response must flag a lone leg with no counterpart as orphan');
  });

  it('default response (no groupBy) — a cross-month pair (counterpart outside window) is NOT an orphan', async () => {
    const pairId = `pair-cross-month-default-${Date.now()}`;
    await seedTx([
      { id: 't-out-april-d', type: 'transfer_out', amount: '750', currency: 'ARS',
        accountId: ACC_ARS_ID, transferPairId: pairId,
        imputationDate: new Date('2026-04-28T15:00:00Z') },
      { id: 't-in-may-d', type: 'transfer_in', amount: '750', currency: 'ARS',
        accountId: ACC_USD_ID, transferPairId: pairId,
        imputationDate: new Date('2026-05-05T15:00:00Z') },
    ]);

    const { status, body } = await getCalendar({
      startDate: MAY_START, endDate: MAY_END,
    });
    assert.equal(status, 200);
    assert.equal(body.summary.orphanTransfers, 0,
      'default response must not flag a single in-window leg whose counterpart exists outside as orphan');
  });

  // --------------------------------------------------------------------
  // Parity between the calendar banner counter and the dedicated
  // /orphan-transfers listing endpoint (Task #177).
  // The third "done looks like" criterion of task #177 is:
  //   "El contador del banner del calendario coincide con la cantidad
  //    listada en esa vista".
  // Both endpoints must apply the SAME exclusion rules so users never
  // see "Hay 5 transferencias huérfanas" in the banner and then land on
  // the listing showing only 3.
  // --------------------------------------------------------------------
  async function getOrphanList() {
    const res = await fetch(`${baseUrl}/api/transactions/orphan-transfers`);
    let json: any = {};
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: json };
  }

  it('parity: legacy pair without transferPairId shows the same count in both endpoints', async () => {
    await seedTx([
      { id: 't-out-parity-legacy', type: 'transfer_out', amount: '200', currency: 'ARS',
        accountId: ACC_ARS_ID,
        imputationDate: new Date('2026-05-14T15:00:00Z') },
      { id: 't-in-parity-legacy', type: 'transfer_in', amount: '200', currency: 'ARS',
        accountId: ACC_USD_ID,
        imputationDate: new Date('2026-05-14T15:00:00Z') },
    ]);

    const { body: cal } = await getCalendar({ startDate: MAY_START, endDate: MAY_END });
    const { body: list } = await getOrphanList();
    assert.equal(cal.summary.orphanTransfers, list.orphans.length,
      'banner count must equal the listed orphan rows');
    assert.equal(list.orphans.length, 2);
  });

  it('parity: a [CANCELACIÓN] mirror row must NOT inflate the banner count', async () => {
    // Repro of the bug fixed in task #177: when a user cancels an orphan
    // transfer through the standard delete flow, storage.deleteTransaction
    // hard-deletes the original and inserts a `[CANCELACIÓN]` mirror row of
    // type transfer_in/transfer_out with NO transferPairId. The listing
    // endpoint already excludes those mirrors via `isCancellationEntry` —
    // the calendar banner counter must do the same so the two views agree.
    // We seed a single orphan AND a stand-alone `[CANCELACIÓN]` mirror to
    // simulate the post-cancel state without invoking the full delete flow.
    await db.insert(transactions).values([
      {
        type: 'transfer_out', amount: '350', currency: 'ARS',
        description: 'real orphan that will stay listed',
        category: 'Transferencia Interna',
        date: new Date('2026-05-10T15:00:00Z'),
        imputationDate: new Date('2026-05-10T15:00:00Z'),
        accountId: ACC_ARS_ID,
        organizationId: ORG_ID,
        status: 'completed',
        assetType: 'transfer',
      },
      {
        type: 'transfer_in', amount: '999', currency: 'ARS',
        description: '[CANCELACIÓN] cancelled transfer mirror — must be ignored',
        category: 'Transferencia Interna',
        date: new Date('2026-05-11T15:00:00Z'),
        imputationDate: new Date('2026-05-11T15:00:00Z'),
        accountId: ACC_ARS_ID,
        organizationId: ORG_ID,
        status: 'completed',
        assetType: 'transfer',
        originalTransactionData: JSON.stringify({ id: 'previously-cancelled' }),
      },
    ]);

    const { body: cal } = await getCalendar({ startDate: MAY_START, endDate: MAY_END });
    const { body: list } = await getOrphanList();

    assert.equal(list.orphans.length, 1,
      'listing endpoint already excludes [CANCELACIÓN] mirrors');
    assert.equal(cal.summary.orphanTransfers, list.orphans.length,
      'calendar banner counter must match the listing — [CANCELACIÓN] mirrors must NOT inflate it');
  });

  it('groupBy=month aggregates the same May data into a single 2026-05 bucket', async () => {
    await seedTx([
      { id: 'm-1', type: 'income', amount: '1000', currency: 'ARS',
        imputationDate: new Date('2026-05-02T15:00:00Z') },
      { id: 'm-2', type: 'income', amount: '500', currency: 'ARS',
        imputationDate: new Date('2026-05-25T15:00:00Z') },
      { id: 'm-3', type: 'receivable', status: 'scheduled', amount: '300', currency: 'ARS',
        imputationDate: new Date('2026-05-30T15:00:00Z') },
    ]);

    const { status, body } = await getCalendar({
      startDate: MAY_START, endDate: MAY_END, groupBy: 'month',
    });
    assert.equal(status, 200);
    assert.equal(body.groupedByMonth.length, 1);
    const m = body.groupedByMonth[0];
    assert.equal(m.month, '2026-05');
    assert.equal(m.totalIncomeARS, 1500);
    assert.equal(m.pendingReceivableARS, 300);
  });
});
