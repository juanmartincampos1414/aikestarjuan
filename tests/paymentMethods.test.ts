import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run payment-methods integration tests');
}

const { db } = await import('../server/db');
const { storage } = await import('../server/storage');
const {
  organizations, users, accounts, transactions, paymentMethods, paymentMethodConcepts, transactionCategories,
} = await import('../shared/schema');
const { eq } = await import('drizzle-orm');

const TAG = `${process.pid}_${Date.now()}`;
const ORG_NAME = `__test_pm_org_${TAG}`;
const USER_EMAIL = `__test_pm_user_${TAG}@example.test`;

let ORG_ID: string;
let USER_ID: string;
let ACC_ID: string;
let CAT_EXPENSE_ID: string;

before(async () => {
  const [user] = await db.insert(users).values({
    email: USER_EMAIL,
    name: 'Test PM User',
    password: 'unused-test-password-hash',
  }).returning();
  USER_ID = user.id;

  const [org] = await db.insert(organizations).values({
    name: ORG_NAME, type: 'business', country: 'AR', defaultCurrency: 'ARS',
  }).returning();
  ORG_ID = org.id;

  const [acc] = await db.insert(accounts).values({
    name: 'Caja PM', type: 'bank', currency: 'ARS', balance: '0', organizationId: ORG_ID,
  }).returning();
  ACC_ID = acc.id;

  const [cat] = await db.insert(transactionCategories).values({
    organizationId: ORG_ID, name: 'Comisiones bancarias', type: 'expense', expenseSubtype: 'expense',
  }).returning();
  CAT_EXPENSE_ID = cat.id;
});

after(async () => {
  try { await db.delete(transactions).where(eq(transactions.organizationId, ORG_ID)); } catch {}
  try { await db.delete(paymentMethods).where(eq(paymentMethods.organizationId, ORG_ID)); } catch {}
  try { await db.delete(transactionCategories).where(eq(transactionCategories.organizationId, ORG_ID)); } catch {}
  try { await db.delete(accounts).where(eq(accounts.id, ACC_ID)); } catch {}
  try { await db.delete(organizations).where(eq(organizations.id, ORG_ID)); } catch {}
  try { await db.delete(users).where(eq(users.id, USER_ID)); } catch {}
});

beforeEach(async () => {
  await db.delete(transactions).where(eq(transactions.organizationId, ORG_ID));
  await db.delete(paymentMethods).where(eq(paymentMethods.organizationId, ORG_ID));
  await db.update(accounts).set({ balance: '0' }).where(eq(accounts.id, ACC_ID));
});

async function createSampleMethod(name = 'MercadoPago test') {
  return await storage.createPaymentMethodWithConcepts(
    { organizationId: ORG_ID, name, isActive: true },
    [
      { name: 'Comisión 2%', kind: 'percentage', value: '2', expenseCategoryId: CAT_EXPENSE_ID, position: 0 },
      { name: 'IIBB 4%', kind: 'percentage', value: '4', expenseCategoryId: null, position: 1 },
      { name: 'Costo fijo', kind: 'fixed', value: '100', expenseCategoryId: null, position: 2 },
    ],
  );
}

describe('Payment Methods — Storage CRUD', () => {
  it('creates a method with concepts and reads them back', async () => {
    const created = await createSampleMethod();
    assert.equal(created.organizationId, ORG_ID);
    assert.equal(created.concepts.length, 3);
    assert.equal(created.concepts[0].name, 'Comisión 2%');
    assert.equal(created.concepts[0].position, 0);
    assert.equal(created.concepts[2].kind, 'fixed');

    const read = await storage.getPaymentMethodWithConcepts(created.id);
    assert.equal(read?.id, created.id);
    assert.equal(read?.concepts.length, 3);
  });

  it('lists methods and filters by activeOnly', async () => {
    const m1 = await createSampleMethod('Método A');
    const m2 = await createSampleMethod('Método B');
    await storage.updatePaymentMethodWithConcepts(m2.id, { isActive: false });

    const all = await storage.getPaymentMethodsByOrganization(ORG_ID);
    assert.equal(all.length, 2);
    const activeOnly = await storage.getPaymentMethodsByOrganization(ORG_ID, true);
    assert.equal(activeOnly.length, 1);
    assert.equal(activeOnly[0].id, m1.id);
  });

  it('replaces concepts on update (replace strategy)', async () => {
    const created = await createSampleMethod();
    const updated = await storage.updatePaymentMethodWithConcepts(
      created.id,
      { name: 'Renamed' },
      [{ name: 'Único concepto', kind: 'percentage', value: '5', expenseCategoryId: null, position: 0 }],
    );
    assert.equal(updated?.name, 'Renamed');
    assert.equal(updated?.concepts.length, 1);
    assert.equal(updated?.concepts[0].name, 'Único concepto');
  });

  it('deletes method and cascades concepts', async () => {
    const created = await createSampleMethod();
    const ok = await storage.deletePaymentMethod(created.id);
    assert.equal(ok, true);
    const after = await storage.getPaymentMethodWithConcepts(created.id);
    assert.equal(after, undefined);
    const orphanConcepts = await db.select().from(paymentMethodConcepts).where(eq(paymentMethodConcepts.paymentMethodId, created.id));
    assert.equal(orphanConcepts.length, 0);
  });
});

