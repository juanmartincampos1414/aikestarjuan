import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Task #255 — Integration test for POST /api/transactions and PATCH
// /api/transactions/:id, mounting the REAL `registerTransactionRoutes` against
// the real database. The point of this test is to catch any future regression
// where a refactor forgets to call `validateTransactionCategory` on these
// endpoints (Task #252's fix): we verify both rejection of unknown categories
// and casing canonicalization through actual HTTP.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run category-validation endpoint tests');
}

const { db } = await import('../server/db');
const { storage } = await import('../server/storage');
const { registerTransactionRoutes } = await import('../server/routes/transactions');
const {
  organizations, users, accounts, transactions, memberships, transactionCategories,
} = await import('../shared/schema');
const { eq } = await import('drizzle-orm');

const SUFFIX = `${process.pid}_${Date.now()}`;
const ORG_NAME = `__test_catval_org_${SUFFIX}`;
const USER_EMAIL = `__test_catval_user_${SUFFIX}@example.test`;

let ORG_ID: string;
let USER_ID: string;
let ACC_ID: string;

const ORIG_STORAGE: Record<string, any> = {};

function stubAuth() {
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
  const [u] = await db.insert(users).values({
    email: USER_EMAIL, name: 'Cat Val Test', password: 'unused-hash',
  }).returning();
  USER_ID = u.id;

  const [org] = await db.insert(organizations).values({
    name: ORG_NAME, type: 'business', country: 'AR', defaultCurrency: 'ARS',
  }).returning();
  ORG_ID = org.id;

  await db.insert(memberships).values({ userId: USER_ID, organizationId: ORG_ID, role: 'owner' });

  const [acc] = await db.insert(accounts).values({
    name: 'Caja CatVal', type: 'cash', currency: 'ARS', organizationId: ORG_ID,
  }).returning();
  ACC_ID = acc.id;

  await db.insert(transactionCategories).values([
    { organizationId: ORG_ID, name: 'Ventas Mayoristas', type: 'income', expenseSubtype: 'income' },
    { organizationId: ORG_ID, name: 'Servicios Públicos', type: 'expense', expenseSubtype: 'expense' },
  ]);

  stubAuth();
  const app = buildApp();
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

after(async () => {
  try { await db.delete(transactions).where(eq(transactions.organizationId, ORG_ID)); } catch {}
  try { await db.delete(transactionCategories).where(eq(transactionCategories.organizationId, ORG_ID)); } catch {}
  try { await db.delete(accounts).where(eq(accounts.id, ACC_ID)); } catch {}
  try { await db.delete(memberships).where(eq(memberships.organizationId, ORG_ID)); } catch {}
  try { await db.delete(organizations).where(eq(organizations.id, ORG_ID)); } catch {}
  try { await db.delete(users).where(eq(users.id, USER_ID)); } catch {}
  for (const [k, v] of Object.entries(ORIG_STORAGE)) (storage as any)[k] = v;
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(async () => {
  await db.delete(transactions).where(eq(transactions.organizationId, ORG_ID));
});

const baseTx = () => ({
  type: 'income' as const,
  amount: '1234.56',
  currency: 'ARS',
  description: 'Venta de prueba',
  date: '2026-05-10',
  imputationDate: '2026-05-10',
  accountId: ACC_ID,
  status: 'completed' as const,
});

async function post(body: any) {
  const res = await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: any = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

async function patch(id: string, body: any) {
  const res = await fetch(`${baseUrl}/api/transactions/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: any = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

describe('POST /api/transactions — category validation (Task #255)', () => {
  it('rechaza una categoría inexistente con 400 + field=category', async () => {
    const r = await post({ ...baseTx(), category: 'Categoría Fantasma' });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'category');
    assert.match(r.body.message, /Categoría Fantasma/);
    const rows = await db.select().from(transactions).where(eq(transactions.organizationId, ORG_ID));
    assert.equal(rows.length, 0, 'no debe persistir la transacción fantasma');
  });

  it('canoniza el casing cuando la categoría matchea (case-insensitive)', async () => {
    const r = await post({ ...baseTx(), category: 'ventas MAYORISTAS' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.category, 'Ventas Mayoristas');
    const [row] = await db.select().from(transactions).where(eq(transactions.id, r.body.id));
    assert.equal(row.category, 'Ventas Mayoristas');
  });

  it('rechaza si la categoría matchea pero del tipo equivocado', async () => {
    // "Servicios Públicos" es expense; mandarlo en un income debe fallar.
    const r = await post({ ...baseTx(), type: 'income', category: 'Servicios Públicos' });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'category');
  });
});

describe('PATCH /api/transactions/:id — category validation (Task #255)', () => {
  it('rechaza una categoría inexistente con 400 + field=category', async () => {
    // Seed un movimiento válido vía storage para tener un id real.
    const created = await storage.createTransaction({
      type: 'income', amount: '100', currency: 'ARS', description: 'seed',
      category: 'Ventas Mayoristas', date: new Date('2026-05-10'),
      imputationDate: new Date('2026-05-10'), accountId: ACC_ID,
      organizationId: ORG_ID, status: 'completed', createdBy: USER_ID,
    } as any);
    const r = await patch(created.id, { category: 'Categoría Fantasma' });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'category');
    const [row] = await db.select().from(transactions).where(eq(transactions.id, created.id));
    assert.equal(row.category, 'Ventas Mayoristas', 'el valor previo no se debe sobreescribir');
  });

  it('canoniza el casing al actualizar', async () => {
    const created = await storage.createTransaction({
      type: 'expense', amount: '50', currency: 'ARS', description: 'seed',
      category: 'Servicios Públicos', date: new Date('2026-05-10'),
      imputationDate: new Date('2026-05-10'), accountId: ACC_ID,
      organizationId: ORG_ID, status: 'completed', createdBy: USER_ID,
    } as any);
    const r = await patch(created.id, { category: 'servicios públicos' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [row] = await db.select().from(transactions).where(eq(transactions.id, created.id));
    assert.equal(row.category, 'Servicios Públicos');
  });
});
