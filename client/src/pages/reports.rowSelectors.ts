import { buildReportableTxFilter, type ReportableTx } from '@/lib/utils';

// Task #199 — single source of truth for the row-level predicates the
// Reports page hands to <DrillDownModal>. Every onClick handler in
// `client/src/pages/reports.tsx` and every parity test in `tests/` MUST
// import from this module so the modal row list can never drift from the
// card top number again.
//
// The predicates intentionally encode three layers in one place:
//   1) `buildReportableTxFilter` — strips cancelled originals, [CANCELACIÓN]
//      mirrors, internal transfers and out-of-scope accounts.
//   2) `passesCodeFilter` — applies the active "código de rentabilidad"
//      dropdown so the modal rows match the filter chip.
//   3) Per-bucket type/subtype/assetType — Costos vs Gastos vs Ingresos vs
//      "categoría", with `asset_acquisition` and `investment` excluded from
//      Valoración expenses (they belong to assetsBookValue / investmentsValue).
//
// If any of these layers ever needs a tweak (e.g. add a new excluded
// assetType), this is the only file that should change.

// Minimum shape every row predicate inspects. We constrain selector inputs
// to this so reports.tsx (which uses the full Drizzle `Transaction` type) and
// tests (which use minimal fixtures) can both consume the selectors without
// type casts.
export type RowCandidate = ReportableTx & {
  expenseSubtype?: string | null;
  assetType?: string | null;
  category?: string | null;
};

export type CodeFilter<T extends RowCandidate = RowCandidate> = (t: T) => boolean;

export interface RowSelectorContext<T extends RowCandidate = RowCandidate> {
  scopeAccountIds: string[];
  passesCodeFilter: CodeFilter<T>;
}

export const ALWAYS_PASSES_CODE_FILTER: CodeFilter = () => true;

// Task #476 — multi-product distribution factor for the código de
// rentabilidad filter. When a SPECIFIC code is selected, a multi-product
// transaction (items[]) should only contribute the portion of its amount
// that belongs to the lines using that code, exactly like the
// "Rentabilidad por código" card already does. Every other financial card
// historically counted the FULL amount whenever ANY line matched, which
// over-estimated mixed-code transactions.
//
// Returns a fraction in [0, 1]:
//   • 1 when no specific code is selected ('all') — no behavioural change.
//   • 1 when the transaction has no items[] (single-product / legacy) — it
//     already matched the filter via its legacy profitabilityCodeId, so the
//     whole amount belongs to the selected code.
//   • the share of the matching lines (∑ matching qty×unitPrice ÷ ∑ all
//     qty×unitPrice) for multi-product transactions. When the line subtotals
//     are all zero we fall back to the matching-line count proportion, mirroring
//     profitabilityByCode's `1 / items.length` degenerate branch.
export interface CodeAmountItem {
  quantity?: string | number | null;
  unitPrice?: string | number | null;
  profitabilityCodeId?: string | null;
}

export function codeAmountFactor(
  t: { items?: CodeAmountItem[] | null; profitabilityCodeId?: string | null },
  selectedCodeId: string,
): number {
  if (selectedCodeId === 'all') return 1;
  const items = t.items;
  if (!items || items.length === 0) return 1;
  const lineTotals = items.map((it) => {
    const q = parseFloat(String(it.quantity ?? '0')) || 0;
    const u = parseFloat(String(it.unitPrice ?? '0')) || 0;
    return q * u;
  });
  const sumLines = lineTotals.reduce((s, v) => s + v, 0);
  if (sumLines > 0) {
    let matched = 0;
    items.forEach((it, idx) => {
      if (it.profitabilityCodeId === selectedCodeId) matched += lineTotals[idx];
    });
    return matched / sumLines;
  }
  const matchedCount = items.filter((it) => it.profitabilityCodeId === selectedCodeId).length;
  return matchedCount / items.length;
}

// Expenses that count as Valoración-level operating expenses. We skip
// asset acquisitions and investment outflows because their value is already
// captured by `assetsBookValue` and `investmentsValue` respectively.
function isValuationOperatingExpense(t: RowCandidate): boolean {
  return t.type === 'expense'
    && t.assetType !== 'asset_acquisition'
    && t.assetType !== 'investment';
}

