import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { storage } from '../server/storage';
import { adjustBalanceHandler, forceBalanceHandler } from '../server/routes/transactions';
import { calculateAccruedInterest } from '../client/src/lib/utils';

// Task #261 — regression guard for Task #259.
//
// Task #259 changed the adjust-balance / force-balance endpoints so that on
// investment accounts they reset `initialInvestment = newBalance` and
// `interestStartDate = NOW()` (so the displayed yield restarts from 0 at
// the new capital). If that wiring ever breaks, users will see inflated or
// negative yields on Dashboard, Reports, Valoración del Patrimonio and the
// weekly email. This suite mounts the real handlers against the real
// storage layer and asserts the three invariants of the reset.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run this test');
}

let server: Server;
let baseUrl: string;
let organizationId: string;
let userId: string;
let operativeAccountId: string;

before(async () => {
  const org = await storage.createOrganization({
    name: `adjust-bal-test-${Date.now()}`,
    type: 'business',
    country: 'AR',
    defaultCurrency: 'ARS',
  });
  organizationId = org.id;

  const user = await storage.createUser({
    email: `adjust-bal-${Date.now()}@test.local`,
    name: 'Adjust Tester',
    password: 'x',
  } as any);
  userId = user.id;

  // The handlers gate on a membership with role that has `accounts:edit`.
  await storage.createMembership({
    userId,
    organizationId,
    role: 'owner',
  } as any);

  const operative = await storage.createAccount({
    name: 'Caja operativa',
    type: 'cash',
    currency: 'ARS',
    balance: '1000',
    accountCategory: 'operative',
    organizationId,
  } as any);
  operativeAccountId = operative.id;

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.organizationId = organizationId;
    req.userId = userId;
    next();
  });
  app.post('/api/accounts/:id/adjust-balance', adjustBalanceHandler);
  app.post('/api/accounts/:id/force-balance', forceBalanceHandler);

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
    await storage.deleteOrganization(organizationId);
  }
});

async function createInvestmentAccount(balance: string) {
  // Plant an investment account that was opened ~30 days ago, with some
  // accrued interest already on the books. After the reset, that historic
  // interest must disappear because the anchor is moved to NOW().
  const acc = await storage.createAccount({
    name: 'Plazo fijo test',
    type: 'bank',
    currency: 'ARS',
    balance,
    accountCategory: 'investment',
    initialInvestment: balance,
    interestRate: '5',
    interestFrequency: 'monthly',
    organizationId,
  } as any);
  // Backdate created_at AND interest_start_date so the pre-reset yield is
  // demonstrably positive (otherwise we couldn't distinguish "reset worked"
  // from "interest happened to be ~0 anyway").
  const { db } = await import('../server/db');
  const { sql } = await import('drizzle-orm');
  await db.execute(sql`UPDATE accounts SET created_at = NOW() - INTERVAL '30 days', interest_start_date = NOW() - INTERVAL '30 days' WHERE id = ${acc.id}`);
  return (await storage.getAccount(acc.id))!;
}

