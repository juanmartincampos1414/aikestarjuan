import React, { useMemo, useState, useCallback } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  format,
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfYear,
  endOfYear,
  addDays,
  addWeeks,
  addMonths,
  addYears,
} from 'date-fns';
import { es } from 'date-fns/locale';
import type { Transaction } from '@shared/schema';
import { normalizeAmountInput } from '@/lib/currency';
import {
  buildReportableTxFilter,
  txCurrency as pickTxCurrency,
  getEffectiveTransactionDate,
} from '@/lib/utils';
import { buildExpenseCategoryDrillDown } from '@/pages/reports.drilldownBuilders';
import type { DrillDownPayload } from '@/pages/reports.drilldownBuilders';

type Mode = 'expense' | 'income';
type Granularity = 'day' | 'week' | 'month' | 'year' | 'period';

interface CategoryDistributionCardProps {
  transactions: Transaction[];
  selectedCurrency: string;
  includedAccountIds: string[];
  accountCurrencyMap: Record<string, string>;
  passesCodeFilter: (t: any) => boolean;
  // Task #476 — multi-product distribution factor for the código de
  // rentabilidad filter. Each transaction's amount is multiplied by this
  // fraction so the donut total, per-category amounts and drill-down footer
  // reflect only the portion belonging to the lines using the selected code.
  // Defaults to 1 (no change) when not provided.
  codeAmountFactor?: (t: any) => number;
  convertAmount: (amount: number, from: string, to: string) => number;
  formatCurrencyFull: (val: number, currency?: string) => string;
  formatCurrencyValue: (val: number, currency?: string) => string;
  globalRangeStart: Date;
  globalRangeEnd: Date;
  setDrillDown: (payload: DrillDownPayload) => void;
  chartRef?: React.RefObject<HTMLDivElement | null>;
}

const CATEGORY_COLORS = [
  '#00D4FF',
  '#FF3366',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#f97316',
  '#84cc16',
  '#6366f1',
];

const GRANULARITY_OPTIONS: { value: Granularity; label: string }[] = [
  { value: 'day', label: 'Día' },
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mes' },
  { value: 'year', label: 'Año' },
  { value: 'period', label: 'Período' },
];

function computeWindow(
  granularity: Granularity,
  cursor: Date,
  globalRangeStart: Date,
  globalRangeEnd: Date,
): { start: Date; end: Date; label: string } {
  switch (granularity) {
    case 'day':
      return {
        start: startOfDay(cursor),
        end: endOfDay(cursor),
        label: format(cursor, "d 'de' MMMM 'de' yyyy", { locale: es }),
      };
    case 'week': {
      const s = startOfWeek(cursor, { weekStartsOn: 1 });
      const e = endOfWeek(cursor, { weekStartsOn: 1 });
      return {
        start: s,
        end: e,
        label: `${format(s, 'd MMM', { locale: es })} – ${format(e, 'd MMM yyyy', { locale: es })}`,
      };
    }
    case 'month':
      return {
        start: startOfMonth(cursor),
        end: endOfMonth(cursor),
        label: format(cursor, "MMMM 'de' yyyy", { locale: es }).replace(/^./, (c) => c.toUpperCase()),
      };
    case 'year':
      return {
        start: startOfYear(cursor),
        end: endOfYear(cursor),
        label: format(cursor, 'yyyy'),
      };
    case 'period':
    default:
      return {
        start: globalRangeStart,
        end: globalRangeEnd,
        label: `${format(globalRangeStart, 'd MMM yyyy', { locale: es })} – ${format(globalRangeEnd, 'd MMM yyyy', { locale: es })}`,
      };
  }
}

function shiftCursor(granularity: Granularity, cursor: Date, direction: -1 | 1): Date {
  switch (granularity) {
    case 'day':
      return addDays(cursor, direction);
    case 'week':
      return addWeeks(cursor, direction);
    case 'month':
      return addMonths(cursor, direction);
    case 'year':
      return addYears(cursor, direction);
    default:
      return cursor;
  }
}

