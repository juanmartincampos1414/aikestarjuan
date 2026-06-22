import type { Transaction } from '@shared/schema';
import { normalizeAmountInput } from '@/lib/currency';
import { safeParseDate, filterCancellationPairs } from '@/lib/utils';

export interface CCMovement {
  id: string;
  date: Date;
  description: string;
  type: 'income' | 'expense' | 'receivable' | 'payable';
  status: string;
  debe: number;
  haber: number;
  saldo: number;
  currency: string;
}

export interface CCTotalsByCurrency {
  [currency: string]: { totalDebe: number; totalHaber: number; saldo: number };
}

export function normalizeCurrencyKey(c: string): string {
  return (c === 'USD_CASH' || c.toUpperCase().includes('USD')) ? 'USD' : c;
}

export function getCurrencySymbol(c: string): string {
  const norm = normalizeCurrencyKey(c);
  if (norm === 'USD') return 'US$';
  if (norm === 'EUR') return '€';
  return '$';
}

export function calculateClientCC(transactions: Transaction[]): { movements: CCMovement[], totalDebe: number, totalHaber: number, saldoFinal: number, byCurrency: CCTotalsByCurrency } {
  const expanded: CCMovement[] = [];
  const filtered = filterCancellationPairs(transactions);

  for (const tx of filtered) {
    const amount = normalizeAmountInput(tx.amount);
    const origAmount = tx.originalAmount ? normalizeAmountInput(tx.originalAmount) : amount;
    const currency = normalizeCurrencyKey(tx.currency || 'ARS');

    if (tx.type === 'receivable' && tx.status === 'completed') {
      expanded.push({
        id: tx.id + '-debe',
        date: safeParseDate(tx.date),
        description: tx.description || 'Sin descripción',
        type: 'receivable',
        status: 'scheduled',
        debe: origAmount,
        haber: 0,
        saldo: 0,
        currency,
      });
      if (!tx.autoAppliedByTransactionId) {
        expanded.push({
          id: tx.id + '-haber',
          date: tx.completedAt ? safeParseDate(tx.completedAt) : safeParseDate(tx.date),
          description: `Cobro: ${tx.description || 'Sin descripción'}`,
          type: 'income',
          status: 'completed',
          debe: 0,
          haber: amount,
          saldo: 0,
          currency,
        });
      }
    } else if (tx.type === 'receivable') {
      const paidAmount = (tx.originalAmount && tx.autoAppliedByTransactionId && origAmount !== amount) ? origAmount - amount : 0;
      const desc = tx.description || 'Sin descripción';
      const annotatedDesc = paidAmount > 0
        ? `${desc} (Cobro parcial: ${new Intl.NumberFormat('es-AR', { style: 'currency', currency: currency === 'USD' ? 'USD' : currency === 'EUR' ? 'EUR' : 'ARS' }).format(paidAmount)} de ${new Intl.NumberFormat('es-AR', { style: 'currency', currency: currency === 'USD' ? 'USD' : currency === 'EUR' ? 'EUR' : 'ARS' }).format(origAmount)})`
        : desc;
      expanded.push({
        id: tx.id,
        date: safeParseDate(tx.date),
        description: annotatedDesc,
        type: 'receivable',
        status: tx.status,
        debe: origAmount,
        haber: 0,
        saldo: 0,
        currency,
      });
    } else if (tx.type === 'income') {
      expanded.push({
        id: tx.id,
        date: safeParseDate(tx.date),
        description: tx.description || 'Sin descripción',
        type: 'income',
        status: tx.status,
        debe: 0,
        haber: amount,
        saldo: 0,
        currency,
      });
    } else if ((tx.type === 'expense' || tx.type === 'payable') && tx.clientId) {
      expanded.push({
        id: tx.id,
        date: safeParseDate(tx.date),
        description: tx.description || 'Sin descripción',
        type: tx.type as CCMovement['type'],
        status: tx.status,
        debe: amount,
        haber: 0,
        saldo: 0,
        currency,
      });
    }
  }

  expanded.sort((a, b) => a.date.getTime() - b.date.getTime());

  const runningByCurrency: Record<string, number> = {};
  let totalDebe = 0;
  let totalHaber = 0;
  const byCurrency: CCTotalsByCurrency = {};

  for (const m of expanded) {
    const c = m.currency;
    if (!runningByCurrency[c]) runningByCurrency[c] = 0;
    if (!byCurrency[c]) byCurrency[c] = { totalDebe: 0, totalHaber: 0, saldo: 0 };

    totalDebe += m.debe;
    totalHaber += m.haber;
    byCurrency[c].totalDebe += m.debe;
    byCurrency[c].totalHaber += m.haber;
    runningByCurrency[c] = runningByCurrency[c] + m.debe - m.haber;
    m.saldo = runningByCurrency[c];
  }

  for (const c of Object.keys(byCurrency)) {
    byCurrency[c].saldo = runningByCurrency[c];
  }

  const saldoFinal = Object.values(runningByCurrency).reduce((s, v) => s + v, 0);

  return { movements: expanded, totalDebe, totalHaber, saldoFinal, byCurrency };
}

