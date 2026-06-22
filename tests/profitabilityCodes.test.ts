import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run profitability code integration tests');
}

const { db } = await import('../server/db');
const { storage } = await import('../server/storage');
const {
  organizations, users, accounts, transactions, products, profitabilityCodes,
} = await import('../shared/schema');
const { eq } = await import('drizzle-orm');

const ORG_NAME_A = `__test_pcode_org_a_${process.pid}_${Date.now()}`;
const ORG_NAME_B = `__test_pcode_org_b_${process.pid}_${Date.now()}`;
const USER_EMAIL = `__test_pcode_user_${process.pid}_${Date.now()}@example.test`;

let ORG_A: string;
let ORG_B: string;
let USER_ID: string;
let ACC_A_ID: string;
let ACC_B_ID: string;

before(async () => {
  const [user] = await db.insert(users).values({
    email: USER_EMAIL,
    name: 'Test PCode User',
    password: 'unused-test-password-hash',
  }).returning();
  USER_ID = user.id;

  const [orgA] = await db.insert(organizations).values({
    name: ORG_NAME_A, type: 'business', country: 'AR', defaultCurrency: 'ARS',
  }).returning();
  ORG_A = orgA.id;

  const [orgB] = await db.insert(organizations).values({
    name: ORG_NAME_B, type: 'business', country: 'AR', defaultCurrency: 'ARS',
  }).returning();
  ORG_B = orgB.id;

  const [accA] = await db.insert(accounts).values({
    name: 'Caja A', type: 'bank', currency: 'ARS', balance: '0', organizationId: ORG_A,
  }).returning();
  ACC_A_ID = accA.id;

  const [accB] = await db.insert(accounts).values({
    name: 'Caja B', type: 'bank', currency: 'ARS', balance: '0', organizationId: ORG_A,
  }).returning();
  ACC_B_ID = accB.id;
});

after(async () => {
  try { await db.delete(transactions).where(eq(transactions.organizationId, ORG_A)); } catch {}
  try { await db.delete(transactions).where(eq(transactions.organizationId, ORG_B)); } catch {}
  try { await db.delete(profitabilityCodes).where(eq(profitabilityCodes.organizationId, ORG_A)); } catch {}
  try { await db.delete(profitabilityCodes).where(eq(profitabilityCodes.organizationId, ORG_B)); } catch {}
  try { await db.delete(products).where(eq(products.organizationId, ORG_A)); } catch {}
  try { await db.delete(organizations).where(eq(organizations.id, ORG_A)); } catch {}
  try { await db.delete(organizations).where(eq(organizations.id, ORG_B)); } catch {}
  try { await db.delete(users).where(eq(users.id, USER_ID)); } catch {}
});

beforeEach(async () => {
  await db.delete(transactions).where(eq(transactions.organizationId, ORG_A));
  await db.delete(transactions).where(eq(transactions.organizationId, ORG_B));
  await db.delete(profitabilityCodes).where(eq(profitabilityCodes.organizationId, ORG_A));
  await db.delete(profitabilityCodes).where(eq(profitabilityCodes.organizationId, ORG_B));
  await db.delete(products).where(eq(products.organizationId, ORG_A));
  await db.update(accounts).set({ balance: '0' }).where(eq(accounts.id, ACC_A_ID));
  await db.update(accounts).set({ balance: '0' }).where(eq(accounts.id, ACC_B_ID));
});