export function selectCostosRows<T extends RowCandidate>(
  transactions: readonly T[],
  ctx: RowSelectorContext<T>,
): T[] {
  const reportable = buildReportableTxFilter({ scopeAccountIds: ctx.scopeAccountIds });
  return transactions.filter(t =>
    isValuationOperatingExpense(t)
    && t.expenseSubtype === 'cost'
    && reportable(t)
    && ctx.passesCodeFilter(t),
  );
}

export function selectGastosRows<T extends RowCandidate>(
  transactions: readonly T[],
  ctx: RowSelectorContext<T>,
): T[] {
  const reportable = buildReportableTxFilter({ scopeAccountIds: ctx.scopeAccountIds });
  return transactions.filter(t =>
    isValuationOperatingExpense(t)
    && t.expenseSubtype !== 'cost'
    && reportable(t)
    && ctx.passesCodeFilter(t),
  );
}

export function selectAllExpensesRows<T extends RowCandidate>(
  transactions: readonly T[],
  ctx: RowSelectorContext<T>,
): T[] {
  const reportable = buildReportableTxFilter({ scopeAccountIds: ctx.scopeAccountIds });
  return transactions.filter(t =>
    isValuationOperatingExpense(t)
    && reportable(t)
    && ctx.passesCodeFilter(t),
  );
}

export function selectIngresosRows<T extends RowCandidate>(
  transactions: readonly T[],
  ctx: RowSelectorContext<T>,
): T[] {
  const reportable = buildReportableTxFilter({ scopeAccountIds: ctx.scopeAccountIds });
  return transactions.filter(t =>
    t.type === 'income'
    && reportable(t)
    && ctx.passesCodeFilter(t),
  );
}

// Task #201 — pending commitments lists rendered under the Económico tab
// ("Cuentas a Pagar" / "Cuentas a Cobrar"). They previously did
// `transactions.filter((t) => t.type === 'payable' && t.status === 'scheduled')`
// inline, which meant they ignored the global exclusion rules
// (cancelled originals, [CANCELACIÓN] mirrors, transfers, out-of-scope
// accounts) and the active "código de rentabilidad" filter. Routing them
// through the shared selectors guarantees that any tweak to those rules
// applies here too — same as every other Reportes card.
export function selectPendingPayables<T extends RowCandidate>(
  transactions: readonly T[],
  ctx: RowSelectorContext<T>,
): T[] {
  const reportable = buildReportableTxFilter({ scopeAccountIds: ctx.scopeAccountIds });
  return transactions.filter(t =>
    t.type === 'payable'
    && t.status === 'scheduled'
    && reportable(t)
    && ctx.passesCodeFilter(t),
  );
}

export function selectPendingReceivables<T extends RowCandidate>(
  transactions: readonly T[],
  ctx: RowSelectorContext<T>,
): T[] {
  const reportable = buildReportableTxFilter({ scopeAccountIds: ctx.scopeAccountIds });
  return transactions.filter(t =>
    t.type === 'receivable'
    && t.status === 'scheduled'
    && reportable(t)
    && ctx.passesCodeFilter(t),
  );
}

// Used by the "Gastos por categoría" pie click handler. Includes payable
// scheduled commitments because the underlying aggregation (expensesByCategory)
// counts them too.
export function selectCategoryRows<T extends RowCandidate>(
  transactions: readonly T[],
  ctx: RowSelectorContext<T>,
  categoryName: string,
): T[] {
  const reportable = buildReportableTxFilter({ scopeAccountIds: ctx.scopeAccountIds });
  return transactions.filter(t =>
    (t.type === 'expense' || t.type === 'payable')
    && reportable(t)
    && ctx.passesCodeFilter(t)
    && t.category === categoryName,
  );
}

// === P&L summary helpers (Ventas / Costos / Gastos en la pestaña Económica)
// The handlers there start from `selectIncludedTxByType(...)` (which already
// applies reportable + code filter + period + completed/scheduled rules),
// so these post-filters only need to split by subtype. Centralising them
// here keeps the "no inline subtype filters in onClick" rule honest.
export function pickCostSubtype<T extends { expenseSubtype?: string | null }>(
  txs: readonly T[],
): T[] {
  return txs.filter(t => t.expenseSubtype === 'cost');
}

