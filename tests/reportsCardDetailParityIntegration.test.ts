import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isCancellationEntry, CANCELLATION_PREFIX, type Transaction } from '../shared/schema';
import {
  buildBurnRateDrillDown,
  buildFinancialBarDrillDown,
  buildEconomicChartDrillDown,
  buildVentasDrillDown,
  buildCostosDrillDown,
  buildGastosDrillDown,
  buildMargenBrutoDrillDown,
  buildResultadoDrillDown,
  buildPatrimonioOperativoDrillDown,
  buildPatrimonioInversionesDrillDown,
  buildActivosFisicosDrillDown,
  buildInversionesValorActualDrillDown,
  buildValoracionTotalDrillDown,
  buildValuationEbitdaDrillDown,
  buildOperativeAvailabilityDrillDown,
  buildFinancialInvestmentsDrillDown,
  buildValuationCostosDrillDown,
  buildValuationGastosDrillDown,
  buildValuationMargenBrutoDrillDown,
  buildExpenseCategoryDrillDown,
  type CcyHelpers,
  type DrillDownPayload,
} from '../client/src/pages/reports.drilldownBuilders';
import type { GenericDrillDownItem } from '../client/src/components/DrillDownModal';

// Task #165 — UI/integration tests for the actual click handlers wired to
// the Reports cards. Whereas tests/reportsCardDetailParity.test.ts mirrors
// the production filters with hand-rolled helpers, this suite imports the
// real builder functions used by reports.tsx — the very same code that runs
// when a user clicks Burn Rate, Flujo Neto, Ventas, Margen Bruto, Resultado,
// etc. — and asserts that:
//   1) the `totalValue` the handler hands to <DrillDownModal> equals the
//      number rendered on the card itself (no silent drift), and
//   2) for grouped cards (Flujo Neto, Margen Bruto, Resultado, P&L bar),
//      the sum of the per-group detail transactions reconstructs the same
//      total — so the modal's bottom number matches the card's top.

const RATE_USD_TO_ARS = 1050;

const helpers: CcyHelpers = {
  // Same conversion logic as reports.tsx's convertToSelected.
  convertToSelected: (amount, ccy) => (ccy === 'USD' ? amount * RATE_USD_TO_ARS : amount),
  // Same getAccountCurrency lookup.
  getAccountCurrency: (id) => (id === 'acc-usd' ? 'USD' : 'ARS'),
  // Plain formatter — content is irrelevant to parity, but we use it to
  // assert totalFormatted is derived from totalValue (same input → same
  // output), catching the "different totalValue passed to the modal" bug.
  formatCurrencyFull: (val) => `AR$ ${val.toFixed(2)}`,
};

const tx = (over: Partial<Transaction> & { id: string; type: any; status: any; amount: any; accountId: any }): Transaction =>
  ({
    description: '',
    date: '2026-04-15',
    imputationDate: null,
    completedAt: null,
    currency: 'ARS',
    expenseSubtype: null,
    ...over,
  }) as Transaction;

// Mirror reports.tsx's getMonthTransactions + getIncludedTxByType filter so
// the test exercises a realistic input. Cancellations and transfers are
// stripped here, just like the production code does before calling the
// builders.
function filterIncluded(txs: Transaction[]): Transaction[] {
  return txs.filter((t: any) =>
    t.status !== 'cancelled' &&
    !isCancellationEntry(t) &&
    t.type !== 'transfer_in' && t.type !== 'transfer_out',
  );
}

function sumViaHelpers(txs: Transaction[]): number {
  return txs.reduce((s, t: any) => {
    const ccy = t.currency || helpers.getAccountCurrency(t.accountId);
    return s + helpers.convertToSelected(Number(t.amount), ccy);
  }, 0);
}

function groupSumNet(payload: DrillDownPayload): number {
  // Mirrors DrillDownModal's multi-group fallback: first group is positive,
  // subsequent groups are subtracted.
  if (!payload.groups) return 0;
  return payload.groups.reduce((acc, g, i) => {
    const t = sumViaHelpers(g.transactions);
    return i === 0 ? acc + t : acc - t;
  }, 0);
}