describe('Payment Methods — Atomic creation of parent + children', () => {
  it('income parent generates expense children with correct amounts and balance impact', async () => {
    const method = await createSampleMethod();
    const { parent, children } = await storage.createTransactionWithPaymentMethodChildren(
      {
        type: 'income',
        amount: '10000',
        description: 'Venta test',
        category: 'Ventas',
        date: new Date(),
        imputationDate: new Date(),
        accountId: ACC_ID,
        organizationId: ORG_ID,
        currency: 'ARS',
        hasInvoice: false,
        status: 'completed',
        createdBy: USER_ID,
        createdVia: 'web',
        assetType: 'operative',
        paymentMethodId: method.id,
        isUniquePayment: true,
        isRecurring: false,
        transactionNumber: `T-${TAG}-PARENT`,
      } as any,
      method,
      { childTransactionNumbers: [`T-${TAG}-C1`, `T-${TAG}-C2`, `T-${TAG}-C3`] },
    );

    assert.equal(parent.type, 'income');
    assert.equal(parent.paymentMethodId, method.id);
    assert.equal(children.length, 3);
    assert.equal(children.every(c => c.type === 'expense'), true);
    assert.equal(children.every(c => c.status === 'completed'), true);
    assert.equal(children.every(c => c.linkedTransactionId === parent.id), true);

    const amounts = children.map(c => parseFloat(c.amount)).sort((a, b) => a - b);
    // 2% of 10000 = 200, 4% of 10000 = 400, fixed = 100
    assert.deepEqual(amounts, [100, 200, 400]);

    const [acc] = await db.select().from(accounts).where(eq(accounts.id, ACC_ID));
    // +10000 income, -200 -400 -100 expenses = +9300
    assert.equal(parseFloat(acc.balance), 9300);
  });

  it('receivable parent generates pending payable children', async () => {
    const method = await createSampleMethod();
    const { parent, children } = await storage.createTransactionWithPaymentMethodChildren(
      {
        type: 'receivable',
        amount: '5000',
        description: 'Cuenta a cobrar',
        category: 'Ventas',
        date: new Date(),
        imputationDate: new Date(),
        accountId: ACC_ID,
        organizationId: ORG_ID,
        currency: 'ARS',
        hasInvoice: false,
        status: 'scheduled',
        createdBy: USER_ID,
        createdVia: 'web',
        assetType: 'operative',
        paymentMethodId: method.id,
        isUniquePayment: true,
        isRecurring: false,
        transactionNumber: `T-${TAG}-RPAR`,
      } as any,
      method,
      { childTransactionNumbers: [`T-${TAG}-RC1`, `T-${TAG}-RC2`, `T-${TAG}-RC3`] },
    );

    assert.equal(parent.type, 'receivable');
    assert.equal(parent.status, 'scheduled');
    assert.equal(children.length, 3);
    assert.equal(children.every(c => c.type === 'payable'), true);
    assert.equal(children.every(c => c.status === 'scheduled'), true);

    // Pending parents/children must NOT touch the account balance.
    const [acc] = await db.select().from(accounts).where(eq(accounts.id, ACC_ID));
    assert.equal(parseFloat(acc.balance), 0);
  });

  it('rejects non-income/receivable parent type', async () => {
    const method = await createSampleMethod();
    await assert.rejects(() => storage.createTransactionWithPaymentMethodChildren(
      {
        type: 'expense',
        amount: '100',
        description: 'no',
        category: 'Test',
        date: new Date(),
        imputationDate: new Date(),
        accountId: ACC_ID,
        organizationId: ORG_ID,
        currency: 'ARS',
        hasInvoice: false,
        status: 'completed',
        createdBy: USER_ID,
        createdVia: 'web',
        assetType: 'operative',
        paymentMethodId: method.id,
        isUniquePayment: true,
        isRecurring: false,
        transactionNumber: `T-${TAG}-BAD`,
      } as any,
      method,
      { childTransactionNumbers: [] },
    ), /income or receivable/);
  });
});

