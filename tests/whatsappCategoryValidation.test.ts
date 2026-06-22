import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createWhatsAppTransaction, resolveSmartDefaults } from '../server/routes/whatsapp';
import { storage } from '../server/storage';

// Task #286 — `createWhatsAppTransaction` es el único write-path del bot. La
// columna `transactions.category` es NOT NULL en la base; antes el bot caía a
// `null` cuando la AI inventaba una categoría inexistente (ej. "General"),
// rompía el INSERT con 23502 y se quedaba mudo dejando al usuario sin la
// transacción. Este test pinea el nuevo contrato:
//   - válida → canonical del catálogo
//   - inválida → primera categoría del catálogo de la org compatible con el
//     tipo (preferentemente "Otros ingresos" / "Otros gastos" si existen)
//   - org sin categorías → seed defaults y elegir una válida
//   - null/empty/whitespace → mismo fallback de catálogo (NUNCA null para
//     non-transfer)
//   - transfers → exentos del catálogo

const ORG = 'org-wa-test';
const USER = 'user-wa-test';

type CatRow = { id: string; organizationId: string; name: string; type: 'income' | 'expense' };

let CATS: CatRow[] = [];
let CREATED: any[] = [];
let SEED_CALLS: Array<{ organizationId: string; userId?: string }> = [];

const ORIG: Record<string, any> = {};

before(() => {
  ORIG.getTransactionCategoriesByOrganization = (storage as any).getTransactionCategoriesByOrganization;
  ORIG.createTransaction = (storage as any).createTransaction;
  ORIG.seedDefaultCategories = (storage as any).seedDefaultCategories;

  (storage as any).getTransactionCategoriesByOrganization = async (
    organizationId: string,
    type?: 'income' | 'expense',
  ) => CATS.filter(c => c.organizationId === organizationId && (!type || c.type === type));

  (storage as any).createTransaction = async (data: any) => {
    const created = { id: `tx-${CREATED.length + 1}`, ...data };
    CREATED.push(created);
    return created;
  };

  (storage as any).seedDefaultCategories = async (organizationId: string, userId?: string) => {
    SEED_CALLS.push({ organizationId, userId });
    const seeded: CatRow[] = [
      { id: `seed-i1-${SEED_CALLS.length}`, organizationId, name: 'Ventas',         type: 'income' },
      { id: `seed-i2-${SEED_CALLS.length}`, organizationId, name: 'Otros ingresos', type: 'income' },
      { id: `seed-e1-${SEED_CALLS.length}`, organizationId, name: 'Proveedores',    type: 'expense' },
      { id: `seed-e2-${SEED_CALLS.length}`, organizationId, name: 'Otros gastos',   type: 'expense' },
    ];
    CATS.push(...seeded);
    return seeded;
  };
});

after(() => {
  (storage as any).getTransactionCategoriesByOrganization = ORIG.getTransactionCategoriesByOrganization;
  (storage as any).createTransaction = ORIG.createTransaction;
  (storage as any).seedDefaultCategories = ORIG.seedDefaultCategories;
});

beforeEach(() => {
  CATS = [
    { id: 'c1', organizationId: ORG, name: 'Ventas Mayoristas',  type: 'income' },
    { id: 'c2', organizationId: ORG, name: 'Otros ingresos',     type: 'income' },
    { id: 'c3', organizationId: ORG, name: 'Servicios Públicos', type: 'expense' },
    { id: 'c4', organizationId: ORG, name: 'Otros gastos',       type: 'expense' },
  ];
  CREATED = [];
  SEED_CALLS = [];
});

function baseTx(overrides: any = {}) {
  return {
    type: 'income',
    amount: '100',
    currency: 'ARS',
    description: 'WA test',
    date: new Date('2026-05-10'),
    imputationDate: new Date('2026-05-10'),
    organizationId: ORG,
    status: 'completed',
    createdBy: USER,
    ...overrides,
  } as any;
}

