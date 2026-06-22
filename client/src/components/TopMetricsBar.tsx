import React, { useRef, useEffect, useState, useMemo } from 'react';
import { useAccounts, useTransactions, useExchangeRates, useOrganization, useAssets, useInvestments } from '@/lib/hooks';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { Wallet, ArrowDownLeft, ArrowUpRight, Activity, TrendingUp } from 'lucide-react';
import { type Account, type Transaction, CURRENCY_SYMBOLS } from '@shared/schema';
import { normalizeAmountInput } from '@/lib/currency';
import { calculateAccruedInterest, filterCancellationPairs } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { calculateFinancialHealth } from '@/lib/financial-health';
import { employeeAPI } from '@/lib/api';

export default function TopMetricsBar() {
  const { data: organization } = useOrganization();
  const { data: accountsData = [], isFetching: accountsFetching } = useAccounts();
  const { data: transactionsData = [], isFetching: transactionsFetching } = useTransactions();
  const { data: exchangeRates } = useExchangeRates();
  const { data: assetsBarData = [] } = useAssets();
  const { data: investmentsBarData = [] } = useInvestments();
  const [, setLocation] = useLocation();

  const currentOrgId = organization?.id;
  const prevOrgIdRef = useRef<string | undefined>(undefined);
  const [isTransitioning, setIsTransitioning] = useState(false);

  // Detect org change and start transition
  useEffect(() => {
    if (currentOrgId && prevOrgIdRef.current !== currentOrgId) {
      if (prevOrgIdRef.current !== undefined) {
        setIsTransitioning(true);
      }
      prevOrgIdRef.current = currentOrgId;
    }
  }, [currentOrgId]);

  // End transition when fetching completes
  useEffect(() => {
    if (isTransitioning && !accountsFetching && !transactionsFetching) {
      setIsTransitioning(false);
    }
  }, [isTransitioning, accountsFetching, transactionsFetching]);

  // Filter data to only show current org's data, including cancellation pair filtering
  const accounts = (accountsData as Account[]).filter(a => a.organizationId === currentOrgId);
  const allOrgTransactions = (transactionsData as Transaction[]).filter(t => t.organizationId === currentOrgId);
  const transactions = useMemo(() => filterCancellationPairs(allOrgTransactions), [allOrgTransactions]);

  // Only show loading spinner on initial load (when we have no data yet)
  const hasNoData = accounts.length === 0 && transactions.length === 0;
  const isInitialLoading = hasNoData && (accountsFetching || transactionsFetching);
  
  // During org transition, just reduce opacity instead of showing spinner
  const isTransitioningOrFetching = isTransitioning || accountsFetching || transactionsFetching;

  const customUsdRate = (() => {
    const stored = localStorage.getItem('aikestar_custom_usd_rate');
    return stored ? parseFloat(stored) : null;
  })();
  const customEurRate = (() => {
    const stored = localStorage.getItem('aikestar_custom_eur_rate');
    return stored ? parseFloat(stored) : null;
  })();

  const usdRate = customUsdRate || exchangeRates?.usdToLocal || 1050;
  const eurRate = customEurRate || exchangeRates?.eurToLocal || 1150;

  const getEffBal = (a: any): number => {
    if (a.accountCategory === 'investment') {
      const accrued = calculateAccruedInterest(a);
      if (accrued > 0) return parseFloat(a.initialInvestment || '0') + accrued;
    }
    return normalizeAmountInput(a.balance);
  };

  const operativeAccounts = accounts.filter(a => a.accountCategory !== 'investment');

  const totalARS = operativeAccounts
    .filter(a => a.currency === 'ARS')
    .reduce((sum, a) => sum + getEffBal(a), 0);

  const totalUSD = operativeAccounts
    .filter(a => a.currency === 'USD')
    .reduce((sum, a) => sum + getEffBal(a), 0);

  const totalUSDCash = operativeAccounts
    .filter(a => a.currency === 'USD_CASH')
    .reduce((sum, a) => sum + getEffBal(a), 0);

  const combinedUSD = totalUSD + totalUSDCash;

  const investmentAccounts = accounts.filter(a => {
    return a.accountCategory === 'investment';
  });
  const investmentTotalARS = investmentAccounts.reduce((sum, a) => {
    const bal = getEffBal(a);
    if (a.currency === 'USD' || a.currency === 'USD_CASH') return sum + bal * usdRate;
    if (a.currency === 'EUR') return sum + bal * eurRate;
    return sum + bal;
  }, 0);
  const investmentInitialARS = investmentAccounts.reduce((sum, a) => {
    const inv = a.initialInvestment ? normalizeAmountInput(a.initialInvestment) : 0;
    if (inv === 0) return sum;
    if (a.currency === 'USD' || a.currency === 'USD_CASH') return sum + inv * usdRate;
    if (a.currency === 'EUR') return sum + inv * eurRate;
    return sum + inv;
  }, 0);
  const investmentGainLoss = investmentTotalARS - investmentInitialARS;
  const investmentRendPct = investmentInitialARS > 0 ? (investmentGainLoss / investmentInitialARS) * 100 : 0;
  const hasInvestments = investmentAccounts.length > 0;

  const barAssetsBookValue = (assetsBarData || []).reduce((sum: number, asset: any) => {
    const acqVal = parseFloat(asset.acquisitionValue?.toString() || '0');
    const depr = parseFloat(asset.accumulatedDepreciation?.toString() || '0');
    const bv = Math.max(0, acqVal - depr);
    const c = asset.currency || 'ARS';
    if (c === 'USD' || c === 'USD_CASH') return sum + bv * usdRate;
    if (c === 'EUR') return sum + bv * eurRate;
    return sum + bv;
  }, 0);

  const barInvestmentsValue = (investmentsBarData || []).reduce((sum: number, inv: any) => {
    const qty = parseFloat(inv.quantity?.toString() || '0');
    const cp = parseFloat(inv.currentPrice?.toString() || '0');
    const tc = parseFloat(inv.totalCost?.toString() || '0');
    const cv = cp > 0 ? qty * cp : tc;
    const c = inv.currency || 'ARS';
    if (c === 'USD' || c === 'USD_CASH') return sum + cv * usdRate;
    if (c === 'EUR') return sum + cv * eurRate;
    return sum + cv;
  }, 0);

  const { data: payrollSummary } = useQuery<{
    totalEmployees: number;
    byCurrency: Record<string, { total: number; employees: any[] }>;
    payrollPayDay: number | null;
    nextPayDate: string | null;
    payrollStatus: 'not_configured' | 'pending' | 'overdue' | 'paid';
  }>({
    queryKey: ['/api/employees/payroll-summary'],
    queryFn: () => employeeAPI.getPayrollSummary(),
  });

  const barPayrollTotalARS = useMemo(() => {
    if (!payrollSummary || payrollSummary.totalEmployees === 0) return 0;
    let total = 0;
    Object.entries(payrollSummary.byCurrency).forEach(([c, d]) => {
      const cur = c || 'ARS';
      if (cur === 'USD' || cur === 'USD_CASH' || cur.toUpperCase().includes('USD')) total += d.total * usdRate;
      else if (cur === 'EUR') total += d.total * eurRate;
      else total += d.total;
    });
    return total;
  }, [payrollSummary, usdRate, eurRate]);

  const { healthScore } = calculateFinancialHealth({
    transactions,
    accounts,
    usdRate,
    eurRate,
    assetsBookValue: barAssetsBookValue,
    investmentsValue: barInvestmentsValue,
    payrollTotalARS: barPayrollTotalARS
  });

  const pendingStatuses = ['scheduled'];
  const convertTxToARS = (amount: number, currency: string) => {
    const c = currency || 'ARS';
    if (c === 'USD' || c === 'USD_CASH' || c.toUpperCase().includes('USD')) return amount * usdRate;
    if (c === 'EUR') return amount * eurRate;
    return amount;
  };
  // Same currency priority as DrillDownModal / dashboard (Task #245): tx-level wins, then
  // account currency, then ARS. Without the account fallback, legacy transactions with no
  // `currency` recorded would always be treated as ARS even when their account is USD/EUR,
  // making "A Cobrar"/"A Pagar" diverge from the cards and drill-downs.
  const getAccountCurrencyTop = (accountId: string | null): string => {
    if (!accountId) return 'ARS';
    return accounts.find(a => a.id === accountId)?.currency || 'ARS';
  };
  const txCurrency = (t: Transaction): string =>
    t.currency || getAccountCurrencyTop(t.accountId) || 'ARS';

  const pendingPayable = (() => {
    let total = transactions
      .filter(t => t.type === 'payable' && pendingStatuses.includes(t.status))
      .reduce((acc, t) => acc + convertTxToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);
    if (payrollSummary && payrollSummary.totalEmployees > 0) {
      Object.entries(payrollSummary.byCurrency).forEach(([c, d]) => {
        total += convertTxToARS(d.total, c);
      });
    }
    return total;
  })();

  const pendingReceivable = transactions
    .filter(t => t.type === 'receivable' && pendingStatuses.includes(t.status))
    .reduce((acc, t) => acc + convertTxToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);

  const healthColor = healthScore >= 70 ? 'text-green-500' : healthScore >= 40 ? 'text-amber-500' : 'text-red-500';
  const healthBgColor = healthScore >= 70 ? 'bg-green-500' : healthScore >= 40 ? 'bg-amber-500' : 'bg-red-500';

  const formatCompact = (value: number, includeSign: boolean = false): string => {
    const absValue = Math.abs(value);
    const prefix = includeSign ? (value >= 0 ? '+' : '-') : (value < 0 ? '-' : '');
    
    if (absValue >= 1000000) {
      const millions = absValue / 1000000;
      return `${prefix}${millions.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}M`;
    }
    if (absValue >= 1000) {
      const thousands = absValue / 1000;
      return `${prefix}${thousands.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}K`;
    }
    return `${prefix}${absValue.toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;
  };

  if (isInitialLoading) {
    return (
      <div className="bg-slate-900/95 backdrop-blur-sm border-b border-slate-700/50 px-4 py-2">
        <div className="max-w-7xl mx-auto flex items-center justify-center gap-2">
          <div className="h-4 w-4 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
          <span className="text-xs text-slate-400">Cargando métricas...</span>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className={`bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 border-b border-slate-700/50 px-2 sm:px-4 py-2 shadow-lg transition-opacity duration-200 ${isTransitioningOrFetching ? 'opacity-70' : 'opacity-100'}`}>
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-1 sm:gap-4">
          {/* Metrics - compact on mobile */}
          <div className="flex flex-wrap items-center gap-1 sm:gap-3 md:gap-6">
            {/* ARS - always visible */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1 sm:gap-2 cursor-default px-1.5 sm:px-2 py-1 rounded-lg bg-blue-500/10">
                  <Wallet className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-blue-400" />
                  <div className="flex flex-col">
                    <span className="text-[8px] sm:text-[10px] text-slate-400 uppercase tracking-wider">ARS</span>
                    <span className="text-xs sm:text-sm font-bold text-white">${formatCompact(totalARS)}</span>
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>Total en Pesos: ${totalARS.toLocaleString('es-AR')}</p>
              </TooltipContent>
            </Tooltip>

            {/* USD - always visible if exists */}
            {combinedUSD !== 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1 sm:gap-2 cursor-default px-1.5 sm:px-2 py-1 rounded-lg bg-green-500/10">
                    <Wallet className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-green-400" />
                    <div className="flex flex-col">
                      <span className="text-[8px] sm:text-[10px] text-slate-400 uppercase tracking-wider">USD</span>
                      <span className="text-xs sm:text-sm font-bold text-white">${formatCompact(combinedUSD)}</span>
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>Total en Dólares: ${combinedUSD.toLocaleString('es-AR')}</p>
                </TooltipContent>
              </Tooltip>
            )}

            {/* Por Cobrar - compact on mobile */}
            {pendingReceivable !== 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1 sm:gap-2 cursor-default px-1.5 sm:px-2 py-1 rounded-lg bg-emerald-500/10">
                    <ArrowDownLeft className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-emerald-400" />
                    <div className="flex flex-col">
                      <span className="text-[8px] sm:text-[10px] text-slate-400 uppercase tracking-wider">Por Cobrar</span>
                      <span className="text-xs sm:text-sm font-bold text-emerald-400">+${formatCompact(Math.abs(pendingReceivable))}</span>
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>Por Cobrar: ${pendingReceivable.toLocaleString('es-AR')}</p>
                </TooltipContent>
              </Tooltip>
            )}

            {/* Por Pagar - compact on mobile */}
            {pendingPayable !== 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1 sm:gap-2 cursor-default px-1.5 sm:px-2 py-1 rounded-lg bg-rose-500/10">
                    <ArrowUpRight className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-rose-400" />
                    <div className="flex flex-col">
                      <span className="text-[8px] sm:text-[10px] text-slate-400 uppercase tracking-wider">Por Pagar</span>
                      <span className="text-xs sm:text-sm font-bold text-rose-400">-${formatCompact(Math.abs(pendingPayable))}</span>
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>Por Pagar: ${pendingPayable.toLocaleString('es-AR')}</p>
                </TooltipContent>
              </Tooltip>
            )}
            {hasInvestments && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1 sm:gap-2 cursor-default px-1.5 sm:px-2 py-1 rounded-lg bg-violet-500/10" data-testid="metric-inversiones">
                    <TrendingUp className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-violet-400" />
                    <div className="flex flex-col">
                      <span className="text-[8px] sm:text-[10px] text-slate-400 uppercase tracking-wider">Inversiones</span>
                      <div className="flex items-center gap-1">
                        <span className="text-xs sm:text-sm font-bold text-white">${formatCompact(investmentTotalARS)}</span>
                        {investmentInitialARS > 0 && (
                          <span className={`text-[9px] sm:text-xs font-semibold ${investmentGainLoss >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {investmentGainLoss >= 0 ? '▲' : '▼'}{Math.abs(investmentRendPct).toFixed(1)}%
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>Inversiones: ${investmentTotalARS.toLocaleString('es-AR')}</p>
                  {investmentInitialARS > 0 && (
                    <p className={investmentGainLoss >= 0 ? 'text-green-500' : 'text-red-500'}>
                      Rendimiento: {investmentGainLoss >= 0 ? '+' : ''}{investmentRendPct.toFixed(1)}% ({investmentGainLoss >= 0 ? '+' : ''}${formatCompact(investmentGainLoss)})
                    </p>
                  )}
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {/* Health indicator - clickable, opens detail dialog */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div 
                className="flex items-center gap-1 sm:gap-2 cursor-pointer shrink-0 hover:opacity-80 transition-opacity"
                onClick={() => {
                  if (window.location.pathname === '/') {
                    window.dispatchEvent(new CustomEvent('openHealthDialog'));
                  } else {
                    sessionStorage.setItem('openHealthDialog', 'true');
                    setLocation('/');
                  }
                }}
                data-testid="header-health-indicator"
              >
                <Activity className={`h-3.5 w-3.5 sm:h-4 sm:w-4 ${healthColor}`} />
                <div className="hidden sm:flex items-center gap-2">
                  <div className="w-16 sm:w-20 h-2 bg-slate-700 rounded-full overflow-hidden">
                    <div 
                      className={`h-full ${healthBgColor} transition-all duration-500`}
                      style={{ width: `${healthScore}%` }}
                    />
                  </div>
                </div>
                <span className={`text-xs sm:text-sm font-bold ${healthColor}`}>{healthScore}%</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>Salud Financiera: {healthScore}% — Click para ver detalles</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}