describe('Profitability Codes — Storage CRUD', () => {
  it('creates and retrieves a code', async () => {
    const created = await storage.createProfitabilityCode({
      organizationId: ORG_A,
      code: 'OBRA-01',
      name: 'Obra principal',
      description: 'Edificio Belgrano',
      color: '#06b6d4',
    });
    assert.equal(created.code, 'OBRA-01');
    assert.equal(created.organizationId, ORG_A);
    assert.equal(created.isActive, true);

    const found = await storage.getProfitabilityCode(created.id);
    assert.equal(found?.id, created.id);

    const list = await storage.getProfitabilityCodesByOrganization(ORG_A);
    assert.equal(list.length, 1);
    assert.equal(list[0].code, 'OBRA-01');
  });

  it('isolates codes per organization', async () => {
    await storage.createProfitabilityCode({
      organizationId: ORG_A, code: 'A1', name: 'A',
    });
    await storage.createProfitabilityCode({
      organizationId: ORG_B, code: 'B1', name: 'B',
    });
    const listA = await storage.getProfitabilityCodesByOrganization(ORG_A);
    const listB = await storage.getProfitabilityCodesByOrganization(ORG_B);
    assert.equal(listA.length, 1);
    assert.equal(listA[0].code, 'A1');
    assert.equal(listB.length, 1);
    assert.equal(listB[0].code, 'B1');
  });

  it('finds by code case-insensitively within an org', async () => {
    await storage.createProfitabilityCode({
      organizationId: ORG_A, code: 'OBRA-01', name: 'Obra',
    });
    const found = await storage.findProfitabilityCodeByCode(ORG_A, 'obra-01');
    assert.equal(found?.code, 'OBRA-01');
    // Different org should not find it
    const notFound = await storage.findProfitabilityCodeByCode(ORG_B, 'OBRA-01');
    assert.equal(notFound, undefined);
  });

  it('updates a code', async () => {
    const created = await storage.createProfitabilityCode({
      organizationId: ORG_A, code: 'X1', name: 'Original',
    });
    const updated = await storage.updateProfitabilityCode(created.id, { name: 'Renamed', color: '#ec4899' });
    assert.equal(updated?.name, 'Renamed');
    assert.equal(updated?.color, '#ec4899');
  });

  it('soft-deletes a code by setting isActive=false', async () => {
    const created = await storage.createProfitabilityCode({
      organizationId: ORG_A, code: 'X1', name: 'X',
    });
    const deactivated = await storage.updateProfitabilityCode(created.id, { isActive: false });
    assert.equal(deactivated?.isActive, false);
    // Active-only listing must hide it
    const activeList = await storage.getProfitabilityCodesByOrganization(ORG_A, true);
    assert.equal(activeList.length, 0);
    // Full listing must still include it
    const fullList = await storage.getProfitabilityCodesByOrganization(ORG_A);
    assert.equal(fullList.length, 1);
  });
});

describe('Profitability Codes — Transaction integration', () => {
  it('persists profitabilityCodeId on a transaction', async () => {
    const code = await storage.createProfitabilityCode({
      organizationId: ORG_A, code: 'OBRA-01', name: 'Obra',
    });
    const tx = await storage.createTransaction({
      organizationId: ORG_A,
      type: 'income',
      amount: '1000',
      description: 'Venta',
      category: 'Ventas',
      date: new Date(),
      imputationDate: new Date(),
      status: 'completed',
      accountId: ACC_A_ID,
      profitabilityCodeId: code.id,
    } as any);
    assert.equal(tx.profitabilityCodeId, code.id);
  });

  it('keeps profitabilityCodeId on regular transactions but allows null', async () => {
    const tx = await storage.createTransaction({
      organizationId: ORG_A,
      type: 'expense',
      amount: '500',
      description: 'Compra',
      category: 'Insumos',
      date: new Date(),
      imputationDate: new Date(),
      status: 'completed',
      accountId: ACC_A_ID,
    } as any);
    assert.equal(tx.profitabilityCodeId, null);
  });
});

describe('Profitability Codes — Product propagation', () => {
  it('stores defaultProfitabilityCodeId on a product', async () => {
    const code = await storage.createProfitabilityCode({
      organizationId: ORG_A, code: 'PROD-PREMIUM', name: 'Línea premium',
    });
    const [prod] = await db.insert(products).values({
      organizationId: ORG_A,
      name: 'Producto premium',
      productType: 'product',
      defaultProfitabilityCodeId: code.id,
    } as any).returning();
    assert.equal((prod as any).defaultProfitabilityCodeId, code.id);
  });
});
