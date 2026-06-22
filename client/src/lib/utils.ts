import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { parseISO, differenceInDays, differenceInCalendarMonths, isWithinInterval } from "date-fns"
import { isCancellationEntry, type InterestFrequency } from "@shared/schema"
// `getArgentinaToday` vive en `@shared/constants` para que cliente y servidor
// usen exactamente la misma lógica. Se reexporta acá para no romper los
// imports existentes (`@/lib/utils`).
export { getArgentinaToday } from "@shared/constants"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const safeParseDate = (val: string | Date | null | undefined): Date => {
  if (!val) return new Date();
  if (val instanceof Date) return val;
  if (typeof val === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      const [y, m, d] = val.split('-').map(Number);
      return new Date(y, m - 1, d, 12, 0, 0);
    }
    if (/T00:00:00(\.\d+)?Z$/.test(val)) {
      const datePart = val.substring(0, 10);
      const [y, m, d] = datePart.split('-').map(Number);
      return new Date(y, m - 1, d, 12, 0, 0);
    }
    return parseISO(val);
  }
  return new Date(val as any);
};

export function getEffectiveTransactionDate(t: {
  type?: string | null;
  status?: string | null;
  completedAt?: string | Date | null;
  date: string | Date;
}): Date {
  const isCompletedCommitment =
    (t.type === 'payable' || t.type === 'receivable') && t.status === 'completed';
  return safeParseDate(isCompletedCommitment && t.completedAt ? t.completedAt : t.date);
}

// Single source of truth for the "is this transaction reportable?" rules.
// Centralising these checks here keeps every Reports.tsx aggregator (and the
// calendar / drill-down helpers) in lockstep so adding a new metric can never
// silently reintroduce the Juan Campos bug (Task #164):
//   - cancelled originals are excluded
//   - [CANCELACIÓN] mirror entries are excluded
//   - transfer_in / transfer_out never count toward income/expense totals
//   - account scope is honoured when provided
//   - period bucketing uses the same dateField rule as
//     getEffectiveTransactionDate (settlement date for completed commitments
//     when looking through the cash-flow lens, imputation date otherwise).
export type ReportableTx = {
  status?: string | null;
  type?: string | null;
  description?: string | null;
  originalTransactionData?: string | null;
  accountId?: string | null;
  date: string | Date;
  imputationDate?: string | Date | null;
  completedAt?: string | Date | null;
};

export type ReportableTxFilterOptions = {
  scopeAccountIds?: Iterable<string> | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  dateField?: 'date' | 'imputationDate';
};

export function buildReportableTxFilter(
  opts: ReportableTxFilterOptions = {},
): (t: ReportableTx) => boolean {
  const ids = opts.scopeAccountIds != null ? new Set(opts.scopeAccountIds) : null;
  const start = opts.periodStart ?? null;
  const end = opts.periodEnd ?? null;
  const dateField = opts.dateField ?? 'date';
  const hasPeriod = !!(start && end);
  return (t: ReportableTx) => {
    if (!t) return false;
    if (t.status === 'cancelled') return false;
    if (isCancellationEntry(t)) return false;
    if (t.type === 'transfer_in' || t.type === 'transfer_out') return false;
    if (ids && (t.accountId == null || !ids.has(t.accountId))) return false;
    if (hasPeriod) {
      const isCompletedCommitment =
        (t.type === 'payable' || t.type === 'receivable') && t.status === 'completed';
      const txDate = (isCompletedCommitment && dateField === 'date')
        ? getEffectiveTransactionDate(t as { type?: string | null; status?: string | null; completedAt?: string | Date | null; date: string | Date })
        : safeParseDate((t as Record<string, string | Date | null | undefined>)[dateField] || t.date);
      if (!isWithinInterval(txDate, { start: start!, end: end! })) return false;
    }
    return true;
  };
}

// Single helper that picks the currency of a transaction: explicit tx
// currency wins, account currency is the fallback, ARS is the default.
// Replaces the duplicated `t.currency || accountCurrencyMap[t.accountId] || 'ARS'`
// inline expressions across reports / calendar / drill-down code.
export function txCurrency(
  t: { currency?: string | null; accountId?: string | null },
  accountCurrencyMap: Record<string, string>,
): string {
  return t.currency || (t.accountId ? accountCurrencyMap[t.accountId] : undefined) || 'ARS';
}