describe('Task #165 — handler totalValue equals the number on the card', () => {
  it('Burn Rate handler: card top (= totalEgresos / periodMonths) === modal totalValue', () => {
    const periodMonths = 3;
    const allExpenses = filterIncluded([
      tx({ id: 'e1', type: 'expense', status: 'completed', amount: 30000, accountId: 'acc-ars', date: '2026-02-10' }),
      tx({ id: 'e2', type: 'expense', status: 'completed', amount: 60000, accountId: 'acc-ars', date: '2026-03-15' }),
      tx({ id: 'e3', type: 'expense', status: 'completed', amount: 15000, accountId: 'acc-ars', date: '2026-04-02' }),
      // Cancellation mirror — excluded by upstream filter.
      tx({ id: 'e4', type: 'expense', status: 'completed', amount: 99999, accountId: 'acc-ars', date: '2026-04-03',
           description: `${CANCELLATION_PREFIX}old income` }),
    ]);
    const totalEgresos = sumViaHelpers(allExpenses);
    const cardDisplay = totalEgresos / periodMonths;

    const payload = buildBurnRateDrillDown({
      allExpenses, totalEgresos, periodMonths, formatCurrencyFull: helpers.formatCurrencyFull,
    });

    assert.equal(payload.totalValue, cardDisplay, 'modal total must equal card top');
    assert.equal(payload.totalFormatted, helpers.formatCurrencyFull(cardDisplay));
    assert.equal(payload.totalLabel, 'Burn Rate Promedio');
    // The list of transactions handed to the modal is the raw expense set:
    // their unaveraged sum must equal totalEgresos, NOT the card top — that
    // asymmetry is exactly why the handler must pass an explicit totalValue.
    assert.equal(sumViaHelpers(payload.transactions ?? []), totalEgresos);
    assert.notEqual(totalEgresos, cardDisplay, 'sanity: averaged ≠ raw sum');
  });

  it('Flujo Neto handler (current month): card top (= income − expense) === modal totalValue === group sum', () => {
    const monthName = 'abr';
    const monthTx = filterIncluded([
      tx({ id: 'i1', type: 'income', status: 'completed', amount: 200000, accountId: 'acc-ars' }),
      // Mixed currency: ARS routed through a USD account → tx currency wins.
      tx({ id: 'i2', type: 'income', status: 'completed', amount: 50000, currency: 'ARS', accountId: 'acc-usd' }),
      tx({ id: 'e1', type: 'expense', status: 'completed', amount: 80000, accountId: 'acc-ars' }),
      tx({ id: 'e2', type: 'expense', status: 'completed', amount: 100, currency: 'USD', accountId: 'acc-usd' }),
      // Scheduled commitment: handler filters to status==='completed', so this
      // must NOT contribute (cash-flow lens).
      tx({ id: 'p1', type: 'payable', status: 'scheduled', amount: 999999, accountId: 'acc-ars' }),
    ]);

    const payload = buildFinancialBarDrillDown({ monthName, monthTx, helpers });

    const incomeSum = 200000 + 50000;
    const expenseSum = 80000 + 100 * RATE_USD_TO_ARS;
    const cardDisplay = incomeSum - expenseSum;

    assert.equal(payload.totalValue, cardDisplay);
    assert.equal(payload.totalLabel, 'Flujo Neto');
    assert.equal(payload.totalFormatted, helpers.formatCurrencyFull(cardDisplay));
    assert.equal(groupSumNet(payload), cardDisplay, 'group sum (Ingresos − Egresos) must equal totalValue');
    assert.equal(payload.title, 'Movimientos de abr');
    // Scheduled payable was correctly excluded.
    const allDetailIds = (payload.groups ?? []).flatMap(g => g.transactions.map((t: any) => t.id));
    assert.ok(!allDetailIds.includes('p1'));
  });

  it('Economic chart (P&L per month) handler: card top (= ventas − costos − gastos) === modal totalValue === group net', () => {
    const monthTx = filterIncluded([
      tx({ id: 'v1', type: 'income', status: 'completed', amount: 500000, accountId: 'acc-ars' }),
      tx({ id: 'v2', type: 'receivable', status: 'scheduled', amount: 300000, accountId: 'acc-ars' }),
      tx({ id: 'c1', type: 'expense', status: 'completed', amount: 100000, accountId: 'acc-ars', expenseSubtype: 'cost' }),
      tx({ id: 'c2', type: 'payable', status: 'scheduled', amount: 50000, accountId: 'acc-ars', expenseSubtype: 'cost' }),
      tx({ id: 'g1', type: 'expense', status: 'completed', amount: 70000, accountId: 'acc-ars' }),
      // Cancelled receivable — excluded upstream.
      tx({ id: 'v3', type: 'receivable', status: 'cancelled', amount: 9_000_000, accountId: 'acc-ars' }),
    ]);

    const payload = buildEconomicChartDrillDown({ monthName: 'abr', monthTx, helpers });
    const ventas = 500000 + 300000;
    const costos = 100000 + 50000;
    const gastos = 70000;
    const expected = ventas - costos - gastos;

    assert.equal(payload.totalValue, expected);
    assert.equal(payload.totalLabel, 'Resultado');
    assert.equal(payload.totalFormatted, helpers.formatCurrencyFull(expected));
    assert.equal(groupSumNet(payload), expected, 'Ventas − Costos − Gastos via group sums must equal totalValue');
  });

  it('Ventas card handler: card top (= totalVentas) === modal totalValue === sum of detail txs', () => {
    const ventasTx = filterIncluded([
      tx({ id: 'v1', type: 'income', status: 'completed', amount: 120000, accountId: 'acc-ars' }),
      tx({ id: 'v2', type: 'receivable', status: 'scheduled', amount: 80000, accountId: 'acc-ars' }),
      // 100 USD → 105_000 ARS at our rate.
      tx({ id: 'v3', type: 'income', status: 'completed', amount: 100, currency: 'USD', accountId: 'acc-usd' }),
    ]);
    const totalVentas = sumViaHelpers(ventasTx);
    assert.equal(totalVentas, 120000 + 80000 + 100 * RATE_USD_TO_ARS);

    const payload = buildVentasDrillDown({
      ventasTx, totalVentas, formatCurrencyFull: helpers.formatCurrencyFull,
    });

    assert.equal(payload.totalValue, totalVentas);
    assert.equal(payload.totalLabel, 'Total Ventas');
    assert.equal(payload.totalFormatted, helpers.formatCurrencyFull(totalVentas));
    assert.equal(sumViaHelpers(payload.transactions ?? []), totalVentas);
  });

  it('Costos card handler: card top === modal totalValue === sum of detail txs', () => {
    const costosTx = filterIncluded([
      tx({ id: 'c1', type: 'expense', status: 'completed', amount: 40000, accountId: 'acc-ars', expenseSubtype: 'cost' }),
      tx({ id: 'c2', type: 'payable', status: 'scheduled', amount: 25000, accountId: 'acc-ars', expenseSubtype: 'cost' }),
    ]);
    const totalCostos = sumViaHelpers(costosTx);

    const payload = buildCostosDrillDown({
      costosTx, totalCostos, formatCurrencyFull: helpers.formatCurrencyFull,
    });

    assert.equal(payload.totalValue, totalCostos);
    assert.equal(payload.totalLabel, 'Total Costos');
    assert.equal(payload.totalFormatted, helpers.formatCurrencyFull(totalCostos));
    assert.equal(sumViaHelpers(payload.transactions ?? []), totalCostos);
  });

  it('Gastos card handler: card top === modal totalValue === sum of detail txs', () => {
    const gastosTx = filterIncluded([
      tx({ id: 'g1', type: 'expense', status: 'completed', amount: 18000, accountId: 'acc-ars' }),
      tx({ id: 'g2', type: 'payable', status: 'scheduled', amount: 7000, accountId: 'acc-ars' }),
    ]);
    const totalGastos = sumViaHelpers(gastosTx);

    const payload = buildGastosDrillDown({
      gastosTx, totalGastos, formatCurrencyFull: helpers.formatCurrencyFull,
    });

    assert.equal(payload.totalValue, totalGastos);
    assert.equal(payload.totalLabel, 'Total Gastos');
    assert.equal(payload.totalFormatted, helpers.formatCurrencyFull(totalGastos));
    assert.equal(sumViaHelpers(payload.transactions ?? []), totalGastos);
  });

  it('Margen Bruto handler: card top (= Ventas − Costos) === modal totalValue === group net', () => {
    const ventasTx = filterIncluded([
      tx({ id: 'v1', type: 'income', status: 'completed', amount: 400000, accountId: 'acc-ars' }),
      tx({ id: 'v2', type: 'receivable', status: 'scheduled', amount: 100000, accountId: 'acc-ars' }),
    ]);
    const costosTx = filterIncluded([
      tx({ id: 'c1', type: 'expense', status: 'completed', amount: 90000, accountId: 'acc-ars', expenseSubtype: 'cost' }),
    ]);
    const totalVentas = sumViaHelpers(ventasTx);
    const totalCostos = sumViaHelpers(costosTx);
    const expected = totalVentas - totalCostos;

    const payload = buildMargenBrutoDrillDown({
      ventasTx, costosTx, totalVentas, totalCostos, formatCurrencyFull: helpers.formatCurrencyFull,
    });

    assert.equal(payload.totalValue, expected);
    assert.equal(payload.totalFormatted, helpers.formatCurrencyFull(expected));
    assert.equal(groupSumNet(payload), expected);
  });

  it('Resultado Neto handler: card top (= Ventas − Costos − Gastos) === modal totalValue === group net', () => {
    const ventasTx = filterIncluded([
      tx({ id: 'v1', type: 'income', status: 'completed', amount: 1_000_000, accountId: 'acc-ars' }),
    ]);
    const costosTx = filterIncluded([
      tx({ id: 'c1', type: 'expense', status: 'completed', amount: 200_000, accountId: 'acc-ars', expenseSubtype: 'cost' }),
    ]);
    const gastosTx = filterIncluded([
      tx({ id: 'g1', type: 'expense', status: 'completed', amount: 150_000, accountId: 'acc-ars' }),
      tx({ id: 'g2', type: 'payable', status: 'scheduled', amount: 50_000, accountId: 'acc-ars' }),
    ]);
    const totalVentas = sumViaHelpers(ventasTx);
    const totalCostos = sumViaHelpers(costosTx);
    const totalGastos = sumViaHelpers(gastosTx);
    const expected = totalVentas - totalCostos - totalGastos;

    const payload = buildResultadoDrillDown({
      ventasTx, costosTx, gastosTx, totalVentas, totalCostos, totalGastos,
      formatCurrencyFull: helpers.formatCurrencyFull,
    });

    assert.equal(payload.totalValue, expected);
    assert.equal(payload.totalLabel, 'Resultado Neto');
    assert.equal(payload.totalFormatted, helpers.formatCurrencyFull(expected));
    assert.equal(groupSumNet(payload), expected);
  });

  it('regression guard: handlers always set totalValue + totalFormatted in lockstep', () => {
    // The original Juan Campos bug surfaced because the modal recomputed its
    // own bottom total from the raw tx list while the card top showed a
    // different number (an average, a net, etc.). The fix is to always pass
    // an explicit totalValue. This test asserts that every Reports builder
    // continues to do so — so a future refactor can't silently drop it.
    const dummy: CcyHelpers = helpers;
    const empty: Transaction[] = [];

    const payloads: DrillDownPayload[] = [
      buildBurnRateDrillDown({ allExpenses: empty, totalEgresos: 0, periodMonths: 1, formatCurrencyFull: dummy.formatCurrencyFull }),
      buildFinancialBarDrillDown({ monthName: 'abr', monthTx: empty, helpers: dummy }),
      buildEconomicChartDrillDown({ monthName: 'abr', monthTx: empty, helpers: dummy }),
      buildVentasDrillDown({ ventasTx: empty, totalVentas: 0, formatCurrencyFull: dummy.formatCurrencyFull }),
      buildCostosDrillDown({ costosTx: empty, totalCostos: 0, formatCurrencyFull: dummy.formatCurrencyFull }),
      buildGastosDrillDown({ gastosTx: empty, totalGastos: 0, formatCurrencyFull: dummy.formatCurrencyFull }),
      buildMargenBrutoDrillDown({ ventasTx: empty, costosTx: empty, totalVentas: 0, totalCostos: 0, formatCurrencyFull: dummy.formatCurrencyFull }),
      buildResultadoDrillDown({ ventasTx: empty, costosTx: empty, gastosTx: empty, totalVentas: 0, totalCostos: 0, totalGastos: 0, formatCurrencyFull: dummy.formatCurrencyFull }),
    ];

    for (const p of payloads) {
      assert.equal(typeof p.totalValue, 'number', `${p.title}: totalValue must be a number`);
      assert.equal(p.totalFormatted, dummy.formatCurrencyFull(p.totalValue!),
        `${p.title}: totalFormatted must be derived from totalValue via formatCurrencyFull`);
    }
  });
});

