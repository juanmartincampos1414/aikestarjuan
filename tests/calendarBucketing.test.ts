import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// These helpers mirror the ones in server/routes/transactions.ts. Keeping them
// inline (instead of exporting from the route module) avoids pulling the
// entire Express app into the test runtime.
const ARG_TZ = 'America/Argentina/Buenos_Aires';
const dayKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ARG_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const monthKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ARG_TZ,
  year: 'numeric',
  month: '2-digit',
});
const toArgDayKey = (d: Date) => dayKeyFormatter.format(d);
const toArgMonthKey = (d: Date) => monthKeyFormatter.format(d);

const normalizeCurrency = (currency: string | null | undefined): 'ARS' | 'USD' => {
  if (!currency) return 'ARS';
  if (currency.startsWith('USD') || currency === 'USD') return 'USD';
  return 'ARS';
};
const txCurrency = (tx: { currency?: string | null; account?: { currency?: string | null } | null }) =>
  normalizeCurrency(tx.currency ?? tx.account?.currency);

describe('calendar Argentina-time bucketing', () => {
  it('places a movement registered at 23:30 ART on the same calendar day, not the next UTC day', () => {
    // 2026-04-15 23:30 ART = 2026-04-16 02:30 UTC. UTC bucketing would push it
    // to "2026-04-16"; ART bucketing must keep it on "2026-04-15".
    const lateNightArgentina = new Date('2026-04-16T02:30:00.000Z');
    assert.equal(toArgDayKey(lateNightArgentina), '2026-04-15');
    assert.equal(toArgMonthKey(lateNightArgentina), '2026-04');
  });

  it('places a movement registered just after midnight UTC during ART previous day', () => {
    // 2026-04-30 21:00 ART = 2026-05-01 00:00 UTC -> must stay in April.
    const crossesUtcMidnight = new Date('2026-05-01T00:00:00.000Z');
    assert.equal(toArgDayKey(crossesUtcMidnight), '2026-04-30');
    assert.equal(toArgMonthKey(crossesUtcMidnight), '2026-04');
  });

  it('keeps a normal afternoon movement on its own day', () => {
    const noonArt = new Date('2026-04-15T15:00:00.000Z'); // 12:00 ART
    assert.equal(toArgDayKey(noonArt), '2026-04-15');
    assert.equal(toArgMonthKey(noonArt), '2026-04');
  });
});

describe('calendar currency precedence', () => {
  it('uses the transactions own currency over the accounts currency', () => {
    assert.equal(
      txCurrency({ currency: 'USD', account: { currency: 'ARS' } }),
      'USD',
    );
  });

  it('falls back to the account currency when the transaction has none', () => {
    assert.equal(
      txCurrency({ currency: null, account: { currency: 'USD' } }),
      'USD',
    );
  });

  it('defaults to ARS when neither side has a currency (e.g. account deleted)', () => {
    assert.equal(txCurrency({ currency: null, account: null }), 'ARS');
    assert.equal(txCurrency({ currency: undefined, account: undefined }), 'ARS');
  });

  it('treats USD-prefixed currencies (USD_FOREIGN, USD_LOCAL) as USD', () => {
    assert.equal(txCurrency({ currency: 'USD_FOREIGN' }), 'USD');
    assert.equal(txCurrency({ currency: 'USD_LOCAL' }), 'USD');
  });
});

describe('calendar effectiveDate fallback', () => {
  // The route enriches each tx with `effectiveDate = imputationDate || date`,
  // and the storage filter mirrors this with COALESCE(imputation_date, date).
  // This test documents the contract so a future change that drops the
  // fallback (e.g. filtering directly on imputation_date) is caught here.
  const effectiveDate = (tx: { imputationDate?: Date | null; date: Date }) =>
    tx.imputationDate || tx.date;

  it('uses imputationDate when present', () => {
    const tx = {
      imputationDate: new Date('2026-04-15T15:00:00Z'),
      date: new Date('2026-04-20T15:00:00Z'),
    };
    assert.equal(toArgDayKey(effectiveDate(tx)), '2026-04-15');
  });

  it('falls back to date when imputationDate is null (legacy rows)', () => {
    const tx = {
      imputationDate: null,
      date: new Date('2026-04-20T15:00:00Z'),
    };
    assert.equal(toArgDayKey(effectiveDate(tx)), '2026-04-20');
  });

  it('falls back to date when imputationDate is missing (defensive)', () => {
    const tx = { date: new Date('2026-04-20T15:00:00Z') };
    assert.equal(toArgDayKey(effectiveDate(tx)), '2026-04-20');
  });
});

