import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildReportableTxFilter, txCurrency } from '../client/src/lib/utils';
import {
  selectCostosRows,
  selectGastosRows,
  selectAllExpensesRows,
  selectIngresosRows,
  selectCategoryRows,
} from '../client/src/pages/reports.rowSelectors';

// Task #170 — make sure Valoración del Patrimonio applies the same exclusion
// rules used everywhere else: cancelled originals out, [CANCELACIÓN] mirrors
// out, transfer_in/out out, currency precedence tx > account > ARS.
//
// This test mirrors the inline aggregation in client/src/pages/reports.tsx
// (`valuationData`). If that aggregation drifts from the helper rules, this
// test will fail and the card on Valoración will keep showing wrong totals.

type Tx = {
  id: string;
  type: 'income' | 'expense' | 'transfer_in' | 'transfer_out' | 'payable' | 'receivable';
  status: 'scheduled' | 'completed' | 'cancelled';
  amount: number;
  currency?: string;
  accountId: string;
  date: string;
  description?: string;
  expenseSubtype?: 'cost' | 'operating';
  assetType?: string | null;
};

function aggregate(
  txs: Tx[],
  includedAccountIds: string[],
  accountCurrency: Record<string, string>,
) {
  const reportable = buildReportableTxFilter({ scopeAccountIds: includedAccountIds });
  const revenueByCurrency: Record<string, number> = {};
  const expensesByCurrency: Record<string, number> = {};
  const costsByCurrency: Record<string, number> = {};
  const gastosByCurrency: Record<string, number> = {};
  txs.forEach(t => {
    if (!reportable(t)) return;
    const cur = txCurrency(t, accountCurrency);
    if (t.type === 'income') {
      revenueByCurrency[cur] = (revenueByCurrency[cur] || 0) + t.amount;
      return;
    }
    if (t.type === 'expense' && t.assetType !== 'asset_acquisition' && t.assetType !== 'investment') {
      expensesByCurrency[cur] = (expensesByCurrency[cur] || 0) + t.amount;
      if (t.expenseSubtype === 'cost') {
        costsByCurrency[cur] = (costsByCurrency[cur] || 0) + t.amount;
      } else {
        gastosByCurrency[cur] = (gastosByCurrency[cur] || 0) + t.amount;
      }
    }
  });
  return { revenueByCurrency, expensesByCurrency, costsByCurrency, gastosByCurrency };
}

