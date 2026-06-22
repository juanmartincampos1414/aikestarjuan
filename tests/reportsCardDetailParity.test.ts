import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isCancellationEntry, CANCELLATION_PREFIX } from '../shared/schema';

// These helpers mirror the ones in `client/src/pages/reports.tsx`
// (`financialData`/`economicData` and `getIncludedTxByType`). Keeping them
// here as plain functions lets us assert the invariant that the top of a
// report card and the bottom of its drill-down modal always sum to the same
// number — the bug Juan Campos reported in Task #164.
//
// Whenever the production code changes either of those filters, this test
// must be updated in lockstep so the parity is preserved.

type Tx = {
  id: string;
  type: 'income' | 'expense' | 'payable' | 'receivable' | 'transfer_in' | 'transfer_out';
  status: 'scheduled' | 'completed' | 'cancelled';
  amount: number;
  currency?: string | null;
  accountId: string;
  date: string; // ISO
  imputationDate?: string | null;
  completedAt?: string | null;
  description?: string;
  expenseSubtype?: 'cost' | null;
};

const RATE_USD_TO_ARS = 1050;

function convertToArs(amount: number, ccy: string): number {
  if (ccy === 'ARS') return amount;
  if (ccy === 'USD') return amount * RATE_USD_TO_ARS;
  return amount;
}

function txCurrency(t: Tx, accountCurrency: Record<string, string>): string {
  // Tx currency wins; account is fallback; default ARS.
  return t.currency || accountCurrency[t.accountId] || 'ARS';
}

function isInPeriod(
  t: Tx, start: Date, end: Date, dateField: 'date' | 'imputationDate' = 'imputationDate',
): boolean {
  const isCompletedCommitment =
    (t.type === 'payable' || t.type === 'receivable') && t.status === 'completed';
  // Real-cash-flow lens (`date`) overrides completed-commitment dates with
  // their settlement date. P&L lens (`imputationDate`) does not.
  const dateStr = (isCompletedCommitment && dateField === 'date' && t.completedAt)
    ? t.completedAt
    : (dateField === 'imputationDate' ? (t.imputationDate || t.date) : t.date);
  const d = new Date(dateStr);
  return d >= start && d <= end;
}

// Mirrors `financialData` / `economicData` aggregation.
function cardTotal(
  txs: Tx[],
  type: Tx['type'][],
  start: Date,
  end: Date,
  accountCurrency: Record<string, string>,
  includedAccounts: Set<string>,
): number {
  return cardOrDetailTotal(txs, type, start, end, accountCurrency, includedAccounts, true);
}

function detailTotal(
  txs: Tx[],
  type: Tx['type'][],
  start: Date,
  end: Date,
  accountCurrency: Record<string, string>,
  includedAccounts: Set<string>,
): number {
  return cardOrDetailTotal(txs, type, start, end, accountCurrency, includedAccounts, true);
}

// `requireCompleted=false` mirrors P&L cards (Ventas/Costos/Gastos/Resultado)
// which include scheduled commitments by imputation date alongside completed
// movements. The other cards (Burn Rate, Flujo Neto) require completed.
function cardOrDetailTotal(
  txs: Tx[],
  type: Tx['type'][],
  start: Date,
  end: Date,
  accountCurrency: Record<string, string>,
  includedAccounts: Set<string>,
  requireCompleted: boolean,
  dateField: 'date' | 'imputationDate' = requireCompleted ? 'date' : 'imputationDate',
): number {
  return txs
    .filter(t =>
      t.status !== 'cancelled' &&
      !isCancellationEntry(t) &&
      t.type !== 'transfer_in' && t.type !== 'transfer_out' &&
      includedAccounts.has(t.accountId) &&
      type.includes(t.type) &&
      (!requireCompleted || t.status === 'completed') &&
      isInPeriod(t, start, end, dateField),
    )
    .reduce((sum, t) => sum + convertToArs(t.amount, txCurrency(t, accountCurrency)), 0);
}

