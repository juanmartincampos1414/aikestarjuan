import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { storage } from '../server/storage';
import { repairTransferHandler } from '../server/routes/transactions';

// Real-endpoint integration test for `POST /api/transactions/:id/repair-transfer`.
//
// We mount the SAME exported `repairTransferHandler` the production route uses
// on a tiny Express server, with auth/permissions stubbed (covered by other
// tests). All data is created through the real `storage` module against the
// real database, so the handler runs the actual SQL + audit-log code paths
// used in production.

let server: Server;
let baseUrl: string;
let organizationId: string;
let userId: string;
let cajaId: string;
let bancoId: string;
let mercadoPagoId: string;

before(async () => {
  const org = await storage.createOrganization({
    name: `repair-transfer-test-${Date.now()}`,
    type: 'business',
    country: 'AR',
    defaultCurrency: 'ARS',
  });
  organizationId = org.id;

  // The endpoint writes audit logs; create a real user so the FK check passes.
  const user = await storage.createUser({
    email: `repair-transfer-${Date.now()}@test.local`,
    name: 'Repair Tester',
    password: 'x',
  });
  userId = user.id;

  const caja = await storage.createAccount({
    name: 'Caja Test',
    type: 'cash',
    currency: 'ARS',
    balance: '10000',
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

  const mp = await storage.createAccount({
    name: 'Mercado Pago Test',
    type: 'wallet',
    currency: 'ARS',
    balance: '0',
    organizationId,
  });
  mercadoPagoId = mp.id;

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.organizationId = organizationId;
    req.userId = userId;
    next();
  });
  app.post('/api/transactions/:id/repair-transfer', repairTransferHandler);

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

async function postRepair(id: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/transactions/${id}/repair-transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

describe('POST /api/transactions/:id/repair-transfer — repair flows (integration with real storage)', () => {
  it('refuses to repair a transfer that already has a live counterpart', async () => {
    const pairId = `healthy-${Date.now()}`;
    const out = await storage.createTransaction({
      type: 'transfer_out',
      amount: '500',
      currency: 'ARS',
      description: 'Pareja sana',
      category: 'Transferencia Interna',
      date: new Date(),
      imputationDate: new Date(),
      accountId: cajaId,
      organizationId,
      status: 'completed',
      transferPairId: pairId,
    });
    await storage.createTransaction({
      type: 'transfer_in',
      amount: '500',
      currency: 'ARS',
      description: 'Pareja sana',
      category: 'Transferencia Interna',
      date: new Date(),
      imputationDate: new Date(),
      accountId: bancoId,
      organizationId,
      status: 'completed',
      transferPairId: pairId,
    });

    const { status, body } = await postRepair(out.id, {
      action: 'recreate-pair',
      counterpartAccountId: bancoId,
    });
    assert.equal(status, 400);
    assert.match(body.message, /ya tiene su contraparte/i);
  });

  it('recreate-pair: creates the missing leg, backfills transferPairId, adjusts balance, writes audit log', async () => {
    // Orphan WITHOUT transferPairId — simulates an old import / partial creation.
    const orphan = await storage.createTransaction({
      type: 'transfer_out',
      amount: '750',
      currency: 'ARS',
      description: 'Salida huérfana',
      category: 'Transferencia Interna',
      date: new Date(),
      imputationDate: new Date(),
      accountId: cajaId,
      organizationId,
      status: 'completed',
      // NOTE: no transferPairId
    });

    const bancoBefore = await storage.getAccount(bancoId);
    const balanceBefore = parseFloat(bancoBefore!.balance);

    const { status, body } = await postRepair(orphan.id, {
      action: 'recreate-pair',
      counterpartAccountId: bancoId,
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.success, true);
    assert.equal(body.mode, 'recreate-pair');
    assert.ok(body.transferPairId, 'a transferPairId must be returned');
    assert.ok(body.createdCounterpart, 'the new counterpart must be returned');
    assert.equal(body.createdCounterpart.type, 'transfer_in', 'opposite leg of transfer_out is transfer_in');
    assert.equal(body.createdCounterpart.accountId, bancoId);
    assert.equal(body.createdCounterpart.amount, '750.00');
    assert.equal(body.createdCounterpart.transferPairId, body.transferPairId);

    // Orphan must now have the same transferPairId (backfill).
    const orphanAfter = await storage.getTransaction(orphan.id);
    assert.equal(orphanAfter!.transferPairId, body.transferPairId,
      'orphan should be backfilled with the new transferPairId');

    // Counterpart account balance must have grown by 750 (transfer_in = credit).
    const bancoAfter = await storage.getAccount(bancoId);
    const balanceAfter = parseFloat(bancoAfter!.balance);
    assert.equal(balanceAfter - balanceBefore, 750, 'banco balance increases by the counterpart amount');

    // Audit log must record the repair.
    const logs = await storage.getAuditLogsByEntity('transaction', orphan.id);
    const repairLog = logs.find(l => l.action === 'repair_transfer');
    assert.ok(repairLog, 'an audit log with action=repair_transfer must exist');
    const newData = JSON.parse(repairLog!.newData as string);
    assert.equal(newData.mode, 'recreate-pair');
    assert.equal(newData.backfilledTransferPairId, true,
      'audit must mark that transferPairId was backfilled on the orphan');
    assert.equal(newData.createdCounterpart.accountName, 'Banco Test');
  });

  it('recreate-pair: respects an explicit cross-currency counterpartAmount in Argentine format', async () => {
    const orphan = await storage.createTransaction({
      type: 'transfer_out',
      amount: '1000',
      currency: 'ARS',
      description: 'Salida huérfana cross-currency',
      category: 'Transferencia Interna',
      date: new Date(),
      imputationDate: new Date(),
      accountId: cajaId,
      organizationId,
      status: 'completed',
    });

    const { status, body } = await postRepair(orphan.id, {
      action: 'recreate-pair',
      counterpartAccountId: mercadoPagoId,
      counterpartAmount: '1.234,56',
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.createdCounterpart.amount, '1234.56',
      'Argentine "1.234,56" must be parsed as 1234.56');
  });

  it('convert (sign-preserving): transfer_in -> income, clears transferPairId, no balance shift, writes audit log', async () => {
    // The original transfer_in already credited Banco by +300 when it was
    // created. Converting it to "income" preserves that credit, so the
    // balance must NOT change as a result of the repair.
    const bancoBefore = await storage.getAccount(bancoId);
    const balanceBefore = parseFloat(bancoBefore!.balance);

    const orphan = await storage.createTransaction({
      type: 'transfer_in',
      amount: '300',
      currency: 'ARS',
      description: 'Entrada sin contraparte',
      category: 'Transferencia Interna',
      date: new Date(),
      imputationDate: new Date(),
      accountId: bancoId,
      organizationId,
      status: 'completed',
      transferPairId: `lost-pair-${Date.now()}`,
    });

    // Creating the orphan transfer_in credited the account.
    const bancoAfterOrphan = await storage.getAccount(bancoId);
    const balanceAfterOrphan = parseFloat(bancoAfterOrphan!.balance);
    assert.equal(balanceAfterOrphan - balanceBefore, 300,
      'sanity check: creating a transfer_in must credit the account');

    const { status, body } = await postRepair(orphan.id, {
      action: 'convert',
      newType: 'income',
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.success, true);
    assert.equal(body.mode, 'convert');
    assert.equal(body.transaction.type, 'income', 'type must be flipped to income');
    assert.equal(body.transaction.transferPairId, null, 'transferPairId must be cleared');
    assert.equal(body.transaction.category, 'Ingresos varios',
      'falls back to "Ingresos varios" when no category override is given');
    assert.match(body.transaction.description, /Convertida desde transferencia huérfana/);

    // Sign-preserving: balance must remain at +300 vs. baseline; the convert
    // must NOT touch the account balance (the transfer already moved it).
    const bancoAfterConvert = await storage.getAccount(bancoId);
    const balanceAfterConvert = parseFloat(bancoAfterConvert!.balance);
    assert.equal(balanceAfterConvert, balanceAfterOrphan,
      'convert must not adjust account balance (transfer already moved it)');

    // Audit log entry exists.
    const logs = await storage.getAuditLogsByEntity('transaction', orphan.id);
    const repairLog = logs.find(l => l.action === 'repair_transfer');
    assert.ok(repairLog, 'an audit log with action=repair_transfer must exist for convert');
    const newData = JSON.parse(repairLog!.newData as string);
    assert.equal(newData.mode, 'convert');
    assert.equal(newData.newType, 'income');
    assert.equal(newData.clearedTransferPairId, true);
  });

  it('convert: rejects opposite-sign mapping (transfer_in -> expense) to protect balance integrity', async () => {
    const orphan = await storage.createTransaction({
      type: 'transfer_in',
      amount: '120',
      currency: 'ARS',
      description: 'Entrada sin contraparte',
      category: 'Transferencia Interna',
      date: new Date(),
      imputationDate: new Date(),
      accountId: bancoId,
      organizationId,
      status: 'completed',
      transferPairId: `wrong-sign-pair-${Date.now()}`,
    });

    const { status, body } = await postRepair(orphan.id, {
      action: 'convert',
      newType: 'expense', // opposite sign: would corrupt balance by 2x
    });

    assert.equal(status, 400);
    assert.match(body.message, /solo puede convertirse en ingreso/i);

    // The orphan must remain unchanged.
    const after = await storage.getTransaction(orphan.id);
    assert.equal(after!.type, 'transfer_in', 'rejected convert must not mutate the transaction');
    assert.equal(after!.transferPairId, orphan.transferPairId, 'transferPairId must not be cleared on rejection');
  });

  it('convert: rejects opposite-sign mapping (transfer_out -> income) to protect balance integrity', async () => {
    const orphan = await storage.createTransaction({
      type: 'transfer_out',
      amount: '70',
      currency: 'ARS',
      description: 'Salida sin contraparte',
      category: 'Transferencia Interna',
      date: new Date(),
      imputationDate: new Date(),
      accountId: cajaId,
      organizationId,
      status: 'completed',
    });

    const { status, body } = await postRepair(orphan.id, {
      action: 'convert',
      newType: 'income',
    });

    assert.equal(status, 400);
    assert.match(body.message, /solo puede convertirse en gasto/i);
  });

  it('rejects non-transfer transactions', async () => {
    const income = await storage.createTransaction({
      type: 'income',
      amount: '100',
      currency: 'ARS',
      description: 'Ingreso normal',
      category: 'Ventas',
      date: new Date(),
      imputationDate: new Date(),
      accountId: cajaId,
      organizationId,
      status: 'completed',
    });

    const { status, body } = await postRepair(income.id, {
      action: 'convert',
      newType: 'expense',
    });
    assert.equal(status, 400);
    assert.match(body.message, /Solo se pueden reparar transferencias/i);
  });

  it('rejects recreate-pair with the same account as the orphan', async () => {
    const orphan = await storage.createTransaction({
      type: 'transfer_out',
      amount: '50',
      currency: 'ARS',
      description: 'Salida huérfana misma cuenta',
      category: 'Transferencia Interna',
      date: new Date(),
      imputationDate: new Date(),
      accountId: cajaId,
      organizationId,
      status: 'completed',
    });

    const { status, body } = await postRepair(orphan.id, {
      action: 'recreate-pair',
      counterpartAccountId: cajaId,
    });
    assert.equal(status, 400);
    assert.match(body.message, /distinta/i);
  });

  it('recreate-pair: two concurrent requests on the same orphan never produce duplicate counterparts', async () => {
    // Race-condition guard. Two simultaneous repair requests on the same
    // orphan must not both insert a counterpart. The handler uses a
    // SELECT ... FOR UPDATE inside the db transaction so the second
    // attempt sees the freshly-set transferPairId and aborts with 409.
    const orphan = await storage.createTransaction({
      type: 'transfer_out',
      amount: '600',
      currency: 'ARS',
      description: 'Salida huérfana - race',
      category: 'Transferencia Interna',
      date: new Date(),
      imputationDate: new Date(),
      accountId: cajaId,
      organizationId,
      status: 'completed',
    });

    const [r1, r2] = await Promise.all([
      postRepair(orphan.id, { action: 'recreate-pair', counterpartAccountId: bancoId }),
      postRepair(orphan.id, { action: 'recreate-pair', counterpartAccountId: bancoId }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    // Exactly one wins (200) and the other is rejected as conflict (409 from
    // the inside-transaction re-check) or 400 from the outer pre-check if
    // the second request started after the first had already finished.
    assert.equal(statuses[0], 200, 'one of the two concurrent requests must succeed');
    assert.ok(statuses[1] === 409 || statuses[1] === 400,
      `the other concurrent request must be rejected (got ${statuses[1]})`);

    // And there must be exactly ONE counterpart (in addition to the orphan).
    const orphanAfter = await storage.getTransaction(orphan.id);
    assert.ok(orphanAfter!.transferPairId, 'orphan must end up with a transferPairId');
    const allOrgTx = await storage.getTransactionsByOrganization(organizationId);
    const counterparts = allOrgTx.filter(t =>
      t.id !== orphan.id &&
      t.transferPairId === orphanAfter!.transferPairId &&
      (t.type === 'transfer_in' || t.type === 'transfer_out') &&
      t.status !== 'cancelled',
    );
    assert.equal(counterparts.length, 1,
      'exactly one counterpart must exist for the orphan after the race');
  });

  it('returns 404 for an unknown transaction id', async () => {
    const { status } = await postRepair('00000000-0000-0000-0000-000000000000', {
      action: 'convert',
      newType: 'income',
    });
    assert.equal(status, 404);
  });
});