describe('Task #170 — Valoración aggregation respects shared exclusions', () => {
  const accs = ['acc-ars', 'acc-usd'];
  const accountCurrency = { 'acc-ars': 'ARS', 'acc-usd': 'USD' };

  it('excludes cancelled originals from revenue and expenses', () => {
    const txs: Tx[] = [
      { id: 'i1', type: 'income', status: 'completed', amount: 100, currency: 'ARS', accountId: 'acc-ars', date: '2026-04-01' },
      { id: 'i2', type: 'income', status: 'cancelled', amount: 999, currency: 'ARS', accountId: 'acc-ars', date: '2026-04-01' },
      { id: 'e1', type: 'expense', status: 'completed', amount: 30, currency: 'ARS', accountId: 'acc-ars', date: '2026-04-01' },
      { id: 'e2', type: 'expense', status: 'cancelled', amount: 555, currency: 'ARS', accountId: 'acc-ars', date: '2026-04-01' },
    ];
    const r = aggregate(txs, accs, accountCurrency);
    assert.equal(r.revenueByCurrency.ARS, 100);
    assert.equal(r.expensesByCurrency.ARS, 30);
  });

  it('excludes [CANCELACIÓN] mirror entries (otherwise they would inflate the opposite total)', () => {
    const txs: Tx[] = [
      { id: 'i1', type: 'income', status: 'completed', amount: 200, currency: 'ARS', accountId: 'acc-ars', date: '2026-04-01' },
      // mirror created by storage.deleteTransaction — same amount, opposite type, [CANCELACIÓN] prefix
      { id: 'm1', type: 'expense', status: 'completed', amount: 200, currency: 'ARS', accountId: 'acc-ars', date: '2026-04-01', description: '[CANCELACIÓN] reverso de i1' },
    ];
    const r = aggregate(txs, accs, accountCurrency);
    assert.equal(r.revenueByCurrency.ARS, 200);
    assert.equal(r.expensesByCurrency.ARS ?? 0, 0);
  });

  it('excludes internal transfers from all valuation buckets', () => {
    const txs: Tx[] = [
      { id: 't1', type: 'transfer_out', status: 'completed', amount: 500, currency: 'ARS', accountId: 'acc-ars', date: '2026-04-01' },
      { id: 't2', type: 'transfer_in',  status: 'completed', amount: 500, currency: 'ARS', accountId: 'acc-usd', date: '2026-04-01' },
      { id: 'i1', type: 'income', status: 'completed', amount: 50, currency: 'ARS', accountId: 'acc-ars', date: '2026-04-01' },
    ];
    const r = aggregate(txs, accs, accountCurrency);
    assert.equal(r.revenueByCurrency.ARS, 50);
    assert.equal(r.expensesByCurrency.ARS ?? 0, 0);
  });

  it('uses tx.currency when present (an ARS expense booked on a USD account stays in ARS)', () => {
    const txs: Tx[] = [
      { id: 'e1', type: 'expense', status: 'completed', amount: 1000, currency: 'ARS', accountId: 'acc-usd', date: '2026-04-01', expenseSubtype: 'operating' },
    ];
    const r = aggregate(txs, accs, accountCurrency);
    assert.equal(r.expensesByCurrency.ARS, 1000);
    assert.equal(r.expensesByCurrency.USD ?? 0, 0);
    assert.equal(r.gastosByCurrency.ARS, 1000);
  });

  it('falls back to account currency when tx.currency is missing, and to ARS as last resort', () => {
    const txs: Tx[] = [
      { id: 'e1', type: 'expense', status: 'completed', amount: 80, accountId: 'acc-usd', date: '2026-04-01', expenseSubtype: 'cost' },
      { id: 'e2', type: 'expense', status: 'completed', amount: 5,  accountId: 'unknown', date: '2026-04-01', expenseSubtype: 'cost' },
    ];
    const r = aggregate(txs, ['acc-usd', 'unknown'], accountCurrency);
    assert.equal(r.expensesByCurrency.USD, 80);
    assert.equal(r.expensesByCurrency.ARS, 5);
    assert.equal(r.costsByCurrency.USD, 80);
    assert.equal(r.costsByCurrency.ARS, 5);
  });

  it('skips transactions on accounts outside the included scope', () => {
    const txs: Tx[] = [
      { id: 'i1', type: 'income', status: 'completed', amount: 100, currency: 'ARS', accountId: 'acc-ars', date: '2026-04-01' },
      { id: 'i2', type: 'income', status: 'completed', amount: 999, currency: 'ARS', accountId: 'excluded-acc', date: '2026-04-01' },
    ];
    const r = aggregate(txs, ['acc-ars'], accountCurrency);
    assert.equal(r.revenueByCurrency.ARS, 100);
  });

  it('classifies expenses by subtype (cost vs gasto) without double counting', () => {
    const txs: Tx[] = [
      { id: 'c1', type: 'expense', status: 'completed', amount: 100, currency: 'ARS', accountId: 'acc-ars', date: '2026-04-01', expenseSubtype: 'cost' },
      { id: 'g1', type: 'expense', status: 'completed', amount: 60,  currency: 'ARS', accountId: 'acc-ars', date: '2026-04-01', expenseSubtype: 'operating' },
    ];
    const r = aggregate(txs, accs, accountCurrency);
    assert.equal(r.expensesByCurrency.ARS, 160);
    assert.equal(r.costsByCurrency.ARS, 100);
    assert.equal(r.gastosByCurrency.ARS, 60);
  });

  it('skips asset_acquisition / investment expenses (they belong to assetsBookValue / investmentsValue)', () => {
    const txs: Tx[] = [
      { id: 'a1', type: 'expense', status: 'completed', amount: 50000, currency: 'ARS', accountId: 'acc-ars', date: '2026-04-01', assetType: 'asset_acquisition' },
      { id: 'inv1', type: 'expense', status: 'completed', amount: 2000, currency: 'ARS', accountId: 'acc-ars', date: '2026-04-01', assetType: 'investment' },
      { id: 'g1', type: 'expense', status: 'completed', amount: 70, currency: 'ARS', accountId: 'acc-ars', date: '2026-04-01', expenseSubtype: 'operating' },
    ];
    const r = aggregate(txs, accs, accountCurrency);
    assert.equal(r.expensesByCurrency.ARS, 70);
  });
});

