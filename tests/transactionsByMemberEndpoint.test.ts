import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run the by-member endpoint integration tests');
}

const { db } = await import('../server/db');
const { storage } = await import('../server/storage');
const { registerTransactionRoutes } = await import('../server/routes/transactions');
const { organizations, users, accounts, transactions, memberships } = await import('../shared/schema');
const { eq } = await import('drizzle-orm');

const SUFFIX = `${process.pid}_${Date.now()}`;
const ORG_NAME = `__test_bymember_org_${SUFFIX}`;
const USER_A_EMAIL = `__test_bymember_a_${SUFFIX}@example.test`;
const USER_B_EMAIL = `__test_bymember_b_${SUFFIX}@example.test`;

let ORG_ID: string;
let USER_A: string;
let USER_B: string;
let ACC_ID: string;

const ORIG_STORAGE: Record<string, any> = {};

function stubAuthOnly() {
  const methods: Record<string, any> = {
    getUser: async (id: string) => (id === USER_A ? { id: USER_A, deletedAt: null } : null),
    getSubscriptionByUserId: async (_id: string) => ({ status: 'active' }),
    getOrganizationOwner: async (_org: string) => ({ id: USER_A }),
    getMembershipByUserAndOrg: async (_u: string, _o: string) => ({
      role: 'owner', userId: USER_A, organizationId: ORG_ID,
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
      userId: USER_A,
      organizationId: ORG_ID,
      destroy: (cb: any) => cb && cb(),
    };
    next();
  });
  registerTransactionRoutes(app);
  return app;
}