// Task #171 — same parity guarantee for the remaining cards in the
// Valoración block (Patrimonio Operativo, Patrimonio en Inversiones,
// Activos Físicos, Inversiones Valor Actual, Valoración Total y EBITDA del
// bloque Valoración). These handlers used to build their DrillDownState
// inline in the JSX, so a refactor could silently let the modal show a
// different number than the card. Now they go through pure builders, and
// these tests assert the modal's totalValue/totalFormatted always match
// the card's top number.
const fmtVal = (v: number) => `AR$ ${v.toFixed(2)}`;

const sampleItem = (id: string, amount: string): GenericDrillDownItem => ({
  id, label: `item-${id}`, sublabel: 'sub', amount, badge: 'b',
});

describe('Task #171 — Valoración block handlers (totalValue === card top)', () => {
  it('Patrimonio Operativo: card top === payload.totalValue === fmt(totalValue)', () => {
    const operativeBalance = 1_234_567.89;
    const items = [sampleItem('a1', fmtVal(800_000)), sampleItem('a2', fmtVal(434_567.89))];
    const payload = buildPatrimonioOperativoDrillDown({
      items, totalValue: operativeBalance, formatValue: fmtVal,
    });
    assert.equal(payload.totalValue, operativeBalance);
    assert.equal(payload.totalFormatted, fmtVal(operativeBalance));
    assert.equal(payload.title, 'Patrimonio Operativo');
    assert.equal(payload.genericItems, items);
  });

  it('Patrimonio en Inversiones: card top === payload.totalValue === fmt(totalValue)', () => {
    const investmentBalance = 9_876_543.21;
    const items = [sampleItem('i1', fmtVal(5_000_000)), sampleItem('i2', fmtVal(4_876_543.21))];
    const payload = buildPatrimonioInversionesDrillDown({
      items, totalValue: investmentBalance, formatValue: fmtVal,
    });
    assert.equal(payload.totalValue, investmentBalance);
    assert.equal(payload.totalFormatted, fmtVal(investmentBalance));
    assert.equal(payload.title, 'Patrimonio en Inversiones');
  });

  it('Activos Físicos (sidebar): card top === payload.totalValue === fmt(totalValue)', () => {
    const assetsBookValue = 4_500_000;
    const items = [sampleItem('asset-1', fmtVal(3_000_000)), sampleItem('asset-2', fmtVal(1_500_000))];
    const payload = buildActivosFisicosDrillDown({
      items, totalValue: assetsBookValue, formatValue: fmtVal,
    });
    assert.equal(payload.totalValue, assetsBookValue);
    assert.equal(payload.totalFormatted, fmtVal(assetsBookValue));
    assert.equal(payload.title, 'Activos Físicos (Valor Libros)');
  });

  it('Inversiones Valor Actual (sidebar): card top === payload.totalValue === fmt(totalValue)', () => {
    const investmentsValue = 7_250_000.5;
    const items = [sampleItem('inv-1', fmtVal(7_250_000.5))];
    const payload = buildInversionesValorActualDrillDown({
      items, totalValue: investmentsValue, formatValue: fmtVal,
    });
    assert.equal(payload.totalValue, investmentsValue);
    assert.equal(payload.totalFormatted, fmtVal(investmentsValue));
    assert.equal(payload.title, 'Inversiones (Valor Actual)');
  });

  it('Valoración Total: card top (= EBITDA + Activos + Inversiones) === payload.totalValue', () => {
    const ebitda = 2_000_000;
    const assetsBookValue = 3_500_000;
    const investmentsValue = 1_750_000;
    const totalValuation = ebitda + assetsBookValue + investmentsValue;
    const items = [sampleItem('ebitda', fmtVal(ebitda))];

    const payload = buildValoracionTotalDrillDown({
      items, ebitda, assetsBookValue, investmentsValue, totalValuation,
      formatValue: fmtVal,
    });

    assert.equal(payload.totalValue, totalValuation);
    assert.equal(payload.totalFormatted, fmtVal(totalValuation));
    assert.equal(payload.title, 'Valor Estimado de la Empresa');
    // Formula lines must reflect the same components used to derive the card top.
    const result = payload.formulaLines?.find(l => l.isResult);
    assert.equal(result?.value, fmtVal(totalValuation),
      'result line must show the exact same number as the card top');
  });

  it('EBITDA (Valoración): card top (= Ingresos − Gastos Op.) === totalValue === group net', () => {
    const revTx = filterIncluded([
      tx({ id: 'r1', type: 'income', status: 'completed', amount: 600_000, accountId: 'acc-ars' }),
      tx({ id: 'r2', type: 'income', status: 'completed', amount: 400_000, accountId: 'acc-ars' }),
    ]);
    const expTx = filterIncluded([
      tx({ id: 'x1', type: 'expense', status: 'completed', amount: 250_000, accountId: 'acc-ars' }),
      tx({ id: 'x2', type: 'expense', status: 'completed', amount: 150_000, accountId: 'acc-ars' }),
    ]);
    const totalRevenue = sumViaHelpers(revTx);
    const totalExpenses = sumViaHelpers(expTx);
    const ebitda = totalRevenue - totalExpenses;

    const payload = buildValuationEbitdaDrillDown({
      revTx, expTx, totalRevenue, totalExpenses, ebitda, formatValue: fmtVal,
    });

    assert.equal(payload.totalValue, ebitda);
    assert.equal(payload.totalFormatted, fmtVal(ebitda));
    assert.equal(payload.title, 'EBITDA');
    assert.equal(groupSumNet(payload), ebitda,
      'group sum (Ingresos − Gastos Op.) must equal totalValue');
  });

  it('regression guard: every Valoración builder always sets totalValue + totalFormatted in lockstep', () => {
    const empty: Transaction[] = [];
    const noItems: GenericDrillDownItem[] = [];

    const payloads: DrillDownPayload[] = [
      buildPatrimonioOperativoDrillDown({ items: noItems, totalValue: 0, formatValue: fmtVal }),
      buildPatrimonioInversionesDrillDown({ items: noItems, totalValue: 0, formatValue: fmtVal }),
      buildActivosFisicosDrillDown({ items: noItems, totalValue: 0, formatValue: fmtVal }),
      buildInversionesValorActualDrillDown({ items: noItems, totalValue: 0, formatValue: fmtVal }),
      buildValoracionTotalDrillDown({
        items: noItems, ebitda: 0, assetsBookValue: 0, investmentsValue: 0, totalValuation: 0,
        formatValue: fmtVal,
      }),
      buildValuationEbitdaDrillDown({
        revTx: empty, expTx: empty, totalRevenue: 0, totalExpenses: 0, ebitda: 0,
        formatValue: fmtVal,
      }),
    ];

    for (const p of payloads) {
      assert.equal(typeof p.totalValue, 'number',
        `${p.title}: totalValue must be a number`);
      assert.equal(p.totalFormatted, fmtVal(p.totalValue!),
        `${p.title}: totalFormatted must be derived from totalValue via formatValue`);
    }
  });
});

