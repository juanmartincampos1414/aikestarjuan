import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { validateTransactionCategory } from '../server/services/categoryValidation';
import { storage } from '../server/storage';

// Task #255 — Unit tests for the gatekeeper that prevents "phantom" categories
// from being persisted on a transaction. This is the single helper called by
// POST /api/transactions, PATCH /api/transactions/:id, and the WhatsApp bot
// (Task #252); any future endpoint that writes user-facing categories MUST go
// through it. These tests pin its contract so a refactor cannot silently re-
// open the data-integrity hole.

const ORG = 'org-cat-test';

type CatRow = { id: string; organizationId: string; name: string; type: 'income' | 'expense'; expenseSubtype: string };

let CATS: CatRow[] = [];
let ORIG_GET: any;

before(() => {
  ORIG_GET = (storage as any).getTransactionCategoriesByOrganization;
  (storage as any).getTransactionCategoriesByOrganization = async (
    organizationId: string,
    type?: 'income' | 'expense',
  ) => CATS.filter(c => c.organizationId === organizationId && (!type || c.type === type));
});

after(() => {
  (storage as any).getTransactionCategoriesByOrganization = ORIG_GET;
});

beforeEach(() => {
  CATS = [
    { id: 'c1', organizationId: ORG, name: 'Ventas Mayoristas', type: 'income', expenseSubtype: 'income' },
    { id: 'c2', organizationId: ORG, name: 'Honorarios',         type: 'income', expenseSubtype: 'income' },
    { id: 'c3', organizationId: ORG, name: 'Servicios Públicos', type: 'expense', expenseSubtype: 'expense' },
    { id: 'c4', organizationId: ORG, name: 'Insumos',            type: 'expense', expenseSubtype: 'cost' },
  ];
});

describe('validateTransactionCategory — Task #255', () => {
  it('canoniza el casing cuando matchea (income)', async () => {
    const r = await validateTransactionCategory(ORG, 'income', 'ventas mayoristas');
    assert.deepEqual(r, { ok: true, canonical: 'Ventas Mayoristas' });
  });

  it('canoniza el casing cuando matchea (expense)', async () => {
    const r = await validateTransactionCategory(ORG, 'expense', 'SERVICIOS PÚBLICOS');
    assert.deepEqual(r, { ok: true, canonical: 'Servicios Públicos' });
  });

  it('trimea espacios alrededor antes de matchear', async () => {
    const r = await validateTransactionCategory(ORG, 'income', '  Honorarios  ');
    assert.deepEqual(r, { ok: true, canonical: 'Honorarios' });
  });

  it('rechaza una categoría inexistente con ok=false y mensaje claro', async () => {
    const r = await validateTransactionCategory(ORG, 'expense', 'Categoría Fantasma');
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.match(r.message, /Categoría Fantasma/);
      assert.match(r.message, /egreso/);
    }
  });

  it('rechaza si la categoría existe pero del tipo equivocado (income vs expense)', async () => {
    // "Insumos" sólo existe como expense; pedirla como income debe fallar.
    const r = await validateTransactionCategory(ORG, 'income', 'Insumos');
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.match(r.message, /ingreso/);
    }
  });

  it('mapea receivable → catálogo income y payable → catálogo expense', async () => {
    const recv = await validateTransactionCategory(ORG, 'receivable', 'honorarios');
    assert.deepEqual(recv, { ok: true, canonical: 'Honorarios' });
    const pay = await validateTransactionCategory(ORG, 'payable', 'insumos');
    assert.deepEqual(pay, { ok: true, canonical: 'Insumos' });
  });

  it('acepta null/undefined/empty/whitespace como "sin categoría" (canonical=null)', async () => {
    const r1 = await validateTransactionCategory(ORG, 'income', null);
    assert.deepEqual(r1, { ok: true, canonical: null });
    const r2 = await validateTransactionCategory(ORG, 'income', undefined);
    assert.deepEqual(r2, { ok: true, canonical: null });
    const r3 = await validateTransactionCategory(ORG, 'expense', '');
    assert.deepEqual(r3, { ok: true, canonical: null });
    const r4 = await validateTransactionCategory(ORG, 'expense', '   ');
    assert.deepEqual(r4, { ok: true, canonical: null });
  });

  it('exime a transfers (transfer_in / transfer_out) del catálogo', async () => {
    // Las etiquetas server-generated nunca viven en el catálogo, así que el
    // validador debe pasarlas trimeadas sin consultar la base.
    const r1 = await validateTransactionCategory(ORG, 'transfer_in', '  Transferencia Interna  ');
    assert.deepEqual(r1, { ok: true, canonical: 'Transferencia Interna' });
    const r2 = await validateTransactionCategory(ORG, 'transfer_out', 'Cualquier Cosa');
    assert.deepEqual(r2, { ok: true, canonical: 'Cualquier Cosa' });
  });

  it('aísla por organización: una categoría de otra org no matchea', async () => {
    CATS.push({ id: 'cx', organizationId: 'OTRA-ORG', name: 'Ventas Mayoristas', type: 'income', expenseSubtype: 'income' });
    const r = await validateTransactionCategory('org-vacía', 'income', 'Ventas Mayoristas');
    assert.equal(r.ok, false);
  });
});