before(async () => {
  const [a] = await db.insert(users).values({
    email: USER_A_EMAIL, name: 'Ana Test', password: 'unused-hash',
  }).returning();
  USER_A = a.id;
  const [b] = await db.insert(users).values({
    email: USER_B_EMAIL, name: 'Bruno Test', password: 'unused-hash',
  }).returning();
  USER_B = b.id;

  const [org] = await db.insert(organizations).values({
    name: ORG_NAME, type: 'business', country: 'AR', defaultCurrency: 'ARS',
  }).returning();
  ORG_ID = org.id;

  await db.insert(memberships).values([
    { userId: USER_A, organizationId: ORG_ID, role: 'owner' },
    { userId: USER_B, organizationId: ORG_ID, role: 'admin' },
  ]);

  const [acc] = await db.insert(accounts).values({
    name: 'Caja test', type: 'cash', currency: 'ARS', organizationId: ORG_ID,
  }).returning();
  ACC_ID = acc.id;

  stubAuthOnly();
  const app = buildApp();
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

after(async () => {
  try { if (ORG_ID) await db.delete(organizations).where(eq(organizations.id, ORG_ID)); } catch {}
  try { if (USER_A) await db.delete(users).where(eq(users.id, USER_A)); } catch {}
  try { if (USER_B) await db.delete(users).where(eq(users.id, USER_B)); } catch {}
  for (const [k, v] of Object.entries(ORIG_STORAGE)) (storage as any)[k] = v;
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(async () => {
  await db.delete(transactions).where(eq(transactions.organizationId, ORG_ID));
});

type TxSeed = {
  id?: string;
  type: 'income' | 'expense' | 'receivable' | 'payable' | 'transfer_in' | 'transfer_out';
  status?: 'completed' | 'scheduled' | 'cancelled';
  amount?: string;
  imputationDate: Date;
  createdBy?: string | null;
  profitabilityCodeId?: string | null;
  description?: string;
};

async function seedTx(rows: TxSeed[]) {
  await db.insert(transactions).values(
    rows.map(r => ({
      ...(r.id ? { id: r.id } : {}),
      type: r.type,
      amount: r.amount ?? '1000',
      currency: 'ARS' as const,
      description: r.description ?? `seed-${r.type}-${r.id ?? ''}`,
      category: 'test',
      date: r.imputationDate,
      imputationDate: r.imputationDate,
      accountId: ACC_ID,
      organizationId: ORG_ID,
      status: r.status ?? 'completed',
      ...(r.createdBy !== undefined ? { createdBy: r.createdBy } : {}),
      ...(r.profitabilityCodeId !== undefined ? { profitabilityCodeId: r.profitabilityCodeId } : {}),
    })),
  );
}

async function getByMember(qs: Record<string, string>) {
  const url = new URL(`${baseUrl}/api/transactions/by-member`);
  for (const [k, v] of Object.entries(qs)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  let json: any = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

describe('GET /api/transactions/by-member — Task #202', () => {
  it('aggregates ingresos/gastos por miembro y excluye cancelados, espejos y transfers', async () => {
    await seedTx([
      { id: 't-a-inc', type: 'income', amount: '5000', createdBy: USER_A,
        imputationDate: new Date('2026-05-10T15:00:00Z') },
      { id: 't-a-exp', type: 'expense', amount: '1500', createdBy: USER_A,
        imputationDate: new Date('2026-05-12T15:00:00Z') },
      { id: 't-b-inc', type: 'income', amount: '2000', createdBy: USER_B,
        imputationDate: new Date('2026-05-15T15:00:00Z') },
      { id: 't-b-recv', type: 'receivable', amount: '800', createdBy: USER_B,
        imputationDate: new Date('2026-05-16T15:00:00Z') },
      { id: 't-b-pay', type: 'payable', amount: '300', createdBy: USER_B,
        imputationDate: new Date('2026-05-17T15:00:00Z') },
      // Excluidos:
      { id: 't-cx', type: 'income', status: 'cancelled', amount: '999', createdBy: USER_A,
        imputationDate: new Date('2026-05-10T15:00:00Z') },
      { id: 't-mirror', type: 'expense', amount: '111', createdBy: USER_A,
        description: '[CANCELACIÓN] espejo', imputationDate: new Date('2026-05-10T15:00:00Z') },
      { id: 't-tin', type: 'transfer_in', amount: '777', createdBy: USER_A,
        imputationDate: new Date('2026-05-10T15:00:00Z') },
      { id: 't-tout', type: 'transfer_out', amount: '777', createdBy: USER_B,
        imputationDate: new Date('2026-05-10T15:00:00Z') },
    ]);

    const { status, body } = await getByMember({
      from: '2026-05-01', to: '2026-05-31',
    });
    assert.equal(status, 200);
    assert.equal(body.members.length, 2);
    const ana = body.members.find((m: any) => m.userId === USER_A);
    const bruno = body.members.find((m: any) => m.userId === USER_B);
    assert.ok(ana && bruno, 'ambos miembros presentes');
    assert.equal(ana.totalIngresos, 5000, 'cancelados/espejos/transfers no cuentan en Ana');
    assert.equal(ana.totalEgresos, 1500);
    assert.equal(ana.countIngresos, 1);
    assert.equal(ana.countEgresos, 1);
    assert.equal(bruno.totalIngresos, 2800, 'income+receivable suman');
    assert.equal(bruno.totalEgresos, 300);
    assert.equal(bruno.countIngresos, 2);
    assert.equal(bruno.countEgresos, 1);
    assert.equal(body.unassigned, null, 'sin huérfanos en este escenario');
    assert.equal(ana.name, 'Ana Test');
    assert.equal(ana.role, 'owner');
  });

  it('expone el grupo "unassigned" sólo si hay movimientos con createdBy null', async () => {
    await seedTx([
      { id: 't-a', type: 'income', amount: '1000', createdBy: USER_A,
        imputationDate: new Date('2026-05-05T15:00:00Z') },
      { id: 't-orphan', type: 'expense', amount: '400', createdBy: null,
        imputationDate: new Date('2026-05-06T15:00:00Z') },
    ]);

    const { status, body } = await getByMember({ from: '2026-05-01', to: '2026-05-31' });
    assert.equal(status, 200);
    assert.ok(body.unassigned, 'unassigned debe existir');
    assert.equal(body.unassigned.totalEgresos, 400);
    assert.equal(body.unassigned.userId, null);
    assert.equal(body.unassigned.name, null);
  });

  it('aplica el filtro codeId como AND y respeta el rango from/to', async () => {
    const CODE = 'code-x';
    await seedTx([
      { id: 't-in-code', type: 'income', amount: '1000', createdBy: USER_A,
        profitabilityCodeId: CODE, imputationDate: new Date('2026-05-10T15:00:00Z') },
      { id: 't-out-of-code', type: 'income', amount: '9999', createdBy: USER_A,
        profitabilityCodeId: 'other', imputationDate: new Date('2026-05-10T15:00:00Z') },
      { id: 't-out-of-range', type: 'income', amount: '8888', createdBy: USER_A,
        profitabilityCodeId: CODE, imputationDate: new Date('2026-04-10T15:00:00Z') },
    ]);

    const { body } = await getByMember({
      from: '2026-05-01', to: '2026-05-31', codeId: CODE,
    });
    const ana = body.members.find((m: any) => m.userId === USER_A);
    assert.equal(ana.totalIngresos, 1000, 'sólo cuenta el row con code y dentro del rango');
    assert.equal(ana.countIngresos, 1);
  });

  it('rechaza fechas inválidas con 400', async () => {
    const r = await getByMember({ from: 'no-es-fecha' });
    assert.equal(r.status, 400);
  });
});
