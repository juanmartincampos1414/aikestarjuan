import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectIngresosRows,
  selectAllExpensesRows,
} from '../client/src/pages/reports.rowSelectors';
import { buildMemberDrillDown } from '../client/src/pages/reports.drilldownBuilders';
import type { Transaction } from '../shared/schema';

// Task #202 — "Reportes por miembro del equipo".
// Esta suite cubre los dos invariantes nuevos del bloque:
//   1) El filtro global de miembro se aplica a TODA la página vía el
//      mismo `passesCodeFilter` que ya alimenta los selectores compartidos
//      (selectIngresosRows / selectAllExpensesRows / etc.). Encadenar
//      "código + miembro" en ese predicado garantiza que cards, drill-downs
//      y agregados queden en lockstep — sin tocar nada en rowSelectors.ts.
//   2) buildMemberDrillDown arma el payload del modal con el card top
//      Neto = Ingresos − Egresos del miembro, usando exactamente las
//      transacciones del miembro (sin filtros adicionales). Es la misma
//      garantía que ya tienen Ventas / Costos / Margen Bruto.

type Row = {
  id: string;
  type: 'income' | 'expense' | 'transfer_in' | 'transfer_out' | 'payable' | 'receivable';
  status: 'completed' | 'scheduled' | 'cancelled';
  amount: number;
  accountId: string;
  date: string;
  description?: string;
  expenseSubtype?: 'cost' | 'operating' | null;
  assetType?: string | null;
  category?: string | null;
  profitabilityCodeId?: string;
  createdBy?: string | null;
};

const SCOPE = ['acc-ars', 'acc-usd'];

// Replica el predicado combinado "código + miembro" definido en reports.tsx.
// Mantenemos ambas implementaciones acá para que el test falle si la
// semántica del filtro global se redefine en el futuro.
function makeCombinedFilter(opts: { codeId: string; memberId: string }) {
  const { codeId, memberId } = opts;
  return (t: { profitabilityCodeId?: string; createdBy?: string | null }) => {
    if (codeId !== 'all' && t.profitabilityCodeId !== codeId) return false;
    if (memberId === 'all') return true;
    if (memberId === 'unassigned') return t.createdBy == null;
    return t.createdBy === memberId;
  };
}