describe('createWhatsAppTransaction — resolución de categoría (Task #286)', () => {
  it('canoniza el casing cuando la categoría sugerida existe en el catálogo', async () => {
    const created = await createWhatsAppTransaction(
      baseTx({ category: 'ventas mayoristas' }),
      USER,
    );
    assert.equal(created.category, 'Ventas Mayoristas');
    assert.equal(CREATED[0].category, 'Ventas Mayoristas');
  });

  it('cuando la sugerida no existe, cae a "Otros ingresos"/"Otros gastos" del catálogo (no a null)', async () => {
    // El bug reportado: la AI sugirió "General" para un gasto y el bot
    // metía null → 23502. Ahora debe caer a "Otros gastos" sin avisar.
    const expense = await createWhatsAppTransaction(
      baseTx({ type: 'expense', category: 'General' }),
      USER,
    );
    assert.equal(expense.category, 'Otros gastos');
    assert.notEqual(expense.category, null);
    assert.equal(CREATED[0].category, 'Otros gastos');

    const income = await createWhatsAppTransaction(
      baseTx({ type: 'income', category: 'Categoría Fantasma' }),
      USER,
    );
    assert.equal(income.category, 'Otros ingresos');
  });

  it('si la categoría existe pero del tipo equivocado, también cae al fallback (no a null)', async () => {
    // "Servicios Públicos" sólo existe como expense; pedirla en un income
    // debe descartarse y resolver a "Otros ingresos".
    const created = await createWhatsAppTransaction(
      baseTx({ type: 'income', category: 'Servicios Públicos' }),
      USER,
    );
    assert.equal(created.category, 'Otros ingresos');
    assert.notEqual(created.category, null);
  });

  it('null/empty/whitespace también caen al fallback del catálogo (nunca null)', async () => {
    const a = await createWhatsAppTransaction(baseTx({ type: 'expense', category: null }), USER);
    assert.equal(a.category, 'Otros gastos');
    const b = await createWhatsAppTransaction(baseTx({ type: 'expense', category: '' }), USER);
    assert.equal(b.category, 'Otros gastos');
    const c = await createWhatsAppTransaction(baseTx({ type: 'expense', category: '   ' }), USER);
    assert.equal(c.category, 'Otros gastos');
    assert.equal(CREATED.length, 3);
    for (const row of CREATED) {
      assert.notEqual(row.category, null);
      assert.equal(row.category, 'Otros gastos');
    }
  });

  it('mapea receivable → catálogo income y payable → catálogo expense', async () => {
    const recv = await createWhatsAppTransaction(
      baseTx({ type: 'receivable', category: 'VENTAS mayoristas' }),
      USER,
    );
    assert.equal(recv.category, 'Ventas Mayoristas');

    const pay = await createWhatsAppTransaction(
      baseTx({ type: 'payable', category: 'servicios PÚBLICOS' }),
      USER,
    );
    assert.equal(pay.category, 'Servicios Públicos');
  });

  it('si la org no tiene NINGUNA categoría del tipo, sembra defaults y elige una válida', async () => {
    // Vaciamos el catálogo de la org y confirmamos un gasto.
    CATS = [];

    const created = await createWhatsAppTransaction(
      baseTx({ type: 'expense', category: 'General' }),
      USER,
    );

    assert.equal(SEED_CALLS.length, 1, 'debe haber sembrado defaults una vez');
    assert.equal(SEED_CALLS[0].organizationId, ORG);
    assert.equal(SEED_CALLS[0].userId, USER);
    assert.equal(created.category, 'Otros gastos');
    assert.notEqual(created.category, null);
    assert.equal(CREATED.length, 1);
    assert.equal(CREATED[0].category, 'Otros gastos');
  });

  it('si una org tiene categorías sólo de un tipo distinto, sembra los defaults faltantes', async () => {
    // Org con sólo expense; pedimos un income → debe sembrar los income defaults.
    CATS = [{ id: 'cx1', organizationId: ORG, name: 'Servicios Públicos', type: 'expense' }];

    const created = await createWhatsAppTransaction(
      baseTx({ type: 'income', category: 'General' }),
      USER,
    );

    assert.equal(SEED_CALLS.length, 1);
    assert.equal(created.category, 'Otros ingresos');
  });

  it('reintenta una vez con fallback cuando el INSERT explota con 23502 en category', async () => {
    // Simulamos drift schema/DB: el primer INSERT explota igual con 23502
    // sobre `category`. El resolver debe atrapar el error y reintentar con
    // un fallback bulletproof para no perder la transacción.
    let calls = 0;
    (storage as any).createTransaction = async (data: any) => {
      calls += 1;
      if (calls === 1) {
        const err: any = new Error('null value in column "category" of relation "transactions" violates not-null constraint');
        err.code = '23502';
        err.column = 'category';
        throw err;
      }
      const created = { id: `tx-${calls}`, ...data };
      CREATED.push(created);
      return created;
    };

    try {
      const created = await createWhatsAppTransaction(
        baseTx({ type: 'expense', category: 'General' }),
        USER,
      );
      assert.equal(calls, 2, 'debe reintentar exactamente una vez');
      assert.notEqual(created.category, null);
      assert.equal(created.category, 'Otros gastos');
    } finally {
      // Restaurar para los demás tests del describe.
      (storage as any).createTransaction = async (data: any) => {
        const created = { id: `tx-${CREATED.length + 1}`, ...data };
        CREATED.push(created);
        return created;
      };
    }
  });
});