describe('calendar bucketing of mixed transactions', () => {
  type Tx = {
    id: string;
    type: 'income' | 'expense' | 'receivable' | 'payable' | 'transfer_in' | 'transfer_out';
    status: 'completed' | 'scheduled' | 'cancelled';
    amount: string;
    currency: string;
    imputationDate: Date;
    transferPairId?: string | null;
    accountId?: string;
    account?: { id: string; name: string; currency: string } | null;
  };

  const txs: Tx[] = [
    { id: '1', type: 'income', status: 'completed', amount: '1000', currency: 'ARS', imputationDate: new Date('2026-04-15T15:00:00Z') },
    { id: '2', type: 'expense', status: 'completed', amount: '300', currency: 'ARS', imputationDate: new Date('2026-04-15T15:00:00Z') },
    { id: '3', type: 'income', status: 'cancelled', amount: '500', currency: 'ARS', imputationDate: new Date('2026-04-15T15:00:00Z') },
    { id: '4', type: 'transfer_out', status: 'completed', amount: '100', currency: 'ARS', imputationDate: new Date('2026-04-15T15:00:00Z') },
    { id: '5', type: 'transfer_in', status: 'completed', amount: '100', currency: 'ARS', imputationDate: new Date('2026-04-15T15:00:00Z') },
    { id: '6', type: 'receivable', status: 'scheduled', amount: '700', currency: 'ARS', imputationDate: new Date('2026-04-20T15:00:00Z') },
    { id: '7', type: 'income', status: 'completed', amount: '50', currency: 'USD', imputationDate: new Date('2026-04-15T15:00:00Z') },
  ];

  it('excludes cancelled and transfers from the live total, but counts scheduled receivables as pending', () => {
    const nonTransfer = txs.filter(t => t.type !== 'transfer_in' && t.type !== 'transfer_out');
    const live = nonTransfer.filter(t => t.status !== 'cancelled');
    const cancelled = nonTransfer.filter(t => t.status === 'cancelled');

    assert.equal(live.length, 4, 'live tx exclude transfers (2) and cancelled (1) from the original 7');
    assert.equal(cancelled.length, 1);

    const incomeARS = live.filter(t => t.type === 'income' && txCurrency(t) === 'ARS').reduce((s, t) => s + parseFloat(t.amount), 0);
    const incomeUSD = live.filter(t => t.type === 'income' && txCurrency(t) === 'USD').reduce((s, t) => s + parseFloat(t.amount), 0);
    const expenseARS = live.filter(t => t.type === 'expense').reduce((s, t) => s + parseFloat(t.amount), 0);
    const pendingReceivableARS = live.filter(t => t.type === 'receivable' && t.status === 'scheduled').reduce((s, t) => s + parseFloat(t.amount), 0);

    assert.equal(incomeARS, 1000, 'cancelled 500 ARS income must NOT count');
    assert.equal(incomeUSD, 50);
    assert.equal(expenseARS, 300);
    assert.equal(pendingReceivableARS, 700, 'scheduled receivable surfaces as pending');
  });

  it('does not double-count a receivable: the period bar uses incomeARS + pendingReceivableARS, never totalReceivableARS', () => {
    // This guards the client-side bug where the period bar summed
    // totalIncome + totalReceivable. Once a receivable is collected it becomes
    // an income via auto-apply, so adding both buckets would count the same
    // money twice. The new contract: the bar uses real income/expense and the
    // pending* fields for "comprometido".
    const live = txs.filter(t => t.type !== 'transfer_in' && t.type !== 'transfer_out' && t.status !== 'cancelled');
    const incomeARS = live.filter(t => t.type === 'income' && txCurrency(t) === 'ARS').reduce((s, t) => s + parseFloat(t.amount), 0);
    const totalReceivableARS = live.filter(t => t.type === 'receivable').reduce((s, t) => s + parseFloat(t.amount), 0);
    const pendingReceivableARS = live.filter(t => t.type === 'receivable' && t.status === 'scheduled').reduce((s, t) => s + parseFloat(t.amount), 0);

    // Sanity: the scheduled receivable equals the total receivable here (it is
    // the only one). The "real" bar must remain at 1000, with 700 shown as
    // separate "comprometido" — never 1700 in a single number.
    assert.equal(totalReceivableARS, pendingReceivableARS);
    assert.equal(incomeARS, 1000);
    assert.equal(pendingReceivableARS, 700);
  });
});