export function calculateSupplierCC(transactions: Transaction[]): { movements: CCMovement[], totalDebe: number, totalHaber: number, saldoFinal: number, byCurrency: CCTotalsByCurrency } {
  const expanded: CCMovement[] = [];
  const filtered = filterCancellationPairs(transactions);

  for (const tx of filtered) {
    const amount = normalizeAmountInput(tx.amount);
    const origAmount = tx.originalAmount ? normalizeAmountInput(tx.originalAmount) : amount;
    const currency = normalizeCurrencyKey(tx.currency || 'ARS');
    const isCancellation = (tx.description || '').startsWith('[CANCELACIÓN]');

    if (tx.type === 'payable' && tx.status === 'completed') {
      expanded.push({
        id: tx.id + '-haber',
        date: safeParseDate(tx.date),
        description: tx.description || 'Sin descripción',
        type: 'payable',
        status: 'scheduled',
        debe: 0,
        haber: origAmount,
        saldo: 0,
        currency,
      });
      if (!tx.autoAppliedByTransactionId) {
        expanded.push({
          id: tx.id + '-debe',
          date: tx.completedAt ? safeParseDate(tx.completedAt) : safeParseDate(tx.date),
          description: `Pago: ${tx.description || 'Sin descripción'}`,
          type: 'expense',
          status: 'completed',
          debe: amount,
          haber: 0,
          saldo: 0,
          currency,
        });
      }
    } else if (tx.type === 'payable') {
      const paidAmount = (tx.originalAmount && tx.autoAppliedByTransactionId && origAmount !== amount) ? origAmount - amount : 0;
      const desc = tx.description || 'Sin descripción';
      const annotatedDesc = paidAmount > 0
        ? `${desc} (Pagado parcial: ${new Intl.NumberFormat('es-AR', { style: 'currency', currency: currency === 'USD' ? 'USD' : currency === 'EUR' ? 'EUR' : 'ARS' }).format(paidAmount)} de ${new Intl.NumberFormat('es-AR', { style: 'currency', currency: currency === 'USD' ? 'USD' : currency === 'EUR' ? 'EUR' : 'ARS' }).format(origAmount)})`
        : desc;
      expanded.push({
        id: tx.id,
        date: safeParseDate(tx.date),
        description: annotatedDesc,
        type: 'payable',
        status: tx.status,
        debe: 0,
        haber: origAmount,
        saldo: 0,
        currency,
      });
    } else if (tx.type === 'expense') {
      expanded.push({
        id: tx.id,
        date: safeParseDate(tx.date),
        description: tx.description || 'Sin descripción',
        type: 'expense',
        status: tx.status,
        debe: amount,
        haber: 0,
        saldo: 0,
        currency,
      });
    } else if (tx.type === 'income' && tx.supplierId) {
      expanded.push({
        id: tx.id,
        date: safeParseDate(tx.date),
        description: tx.description || 'Sin descripción',
        type: 'income',
        status: tx.status,
        debe: 0,
        haber: amount,
        saldo: 0,
        currency,
      });
    } else if (isCancellation && (tx.type === 'receivable' || tx.type === 'income')) {
      expanded.push({
        id: tx.id,
        date: safeParseDate(tx.date),
        description: tx.description || 'Sin descripción',
        type: tx.type as CCMovement['type'],
        status: tx.status,
        debe: 0,
        haber: amount,
        saldo: 0,
        currency,
      });
    }
  }

  expanded.sort((a, b) => a.date.getTime() - b.date.getTime());

  const runningByCurrency: Record<string, number> = {};
  let totalDebe = 0;
  let totalHaber = 0;
  const byCurrency: CCTotalsByCurrency = {};

  for (const m of expanded) {
    const c = m.currency;
    if (!runningByCurrency[c]) runningByCurrency[c] = 0;
    if (!byCurrency[c]) byCurrency[c] = { totalDebe: 0, totalHaber: 0, saldo: 0 };

    totalDebe += m.debe;
    totalHaber += m.haber;
    byCurrency[c].totalDebe += m.debe;
    byCurrency[c].totalHaber += m.haber;
    runningByCurrency[c] = runningByCurrency[c] + m.debe - m.haber;
    m.saldo = runningByCurrency[c];
  }

  for (const c of Object.keys(byCurrency)) {
    byCurrency[c].saldo = runningByCurrency[c];
  }

  const saldoFinal = Object.values(runningByCurrency).reduce((s, v) => s + v, 0);

  return { movements: expanded, totalDebe, totalHaber, saldoFinal, byCurrency };
}

export function calculateAllClientsCCTotal(
  clients: Array<{ id: string }>,
  transactions: Transaction[]
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const client of clients) {
    const clientTxs = transactions.filter(tx => tx.clientId === client.id);
    if (clientTxs.length === 0) continue;
    const { byCurrency } = calculateClientCC(clientTxs);
    for (const [currency, data] of Object.entries(byCurrency)) {
      if (data.saldo > 0) {
        totals[currency] = (totals[currency] || 0) + data.saldo;
      }
    }
  }
  return totals;
}

export function calculateAllSuppliersCCTotal(
  suppliers: Array<{ id: string }>,
  transactions: Transaction[]
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const supplier of suppliers) {
    const supplierTxs = transactions.filter(tx => tx.supplierId === supplier.id);
    if (supplierTxs.length === 0) continue;
    const { byCurrency } = calculateSupplierCC(supplierTxs);
    for (const [currency, data] of Object.entries(byCurrency)) {
      if (data.saldo < 0) {
        totals[currency] = (totals[currency] || 0) + Math.abs(data.saldo);
      }
    }
  }
  return totals;
}
