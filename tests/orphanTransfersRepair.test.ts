import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Real DB-backed integration test for the orphan-transfer endpoints
// (Tasks #173 + #178). Mounts the production route module
// (`registerTransactionRoutes`), the production storage instance, and uses
// real Drizzle queries against DATABASE_URL. Only auth-related storage
// methods are stubbed so we can pass `requireAuth` without seeding a real
// subscription/membership/user-permission graph.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run the orphan-transfer integration tests');
}

const { db } = await import('../server/db');
const { storage } = await import('../server/storage');
const { registerTransactionRoutes } = await import('../server/routes/transactions');
const { organizations, users, accounts, transactions } = await import('../shared/schema');
const { eq } = await import('drizzle-orm');

const ORG_NAME = `__test_orphan_org_${process.pid}_${Date.now()}`;
const USER_EMAIL = `__test_orphan_user_${process.pid}_${Date.now()}@example.test`;

let ORG_ID: string;
let USER_ID: string;
let ACC_A_ID: string;
let ACC_B_ID: string;

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
  const [user] = await db.insert(users).values({
    email: USER_EMAIL,
    name: 'Test Orphan User',
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

  const [accA] = await db.insert(accounts).values({
    name: 'Caja ARS A',
    type: 'bank',
    currency: 'ARS',
    balance: '0',
    organizationId: ORG_ID,
  }).returning();
  ACC_A_ID = accA.id;

  const [accB] = await db.insert(accounts).values({
    name: 'Caja ARS B',
    type: 'bank',
    currency: 'ARS',
    balance: '0',
    organizationId: ORG_ID,
  }).returning();
  ACC_B_ID = accB.id;

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
  try { if (ORG_ID) await db.delete(organizations).where(eq(organizations.id, ORG_ID)); } catch {}
  try { if (USER_ID) await db.delete(users).where(eq(users.id, USER_ID)); } catch {}
  for (const [k, v] of Object.entries(ORIG_STORAGE)) (storage as any)[k] = v;
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(async () => {
  await db.delete(transactions).where(eq(transactions.organizationId, ORG_ID));
  // Reset both account balances to 0 between tests so balance assertions are
  // independent.
  await db.update(accounts).set({ balance: '0' }).where(eq(accounts.id, ACC_A_ID));
  await db.update(accounts).set({ balance: '0' }).where(eq(accounts.id, ACC_B_ID));
});

async function getOrphans() {
  const res = await fetch(`${baseUrl}/api/transactions/orphan-transfers`);
  const body = await res.json();
  return { status: res.status, body };
}

async function repair(id: string, payload: any) {
  const res = await fetch(`${baseUrl}/api/transactions/orphan-transfers/${id}/repair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body: any = {};
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function repairBatch(items: any[]) {
  const res = await fetch(`${baseUrl}/api/transactions/orphan-transfers/repair-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  let body: any = {};
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function seedOrphan(opts: {
  type: 'transfer_in' | 'transfer_out';
  accountId: string;
  amount?: string;
  withPairId?: boolean;
  initialBalance?: number;
}) {
  // Initial balance reflects the orphan's effect (so the repair tests can
  // assert balance changes from a meaningful starting point).
  const amount = opts.amount ?? '500';
  const startingBalance = opts.initialBalance
    ?? (opts.type === 'transfer_in' ? parseFloat(amount) : -parseFloat(amount));
  await db.update(accounts)
    .set({ balance: String(startingBalance) })
    .where(eq(accounts.id, opts.accountId));

  const [row] = await db.insert(transactions).values({
    type: opts.type,
    amount,
    currency: 'ARS',
    description: `seed-orphan-${opts.type}`,
    category: 'Transferencia Interna',
    date: new Date(),
    imputationDate: new Date(),
    accountId: opts.accountId,
    organizationId: ORG_ID,
    status: 'completed',
    transferPairId: opts.withPairId ? crypto.randomUUID() : null,
    assetType: 'transfer',
  }).returning();
  return row;
}

async function getBalance(accountId: string): Promise<number> {
  const acc = await storage.getAccount(accountId);
  return acc ? parseFloat(acc.balance.toString()) : NaN;
}

describe('GET /api/transactions/orphan-transfers — listing', () => {
  it('returns rows with no transferPairId as orphans', async () => {
    const row = await seedOrphan({ type: 'transfer_out', accountId: ACC_A_ID, amount: '100' });
    const { status, body } = await getOrphans();
    assert.equal(status, 200);
    assert.equal(body.orphans.length, 1);
    assert.equal(body.orphans[0].id, row.id);
    assert.equal(body.orphans[0].reason, 'no_pair_id');
    assert.equal(body.orphans[0].accountName, 'Caja ARS A');
  });

  it('returns single-leg pairs (transferPairId set, counterpart missing) as orphans', async () => {
    const row = await seedOrphan({ type: 'transfer_in', accountId: ACC_B_ID, amount: '300', withPairId: true });
    const { body } = await getOrphans();
    const found = body.orphans.find((o: any) => o.id === row.id);
    assert.ok(found, 'single-leg pair must be reported');
    assert.equal(found.reason, 'missing_counterpart_leg');
  });

  it('does NOT return paired transfers (both legs present)', async () => {
    const pairId = crypto.randomUUID();
    await db.insert(transactions).values([
      {
        type: 'transfer_out', amount: '700', currency: 'ARS',
        description: 'leg-out', category: 'Transferencia Interna',
        date: new Date(), imputationDate: new Date(),
        accountId: ACC_A_ID, organizationId: ORG_ID, status: 'completed',
        transferPairId: pairId, assetType: 'transfer',
      },
      {
        type: 'transfer_in', amount: '700', currency: 'ARS',
        description: 'leg-in', category: 'Transferencia Interna',
        date: new Date(), imputationDate: new Date(),
        accountId: ACC_B_ID, organizationId: ORG_ID, status: 'completed',
        transferPairId: pairId, assetType: 'transfer',
      },
    ]);
    const { body } = await getOrphans();
    assert.equal(body.orphans.length, 0, 'a fully-paired transfer must not be orphan');
  });

  it('does NOT return cancelled rows as orphans', async () => {
    await db.insert(transactions).values({
      type: 'transfer_in', amount: '500', currency: 'ARS',
      description: 'cancelled-leg', category: 'Transferencia Interna',
      date: new Date(), imputationDate: new Date(),
      accountId: ACC_A_ID, organizationId: ORG_ID, status: 'cancelled',
      transferPairId: null, assetType: 'transfer',
    });
    const { body } = await getOrphans();
    assert.equal(body.orphans.length, 0);
  });
});

describe('POST /api/transactions/orphan-transfers/:id/repair — create_pair', () => {
  it('creates the missing counterpart leg, links both via transferPairId, and adjusts the counterpart account balance', async () => {
    // Orphan transfer_out of 200 from account A. Account A balance starts at -200 (the orphan's effect).
    const orphan = await seedOrphan({ type: 'transfer_out', accountId: ACC_A_ID, amount: '200' });
    const balanceB_before = await getBalance(ACC_B_ID);

    const { status, body } = await repair(orphan.id, {
      action: 'create_pair',
      counterpartAccountId: ACC_B_ID,
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.action, 'create_pair');
    assert.ok(body.transferPairId, 'response must include the shared pair id');
    assert.ok(body.counterpart?.id, 'response must include the created counterpart row');
    assert.equal(body.counterpart.type, 'transfer_in', 'counterpart of transfer_out must be transfer_in');
    assert.equal(body.counterpart.accountId, ACC_B_ID);
    assert.equal(parseFloat(body.counterpart.amount), 200);

    // The orphan now has a transferPairId.
    const orphanAfter = await storage.getTransaction(orphan.id);
    assert.equal(orphanAfter?.transferPairId, body.transferPairId);

    // Counterpart account B credited by 200.
    const balanceB_after = await getBalance(ACC_B_ID);
    assert.equal(balanceB_after - balanceB_before, 200, 'transfer_in must add 200 to account B');

    // Listing the orphans again must NOT include this row.
    const { body: listAfter } = await getOrphans();
    assert.equal(listAfter.orphans.find((o: any) => o.id === orphan.id), undefined,
      'repaired orphan must disappear from the orphan list');
  });

  it('rejects create_pair with same account', async () => {
    const orphan = await seedOrphan({ type: 'transfer_in', accountId: ACC_A_ID, amount: '50' });
    const { status, body } = await repair(orphan.id, {
      action: 'create_pair',
      counterpartAccountId: ACC_A_ID,
    });
    assert.equal(status, 400);
    assert.match(body.message, /distinta/i);
  });

  it('rejects create_pair when counterpartAccountId is missing', async () => {
    const orphan = await seedOrphan({ type: 'transfer_out', accountId: ACC_A_ID, amount: '120' });
    const balanceA_before = await getBalance(ACC_A_ID);
    const balanceB_before = await getBalance(ACC_B_ID);

    const { status, body } = await repair(orphan.id, { action: 'create_pair' });
    assert.equal(status, 400, JSON.stringify(body));
    assert.match(body.message, /contraparte/i);

    // No side-effect: orphan untouched, balances untouched.
    const after = await storage.getTransaction(orphan.id);
    assert.equal(after?.transferPairId, null, 'orphan must NOT receive a transferPairId on rejection');
    assert.equal(await getBalance(ACC_A_ID), balanceA_before);
    assert.equal(await getBalance(ACC_B_ID), balanceB_before);
  });

  it('rejects create_pair when counterpart account currency does not match', async () => {
    // Spin up a USD account in the same org just for this test, and clean it
    // up at the end so the rest of the suite stays unaffected.
    const [usdAcc] = await db.insert(accounts).values({
      name: 'Caja USD', type: 'bank', currency: 'USD',
      balance: '0', organizationId: ORG_ID,
    }).returning();
    try {
      const orphan = await seedOrphan({ type: 'transfer_in', accountId: ACC_A_ID, amount: '90' });
      const { status, body } = await repair(orphan.id, {
        action: 'create_pair',
        counterpartAccountId: usdAcc.id,
      });
      assert.equal(status, 400, JSON.stringify(body));
      assert.match(body.message, /misma moneda/i);

      // Currency-mismatch must NOT create a counterpart row anywhere.
      const all = await storage.getTransactionsByOrganization(ORG_ID);
      const transferLegs = all.filter(t => t.type === 'transfer_in' || t.type === 'transfer_out');
      assert.equal(transferLegs.length, 1, 'no counterpart leg may be created when currencies mismatch');
    } finally {
      await db.delete(accounts).where(eq(accounts.id, usdAcc.id));
    }
  });
});

describe('POST /api/transactions/orphan-transfers/:id/repair — convert_to_regular', () => {
  it('converts a transfer_in into an income with no balance change (natural mapping)', async () => {
    const orphan = await seedOrphan({ type: 'transfer_in', accountId: ACC_A_ID, amount: '400' });
    const balanceA_before = await getBalance(ACC_A_ID);

    const { status, body } = await repair(orphan.id, {
      action: 'convert_to_regular',
      regularType: 'income',
      regularCategory: 'Ventas',
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.transaction.type, 'income');
    assert.equal(body.transaction.transferPairId, null);
    assert.equal(body.transaction.category, 'Ventas');
    assert.match(body.transaction.description, /^\[REPARADA\]/);

    const balanceA_after = await getBalance(ACC_A_ID);
    assert.equal(balanceA_after, balanceA_before, 'transfer_in→income must not change the balance');

    const { body: listAfter } = await getOrphans();
    assert.equal(listAfter.orphans.find((o: any) => o.id === orphan.id), undefined);
  });

  it('converts a transfer_out into an income and flips the account balance by 2*amount', async () => {
    // transfer_out of 100 → account A balance starts at -100 (the orphan effect).
    const orphan = await seedOrphan({ type: 'transfer_out', accountId: ACC_A_ID, amount: '100' });
    const balanceA_before = await getBalance(ACC_A_ID);

    const { status, body } = await repair(orphan.id, {
      action: 'convert_to_regular',
      regularType: 'income',
    });
    assert.equal(status, 200, JSON.stringify(body));

    const balanceA_after = await getBalance(ACC_A_ID);
    assert.equal(balanceA_after - balanceA_before, 200,
      'transfer_out (-100) → income (+100) must add 2*amount to undo the prior debit and apply the credit');
  });
});

describe('POST /api/transactions/orphan-transfers/:id/repair — cancel', () => {
  it('cancels the orphan via the standard cancellation flow (mirror entry + balance reversal)', async () => {
    // transfer_in of 250 → account A balance starts at +250.
    const orphan = await seedOrphan({ type: 'transfer_in', accountId: ACC_A_ID, amount: '250' });
    const balanceA_before = await getBalance(ACC_A_ID);
    assert.equal(balanceA_before, 250);

    const { status, body } = await repair(orphan.id, { action: 'cancel' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.action, 'cancel');
    assert.ok(body.cancellationId, 'response must include the id of the [CANCELACIÓN] mirror row');

    // The standard cancellation flow (storage.deleteTransaction) hard-deletes
    // the original row AND inserts a [CANCELACIÓN] mirror so the audit trail
    // is preserved and balances net to zero. Match that contract here so the
    // orphan repair behaves identically to the rest of the app.
    const after = await storage.getTransaction(orphan.id);
    assert.equal(after, undefined, 'original orphan row must be hard-deleted by the cancel flow');

    const mirror = await storage.getTransaction(body.cancellationId);
    assert.ok(mirror, '[CANCELACIÓN] mirror row must exist');
    assert.match(mirror!.description ?? '', /^\[CANCELACIÓN\]/);

    // Balance must net to zero: the +250 from the original was offset by the
    // -250 the cancellation flow applied.
    const balanceA_after = await getBalance(ACC_A_ID);
    assert.equal(balanceA_after, 0, 'cancelling a +250 transfer_in must leave the balance back at 0');

    // The orphan list must no longer include the row (it's gone).
    const { body: listAfter } = await getOrphans();
    assert.equal(listAfter.orphans.find((o: any) => o.id === orphan.id), undefined);
  });

  it('does NOT re-list the [CANCELACIÓN] mirror as a new orphan (regression)', async () => {
    // The cancellation flow inserts a transfer-typed mirror row with no
    // transferPairId. Without an isCancellationEntry filter on the orphan
    // listing query, that mirror would IMMEDIATELY reappear as a "new"
    // orphan and the user could "repair" the very row that exists only to
    // balance the books. This regression test pins the contract.
    const orphan = await seedOrphan({ type: 'transfer_out', accountId: ACC_A_ID, amount: '777' });

    const { status, body } = await repair(orphan.id, { action: 'cancel' });
    assert.equal(status, 200, JSON.stringify(body));
    const mirrorId = body.cancellationId as string;
    assert.ok(mirrorId);

    // Confirm the mirror really IS a transfer-typed [CANCELACIÓN] row
    // (i.e. it would qualify as orphan without the filter).
    const mirror = await storage.getTransaction(mirrorId);
    assert.ok(mirror);
    assert.match(mirror!.type, /^transfer_/);
    assert.equal(mirror!.transferPairId, null);
    assert.match(mirror!.description ?? '', /^\[CANCELACIÓN\]/);

    // It must NOT be in the orphan list.
    const { body: listAfter } = await getOrphans();
    const reappeared = listAfter.orphans.find((o: any) => o.id === mirrorId);
    assert.equal(reappeared, undefined,
      '[CANCELACIÓN] mirrors must be excluded from the orphan list');
  });
});

describe('POST /api/transactions/orphan-transfers/repair-batch — batch repairs (Task #179)', () => {
  it('rejects an empty items array', async () => {
    const { status, body } = await repairBatch([]);
    assert.equal(status, 400, JSON.stringify(body));
    assert.match(body.message, /inválido/i);
  });

  it('rejects a malformed payload (missing items)', async () => {
    const res = await fetch(`${baseUrl}/api/transactions/orphan-transfers/repair-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrong: true }),
    });
    assert.equal(res.status, 400);
  });

  it('creates the missing counterpart leg for several orphans pointing to the same destination account', async () => {
    // Three orphan transfer_outs from account A, all going to be paired into B.
    const orphans = [
      await seedOrphan({ type: 'transfer_out', accountId: ACC_A_ID, amount: '100' }),
      await seedOrphan({ type: 'transfer_out', accountId: ACC_A_ID, amount: '200' }),
      await seedOrphan({ type: 'transfer_out', accountId: ACC_A_ID, amount: '50' }),
    ];
    const balanceB_before = await getBalance(ACC_B_ID);

    const { status, body } = await repairBatch(
      orphans.map(o => ({ id: o.id, action: 'create_pair', counterpartAccountId: ACC_B_ID })),
    );

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.success, true);
    assert.equal(body.succeeded, 3);
    assert.equal(body.failed, 0);
    assert.equal(body.results.length, 3);
    for (const r of body.results) {
      assert.equal(r.ok, true);
      assert.equal(r.action, 'create_pair');
      assert.ok(r.counterpartId);
      assert.ok(r.transferPairId);
    }

    // All three counterparts must have been credited to account B (100+200+50 = 350).
    const balanceB_after = await getBalance(ACC_B_ID);
    assert.equal(balanceB_after - balanceB_before, 350,
      'account B must be credited with the sum of all paired amounts');

    // None of the original orphans should still appear as orphan.
    const { body: listAfter } = await getOrphans();
    for (const o of orphans) {
      assert.equal(listAfter.orphans.find((x: any) => x.id === o.id), undefined,
        `orphan ${o.id} must be repaired and gone from the list`);
    }
  });

  it('reports partial success when some items fail (e.g. wrong-currency counterpart) without rolling back the rest', async () => {
    // Add a USD account so we can force a mismatch on one item.
    const [usdAcc] = await db.insert(accounts).values({
      name: 'Caja USD batch', type: 'bank', currency: 'USD',
      balance: '0', organizationId: ORG_ID,
    }).returning();
    try {
      const okOrphan = await seedOrphan({ type: 'transfer_out', accountId: ACC_A_ID, amount: '40' });
      const badOrphan = await seedOrphan({ type: 'transfer_in', accountId: ACC_A_ID, amount: '70' });

      const { status, body } = await repairBatch([
        { id: okOrphan.id, action: 'create_pair', counterpartAccountId: ACC_B_ID },
        { id: badOrphan.id, action: 'create_pair', counterpartAccountId: usdAcc.id }, // currency mismatch
      ]);

      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.success, false, 'overall success must be false when at least one item failed');
      assert.equal(body.succeeded, 1);
      assert.equal(body.failed, 1);

      const okResult = body.results.find((r: any) => r.id === okOrphan.id);
      const badResult = body.results.find((r: any) => r.id === badOrphan.id);
      assert.equal(okResult.ok, true);
      assert.equal(badResult.ok, false);
      assert.equal(badResult.status, 400);
      assert.match(badResult.message, /misma moneda/i);

      // The successful one must really be repaired (gone from orphan list);
      // the failed one must STILL be orphan.
      const { body: listAfter } = await getOrphans();
      assert.equal(listAfter.orphans.find((o: any) => o.id === okOrphan.id), undefined);
      assert.ok(listAfter.orphans.find((o: any) => o.id === badOrphan.id),
        'failed orphan must still be in the list — partial-failure must not silently consume it');
    } finally {
      await db.delete(accounts).where(eq(accounts.id, usdAcc.id));
    }
  });

  it('supports mixing different actions in the same batch', async () => {
    const orphanPair = await seedOrphan({ type: 'transfer_out', accountId: ACC_A_ID, amount: '60' });
    const orphanConvert = await seedOrphan({ type: 'transfer_in', accountId: ACC_A_ID, amount: '90' });
    const orphanCancel = await seedOrphan({ type: 'transfer_in', accountId: ACC_B_ID, amount: '30' });

    const { status, body } = await repairBatch([
      { id: orphanPair.id, action: 'create_pair', counterpartAccountId: ACC_B_ID },
      { id: orphanConvert.id, action: 'convert_to_regular', regularType: 'income', regularCategory: 'Ventas' },
      { id: orphanCancel.id, action: 'cancel' },
    ]);

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.succeeded, 3);
    assert.equal(body.failed, 0);

    const pairResult = body.results.find((r: any) => r.id === orphanPair.id);
    const convertResult = body.results.find((r: any) => r.id === orphanConvert.id);
    const cancelResult = body.results.find((r: any) => r.id === orphanCancel.id);
    assert.equal(pairResult.action, 'create_pair');
    assert.ok(pairResult.counterpartId);
    assert.equal(convertResult.action, 'convert_to_regular');
    assert.equal(cancelResult.action, 'cancel');
    assert.ok(cancelResult.cancellationId);

    // Verify side effects
    const convertedTx = await storage.getTransaction(orphanConvert.id);
    assert.equal(convertedTx?.type, 'income');
    assert.equal(convertedTx?.category, 'Ventas');

    // Cancelled orphan is hard-deleted by the standard cancellation flow.
    const cancelledTx = await storage.getTransaction(orphanCancel.id);
    assert.equal(cancelledTx, undefined);
  });

  it('reports a not-found item without aborting the rest of the batch', async () => {
    const ok = await seedOrphan({ type: 'transfer_out', accountId: ACC_A_ID, amount: '10' });
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const { status, body } = await repairBatch([
      { id: fakeId, action: 'cancel' },
      { id: ok.id, action: 'cancel' },
    ]);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.succeeded, 1);
    assert.equal(body.failed, 1);
    const fakeRes = body.results.find((r: any) => r.id === fakeId);
    assert.equal(fakeRes.ok, false);
    assert.equal(fakeRes.status, 404);
    const okRes = body.results.find((r: any) => r.id === ok.id);
    assert.equal(okRes.ok, true);
  });
});