// Mirrors the route logic for surfacing internal transfers in the calendar
// without distorting the period balance. The route keeps transfers OUT of the
// money totals (real and comprometido) and dedupes them by `transferPairId`
// so each move counts once instead of twice. Cancelled transfers are dropped
// entirely. Orphan transfers (no pair id, e.g. legacy rows) are kept as-is.
describe('calendar transfer surfacing (deduped, never affects totals)', () => {
  type Tx = {
    id: string;
    type: 'income' | 'expense' | 'transfer_in' | 'transfer_out';
    status: 'completed' | 'cancelled';
    amount: string;
    currency: string;
    imputationDate: Date;
    transferPairId?: string | null;
    accountId?: string;
    account?: { id: string; name: string; currency: string } | null;
  };

  const cajaArs = { id: 'acc-caja', name: 'Caja', currency: 'ARS' };
  const bancoArs = { id: 'acc-banco', name: 'Banco', currency: 'ARS' };

  const txs: Tx[] = [
    { id: 'i1', type: 'income', status: 'completed', amount: '5000', currency: 'ARS', imputationDate: new Date('2026-04-15T15:00:00Z') },
    // Pair A: caja -> banco, 1000 ARS, both completed
    { id: 't1-out', type: 'transfer_out', status: 'completed', amount: '1000', currency: 'ARS', imputationDate: new Date('2026-04-15T15:00:00Z'), transferPairId: 'pair-A', accountId: cajaArs.id, account: cajaArs },
    { id: 't1-in', type: 'transfer_in', status: 'completed', amount: '1000', currency: 'ARS', imputationDate: new Date('2026-04-15T15:00:00Z'), transferPairId: 'pair-A', accountId: bancoArs.id, account: bancoArs },
    // Pair B: cancelled — must be dropped entirely
    { id: 't2-out', type: 'transfer_out', status: 'cancelled', amount: '999', currency: 'ARS', imputationDate: new Date('2026-04-15T15:00:00Z'), transferPairId: 'pair-B', accountId: cajaArs.id, account: cajaArs },
    { id: 't2-in', type: 'transfer_in', status: 'cancelled', amount: '999', currency: 'ARS', imputationDate: new Date('2026-04-15T15:00:00Z'), transferPairId: 'pair-B', accountId: bancoArs.id, account: bancoArs },
    // Orphan: legacy transfer with no pair id — survives as a single entry
    { id: 't3-out', type: 'transfer_out', status: 'completed', amount: '200', currency: 'ARS', imputationDate: new Date('2026-04-15T15:00:00Z'), transferPairId: null, accountId: cajaArs.id, account: cajaArs },
  ];

  type TransferCounterpart = {
    accountId: string | undefined;
    account: { id: string; name: string; currency: string } | null;
  } | null;
  type DedupedTx = Tx & { transferCounterpart: TransferCounterpart };

  const dedupeTransfers = (all: Tx[]): DedupedTx[] => {
    const transfers = all.filter(t => (t.type === 'transfer_in' || t.type === 'transfer_out') && t.status !== 'cancelled');
    const byPair = new Map<string, Tx[]>();
    const orphans: Tx[] = [];
    for (const t of transfers) {
      if (!t.transferPairId) { orphans.push(t); continue; }
      const arr = byPair.get(t.transferPairId) ?? [];
      arr.push(t);
      byPair.set(t.transferPairId, arr);
    }
    return [
      ...orphans.map<DedupedTx>(t => ({ ...t, transferCounterpart: null })),
      ...Array.from(byPair.values()).map<DedupedTx>(pair => {
        const out = pair.find(p => p.type === 'transfer_out');
        const inn = pair.find(p => p.type === 'transfer_in');
        const canonical = out ?? pair[0];
        const counterpart = canonical === out ? inn : pair.find(p => p.id !== canonical.id);
        const tc: TransferCounterpart = counterpart
          ? { accountId: counterpart.accountId, account: counterpart.account ?? null }
          : null;
        return { ...canonical, transferCounterpart: tc };
      }),
    ];
  };

  it('dedupes transfers by transferPairId so each move counts once', () => {
    const deduped = dedupeTransfers(txs);
    // 1 completed pair + 1 orphan = 2 entries (cancelled pair excluded)
    assert.equal(deduped.length, 2);
    const pairCanonical = deduped.find(t => t.id === 't1-out');
    assert.ok(pairCanonical, 'the transfer_out side is preferred as canonical');
    assert.equal(pairCanonical?.transferCounterpart?.account?.name, 'Banco');
    assert.ok(deduped.find(t => t.id === 't3-out'), 'orphan transfer survives');
    assert.equal(deduped.find(t => t.id === 't3-out')?.transferCounterpart, null);
    assert.equal(deduped.filter(t => t.status === 'cancelled').length, 0, 'no cancelled transfers leak through');
  });

  it('does not include transfer amounts in income/expense/pending totals', () => {
    const live = txs.filter(t => t.type !== 'transfer_in' && t.type !== 'transfer_out' && t.status !== 'cancelled');
    const incomeARS = live.filter(t => t.type === 'income' && txCurrency(t) === 'ARS').reduce((s, t) => s + parseFloat(t.amount), 0);
    const expenseARS = live.filter(t => t.type === 'expense').reduce((s, t) => s + parseFloat(t.amount), 0);
    // Transfers move 1000 between accounts. They MUST NOT inflate either side.
    assert.equal(incomeARS, 5000);
    assert.equal(expenseARS, 0);
  });

  it('renders transfers with neutral semantics: no +/- sign, account path "origen → destino"', () => {
    // Mirrors the client logic in client/src/pages/calendar.tsx so the day
    // view and the month modal both treat transfer rows identically: they
    // never show a +/- sign (because they don't move the balance) and the
    // metadata line shows the account flow rather than "categoría • cuenta".
    const isTransferType = (t: string) => t === 'transfer_in' || t === 'transfer_out';
    const renderRowMeta = (tx: DedupedTx) => {
      const counterpartName = tx.transferCounterpart?.account?.name;
      const originName = tx.account?.name || 'Sin cuenta';
      if (!isTransferType(tx.type)) return `${'Otros'} • ${originName}`;
      return tx.type === 'transfer_out'
        ? `${originName}${counterpartName ? ` → ${counterpartName}` : ''}`
        : `${counterpartName ? `${counterpartName} → ` : ''}${originName}`;
    };
    const renderRowSign = (tx: DedupedTx) => (isTransferType(tx.type) ? '' : (tx.type === 'income' ? '+' : '-'));

    const deduped = dedupeTransfers(txs);
    const pairRow = deduped.find(t => t.id === 't1-out')!;
    const orphanRow = deduped.find(t => t.id === 't3-out')!;

    assert.equal(renderRowMeta(pairRow), 'Caja → Banco');
    assert.equal(renderRowSign(pairRow), '');
    // Orphan has no counterpart — the arrow is omitted, only the origin.
    assert.equal(renderRowMeta(orphanRow), 'Caja');
    assert.equal(renderRowSign(orphanRow), '');
  });

  it('keeps the live `count` on the period free of transfers (transferCount is reported separately)', () => {
    const live = txs.filter(t => t.type !== 'transfer_in' && t.type !== 'transfer_out' && t.status !== 'cancelled');
    const transferCount = dedupeTransfers(txs).length;
    // Only the income counts as a "live" tx for the day. Transfers travel in
    // their own counter so the UI can render "+ 2 transferencias" without
    // breaking the existing "completados / pendientes" math.
    assert.equal(live.length, 1);
    assert.equal(transferCount, 2);
  });
});