describe('Payment Methods — getPaymentMethodChildren self-join', () => {
  it('only returns children whose parent has paymentMethodId set', async () => {
    const method = await createSampleMethod();
    const { parent, children } = await storage.createTransactionWithPaymentMethodChildren(
      {
        type: 'receivable',
        amount: '1000',
        description: 'Self-join test',
        category: 'Ventas',
        date: new Date(),
        imputationDate: new Date(),
        accountId: ACC_ID,
        organizationId: ORG_ID,
        currency: 'ARS',
        hasInvoice: false,
        status: 'scheduled',
        createdBy: USER_ID,
        createdVia: 'web',
        assetType: 'operative',
        paymentMethodId: method.id,
        isUniquePayment: true,
        isRecurring: false,
        transactionNumber: `T-${TAG}-SJ`,
      } as any,
      method,
      { childTransactionNumbers: [`T-${TAG}-SJ1`, `T-${TAG}-SJ2`, `T-${TAG}-SJ3`] },
    );

    const found = await storage.getPaymentMethodChildren(parent.id);
    assert.equal(found.length, 3);
    const foundIds = new Set(found.map(c => c.id));
    for (const c of children) {
      assert.equal(foundIds.has(c.id), true);
    }

    // Now create an unrelated parent without paymentMethodId, with a manual
    // child linked via linkedTransactionId. getPaymentMethodChildren MUST NOT
    // include it because the parent is not a payment-method parent.
    const [otherParent] = await db.insert(transactions).values({
      type: 'receivable',
      amount: '500',
      description: 'Unrelated parent',
      category: 'Otros',
      date: new Date(),
      imputationDate: new Date(),
      accountId: ACC_ID,
      organizationId: ORG_ID,
      currency: 'ARS',
      hasInvoice: false,
      status: 'scheduled',
      createdBy: USER_ID,
      createdVia: 'web',
      assetType: 'operative',
      isUniquePayment: true,
      isRecurring: false,
      transactionNumber: `T-${TAG}-OP`,
    } as any).returning();
    await db.insert(transactions).values({
      type: 'payable',
      amount: '50',
      description: 'Manual child',
      category: 'Otros',
      date: new Date(),
      imputationDate: new Date(),
      accountId: ACC_ID,
      organizationId: ORG_ID,
      currency: 'ARS',
      hasInvoice: false,
      status: 'scheduled',
      createdBy: USER_ID,
      createdVia: 'web',
      assetType: 'operative',
      linkedTransactionId: otherParent.id,
      isUniquePayment: true,
      isRecurring: false,
      transactionNumber: `T-${TAG}-OPC`,
    } as any);
    const foundEmpty = await storage.getPaymentMethodChildren(otherParent.id);
    assert.equal(foundEmpty.length, 0);
  });
});