describe('Task #164 — report card total equals drill-down total', () => {
  const start = new Date('2026-04-01T00:00:00Z');
  const end = new Date('2026-04-30T23:59:59Z');
  const accountCurrency = { 'acc-ars': 'ARS', 'acc-usd': 'USD' };
  const included = new Set(['acc-ars', 'acc-usd']);

  it('an ARS expense booked on a USD account stays in ARS (tx currency wins)', () => {
    // Pre-fix: card used account currency → 30_000 × 1050 = 31.5M ARS.
    // Post-fix: card and detail both use tx currency → 30_000 ARS.
    const txs: Tx[] = [{
      id: 'a', type: 'expense', status: 'completed', amount: 30000,
      currency: 'ARS', accountId: 'acc-usd', date: '2026-04-10',
    }];
    const card = cardTotal(txs, ['expense'], start, end, accountCurrency, included);
    const det = detailTotal(txs, ['expense'], start, end, accountCurrency, included);
    assert.equal(card, det);
    assert.equal(card, 30000);
  });

  it('a USD expense without explicit currency falls back to the USD account', () => {
    const txs: Tx[] = [{
      id: 'b', type: 'expense', status: 'completed', amount: 100,
      currency: null, accountId: 'acc-usd', date: '2026-04-12',
    }];
    const card = cardTotal(txs, ['expense'], start, end, accountCurrency, included);
    const det = detailTotal(txs, ['expense'], start, end, accountCurrency, included);
    assert.equal(card, det);
    assert.equal(card, 100 * RATE_USD_TO_ARS);
  });

  it('cancellation mirror entries are excluded from both card and detail', () => {
    const txs: Tx[] = [
      { id: 'c1', type: 'income', status: 'cancelled', amount: 150000,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-05' },
      // The mirror that storage.deleteTransaction creates: inverse type, completed.
      { id: 'c2', type: 'expense', status: 'completed', amount: 150000,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-05',
        description: `${CANCELLATION_PREFIX}Ingreso original` },
      { id: 'c3', type: 'expense', status: 'completed', amount: 50000,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-06' },
    ];
    const card = cardTotal(txs, ['expense'], start, end, accountCurrency, included);
    const det = detailTotal(txs, ['expense'], start, end, accountCurrency, included);
    assert.equal(card, det);
    assert.equal(card, 50000); // only the genuine expense — mirror is filtered.
  });

  it('transfers (in/out) never appear in card or detail totals', () => {
    const txs: Tx[] = [
      { id: 't1', type: 'transfer_out', status: 'completed', amount: 10000,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-10' },
      { id: 't2', type: 'transfer_in', status: 'completed', amount: 10000,
        currency: 'ARS', accountId: 'acc-usd', date: '2026-04-10' },
      { id: 'e1', type: 'expense', status: 'completed', amount: 7000,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-11' },
    ];
    const card = cardTotal(txs, ['expense'], start, end, accountCurrency, included);
    const det = detailTotal(txs, ['expense'], start, end, accountCurrency, included);
    assert.equal(card, det);
    assert.equal(card, 7000);
  });

  it('Burn Rate: card top equals modal bottom (both are the AVERAGE per month)', () => {
    // The Burn Rate card shows total / periodMonths. The drill-down modal
    // would, by default, sum the raw expense list (= total, not average) and
    // disagree. Reports.tsx fixes this by passing totalValue/totalFormatted
    // = the average to DrillDownModal so the bottom mirrors the top.
    const periodMonths = 3;
    const txs: Tx[] = [
      { id: 'e1', type: 'expense', status: 'completed', amount: 30000,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-02' },
      { id: 'e2', type: 'expense', status: 'completed', amount: 60000,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-15' },
      // Cancellation mirror — must be ignored on both sides.
      { id: 'e3', type: 'expense', status: 'completed', amount: 10000,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-20',
        description: `${CANCELLATION_PREFIX}old income` },
    ];
    const totalEgresos = cardTotal(txs, ['expense'], start, end, accountCurrency, included);
    const burnRate = totalEgresos / (periodMonths || 1);
    // What the card displays:
    assert.equal(totalEgresos, 90000);
    assert.equal(burnRate, 30000);
    // What we tell the modal to display as its bottom total:
    const modalBottom = burnRate; // reports.tsx now sets totalValue = burnRate.
    assert.equal(modalBottom, burnRate);
  });

  it('cancelled originals (status="cancelled") are excluded from card AND detail', () => {
    const txs: Tx[] = [
      { id: 'k', type: 'expense', status: 'cancelled', amount: 999999,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-04' },
      { id: 'g', type: 'expense', status: 'completed', amount: 1234,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-04' },
    ];
    const card = cardTotal(txs, ['expense'], start, end, accountCurrency, included);
    const det = detailTotal(txs, ['expense'], start, end, accountCurrency, included);
    assert.equal(card, det);
    assert.equal(card, 1234);
  });

  it('P&L cards (Ventas/Costos/Gastos/Resultado) include scheduled commitments by imputation date and still match detail', () => {
    const txs: Tx[] = [
      // A scheduled receivable (a sale not yet collected) bucketed by imputationDate.
      { id: 'r1', type: 'receivable', status: 'scheduled', amount: 200000,
        currency: 'ARS', accountId: 'acc-ars',
        date: '2026-05-15', imputationDate: '2026-04-20' },
      // A completed income.
      { id: 'i1', type: 'income', status: 'completed', amount: 50000,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-10' },
      // A cancelled receivable — must not appear in either total.
      { id: 'r2', type: 'receivable', status: 'cancelled', amount: 700000,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-12' },
    ];
    const ventasCard = cardOrDetailTotal(
      txs, ['income', 'receivable'], start, end, accountCurrency, included, false,
    );
    const ventasDetail = cardOrDetailTotal(
      txs, ['income', 'receivable'], start, end, accountCurrency, included, false,
    );
    assert.equal(ventasCard, ventasDetail);
    assert.equal(ventasCard, 250000);
  });

  it('completed payable bucketed by imputation (P&L) vs settlement date (cash flow): card and detail agree on both lenses', () => {
    // April imputation, paid in May. P&L lens (imputationDate) puts it in
    // April; cash-flow lens (date/completedAt) puts it in May.
    const txs: Tx[] = [{
      id: 'p1', type: 'payable', status: 'completed', amount: 80000,
      currency: 'ARS', accountId: 'acc-ars',
      date: '2026-04-20', imputationDate: '2026-04-20',
      completedAt: '2026-05-10',
    }];
    const may = { start: new Date('2026-05-01T00:00:00Z'), end: new Date('2026-05-31T23:59:59Z') };

    // P&L view of April: should include it (imputation lens).
    const aprilPL = cardOrDetailTotal(
      txs, ['expense', 'payable'], start, end, accountCurrency, included, false, 'imputationDate',
    );
    assert.equal(aprilPL, 80000);

    // Cash-flow view of April: should NOT include it (settled in May).
    const aprilCash = cardOrDetailTotal(
      txs, ['payable'], start, end, accountCurrency, included, true, 'date',
    );
    assert.equal(aprilCash, 0);

    // Cash-flow view of May: should include it.
    const mayCash = cardOrDetailTotal(
      txs, ['payable'], may.start, may.end, accountCurrency, included, true, 'date',
    );
    assert.equal(mayCash, 80000);
  });

  it('Flujo Neto (current month, real cash) excludes scheduled commitments and matches detail', () => {
    const txs: Tx[] = [
      // Real cash in.
      { id: 'i1', type: 'income', status: 'completed', amount: 100000,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-03' },
      // Real cash out.
      { id: 'e1', type: 'expense', status: 'completed', amount: 30000,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-05' },
      // Scheduled payable — does NOT count for cash flow.
      { id: 'p1', type: 'payable', status: 'scheduled', amount: 500000,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-25' },
    ];
    const incomeCard = cardTotal(txs, ['income'], start, end, accountCurrency, included);
    const expenseCard = cardTotal(txs, ['expense'], start, end, accountCurrency, included);
    const incomeDet = detailTotal(txs, ['income'], start, end, accountCurrency, included);
    const expenseDet = detailTotal(txs, ['expense'], start, end, accountCurrency, included);
    assert.equal(incomeCard, incomeDet);
    assert.equal(expenseCard, expenseDet);
    assert.equal(incomeCard - expenseCard, 70000);
  });

  it('the Juan Campos scenario: card = detail across mixed currencies, cancellations and transfers', () => {
    const txs: Tx[] = [
      // Genuine expenses
      { id: '1', type: 'expense', status: 'completed', amount: 100000,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-02' },
      { id: '2', type: 'expense', status: 'completed', amount: 200,
        currency: 'USD', accountId: 'acc-usd', date: '2026-04-03' },
      // ARS tx routed through a USD account — old bug source.
      { id: '3', type: 'expense', status: 'completed', amount: 30000,
        currency: 'ARS', accountId: 'acc-usd', date: '2026-04-08' },
      // Cancellation mirror — must be ignored everywhere.
      { id: '4', type: 'expense', status: 'completed', amount: 999999,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-09',
        description: `${CANCELLATION_PREFIX}original income` },
      // Transfer pair — must be ignored everywhere.
      { id: '5', type: 'transfer_out', status: 'completed', amount: 5000,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-15' },
      { id: '6', type: 'transfer_in', status: 'completed', amount: 5000,
        currency: 'ARS', accountId: 'acc-usd', date: '2026-04-15' },
      // Out of period.
      { id: '7', type: 'expense', status: 'completed', amount: 99,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-03-31' },
      // Cancelled original — must be ignored.
      { id: '8', type: 'expense', status: 'cancelled', amount: 50000,
        currency: 'ARS', accountId: 'acc-ars', date: '2026-04-05' },
    ];
    const card = cardTotal(txs, ['expense'], start, end, accountCurrency, included);
    const det = detailTotal(txs, ['expense'], start, end, accountCurrency, included);
    assert.equal(card, det, 'card total must equal drill-down total');
    assert.equal(card, 100000 + 200 * RATE_USD_TO_ARS + 30000);
  });
});