export function pickGastoSubtype<T extends { expenseSubtype?: string | null }>(
  txs: readonly T[],
): T[] {
  return txs.filter(t => t.expenseSubtype !== 'cost');
}

// === Task #200 — period-aware selectors for the Económico / Flujo / Burn
// Rate handlers. Previously the page kept these as local useCallback helpers
// (`getIncludedTxByType`, `getMonthTransactions`) that called
// `buildReportableTxFilter` + `transactions.filter` inline. Moving them
// here means every drill-down handler in reports.tsx — Valoración AND
// Económico/Flujo — sources its modal row list from the same module, so
// the lint test in tests/reportsRowSelectorsLint.test.ts can guarantee the
// guardrail covers the whole page (not just Valoración).

export type ReportableDateField = 'date' | 'imputationDate';

export interface IncludedTxByTypeOptions {
  // Single type or list (e.g. 'expense' for Burn Rate, ['income','expense']
  // for Flujo Neto). Matches the original helper signature 1:1.
  types: string | readonly string[];
  periodStart: Date;
  periodEnd: Date;
  // Cash-flow lens vs. P&L lens — same default as the original helper so
  // call sites keep the same behaviour after the migration.
  dateField?: ReportableDateField;
  // P&L cards include scheduled commitments (`payable`/`receivable`); cash
  // cards (Burn Rate / Flujo Neto) only count completed movements.
  includePayableReceivable?: boolean;
}

// Mirrors reports.tsx's `getIncludedTxByType` exactly (period filter via
// `buildReportableTxFilter`, code filter, then either expand to
// payable/receivable or restrict to completed). Kept here so onClick
// handlers can never silently drift from the modal numbers again.
// `RowCandidate` already includes `status` (via ReportableTx), so the
// constraint here just narrows on the same shape.
export function selectIncludedTxByType<T extends RowCandidate>(
  transactions: readonly T[],
  ctx: RowSelectorContext<T>,
  options: IncludedTxByTypeOptions,
): T[] {
  const {
    types,
    periodStart,
    periodEnd,
    dateField = 'date',
    includePayableReceivable = false,
  } = options;
  const typesList = Array.isArray(types) ? Array.from(types) : [types as string];
  const reportable = buildReportableTxFilter({
    scopeAccountIds: ctx.scopeAccountIds,
    periodStart,
    periodEnd,
    dateField,
  });
  return transactions.filter(t => {
    if (!reportable(t)) return false;
    if (!ctx.passesCodeFilter(t)) return false;
    if (includePayableReceivable) {
      // P&L cards include scheduled commitments; the helper already lets
      // them through, so we only need to expand the type set here.
      const expandedTypes: string[] = [];
      typesList.forEach(tp => {
        expandedTypes.push(tp);
        if (tp === 'income') expandedTypes.push('receivable');
        if (tp === 'expense') expandedTypes.push('payable');
      });
      return expandedTypes.includes(t.type ?? '');
    }
    // Real cash-flow cards (Burn Rate, Flujo Neto) only count completed.
    return typesList.includes(t.type ?? '') && t.status === 'completed';
  });
}

export interface MonthRowsOptions {
  monthStart: Date;
  monthEnd: Date;
  dateField?: ReportableDateField;
}

// Mirrors reports.tsx's `getMonthTransactions` exactly: period-scoped
// reportable + code filter, no extra type predicate. The handlers
// (`handleFinancialBarClick`, `handleEconomicChartClick`) hand the result
// straight to the drill-down builders, which split by type/subtype.
export function selectMonthRows<T extends RowCandidate>(
  transactions: readonly T[],
  ctx: RowSelectorContext<T>,
  options: MonthRowsOptions,
): T[] {
  const { monthStart, monthEnd, dateField = 'date' } = options;
  const reportable = buildReportableTxFilter({
    scopeAccountIds: ctx.scopeAccountIds,
    periodStart: monthStart,
    periodEnd: monthEnd,
    dateField,
  });
  return transactions.filter(t => reportable(t) && ctx.passesCodeFilter(t));
}