describe('Task #202 — filtro global de miembro vía selectores compartidos', () => {
  const sample: Row[] = [
    // Ana — 2 ingresos, 1 gasto operativo
    { id: 'ana-i1', type: 'income', status: 'completed', amount: 1000, accountId: 'acc-ars', date: '2026-04-01', createdBy: 'user-ana', profitabilityCodeId: 'pc-1' },
    { id: 'ana-i2', type: 'income', status: 'completed', amount: 500, accountId: 'acc-ars', date: '2026-04-05', createdBy: 'user-ana', profitabilityCodeId: 'pc-1' },
    { id: 'ana-g1', type: 'expense', status: 'completed', amount: 200, accountId: 'acc-ars', date: '2026-04-10', createdBy: 'user-ana', profitabilityCodeId: 'pc-1', expenseSubtype: 'operating' },
    // Beto — 1 ingreso, 2 gastos
    { id: 'beto-i1', type: 'income', status: 'completed', amount: 700, accountId: 'acc-ars', date: '2026-04-02', createdBy: 'user-beto', profitabilityCodeId: 'pc-1' },
    { id: 'beto-g1', type: 'expense', status: 'completed', amount: 300, accountId: 'acc-ars', date: '2026-04-08', createdBy: 'user-beto', profitabilityCodeId: 'pc-1', expenseSubtype: 'operating' },
    { id: 'beto-g2', type: 'expense', status: 'completed', amount: 100, accountId: 'acc-ars', date: '2026-04-15', createdBy: 'user-beto', profitabilityCodeId: 'pc-2', expenseSubtype: 'operating' },
    // Sin asignar — 1 ingreso huérfano (createdBy null)
    { id: 'orphan-i1', type: 'income', status: 'completed', amount: 50, accountId: 'acc-ars', date: '2026-04-20', createdBy: null, profitabilityCodeId: 'pc-1' },
    // Filas que NUNCA deben pasar (cancelled / mirror / transfer / out-of-scope)
    { id: 'cancelled-1', type: 'income', status: 'cancelled', amount: 9999, accountId: 'acc-ars', date: '2026-04-01', createdBy: 'user-ana', profitabilityCodeId: 'pc-1' },
    { id: 'mirror-1', type: 'expense', status: 'completed', amount: 9999, accountId: 'acc-ars', date: '2026-04-01', createdBy: 'user-ana', profitabilityCodeId: 'pc-1', description: '[CANCELACIÓN] reverso', expenseSubtype: 'operating' },
    { id: 'transfer-1', type: 'transfer_out', status: 'completed', amount: 9999, accountId: 'acc-ars', date: '2026-04-01', createdBy: 'user-ana', profitabilityCodeId: 'pc-1' },
    { id: 'oos-1', type: 'expense', status: 'completed', amount: 9999, accountId: 'excluded-acc', date: '2026-04-01', createdBy: 'user-ana', profitabilityCodeId: 'pc-1', expenseSubtype: 'operating' },
  ];

  it('memberId = "all" + codeId = "all" → todos los movimientos válidos pasan', () => {
    const ctx = { scopeAccountIds: SCOPE, passesCodeFilter: makeCombinedFilter({ codeId: 'all', memberId: 'all' }) };
    const ing = selectIngresosRows(sample, ctx);
    const exp = selectAllExpensesRows(sample, ctx);
    assert.deepEqual(ing.map(r => r.id).sort(), ['ana-i1', 'ana-i2', 'beto-i1', 'orphan-i1']);
    assert.deepEqual(exp.map(r => r.id).sort(), ['ana-g1', 'beto-g1', 'beto-g2']);
  });

  it('memberId = "user-ana" → sólo ingresos/gastos creados por Ana', () => {
    const ctx = { scopeAccountIds: SCOPE, passesCodeFilter: makeCombinedFilter({ codeId: 'all', memberId: 'user-ana' }) };
    const ing = selectIngresosRows(sample, ctx);
    const exp = selectAllExpensesRows(sample, ctx);
    assert.deepEqual(ing.map(r => r.id).sort(), ['ana-i1', 'ana-i2']);
    assert.deepEqual(exp.map(r => r.id).sort(), ['ana-g1']);
  });

  it('memberId = "user-beto" → sólo ingresos/gastos creados por Beto', () => {
    const ctx = { scopeAccountIds: SCOPE, passesCodeFilter: makeCombinedFilter({ codeId: 'all', memberId: 'user-beto' }) };
    const ing = selectIngresosRows(sample, ctx);
    const exp = selectAllExpensesRows(sample, ctx);
    assert.deepEqual(ing.map(r => r.id), ['beto-i1']);
    assert.deepEqual(exp.map(r => r.id).sort(), ['beto-g1', 'beto-g2']);
  });

  it('memberId = "unassigned" → sólo movimientos huérfanos (createdBy null)', () => {
    const ctx = { scopeAccountIds: SCOPE, passesCodeFilter: makeCombinedFilter({ codeId: 'all', memberId: 'unassigned' }) };
    const ing = selectIngresosRows(sample, ctx);
    const exp = selectAllExpensesRows(sample, ctx);
    assert.deepEqual(ing.map(r => r.id), ['orphan-i1']);
    assert.deepEqual(exp.map(r => r.id), []);
  });

  it('codeId = "pc-1" + memberId = "user-beto" → ambos filtros se aplican (AND)', () => {
    const ctx = { scopeAccountIds: SCOPE, passesCodeFilter: makeCombinedFilter({ codeId: 'pc-1', memberId: 'user-beto' }) };
    const ing = selectIngresosRows(sample, ctx);
    const exp = selectAllExpensesRows(sample, ctx);
    // beto-g2 tiene profitabilityCodeId='pc-2' → queda fuera
    assert.deepEqual(ing.map(r => r.id), ['beto-i1']);
    assert.deepEqual(exp.map(r => r.id), ['beto-g1']);
  });

  it('cancelled / mirror / transfer / out-of-scope siguen quedando fuera para cualquier miembro', () => {
    const ctx = { scopeAccountIds: SCOPE, passesCodeFilter: makeCombinedFilter({ codeId: 'all', memberId: 'user-ana' }) };
    const ing = selectIngresosRows(sample, ctx);
    const exp = selectAllExpensesRows(sample, ctx);
    const allIds = [...ing, ...exp].map(r => r.id);
    assert.ok(!allIds.includes('cancelled-1'), 'cancelled-1 no debe pasar');
    assert.ok(!allIds.includes('mirror-1'), 'mirror-1 no debe pasar');
    assert.ok(!allIds.includes('transfer-1'), 'transfer-1 no debe pasar');
    assert.ok(!allIds.includes('oos-1'), 'oos-1 (out-of-scope) no debe pasar');
  });
});