// Compact display for the center of the donut. 5_010_000 → "5,01 M$".
// 1_200 → "1,20 K$". Below 1000 → plain integer.
function formatCompact(value: number, currencySymbol: string): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) {
    return `${sign}${(abs / 1_000_000_000).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} B${currencySymbol}`;
  }
  if (abs >= 1_000_000) {
    return `${sign}${(abs / 1_000_000).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} M${currencySymbol}`;
  }
  if (abs >= 1_000) {
    return `${sign}${(abs / 1_000).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} K${currencySymbol}`;
  }
  return `${sign}${abs.toLocaleString('es-AR', { maximumFractionDigits: 0 })} ${currencySymbol}`;
}

const SIN_CATEGORIA = 'Sin categoría';

export function CategoryDistributionCard(props: CategoryDistributionCardProps) {
  const {
    transactions,
    selectedCurrency,
    includedAccountIds,
    accountCurrencyMap,
    passesCodeFilter,
    codeAmountFactor,
    convertAmount,
    formatCurrencyFull,
    globalRangeStart,
    globalRangeEnd,
    setDrillDown,
    chartRef,
  } = props;

  const [mode, setMode] = useState<Mode>('expense');
  const [granularity, setGranularity] = useState<Granularity>('month');
  const [cursor, setCursor] = useState<Date>(() => new Date());

  const window = useMemo(
    () => computeWindow(granularity, cursor, globalRangeStart, globalRangeEnd),
    [granularity, cursor, globalRangeStart, globalRangeEnd],
  );

  // Aggregation: respects mode, time window, global account/code filters and currency.
  const aggregation = useMemo(() => {
    const reportable = buildReportableTxFilter({ scopeAccountIds: includedAccountIds });
    const byCategory = new Map<string, { name: string; value: number; txs: Transaction[] }>();
    let total = 0;
    (transactions as Transaction[]).forEach((t: any) => {
      if (!reportable(t)) return;
      if (!passesCodeFilter(t)) return;
      const typeOk =
        mode === 'expense'
          ? t.type === 'expense' || t.type === 'payable'
          : t.type === 'income';
      if (!typeOk) return;
      const txDate = getEffectiveTransactionDate(t);
      if (!txDate) return;
      if (txDate < window.start || txDate > window.end) return;
      const factor = codeAmountFactor ? codeAmountFactor(t) : 1;
      const converted = convertAmount(
        normalizeAmountInput(t.amount),
        pickTxCurrency(t, accountCurrencyMap),
        selectedCurrency,
      ) * factor;
      if (!isFinite(converted)) return;
      const rawName = (t.category && String(t.category).trim()) || SIN_CATEGORIA;
      let entry = byCategory.get(rawName);
      if (!entry) {
        entry = { name: rawName, value: 0, txs: [] };
        byCategory.set(rawName, entry);
      }
      entry.value += converted;
      entry.txs.push(t);
      total += converted;
    });
    const rows = Array.from(byCategory.values())
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value);
    return { rows, total };
  }, [
    transactions,
    includedAccountIds,
    passesCodeFilter,
    mode,
    window.start,
    window.end,
    convertAmount,
    accountCurrencyMap,
    selectedCurrency,
    codeAmountFactor,
  ]);

  const handleCategoryClick = useCallback(
    (row: { name: string; value: number; txs: Transaction[] }) => {
      const payload = buildExpenseCategoryDrillDown({
        categoryName: row.name,
        categoryTx: row.txs,
        totalValue: row.value,
        formatCurrencyFull,
      });
      if (mode === 'income') {
        setDrillDown({
          ...payload,
          title: `Ingresos: ${row.name}`,
          formula: `Todos los ingresos en la categoría "${row.name}"`,
        });
      } else {
        setDrillDown(payload);
      }
    },
    [mode, formatCurrencyFull, setDrillDown],
  );

  const handlePieSegmentClick = useCallback(
    (_: any, index: number) => {
      const row = aggregation.rows[index];
      if (row) handleCategoryClick(row);
    },
    [aggregation.rows, handleCategoryClick],
  );

  const goPrev = useCallback(() => setCursor((d) => shiftCursor(granularity, d, -1)), [granularity]);
  const goNext = useCallback(() => setCursor((d) => shiftCursor(granularity, d, 1)), [granularity]);

  // Largest-remainder allocator: returns one-decimal percentages (tenths/10)
  // that sum exactly to 100.0%. Tie-break for the remainder distribution
  // uses banker's rule (prefer the row whose current floor is even); on
  // a second tie, lower index wins for stability.
  const allocatedPercents = useMemo<number[]>(() => {
    const values = aggregation.rows.map((r) => r.value);
    const total = aggregation.total;
    const n = values.length;
    if (n === 0 || total <= 0) return values.map(() => 0);
    const TARGET = 1000; // tenths of a percent → 100.0%
    const raw = values.map((v) => (v / total) * TARGET);
    const floors = raw.map((r) => Math.floor(r));
    const fracs = raw.map((r, i) => r - floors[i]);
    let remaining = TARGET - floors.reduce((a, b) => a + b, 0);
    if (remaining < 0) remaining = 0;
    if (remaining > n) remaining = n;
    const order = raw
      .map((_, i) => i)
      .sort((a, b) => {
        if (fracs[b] !== fracs[a]) return fracs[b] - fracs[a];
        const evenA = floors[a] % 2 === 0;
        const evenB = floors[b] % 2 === 0;
        if (evenA !== evenB) return evenA ? -1 : 1; // banker's: prefer even
        return a - b;
      });
    const tenths = floors.slice();
    for (let k = 0; k < remaining; k++) tenths[order[k]] += 1;
    return tenths.map((t) => t / 10);
  }, [aggregation.rows, aggregation.total]);

  // Display: always 1 decimal with es-AR comma. Sum across all rows is 100,0%
  // by construction; rows with allocated 0,0% but a non-zero value are shown
  // as "<0,1%" so the user can tell the slice exists, while every other row
  // shows its allocated percent verbatim.
  const formatPercent = (allocated: number, rawValue: number) => {
    if (allocated === 0 && rawValue > 0) return '<0,1%';
    return `${allocated.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  };

  const currencySymbol = (selectedCurrency || '').replace(/_CASH$/, '').slice(-3) || '$';
  const compactSymbol = selectedCurrency === 'USD' || selectedCurrency === 'USD_CASH'
    ? 'US$'
    : selectedCurrency === 'EUR' ? '€'
    : '$';
  const showArrows = granularity !== 'period';
  const emptyMessage = mode === 'expense' ? 'No hay egresos en este período' : 'No hay ingresos en este período';

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Análisis por Categoría</CardTitle>
        <CardDescription>
          {mode === 'expense' ? 'Egresos' : 'Ingresos'} ordenados por peso · {window.label}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div ref={chartRef}>
          {/* Toggle Gastos / Ingresos */}
          <div className="grid grid-cols-2 gap-2 mb-3" role="tablist" aria-label="Tipo de movimiento">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'expense'}
              data-testid="tab-category-mode-expense"
              onClick={() => setMode('expense')}
              className={
                'px-3 py-2 text-sm font-medium rounded-md border transition-colors ' +
                (mode === 'expense'
                  ? 'bg-rose-50 border-rose-300 text-rose-700'
                  : 'bg-transparent border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800')
              }
            >
              Gastos
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'income'}
              data-testid="tab-category-mode-income"
              onClick={() => setMode('income')}
              className={
                'px-3 py-2 text-sm font-medium rounded-md border transition-colors ' +
                (mode === 'income'
                  ? 'bg-cyan-50 border-cyan-300 text-cyan-700'
                  : 'bg-transparent border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800')
              }
            >
              Ingresos
            </button>
          </div>

          {/* Granularidad */}
          <div className="flex flex-wrap gap-1.5 mb-2" role="tablist" aria-label="Granularidad temporal">
            {GRANULARITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="tab"
                aria-selected={granularity === opt.value}
                data-testid={`button-category-granularity-${opt.value}`}
                onClick={() => setGranularity(opt.value)}
                className={
                  'px-2.5 py-1 text-xs rounded-full border transition-colors ' +
                  (granularity === opt.value
                    ? 'bg-primary/10 border-primary/40 text-primary font-medium'
                    : 'bg-transparent border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800')
                }
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Navegación */}
          <div className="flex items-center justify-center gap-2 mb-3 min-h-[28px]">
            {showArrows && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={goPrev}
                aria-label="Período anterior"
                data-testid="button-category-prev"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            )}
            <span
              className="text-sm font-medium text-slate-700 dark:text-slate-200 select-none"
              data-testid="text-category-range-label"
            >
              {window.label}
            </span>
            {showArrows && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={goNext}
                aria-label="Período siguiente"
                data-testid="button-category-next"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* Donut */}
          <div className="relative h-[320px] sm:h-[340px] mx-auto max-w-[420px]">
            {aggregation.rows.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground" data-testid="text-category-empty">
                {emptyMessage}
              </div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={aggregation.rows}
                      cx="50%"
                      cy="50%"
                      innerRadius={95}
                      outerRadius={140}
                      paddingAngle={aggregation.rows.length > 1 ? 2 : 0}
                      cornerRadius={6}
                      dataKey="value"
                      className="cursor-pointer"
                      onClick={handlePieSegmentClick}
                      stroke="none"
                    >
                      {aggregation.rows.map((entry, index) => (
                        <Cell key={`cell-${entry.name}`} fill={CATEGORY_COLORS[index % CATEGORY_COLORS.length]} />
                      ))}
                    </Pie>
                    <RechartsTooltip formatter={(value: number) => formatCurrencyFull(value)} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span
                    className="text-3xl sm:text-4xl font-extrabold tracking-tight text-slate-800 dark:text-slate-100"
                    data-testid="text-category-total-compact"
                    title={formatCurrencyFull(aggregation.total)}
                  >
                    {formatCompact(aggregation.total, compactSymbol)}
                  </span>
                  <span className="text-[10px] uppercase tracking-[0.18em] text-slate-400 mt-1.5 font-medium">
                    Total {mode === 'expense' ? 'egresos' : 'ingresos'}
                  </span>
                </div>
              </>
            )}
          </div>

          {/* Lista por categoría con % */}
          {aggregation.rows.length > 0 && (
            <ul
              className="mt-5 space-y-2 max-h-[360px] overflow-y-auto pr-1"
              data-testid="list-category-rows"
            >
              {aggregation.rows.map((row, index) => {
                const color = CATEGORY_COLORS[index % CATEGORY_COLORS.length];
                const pct = formatPercent(allocatedPercents[index] ?? 0, row.value);
                const initial = (row.name.trim().charAt(0) || '?').toUpperCase();
                return (
                  <li key={row.name}>
                    <button
                      type="button"
                      onClick={() => handleCategoryClick(row)}
                      className="w-full flex items-center gap-3 px-3 py-3 rounded-xl bg-slate-50 dark:bg-slate-900/70 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-100 dark:border-slate-800 hover:border-slate-200 text-left transition-colors"
                      data-testid={`row-category-${row.name}`}
                    >
                      <span
                        className="inline-flex items-center justify-center w-10 h-10 rounded-full text-white text-sm font-bold shrink-0 shadow-sm"
                        style={{ backgroundColor: color }}
                        aria-hidden="true"
                      >
                        {initial}
                      </span>
                      <span className="flex-1 text-sm sm:text-[15px] font-medium text-slate-800 dark:text-slate-100 truncate" title={row.name}>
                        {row.name}
                      </span>
                      <span
                        className="text-sm text-slate-500 dark:text-slate-400 tabular-nums shrink-0 min-w-[3.5rem] text-right"
                        data-testid={`text-category-percent-${row.name}`}
                      >
                        {pct}
                      </span>
                      <span
                        className="text-sm sm:text-[15px] font-semibold text-slate-900 dark:text-slate-50 tabular-nums shrink-0 min-w-[5.5rem] text-right"
                        title={formatCurrencyFull(row.value)}
                        data-testid={`text-category-amount-${row.name}`}
                      >
                        {formatCurrencyFull(row.value)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
