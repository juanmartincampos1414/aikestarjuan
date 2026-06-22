import React, { useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { safeParseDate } from '@/lib/utils';
import { normalizeAmountInput } from '@/lib/currency';
import { type Transaction, type Client, type Supplier } from '@shared/schema';

interface DrillDownGroup {
  label: string;
  color: string;
  transactions: Transaction[];
}

export interface GenericDrillDownItem {
  id: string;
  label: string;
  sublabel?: string;
  amount: string;
  badge?: string;
  badgeColor?: string;
}

interface FormulaLine {
  label: string;
  value: string;
  isResult?: boolean;
  sign?: '+' | '-' | '=';
}

interface DrillDownModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  formula?: string;
  formulaLines?: FormulaLine[];
  transactions?: Transaction[];
  groups?: DrillDownGroup[];
  genericItems?: GenericDrillDownItem[];
  genericItemsLabel?: string;
  totalLabel?: string;
  totalValue?: number;
  totalFormatted?: string;
  getAccountCurrency: (accountId: string | null) => string;
  convertToARS: (amount: number, currency: string) => number;
  targetCurrency?: string;
  clients?: Client[];
  suppliers?: Supplier[];
}

export function DrillDownModal({
  open, onClose, title, formula, formulaLines, transactions, groups, genericItems, genericItemsLabel,
  totalLabel, totalValue, totalFormatted,
  getAccountCurrency, convertToARS, targetCurrency = 'ARS', clients = [], suppliers = [],
}: DrillDownModalProps) {
  const allGroups: DrillDownGroup[] = groups || (transactions ? [{ label: '', color: '', transactions }] : []);
  const allTxs = allGroups.flatMap(g => g.transactions);
  const hasTransactions = allTxs.length > 0;

  const getEntityName = (tx: Transaction) => {
    if (tx.clientId) {
      const client = clients.find(c => c.id === tx.clientId);
      return client?.name || '';
    }
    if (tx.supplierId) {
      const supplier = suppliers.find(s => s.id === tx.supplierId);
      return supplier?.name || '';
    }
    return '';
  };

  const getCurrencySymbol = (currency: string) => {
    if (currency === 'USD' || currency === 'USD_CASH') return 'US$';
    if (currency === 'EUR') return '€';
    return '$';
  };

  const derivedTotal = (() => {
    if (groups && groups.length > 1) {
      return groups.reduce((net, g, i) => {
        const groupTotal = g.transactions.reduce((acc, t) => {
          const currency = t.currency || getAccountCurrency(t.accountId);
          return acc + convertToARS(normalizeAmountInput(t.amount), currency);
        }, 0);
        return i === 0 ? net + groupTotal : net - groupTotal;
      }, 0);
    }
    return allTxs.reduce((acc, t) => {
      const currency = t.currency || getAccountCurrency(t.accountId);
      return acc + convertToARS(normalizeAmountInput(t.amount), currency);
    }, 0);
  })();
  // When the modal renders multiple groups (e.g. Utilidad Neta = Ingresos − Costos − Gastos),
  // the user sees the per-group subtotals summed in the "Resumen del cálculo" card. The total
  // shown at the bottom MUST match that visible sum. If the parent passes a precomputed
  // `totalValue` that disagrees (because it was computed via a different code path with
  // different filters/currency conversion), trust the locally-derived total — it is the one
  // the user can verify with their own eyes — and warn so the divergence is caught in QA.
  const useDerived = !!(groups && groups.length > 1);
  const mismatchDiff = useDerived && totalValue !== undefined && Math.abs(totalValue - derivedTotal) > 0.01
    ? totalValue - derivedTotal
    : null;
  // Emit the mismatch warning from an effect, not during render: render runs on every parent
  // re-render and would spam the console with identical lines. Keyed by the actual values, so
  // it fires once per genuine divergence.
  useEffect(() => {
    if (mismatchDiff !== null) {
      console.warn(
        `[DrillDownModal] Total mismatch on "${title}": precomputed totalValue=${totalValue} but derived from groups=${derivedTotal} (diff ${mismatchDiff}). Showing derived value.`
      );
    }
  }, [mismatchDiff, title, totalValue, derivedTotal]);
  const computedTotal = useDerived ? derivedTotal : (totalValue ?? derivedTotal);

  const targetSymbol = getCurrencySymbol(targetCurrency);
  const formatConverted = (v: number) => {
    const prefix = v < 0 ? `-${targetSymbol} ` : `${targetSymbol} `;
    return `${prefix}${Math.abs(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const getStatusLabel = (tx: Transaction) => {
    if (tx.status === 'completed') {
      if (tx.type === 'payable' || tx.type === 'expense') return 'Pagado';
      return 'Cobrado';
    }
    const labels: Record<string, string> = { scheduled: 'Programado', cancelled: 'Cancelado' };
    return labels[tx.status] || tx.status;
  };

  const statusVariants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    completed: 'default',
    scheduled: 'outline',
    cancelled: 'destructive',
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[800px] w-[95vw] max-h-[85vh] overflow-hidden flex flex-col" data-testid="drill-down-modal">
        <DialogHeader>
          <DialogTitle className="text-lg">{title}</DialogTitle>
          <DialogDescription>
            {formula || (hasTransactions ? `${allTxs.length} movimiento${allTxs.length !== 1 ? 's' : ''}` : 'Detalle del cálculo')}
          </DialogDescription>
        </DialogHeader>

        {formulaLines && formulaLines.length > 0 && (
          <div className="rounded-lg bg-muted/40 border p-3 space-y-1.5 mb-2" data-testid="drill-down-formula">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Cómo se calcula</p>
            {formulaLines.map((fl, i) => (
              <div key={i} className={`flex justify-between items-center text-sm py-1 px-2 rounded ${fl.isResult ? 'bg-primary/10 font-bold border-t mt-1 pt-2' : ''}`}>
                <span className={fl.isResult ? 'text-primary' : 'text-muted-foreground'}>
                  {fl.sign && <span className="mr-1.5 font-mono">{fl.sign}</span>}
                  {fl.label}
                </span>
                <span className={`font-mono tabular-nums ${fl.isResult ? 'text-primary text-base' : ''}`}>{fl.value}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-auto max-h-[60vh]">
          <div className="space-y-4">
            {genericItems && genericItems.length > 0 && (
              <div>
                {genericItemsLabel && (
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">{genericItemsLabel} ({genericItems.length})</p>
                )}
                <div className="space-y-1.5">
                  {genericItems.map((item) => (
                    <div key={item.id} className="flex items-center justify-between p-2 rounded-md bg-muted/30 hover:bg-muted/50 transition-colors text-sm" data-testid={`drill-down-generic-${item.id}`}>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{item.label}</p>
                        {item.sublabel && <p className="text-xs text-muted-foreground">{item.sublabel}</p>}
                      </div>
                      <div className="flex items-center gap-2 ml-2">
                        {item.badge && (
                          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${item.badgeColor || ''}`}>{item.badge}</Badge>
                        )}
                        <span className="font-mono font-medium whitespace-nowrap">{item.amount}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {allGroups.map((group, gi) => (
              <div key={gi}>
                {group.label && (
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <div className={`w-3 h-3 rounded-full ${group.color}`} />
                    <span className="text-sm font-semibold text-muted-foreground">{group.label}</span>
                    <span className="text-xs text-muted-foreground">({group.transactions.length})</span>
                  </div>
                )}

                <div className="sm:hidden space-y-2">
                  {group.transactions.map((tx) => {
                    const currency = tx.currency || getAccountCurrency(tx.accountId);
                    const symbol = getCurrencySymbol(currency);
                    const amount = normalizeAmountInput(tx.amount);
                    const arsAmount = convertToARS(amount, currency);
                    const entity = getEntityName(tx);
                    return (
                      <div key={tx.id} className="border rounded-lg p-3 bg-card space-y-1" data-testid={`drill-down-tx-${tx.id}`}>
                        <div className="flex justify-between items-start">
                          <span className="text-sm font-medium truncate flex-1 mr-2">{tx.description}</span>
                          <span className="text-sm font-bold tabular-nums whitespace-nowrap">
                            {symbol} {amount.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                          </span>
                        </div>
                        <div className="flex justify-between items-center text-xs text-muted-foreground">
                          <span>{format(safeParseDate(tx.date), 'dd/MM/yy')}</span>
                          {currency !== targetCurrency && <span className="text-xs opacity-70">≈ {formatConverted(arsAmount)}</span>}
                          <Badge variant={statusVariants[tx.status] || 'secondary'} className="text-[10px] h-5">
                            {getStatusLabel(tx)}
                          </Badge>
                        </div>
                        {entity && <p className="text-xs text-muted-foreground">{entity}</p>}
                      </div>
                    );
                  })}
                </div>

                <div className="hidden sm:block overflow-x-auto">
                  <table className="min-w-[680px] w-full text-sm">
                    {gi === 0 && hasTransactions && (
                      <thead>
                        <tr className="border-b text-muted-foreground text-xs">
                          <th className="text-left py-2 px-1.5 whitespace-nowrap w-[70px]">Fecha</th>
                          <th className="text-left py-2 px-1.5">Descripción</th>
                          <th className="text-left py-2 px-1.5 whitespace-nowrap w-[110px]">Cliente/Prov.</th>
                          <th className="text-center py-2 px-1.5 whitespace-nowrap w-[75px]">Estado</th>
                          <th className="text-right py-2 px-1.5 whitespace-nowrap w-[120px]">Monto</th>
                          <th className="text-right py-2 px-1.5 whitespace-nowrap w-[120px]">Convertido</th>
                        </tr>
                      </thead>
                    )}
                    <tbody>
                      {group.transactions.map((tx) => {
                        const currency = tx.currency || getAccountCurrency(tx.accountId);
                        const symbol = getCurrencySymbol(currency);
                        const amount = normalizeAmountInput(tx.amount);
                        const arsAmount = convertToARS(amount, currency);
                        const entity = getEntityName(tx);
                        return (
                          <tr key={tx.id} className="border-b last:border-0 hover:bg-muted/30" data-testid={`drill-down-tx-${tx.id}`}>
                            <td className="py-2 px-1.5 text-muted-foreground text-xs whitespace-nowrap">{format(safeParseDate(tx.date), 'dd/MM/yy')}</td>
                            <td className="py-2 px-1.5 font-medium truncate overflow-hidden" title={tx.description}>{tx.description}</td>
                            <td className="py-2 px-1.5 text-muted-foreground truncate overflow-hidden whitespace-nowrap" title={entity || '-'}>{entity || '-'}</td>
                            <td className="py-2 px-1.5 text-center whitespace-nowrap">
                              <Badge variant={statusVariants[tx.status] || 'secondary'} className="text-[10px]">
                                {getStatusLabel(tx)}
                              </Badge>
                            </td>
                            <td className="py-2 px-1.5 text-right font-medium tabular-nums whitespace-nowrap">
                              {symbol} {amount.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                            </td>
                            <td className="py-2 px-1.5 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                              {currency !== targetCurrency ? formatConverted(arsAmount) : ''}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </div>

        {groups && groups.length > 1 && (() => {
          const groupSubtotals = groups.map(g => ({
            label: g.label,
            color: g.color,
            count: g.transactions.length,
            total: g.transactions.reduce((acc, t) => {
              const currency = t.currency || getAccountCurrency(t.accountId);
              return acc + convertToARS(normalizeAmountInput(t.amount), currency);
            }, 0),
          }));
          const netResult = groupSubtotals.reduce((acc, gs, i) => i === 0 ? acc + gs.total : acc - gs.total, 0);
          // Always show the sum the user can verify line-by-line, never a precomputed value
          // that may have come from a different code path. See computedTotal block above.
          const displayTotal = netResult;
          return (
            <div className="border-t pt-3 mt-2">
              <div className="rounded-lg bg-muted/40 border p-3 space-y-2" data-testid="drill-down-summary">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Resumen del cálculo</p>
                {groupSubtotals.map((gs, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <div className={`w-2.5 h-2.5 rounded-full ${gs.color}`} />
                      <span className="text-muted-foreground">{gs.label} ({gs.count})</span>
                    </div>
                    <span className="font-medium tabular-nums">
                      {i > 0 ? '− ' : ''}{formatConverted(gs.total)}
                    </span>
                  </div>
                ))}
                <div className="border-t pt-2 mt-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      {groupSubtotals.map(gs => gs.label).join(' − ')} = <span className="font-semibold">{totalLabel || 'Resultado'}</span>
                    </span>
                    <span className={`text-base font-bold tabular-nums ${displayTotal >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {useDerived ? formatConverted(displayTotal) : (totalFormatted || formatConverted(displayTotal))}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        <div className={`border-t pt-3 ${groups && groups.length > 1 ? 'mt-1' : 'mt-2'}`}>
          <div className="flex justify-between items-center">
            <span className="text-sm font-semibold text-muted-foreground">{totalLabel || 'Total'}</span>
            <span className={`text-lg font-bold tabular-nums ${groups && groups.length > 1 ? (computedTotal >= 0 ? 'text-green-600' : 'text-red-600') : ''}`} data-testid="drill-down-total">
              {useDerived ? formatConverted(computedTotal) : (totalFormatted || formatConverted(computedTotal))}
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