async function postJson(path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

describe('POST /api/accounts/:id/adjust-balance — investment yield reset', () => {
  it('resets initialInvestment, interest_start_date and accrued yield to ~0', async () => {
    const investment = await createInvestmentAccount('100000');

    // Sanity check: before the reset, the account has measurable accrued
    // yield (≈ 30 days at 5%/month). If this assertion ever fails it means
    // the test setup itself is broken.
    const accruedBefore = calculateAccruedInterest({
      initialInvestment: investment.initialInvestment,
      interestRate: investment.interestRate,
      interestFrequency: investment.interestFrequency,
      interestStartDate: investment.interestStartDate,
      createdAt: investment.createdAt,
    });
    assert.ok(accruedBefore > 0, `precondition: accrued yield must be > 0 before reset (got ${accruedBefore})`);

    const tBefore = Date.now();
    const { status, body } = await postJson(`/api/accounts/${investment.id}/adjust-balance`, {
      newBalance: '150000',
      reason: 'Test reset',
    });
    const tAfter = Date.now();

    assert.equal(status, 200, JSON.stringify(body));
    const updated = body.account;
    assert.equal(updated.balance, '150000.00', 'balance must equal newBalance');
    assert.equal(updated.initialInvestment, '150000.00', 'initialInvestment must be reset to newBalance');
    assert.ok(updated.interestStartDate, 'interestStartDate must be set');
    const anchorTs = new Date(updated.interestStartDate).getTime();
    assert.ok(anchorTs >= tBefore - 1000 && anchorTs <= tAfter + 1000,
      `interestStartDate must be ~NOW() (got ${updated.interestStartDate})`);

    // Yield calculated immediately after the reset must be ~0 (we just
    // moved the anchor to NOW), regardless of the 30-day-old created_at.
    const accruedAfter = calculateAccruedInterest({
      initialInvestment: updated.initialInvestment,
      interestRate: updated.interestRate,
      interestFrequency: updated.interestFrequency,
      interestStartDate: updated.interestStartDate,
      createdAt: updated.createdAt,
    });
    assert.ok(accruedAfter < 1, `accrued yield must be ~0 immediately after reset (got ${accruedAfter})`);
  });

  it('does NOT touch initialInvestment or interestStartDate on operative accounts', async () => {
    const before = await storage.getAccount(operativeAccountId);
    const beforeAnchor = before!.interestStartDate;

    const { status, body } = await postJson(`/api/accounts/${operativeAccountId}/adjust-balance`, {
      newBalance: '2000',
    });
    assert.equal(status, 200, JSON.stringify(body));
    const updated = body.account;
    assert.equal(updated.balance, '2000.00');
    assert.equal(updated.initialInvestment, before!.initialInvestment ?? null,
      'operative accounts must not have initialInvestment set by adjust-balance');
    assert.equal(
      updated.interestStartDate ? new Date(updated.interestStartDate).toISOString() : null,
      beforeAnchor ? new Date(beforeAnchor).toISOString() : null,
      'operative accounts must not have interestStartDate touched by adjust-balance',
    );
  });
});

describe('POST /api/accounts/:id/force-balance — investment yield reset', () => {
  it('resets initialInvestment, interest_start_date and accrued yield to ~0', async () => {
    const investment = await createInvestmentAccount('80000');

    const accruedBefore = calculateAccruedInterest({
      initialInvestment: investment.initialInvestment,
      interestRate: investment.interestRate,
      interestFrequency: investment.interestFrequency,
      interestStartDate: investment.interestStartDate,
      createdAt: investment.createdAt,
    });
    assert.ok(accruedBefore > 0, `precondition: accrued yield must be > 0 before force reset (got ${accruedBefore})`);

    const tBefore = Date.now();
    const { status, body } = await postJson(`/api/accounts/${investment.id}/force-balance`, {
      newBalance: '120000',
    });
    const tAfter = Date.now();

    assert.equal(status, 200, JSON.stringify(body));
    const updated = body.account;
    assert.equal(updated.balance, '120000.00');
    assert.equal(updated.initialInvestment, '120000.00');
    assert.ok(updated.interestStartDate);
    const anchorTs = new Date(updated.interestStartDate).getTime();
    assert.ok(anchorTs >= tBefore - 1000 && anchorTs <= tAfter + 1000,
      `interestStartDate must be ~NOW() (got ${updated.interestStartDate})`);

    const accruedAfter = calculateAccruedInterest({
      initialInvestment: updated.initialInvestment,
      interestRate: updated.interestRate,
      interestFrequency: updated.interestFrequency,
      interestStartDate: updated.interestStartDate,
      createdAt: updated.createdAt,
    });
    assert.ok(accruedAfter < 1, `accrued yield must be ~0 immediately after force-balance (got ${accruedAfter})`);
  });
});