describe('Payment Methods — Propagation of collection to children', () => {
  async function setupReceivableWithChildren(parentAmount = '10000') {
    const method = await createSampleMethod();
    const { parent, children } = await storage.createTransactionWithPaymentMethodChildren(
      {
        type: 'receivable',
        amount: parentAmount,
        description: 'Propagation test',
        category: 'Ventas',
        date: new Date(),
        imputationDate: new Date(),
        accountId: ACC_ID,
        organizationId: ORG_ID,
        currency: 'ARS',
        hasInvoice: false,
        status: 'scheduled',
        createdBy: USER_ID,
        createdVia: 'web',
        assetType: 'operative',
        paymentMethodId: method.id,
        isUniquePayment: true,
        isRecurring: false,
        transactionNumber: `T-${TAG}-PROP-${Math.random().toString(36).slice(2, 7)}`,
      } as any,
      method,
      { childTransactionNumbers: children3Numbers() },
    );
    return { method, parent, children };
  }

  function children3Numbers() {
    return [
      `T-${TAG}-CN-${Math.random().toString(36).slice(2, 7)}`,
      `T-${TAG}-CN-${Math.random().toString(36).slice(2, 7)}`,
      `T-${TAG}-CN-${Math.random().toString(36).slice(2, 7)}`,
    ];
  }

  it('full collection (ratio=1) marks all children completed and impacts the account balance', async () => {
    const { parent, children } = await setupReceivableWithChildren();
    // Account starts at 0 because all rows were pending.
    const [accBefore] = await db.select().from(accounts).where(eq(accounts.id, ACC_ID));
    assert.equal(parseFloat(accBefore.balance), 0);

    const sumChildAmounts = children.reduce((s, c) => s + parseFloat(c.amount), 0);
    assert.equal(sumChildAmounts, 700); // 200 + 400 + 100

    const result = await storage.propagateCollectionToPaymentMethodChildren(
      parent.id, 1, USER_ID, parent.id,
    );
    assert.equal(result.completedChildren.length, 3);
    assert.equal(result.updatedChildren.length, 0);

    const dbChildren = await storage.getPaymentMethodChildren(parent.id);
    assert.equal(dbChildren.every(c => c.status === 'completed'), true);
    assert.equal(dbChildren.every(c => c.completedBy === USER_ID), true);
    assert.equal(dbChildren.every(c => c.autoAppliedByTransactionId === parent.id), true);

    const [accAfter] = await db.select().from(accounts).where(eq(accounts.id, ACC_ID));
    // Children are payable→ account decreases by 700.
    assert.equal(parseFloat(accAfter.balance), -700);
  });

  it('partial collection (ratio=0.5) scales child amounts and leaves them pending', async () => {
    const { parent, children } = await setupReceivableWithChildren();
    const result = await storage.propagateCollectionToPaymentMethodChildren(
      parent.id, 0.5, USER_ID, parent.id,
    );
    assert.equal(result.completedChildren.length, 0);
    assert.equal(result.updatedChildren.length, 3);

    const dbChildren = await storage.getPaymentMethodChildren(parent.id);
    assert.equal(dbChildren.every(c => c.status === 'scheduled'), true);
    const newAmounts = dbChildren.map(c => parseFloat(c.amount)).sort((a, b) => a - b);
    // Original 100, 200, 400 → after 50% remaining = 50, 100, 200
    assert.deepEqual(newAmounts, [50, 100, 200]);

    // originalAmount must be tracked for at least one of the children so that
    // the UI can show "X de Y" on partial states. We accept either the original
    // string or null fallback to current — but at least one row should have
    // originalAmount populated.
    const withOriginal = dbChildren.filter(c => !!c.originalAmount);
    assert.equal(withOriginal.length, 3);

    // Account balance is unchanged on partial collection.
    const [acc] = await db.select().from(accounts).where(eq(accounts.id, ACC_ID));
    assert.equal(parseFloat(acc.balance), 0);
  });

  it('successive partials (0.5 then full) end with completed children and correct balance impact', async () => {
    const { parent } = await setupReceivableWithChildren();
    await storage.propagateCollectionToPaymentMethodChildren(parent.id, 0.5, USER_ID, parent.id);
    // Now remaining child amounts are 50/100/200 = total 350.
    const result = await storage.propagateCollectionToPaymentMethodChildren(parent.id, 1, USER_ID, parent.id);
    assert.equal(result.completedChildren.length, 3);

    const [acc] = await db.select().from(accounts).where(eq(accounts.id, ACC_ID));
    // The second pass charges the *current* (already-scaled) amounts → -350.
    assert.equal(parseFloat(acc.balance), -350);
  });

  it('ignores non-positive ratios (no-op)', async () => {
    const { parent } = await setupReceivableWithChildren();
    const r1 = await storage.propagateCollectionToPaymentMethodChildren(parent.id, 0, USER_ID, parent.id);
    assert.equal(r1.completedChildren.length, 0);
    assert.equal(r1.updatedChildren.length, 0);
    const r2 = await storage.propagateCollectionToPaymentMethodChildren(parent.id, -1, USER_ID, parent.id);
    assert.equal(r2.completedChildren.length, 0);
    assert.equal(r2.updatedChildren.length, 0);
    const r3 = await storage.propagateCollectionToPaymentMethodChildren(parent.id, NaN, USER_ID, parent.id);
    assert.equal(r3.completedChildren.length, 0);

    const dbChildren = await storage.getPaymentMethodChildren(parent.id);
    assert.equal(dbChildren.every(c => c.status === 'scheduled'), true);
  });

  it('skips already-completed children on a second full propagation (no double impact)', async () => {
    const { parent } = await setupReceivableWithChildren();
    await storage.propagateCollectionToPaymentMethodChildren(parent.id, 1, USER_ID, parent.id);
    const [accAfterFirst] = await db.select().from(accounts).where(eq(accounts.id, ACC_ID));
    assert.equal(parseFloat(accAfterFirst.balance), -700);

    const second = await storage.propagateCollectionToPaymentMethodChildren(parent.id, 1, USER_ID, parent.id);
    assert.equal(second.completedChildren.length, 0);
    const [accAfterSecond] = await db.select().from(accounts).where(eq(accounts.id, ACC_ID));
    assert.equal(parseFloat(accAfterSecond.balance), -700);
  });
});