// Pre-confirm summary contract: el bot le muestra al usuario el resumen
// ANTES de que confirme. Si la categoría que mostramos ahí fuese la inventada
// por la IA ("General"), el usuario diría "sí" pensando que se va a guardar
// con esa etiqueta y después vería otra distinta. `resolveSmartDefaults`
// tiene que devolver siempre una categoría que exista en el catálogo de la
// org, así el resumen pre-confirm refleja la categoría real que se va a
// persistir.
describe('resolveSmartDefaults — categoría siempre del catálogo (Task #286)', () => {
  it('expense con categoría inventada cae a "Otros gastos" del catálogo en el resumen pre-confirm', async () => {
    const smart = await resolveSmartDefaults(
      USER, ORG, 'expense',
      'café con un amigo', null, null,
      [{ id: 'a1', name: 'Caja', currency: 'ARS' }],
      'General',
    );
    assert.equal(smart.category, 'Otros gastos');
    assert.equal(smart.sources.category, 'auto');
  });

  it('income con categoría inventada cae a "Otros ingresos" del catálogo en el resumen pre-confirm', async () => {
    const smart = await resolveSmartDefaults(
      USER, ORG, 'income',
      'venta', null, null,
      [{ id: 'a1', name: 'Caja', currency: 'ARS' }],
      'General',
    );
    assert.equal(smart.category, 'Otros ingresos');
    assert.equal(smart.sources.category, 'auto');
  });

  it('org sin categorías: sembra defaults y devuelve una válida (nunca "General")', async () => {
    CATS = []; // org vacía
    const smart = await resolveSmartDefaults(
      USER, ORG, 'expense',
      'almuerzo', null, null,
      [{ id: 'a1', name: 'Caja', currency: 'ARS' }],
      'General',
    );
    assert.equal(smart.category, 'Otros gastos');
    assert.equal(SEED_CALLS.length, 1, 'debe sembrar defaults una vez');
  });

  it('respeta una categoría que sí existe en el catálogo (canoniza casing)', async () => {
    const smart = await resolveSmartDefaults(
      USER, ORG, 'expense',
      'luz', null, null,
      [{ id: 'a1', name: 'Caja', currency: 'ARS' }],
      'servicios públicos',
    );
    assert.equal(smart.category, 'Servicios Públicos');
  });
});