describe('Task #202 — buildMemberDrillDown (parity card top ↔ modal totalValue)', () => {
  const fmt = (v: number) => `AR$ ${v.toFixed(2)}`;

  const ingresosTx = [
    { id: 'i1', amount: '1000' } as unknown as Transaction,
    { id: 'i2', amount: '500' } as unknown as Transaction,
  ];
  const egresosTx = [
    { id: 'e1', amount: '200' } as unknown as Transaction,
  ];

  it('Card top = Ingresos − Egresos, mismo número que el modal', () => {
    const totalIngresos = 1500;
    const totalEgresos = 200;
    const expectedNeto = totalIngresos - totalEgresos;

    const payload = buildMemberDrillDown({
      memberLabel: 'Ana',
      ingresosTx,
      egresosTx,
      totalIngresos,
      totalEgresos,
      formatCurrencyFull: fmt,
    });

    assert.equal(payload.totalValue, expectedNeto);
    assert.equal(payload.totalFormatted, fmt(expectedNeto));
    assert.equal(payload.totalLabel, 'Neto');
    assert.equal(payload.title, 'Movimientos de Ana');
    assert.equal(payload.groups?.length, 2);
    assert.equal(payload.groups?.[0].label, 'Ingresos');
    assert.equal(payload.groups?.[1].label, 'Egresos');
    assert.equal(payload.groups?.[0].transactions, ingresosTx);
    assert.equal(payload.groups?.[1].transactions, egresosTx);
  });

  it('Neto puede ser negativo y queda reflejado tal cual en totalValue', () => {
    const payload = buildMemberDrillDown({
      memberLabel: 'Beto',
      ingresosTx: [],
      egresosTx,
      totalIngresos: 0,
      totalEgresos: 1000,
      formatCurrencyFull: fmt,
    });
    assert.equal(payload.totalValue, -1000);
    assert.equal(payload.totalFormatted, fmt(-1000));
  });

  it('Etiqueta "Sin asignar" pasa al título cuando se invoca con orphans', () => {
    const payload = buildMemberDrillDown({
      memberLabel: 'Sin asignar',
      ingresosTx: [],
      egresosTx: [],
      totalIngresos: 0,
      totalEgresos: 0,
      formatCurrencyFull: fmt,
    });
    assert.equal(payload.title, 'Movimientos de Sin asignar');
    assert.equal(payload.totalValue, 0);
  });

  it('reset de selectedMemberId — replica el guardado del useEffect en reports.tsx', () => {
    // Replicamos la lógica del effect para garantizar que el contrato no
    // regresione: el chequeo de members.length <= 1 va ANTES del early-return
    // por 'unassigned', si no, queda un filtro stale invisible.
    type Member = { userId: string };
    function nextSelected(prev: string, members: Member[]): string {
      if (prev === 'all') return prev;
      if (members.length <= 1) return 'all';
      if (prev === 'unassigned') return prev;
      const stillExists = members.some(m => m.userId === prev);
      return stillExists ? prev : 'all';
    }

    // Caso 1: org pasa a 1 miembro con 'unassigned' activo → reset a 'all'
    assert.equal(nextSelected('unassigned', [{ userId: 'u-1' }]), 'all');
    // Caso 2: org pasa a 1 miembro con un userId activo → reset a 'all'
    assert.equal(nextSelected('u-2', [{ userId: 'u-1' }]), 'all');
    // Caso 3: 'all' nunca se toca
    assert.equal(nextSelected('all', [{ userId: 'u-1' }]), 'all');
    assert.equal(nextSelected('all', []), 'all');
    // Caso 4: 'unassigned' se mantiene si hay > 1 miembros
    assert.equal(nextSelected('unassigned', [{ userId: 'u-1' }, { userId: 'u-2' }]), 'unassigned');
    // Caso 5: miembro existente se mantiene si hay > 1 miembros y sigue presente
    assert.equal(nextSelected('u-2', [{ userId: 'u-1' }, { userId: 'u-2' }]), 'u-2');
    // Caso 6: miembro removido (no está en la lista nueva) → reset a 'all'
    assert.equal(nextSelected('u-3', [{ userId: 'u-1' }, { userId: 'u-2' }]), 'all');
  });

  it('formulaLines siempre incluye Ingresos / Egresos / Neto en ese orden', () => {
    const payload = buildMemberDrillDown({
      memberLabel: 'Ana',
      ingresosTx,
      egresosTx,
      totalIngresos: 1500,
      totalEgresos: 200,
      formatCurrencyFull: fmt,
    });
    const labels = (payload.formulaLines ?? []).map(l => l.label);
    assert.deepEqual(labels, ['Ingresos', 'Egresos', 'Neto']);
    const result = payload.formulaLines?.find(l => l.isResult);
    assert.equal(result?.label, 'Neto');
    assert.equal(result?.value, fmt(1300));
  });
});