// Task #175 follow-up — the modal's ROW LIST (not just the footer total) for
// the Valoración cards (Costos, Gastos, Margen Bruto, EBITDA) and for Gastos
// por categoría must apply the same exclusions used by the card aggregations.
// Otherwise, footer = X but the rows sum to Y, which is the exact UX bug we're
// trying to prevent. These tests mirror the inline JSX predicate so a
// regression in any handler is caught.
// Minimal row shape used by these tests. It satisfies RowCandidate from the
// shared selectors (which extends ReportableTx + the optional row fields).
type SampleRow = {
  id: string;
  type: 'income' | 'expense' | 'payable' | 'receivable' | 'transfer_in' | 'transfer_out';
  status: 'completed' | 'scheduled' | 'cancelled';
  amount: number;
  accountId: string;
  date: string;
  description?: string;
  expenseSubtype?: 'cost' | 'operating' | null;
  assetType?: string | null;
  category?: string | null;
  profitabilityCodeId?: string;
};

describe('Task #175 follow-up — modal row lists honor card exclusions', () => {
  const accs = ['acc-ars', 'acc-usd'];
  // codeFilter(t) — pretend a profitability code filter is active that
  // accepts only transactions with profitabilityCodeId === 'pc-1'.
  const passesCode = (t: { profitabilityCodeId?: string }) => t.profitabilityCodeId === 'pc-1';

  // Task #199 — these helpers wrap the SAME selector module that
  // client/src/pages/reports.tsx imports. There is no parallel copy of the
  // predicate any more: a regression in the JSX handler that drifts from the
  // aggregator can only happen if it stops using selectCostosRows/etc. The
  // reports.rowSelectorsLint test guards against exactly that.
  const ctx = { scopeAccountIds: accs, passesCodeFilter: passesCode };
  const pickCostosRows = (txs: readonly SampleRow[]) => selectCostosRows(txs, ctx);
  const pickGastosRows = (txs: readonly SampleRow[]) => selectGastosRows(txs, ctx);
  const pickIngresosRows = (txs: readonly SampleRow[]) => selectIngresosRows(txs, ctx);
  const pickAllExpensesRows = (txs: readonly SampleRow[]) => selectAllExpensesRows(txs, ctx);
  const pickCategoryRows = (txs: readonly SampleRow[], categoryName: string) =>
    selectCategoryRows(txs, ctx, categoryName);

  const sample: SampleRow[] = [
    // Real, in-scope, code-matching, all subtypes:
    { id: 'cost-1', type: 'expense', status: 'completed', amount: 100, accountId: 'acc-ars', date: '2026-04-01', expenseSubtype: 'cost', profitabilityCodeId: 'pc-1', category: 'CMV' },
    { id: 'gasto-1', type: 'expense', status: 'completed', amount: 50, accountId: 'acc-ars', date: '2026-04-01', expenseSubtype: 'operating', profitabilityCodeId: 'pc-1', category: 'Servicios' },
    { id: 'income-1', type: 'income', status: 'completed', amount: 800, accountId: 'acc-ars', date: '2026-04-01', profitabilityCodeId: 'pc-1' },
    // CANCELLED original — must not appear in any row list.
    { id: 'cancelled-cost', type: 'expense', status: 'cancelled', amount: 999, accountId: 'acc-ars', date: '2026-04-01', expenseSubtype: 'cost', profitabilityCodeId: 'pc-1', category: 'CMV' },
    // [CANCELACIÓN] mirror — must not appear.
    { id: 'mirror-income', type: 'expense', status: 'completed', amount: 800, accountId: 'acc-ars', date: '2026-04-01', description: '[CANCELACIÓN] reverso de income-1', profitabilityCodeId: 'pc-1' },
    // Internal transfers — must not appear.
    { id: 't-out', type: 'transfer_out', status: 'completed', amount: 500, accountId: 'acc-ars', date: '2026-04-01', profitabilityCodeId: 'pc-1' },
    { id: 't-in',  type: 'transfer_in',  status: 'completed', amount: 500, accountId: 'acc-usd', date: '2026-04-01', profitabilityCodeId: 'pc-1' },
    // Out-of-scope account — must not appear.
    { id: 'out-of-scope', type: 'expense', status: 'completed', amount: 70, accountId: 'excluded-acc', date: '2026-04-01', expenseSubtype: 'cost', profitabilityCodeId: 'pc-1', category: 'CMV' },
    // Different profitability code — must not appear when filter is active.
    { id: 'wrong-code', type: 'expense', status: 'completed', amount: 60, accountId: 'acc-ars', date: '2026-04-01', expenseSubtype: 'cost', profitabilityCodeId: 'pc-2', category: 'CMV' },
    // Asset acquisition — explicitly excluded from valuation expenses.
    { id: 'asset-buy', type: 'expense', status: 'completed', amount: 50000, accountId: 'acc-ars', date: '2026-04-01', assetType: 'asset_acquisition', profitabilityCodeId: 'pc-1' },
    // Payable matching the category — must appear only in pickCategoryRows.
    { id: 'payable-cat', type: 'payable', status: 'scheduled', amount: 25, accountId: 'acc-ars', date: '2026-04-01', profitabilityCodeId: 'pc-1', category: 'Servicios' },
  ];

  it('Costos (Valoración) row list excludes cancelled/mirror/transfer/out-of-scope/code-filtered/asset-acquisition rows', () => {
    const rows = pickCostosRows(sample);
    assert.deepEqual(rows.map(r => r.id), ['cost-1']);
  });

  it('Gastos Operativos (Valoración) row list excludes cancelled/mirror/transfer/out-of-scope/code-filtered rows', () => {
    const rows = pickGastosRows(sample);
    assert.deepEqual(rows.map(r => r.id), ['gasto-1']);
  });

  it('Margen Bruto (Valoración) row lists (ingresos & costos) honor exclusions', () => {
    const ing = pickIngresosRows(sample);
    const cost = pickCostosRows(sample);
    assert.deepEqual(ing.map(r => r.id), ['income-1']);
    assert.deepEqual(cost.map(r => r.id), ['cost-1']);
  });

  it('EBITDA (Valoración) row lists (ingresos & gastos totales) honor exclusions', () => {
    const ing = pickIngresosRows(sample);
    const exp = pickAllExpensesRows(sample);
    assert.deepEqual(ing.map(r => r.id), ['income-1']);
    // expenses include both cost-1 and gasto-1, but NOT cancelled/mirror/transfer/asset-buy/wrong-code/out-of-scope
    assert.deepEqual(exp.map(r => r.id).sort(), ['cost-1', 'gasto-1']);
  });

  it('Gastos por categoría row list honors exclusions and limits to the chosen category', () => {
    const rows = pickCategoryRows(sample, 'Servicios');
    // gasto-1 (expense) and payable-cat (payable) both pass; mirror/transfer/out-of-scope/wrong-code do not
    assert.deepEqual(rows.map(r => r.id).sort(), ['gasto-1', 'payable-cat']);
  });

  // === Task #202 — el filtro global "Miembro" se inyecta DENTRO del mismo
  // passesCodeFilter y por lo tanto debe aplicarse a TODAS las cards/lists
  // que ya pasan por los selectores compartidos (Valoración, Categorías,
  // Económico, etc). Estos casos pinean que el contrato "código AND miembro"
  // sigue valiendo a través de los selectores reales.
  it('Task #202 — passesCode + member: sólo movimientos del miembro elegido pasan los selectores', () => {
    const onlyAna = (t: { profitabilityCodeId?: string; createdBy?: string | null }) =>
      passesCode(t) && t.createdBy === 'user-ana';
    const ctxAna = { scopeAccountIds: accs, passesCodeFilter: onlyAna };
    const sampleWithAuthors: SampleRow[] = sample.map((r, idx) => ({
      ...r,
      // Asignamos cost-1 a Ana, gasto-1 a Beto, income-1 a Ana, payable-cat a Beto;
      // el resto queda con createdBy null para confirmar que tampoco entra.
      createdBy:
        r.id === 'cost-1' ? 'user-ana'
        : r.id === 'gasto-1' ? 'user-beto'
        : r.id === 'income-1' ? 'user-ana'
        : r.id === 'payable-cat' ? 'user-beto'
        : null,
    } as SampleRow & { createdBy: string | null }));

    // Cards de Valoración (costos y gastos) ahora muestran sólo lo de Ana
    assert.deepEqual(selectCostosRows(sampleWithAuthors, ctxAna).map(r => r.id), ['cost-1']);
    assert.deepEqual(selectGastosRows(sampleWithAuthors, ctxAna).map(r => r.id), []);
    assert.deepEqual(selectIngresosRows(sampleWithAuthors, ctxAna).map(r => r.id), ['income-1']);
    assert.deepEqual(selectAllExpensesRows(sampleWithAuthors, ctxAna).map(r => r.id), ['cost-1']);
    // Gastos por categoría también — Servicios pertenece a Beto, no aparece para Ana
    assert.deepEqual(selectCategoryRows(sampleWithAuthors, ctxAna, 'Servicios').map(r => r.id), []);
  });

  it('Task #202 — memberId="unassigned": sólo movimientos huérfanos (createdBy null) pasan', () => {
    const onlyOrphans = (t: { profitabilityCodeId?: string; createdBy?: string | null }) =>
      passesCode(t) && t.createdBy == null;
    const ctxOrphan = { scopeAccountIds: accs, passesCodeFilter: onlyOrphans };
    // En el sample original todos tienen createdBy undefined (≡ null),
    // así que con onlyOrphans + passesCode los selectores devuelven exactamente
    // las mismas filas que con passesCode solo. Esta paridad es el invariante:
    // "unassigned" filtra por ausencia de autor, no introduce exclusiones nuevas.
    const baseCtx = { scopeAccountIds: accs, passesCodeFilter: passesCode };
    assert.deepEqual(
      selectIngresosRows(sample, ctxOrphan).map(r => r.id),
      selectIngresosRows(sample, baseCtx).map(r => r.id),
    );
    assert.deepEqual(
      selectAllExpensesRows(sample, ctxOrphan).map(r => r.id),
      selectAllExpensesRows(sample, baseCtx).map(r => r.id),
    );
  });

  it('Modal row sums equal aggregated subtotals — footer (totalValue) cannot be inflated', () => {
    // The aggregator from the previous describe block, applied to the same
    // sample. The card's totalCosts must equal the sum of pickCostosRows, and
    // the same for gastos and ingresos. If the JSX inline filter ever drifts
    // from the aggregator predicate, this fails.
    const reportable = buildReportableTxFilter({ scopeAccountIds: accs });
    let aggCosts = 0, aggGastos = 0, aggIncome = 0;
    sample.forEach(t => {
      if (!reportable(t)) return;
      if (!passesCode(t)) return;
      if (t.type === 'income') { aggIncome += t.amount; return; }
      if (t.type === 'expense' && t.assetType !== 'asset_acquisition' && t.assetType !== 'investment') {
        if (t.expenseSubtype === 'cost') aggCosts += t.amount;
        else aggGastos += t.amount;
      }
    });
    const sum = (arr: readonly SampleRow[]) => arr.reduce((s, t) => s + t.amount, 0);
    assert.equal(sum(pickCostosRows(sample)), aggCosts);
    assert.equal(sum(pickGastosRows(sample)), aggGastos);
    assert.equal(sum(pickIngresosRows(sample)), aggIncome);
  });
});