export function calculateAccruedInterest(account: {
  initialInvestment?: string | null;
  interestRate?: string | null;
  interestFrequency?: string | null;
  interestStartDate?: string | Date | null;
  createdAt?: string | Date | null;
  maturityDate?: string | Date | null;
}): number {
  const capital = account.initialInvestment ? parseFloat(account.initialInvestment) : 0;
  const rate = account.interestRate ? parseFloat(account.interestRate) : 0;
  if (capital <= 0 || rate <= 0) return 0;

  const freq = (account.interestFrequency || 'monthly') as InterestFrequency;
  const anchor = account.interestStartDate ?? account.createdAt;
  const startDate = anchor ? safeParseDate(anchor) : new Date();
  const endDate = account.maturityDate ? (() => {
    const mat = safeParseDate(account.maturityDate);
    return mat < new Date() ? mat : new Date();
  })() : new Date();

  if (endDate <= startDate) return 0;

  let periods = 0;
  switch (freq) {
    case 'daily':
      periods = differenceInDays(endDate, startDate);
      break;
    case 'weekly':
      periods = differenceInDays(endDate, startDate) / 7;
      break;
    case 'monthly':
      periods = differenceInCalendarMonths(endDate, startDate) + 
        (endDate.getDate() - startDate.getDate()) / 30;
      break;
    case 'yearly':
      periods = differenceInCalendarMonths(endDate, startDate) / 12;
      break;
  }

  if (periods < 0) periods = 0;

  return capital * (rate / 100) * periods;
}

export function calculateAccruedInterestForPeriod(account: {
  initialInvestment?: string | null;
  interestRate?: string | null;
  interestFrequency?: string | null;
  interestStartDate?: string | Date | null;
  createdAt?: string | Date | null;
  maturityDate?: string | Date | null;
}, periodStartDate: Date): number {
  const capital = account.initialInvestment ? parseFloat(account.initialInvestment) : 0;
  const rate = account.interestRate ? parseFloat(account.interestRate) : 0;
  if (capital <= 0 || rate <= 0) return 0;

  const freq = (account.interestFrequency || 'monthly') as InterestFrequency;
  const anchor = account.interestStartDate ?? account.createdAt;
  const accountStart = anchor ? safeParseDate(anchor) : new Date();
  const now = new Date();
  const maturityCap = account.maturityDate ? safeParseDate(account.maturityDate) : null;

  const windowStart = periodStartDate > accountStart ? periodStartDate : accountStart;
  const windowEnd = maturityCap && maturityCap < now ? maturityCap : now;

  if (windowEnd <= windowStart) return 0;

  let periods = 0;
  switch (freq) {
    case 'daily':
      periods = differenceInDays(windowEnd, windowStart);
      break;
    case 'weekly':
      periods = differenceInDays(windowEnd, windowStart) / 7;
      break;
    case 'monthly':
      periods = differenceInCalendarMonths(windowEnd, windowStart) +
        (windowEnd.getDate() - windowStart.getDate()) / 30;
      break;
    case 'yearly':
      periods = differenceInCalendarMonths(windowEnd, windowStart) / 12;
      break;
  }
  if (periods < 0) periods = 0;

  return capital * (rate / 100) * periods;
}

export function getEffectiveBalance(account: {
  balance?: string | null;
  initialInvestment?: string | null;
  interestRate?: string | null;
  interestFrequency?: string | null;
  createdAt?: string | Date | null;
  maturityDate?: string | Date | null;
  type?: string | null;
}): number {
  const balance = parseFloat(account.balance || '0');
  const accrued = calculateAccruedInterest(account);
  if (accrued > 0) {
    const capital = parseFloat(account.initialInvestment || '0');
    return capital + accrued;
  }
  return balance;
}

export function filterCancellationPairs<T extends { id: string; description?: string | null; originalTransactionData?: string | null }>(
  items: T[]
): T[] {
  const cancellationIds = new Set<string>();
  const cancelledOriginalIds = new Set<string>();
  for (const item of items) {
    if ((item.description || '').startsWith('[CANCELACIÓN]')) {
      cancellationIds.add(item.id);
      if (item.originalTransactionData) {
        try {
          const orig = JSON.parse(item.originalTransactionData as string);
          if (orig.id) {
            cancelledOriginalIds.add(orig.id);
          }
        } catch {}
      }
    }
  }
  return items.filter(t => !cancellationIds.has(t.id) && !cancelledOriginalIds.has(t.id));
}