// Task #175 — finish parity coverage: the inline drill-downs for the
// remaining clickable cards (Disponibilidad Operativa, Inversiones financiera,
// Costos/Gastos/Margen Bruto en Valoración, y Gastos por categoría) are now
// also routed through builders. Each card must show the same number on top
// as the modal shows on the bottom.
describe('Task #175 — parity for remaining Reports cards', () => {
  it('Disponibilidad Operativa: card top = totalValue = totalFormatted(totalValue)', () => {
    const items: GenericDrillDownItem[] = [
      { id: 'a1', label: 'Caja ARS', sublabel: 'ARS', amount: 'AR$ 100000.00', badge: 'cash' },
      { id: 'a2', label: 'Banco USD', sublabel: 'USD', amount: 'AR$ 525000.00', badge: 'bank' },
    ];
    const cardTop = 625_000;
    const payload = buildOperativeAvailabilityDrillDown({
      items, totalValue: cardTop, formatCurrencyFull: fmtVal,
    });
    assert.equal(payload.totalValue, cardTop);
    assert.equal(payload.totalFormatted, fmtVal(cardTop));
    assert.equal(payload.title, 'Disponibilidad Operativa');
  });

  it('Inversiones (financial card): card top = totalValue = totalFormatted(totalValue)', () => {
    const items: GenericDrillDownItem[] = [
      { id: 'inv1', label: 'Plazo Fijo', sublabel: 'ARS', amount: 'AR$ 500000.00', badge: 'inversión' },
    ];
    const cardTop = 500_000;
    const payload = buildFinancialInvestmentsDrillDown({
      items, totalValue: cardTop, formatCurrencyFull: fmtVal,
    });
    assert.equal(payload.totalValue, cardTop);
    assert.equal(payload.totalFormatted, fmtVal(cardTop));
    assert.equal(payload.title, 'Inversiones');
  });

  it('Costos (Valoración): card top = totalValue = totalFormatted(totalValue)', () => {
    const costosTx: Transaction[] = [
      tx({ id: 'c1', type: 'expense', status: 'completed', amount: 30_000, accountId: 'acc-ars', expenseSubtype: 'cost' }),
      tx({ id: 'c2', type: 'expense', status: 'completed', amount: 10_000, accountId: 'acc-ars', expenseSubtype: 'cost' }),
    ];
    const cardTop = 40_000; // valuationData.totalCosts (already converted)
    const payload = buildValuationCostosDrillDown({
      costosTx, totalValue: cardTop, formatValue: fmtVal,
    });
    assert.equal(payload.totalValue, cardTop);
    assert.equal(payload.totalFormatted, fmtVal(cardTop));
    assert.equal(payload.title, 'Costos (Valoración)');
  });

  it('Gastos Operativos (Valoración): card top = totalValue = totalFormatted(totalValue)', () => {
    const gastosTx: Transaction[] = [
      tx({ id: 'g1', type: 'expense', status: 'completed', amount: 7_000, accountId: 'acc-ars', expenseSubtype: 'operating' as any }),
    ];
    const cardTop = 7_000;
    const payload = buildValuationGastosDrillDown({
      gastosTx, totalValue: cardTop, formatValue: fmtVal,
    });
    assert.equal(payload.totalValue, cardTop);
    assert.equal(payload.totalFormatted, fmtVal(cardTop));
    assert.equal(payload.title, 'Gastos Operativos (Valoración)');
  });

  it('Margen Bruto (Valoración): totalValue = revenue - costs and group sum reconstructs it', () => {
    const revTx: Transaction[] = [
      tx({ id: 'r1', type: 'income', status: 'completed', amount: 200_000, accountId: 'acc-ars' }),
    ];
    const costTx: Transaction[] = [
      tx({ id: 'c1', type: 'expense', status: 'completed', amount: 50_000, accountId: 'acc-ars', expenseSubtype: 'cost' }),
    ];
    const totalRevenue = 200_000;
    const totalCosts = 50_000;
    const margenBruto = 150_000;
    const payload = buildValuationMargenBrutoDrillDown({
      revTx, costTx, totalRevenue, totalCosts, margenBruto, formatValue: fmtVal,
    });
    assert.equal(payload.totalValue, margenBruto);
    assert.equal(payload.totalFormatted, fmtVal(margenBruto));
    // group sum: ingresos - costos
    const sumGroup = (g: typeof payload.groups extends infer G ? (G extends Array<infer X> ? X : never) : never) =>
      (g as any).transactions.reduce((s: number, t: any) => s + Number(t.amount), 0);
    const ingresos = sumGroup(payload.groups!.find(g => g.label === 'Ingresos')!);
    const costos = sumGroup(payload.groups!.find(g => g.label === 'Costos')!);
    assert.equal(ingresos - costos, margenBruto);
  });

  it('Gastos por categoría: card top (precomputed converted total) = totalValue = totalFormatted(totalValue)', () => {
    // expensesByCategory in reports.tsx already converts to selected currency
    // and excludes cancellations/transfers via buildReportableTxFilter. We
    // pass that converted number straight to the builder so the modal cannot
    // recompute a different total from the raw items list.
    const categoryTx: Transaction[] = [
      tx({ id: 'e1', type: 'expense', status: 'completed', amount: 12_000, accountId: 'acc-ars', category: 'Servicios' as any }),
      tx({ id: 'e2', type: 'expense', status: 'completed', amount: 8_000, accountId: 'acc-ars', category: 'Servicios' as any }),
    ];
    const cardTop = 20_000;
    const payload = buildExpenseCategoryDrillDown({
      categoryName: 'Servicios', categoryTx, totalValue: cardTop, formatCurrencyFull: fmtVal,
    });
    assert.equal(payload.totalValue, cardTop);
    assert.equal(payload.totalFormatted, fmtVal(cardTop));
    assert.equal(payload.title, 'Gastos: Servicios');
    assert.equal(payload.totalLabel, 'Total Servicios');
  });

  it('regression guard: every Task #175 builder always sets totalValue + totalFormatted in lockstep', () => {
    const empty: Transaction[] = [];
    const noItems: GenericDrillDownItem[] = [];
    const payloads: DrillDownPayload[] = [
      buildOperativeAvailabilityDrillDown({ items: noItems, totalValue: 0, formatCurrencyFull: fmtVal }),
      buildFinancialInvestmentsDrillDown({ items: noItems, totalValue: 0, formatCurrencyFull: fmtVal }),
      buildValuationCostosDrillDown({ costosTx: empty, totalValue: 0, formatValue: fmtVal }),
      buildValuationGastosDrillDown({ gastosTx: empty, totalValue: 0, formatValue: fmtVal }),
      buildValuationMargenBrutoDrillDown({
        revTx: empty, costTx: empty, totalRevenue: 0, totalCosts: 0, margenBruto: 0, formatValue: fmtVal,
      }),
      buildExpenseCategoryDrillDown({
        categoryName: 'X', categoryTx: empty, totalValue: 0, formatCurrencyFull: fmtVal,
      }),
    ];
    for (const p of payloads) {
      assert.equal(typeof p.totalValue, 'number',
        `${p.title}: totalValue must be a number`);
      assert.equal(p.totalFormatted, fmtVal(p.totalValue!),
        `${p.title}: totalFormatted must be derived from totalValue`);
    }
  });
});
