import React, { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAccounts, useTransactions, useOrganization, useExchangeRates, useUser, useUpdateAccount, useAdjustAccountBalance, useForceAccountBalance, useMembership, useAssets, useInvestments, useClients, useSuppliers } from '@/lib/hooks';
import { useScrollState } from '@/components/layout/DashboardLayout';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { ArrowUpRight, ArrowDownLeft, ArrowRightLeft, Wallet, TrendingUp, Plus, Camera, Film, AlertTriangle, Clock, CreditCard, Receipt, Building, Building2, Info, HelpCircle, Sparkles, Loader2, ChevronDown, ChevronUp, Lightbulb, Maximize2, Minimize2, MoreVertical, Scale, BarChart3, Zap, Lock, ArrowUp, ArrowDown, Calendar, PieChart, Repeat, Percent, Smartphone } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Pencil, Check as CheckIcon, X as XIcon } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { type Currency, type Account, type Transaction, CURRENCY_SYMBOLS, CURRENCY_LABELS, CURRENCIES, ROLE_PERMISSIONS, type Role, FINANCIAL_ACCOUNT_TYPE_CONFIG, type FinancialAccountType, OPERATIVE_ACCOUNT_TYPES, INVESTMENT_ACCOUNT_TYPES, INTEREST_FREQUENCIES, INTEREST_FREQUENCY_LABELS, type InterestFrequency, FINANCIAL_ACCOUNT_TYPES } from '@shared/schema';
import { getIconByKey } from '@/components/OrganizationBrandPicker';
import { getProfileIconByKey } from '@/components/UserProfilePicker';

import { TransactionWizard } from '@/components/transaction-wizard';
import { DrillDownModal } from '@/components/DrillDownModal';
import { CurrencyWithTooltip } from '@/components/CurrencyWithTooltip';
import { fetchWithAuth, employeeAPI } from '@/lib/api';
import { TiendanubeDashboardAlert } from '@/components/integrations/TiendanubeDashboardAlert';
import { CrmDashboardCards } from '@/components/crm/CrmDashboardCards';
import { OpsDashboardCards } from '@/components/crm/OpsDashboardCards';
import { InvestmentsDashboardCard } from '@/components/crm/InvestmentsDashboardCard';
import { normalizeAmountInput, formatAmountLive } from '@/lib/currency';
import { useToast } from '@/hooks/use-toast';
import { safeParseDate, calculateAccruedInterest, filterCancellationPairs, getEffectiveTransactionDate } from '@/lib/utils';
import { calculateFinancialHealth } from '@/lib/financial-health';

const dashboardAccountSchema = z.object({
  name: z.string().min(2, 'El nombre es requerido'),
  accountCategory: z.enum(['operative', 'investment']),
  type: z.enum(FINANCIAL_ACCOUNT_TYPES),
  customTypeLabel: z.string().optional(),
  currency: z.enum(CURRENCIES),
  balance: z.string().min(1, 'El saldo inicial es requerido'),
  initialInvestment: z.string().optional(),
  maturityDate: z.string().optional(),
  interestRate: z.string().optional(),
  interestFrequency: z.string().optional(),
});
type DashboardAccountFormValues = z.infer<typeof dashboardAccountSchema>;

const getAccountTypeLabel = (type: string) => {
  const config = FINANCIAL_ACCOUNT_TYPE_CONFIG[type as FinancialAccountType];
  return config?.label || type;
};
const getAccountTypeShortLabel = (type: string) => {
  const labels: Record<string, string> = {
    'bank': 'Banco', 'cash': 'Efectivo', 'wallet': 'Billetera', 'credit_card': 'Tarjeta',
    'investment': 'Inversión', 'broker': 'Broker', 'crypto': 'Cripto',
    'fintech': 'Fintech', 'fixed_term': 'Plazo Fijo', 'other': 'Otro'
  };
  return labels[type] || type;
};
const getAccountIcon = (type: string, colorClass: string) => {
  const config = FINANCIAL_ACCOUNT_TYPE_CONFIG[type as FinancialAccountType];
  const iconColor = colorClass || config?.color || 'text-gray-600 dark:text-slate-300';
  switch(type) {
    case 'bank': return <CreditCard className={`h-4 w-4 ${iconColor}`} />;
    case 'cash': return <Receipt className={`h-4 w-4 ${iconColor}`} />;
    case 'wallet': return <CreditCard className={`h-4 w-4 ${iconColor}`} />;
    case 'investment': return <TrendingUp className={`h-4 w-4 ${iconColor}`} />;
    case 'broker': return <BarChart3 className={`h-4 w-4 ${iconColor}`} />;
    case 'crypto': return <Wallet className={`h-4 w-4 ${iconColor}`} />;
    case 'fintech': return <Zap className={`h-4 w-4 ${iconColor}`} />;
    case 'fixed_term': return <Lock className={`h-4 w-4 ${iconColor}`} />;
    case 'credit_card': return <CreditCard className={`h-4 w-4 ${iconColor}`} />;
    default: return <CreditCard className={`h-4 w-4 ${iconColor}`} />;
  }
};
const getAccountBgGradient = (type: string) => {
  const gradients: Record<string, string> = {
    'bank': 'bg-gradient-to-br from-blue-100 to-blue-50',
    'cash': 'bg-gradient-to-br from-emerald-100 to-emerald-50',
    'wallet': 'bg-gradient-to-br from-purple-100 to-purple-50',
    'credit_card': 'bg-gradient-to-br from-orange-100 to-orange-50',
    'investment': 'bg-gradient-to-br from-emerald-100 to-emerald-50',
    'broker': 'bg-gradient-to-br from-indigo-100 to-indigo-50',
    'crypto': 'bg-gradient-to-br from-amber-100 to-amber-50',
    'fintech': 'bg-gradient-to-br from-cyan-100 to-cyan-50',
    'fixed_term': 'bg-gradient-to-br from-teal-100 to-teal-50',
    'other': 'bg-gradient-to-br from-gray-100 to-gray-50',
  };
  return gradients[type] || gradients['other'];
};

export default function DashboardPage() {
  const { data: accountsData = [], isLoading: accountsLoading } = useAccounts();
  const { data: transactionsData = [], isLoading: transactionsLoading } = useTransactions();
  const { data: assetsData = [] } = useAssets();
  const { data: investmentsData = [] } = useInvestments();
  
  const accounts = accountsData as Account[];
  const allTransactions = transactionsData as Transaction[];
  const transactions = useMemo(() => filterCancellationPairs(allTransactions), [allTransactions]);
  const { data: organization } = useOrganization();
  const { data: user } = useUser();
  const { data: exchangeRates } = useExchangeRates();
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
  const { isScrolled } = useScrollState();
  const [, navigate] = useLocation();
  const { data: membership } = useMembership();
  const updateAccountMutation = useUpdateAccount();
  const adjustBalanceMutation = useAdjustAccountBalance();
  const forceBalanceMutation = useForceAccountBalance();
  const { toast } = useToast();
  const [editAccount, setEditAccount] = useState<any>(null);
  const [confirmDiscardEdit, setConfirmDiscardEdit] = useState(false);
  const [adjustAccount, setAdjustAccount] = useState<any>(null);
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustDisplayValue, setAdjustDisplayValue] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [forceMode, setForceMode] = useState(false);
  const [editInvestmentDisplayValue, setEditInvestmentDisplayValue] = useState('');
  const { data: clientsData = [] } = useClients();
  const { data: suppliersData = [] } = useSuppliers();
  const [drillDownMetric, setDrillDownMetric] = useState<string | null>(null);

  // Task #219: WhatsApp "abandoned wizard" reminder banner.
  // Shows when the user has a phoneNumber loaded but `phoneVerified=false`
  // AND it has been sitting unverified for more than 24h. Dismissable; we
  // remember the dismissal in localStorage and re-arm it after 7 days so we
  // don't pester users who actively decided to skip linking.
  // The dismiss key is scoped per user.id so a dismissal on a shared browser
  // doesn't suppress the banner for a different user signed in afterwards.
  const PHONE_BANNER_DISMISS_KEY_PREFIX = 'phoneVerifyBannerDismissedAt:';
  const PHONE_BANNER_AGE_MS = 24 * 60 * 60 * 1000;
  const PHONE_BANNER_REARM_MS = 7 * 24 * 60 * 60 * 1000;
  const phoneBannerDismissKey = user?.id
    ? `${PHONE_BANNER_DISMISS_KEY_PREFIX}${user.id}`
    : null;
  // Read dismissal flag whenever the active user changes (and on mount). We
  // intentionally key the effect on `phoneBannerDismissKey` so switching
  // accounts in the same browser session re-evaluates from storage.
  const [phoneBannerDismissed, setPhoneBannerDismissed] = useState<boolean>(false);
  useEffect(() => {
    if (!phoneBannerDismissKey) {
      setPhoneBannerDismissed(false);
      return;
    }
    try {
      const raw = localStorage.getItem(phoneBannerDismissKey);
      if (!raw) {
        setPhoneBannerDismissed(false);
        return;
      }
      const ts = parseInt(raw, 10);
      if (!Number.isFinite(ts)) {
        setPhoneBannerDismissed(false);
        return;
      }
      setPhoneBannerDismissed(Date.now() - ts < PHONE_BANNER_REARM_MS);
    } catch {
      setPhoneBannerDismissed(false);
    }
  }, [phoneBannerDismissKey, PHONE_BANNER_REARM_MS]);
  const showPhoneVerifyBanner = useMemo(() => {
    if (phoneBannerDismissed) return false;
    if (!user?.phoneNumber) return false;
    if (user.phoneVerified) return false;
    const addedAt = user.phoneNumberAddedAt;
    if (!addedAt) return false;
    const ts = Date.parse(addedAt);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts > PHONE_BANNER_AGE_MS;
  }, [user?.phoneNumber, user?.phoneVerified, user?.phoneNumberAddedAt, phoneBannerDismissed]);
  const handleDismissPhoneBanner = () => {
    if (phoneBannerDismissKey) {
      try {
        localStorage.setItem(phoneBannerDismissKey, String(Date.now()));
      } catch {
        // Best-effort: even if storage fails (private mode), hide for the
        // current session by flipping the in-memory flag.
      }
    }
    setPhoneBannerDismissed(true);
  };

  const userRole = membership?.role as Role | undefined;
  const userPermissions = userRole ? ROLE_PERMISSIONS[userRole] || [] : [];
  const canEditAccounts = userPermissions.includes('accounts:edit');

  const dashboardEditForm = useForm<DashboardAccountFormValues>({
    resolver: zodResolver(dashboardAccountSchema),
    defaultValues: { name: '', accountCategory: 'operative', type: 'bank', currency: 'ARS', balance: '0', initialInvestment: '', maturityDate: '', interestRate: '', interestFrequency: 'monthly' },
  });

  const handleDashboardEditOpen = (acc: any) => {
    const accType = (acc.type || 'bank') as FinancialAccountType;
    const category = acc.accountCategory || 'operative';
    const investmentVal = acc.initialInvestment ? acc.initialInvestment.toString() : '';
    const maturityVal = acc.maturityDate ? (() => {
      const d = safeParseDate(acc.maturityDate);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })() : '';
    dashboardEditForm.reset({
      name: acc.name,
      accountCategory: category,
      type: accType,
      currency: (acc.currency || 'ARS') as Currency,
      balance: acc.balance.toString(),
      customTypeLabel: acc.customTypeLabel || '',
      initialInvestment: investmentVal,
      maturityDate: maturityVal,
      interestRate: acc.interestRate ? acc.interestRate.toString() : '',
      interestFrequency: acc.interestFrequency || 'monthly',
    });
    if (investmentVal) {
      const { displayValue } = formatAmountLive(investmentVal, '');
      setEditInvestmentDisplayValue(displayValue);
    } else {
      setEditInvestmentDisplayValue('');
    }
    setEditAccount(acc);
  };

  const handleDashboardEditClose = (open: boolean) => {
    if (!open && editAccount) {
      if (dashboardEditForm.formState.isDirty) {
        setConfirmDiscardEdit(true);
        return;
      }
    }
    if (!open) setEditAccount(null);
  };

  const confirmDashboardDiscard = () => {
    setEditAccount(null);
    setConfirmDiscardEdit(false);
  };

  const onDashboardEditSubmit = async (data: DashboardAccountFormValues) => {
    if (!editAccount) return;
    try {
      const needsCustomLabel = data.type === 'other' || data.type === 'other_investment' || (data.accountCategory === 'investment' && data.customTypeLabel);
      const isInvestment = data.accountCategory === 'investment';
      await updateAccountMutation.mutateAsync({
        id: editAccount.id,
        data: {
          name: data.name,
          type: data.type,
          currency: data.currency as Currency,
          accountCategory: data.accountCategory,
          customTypeLabel: needsCustomLabel ? data.customTypeLabel : null,
          initialInvestment: isInvestment && data.initialInvestment ? data.initialInvestment : null,
          maturityDate: isInvestment && data.maturityDate ? data.maturityDate : null,
          interestRate: isInvestment && data.interestRate ? data.interestRate : null,
          interestFrequency: isInvestment && data.interestFrequency ? data.interestFrequency : null,
        },
      });
      toast({ title: "Cuenta actualizada", description: `La cuenta ${data.name} ha sido actualizada.` });
      setEditAccount(null);
    } catch (error: any) {
      toast({ title: "Error", description: error.message || "No se pudo actualizar la cuenta", variant: "destructive" });
    }
  };

  const handleDashboardAdjustOpen = (acc: any) => {
    setAdjustAccount(acc);
    const effectiveBalance = getAccountEffectiveBalance(acc);
    const balanceStr = effectiveBalance.toString();
    setAdjustAmount(balanceStr);
    const { displayValue } = formatAmountLive(balanceStr, '');
    setAdjustDisplayValue(displayValue);
    setAdjustReason('');
    setForceMode(false);
  };

  const formatCurrencyForAdjust = (value: number | string, currency: Currency) => {
    const num = typeof value === 'string' ? normalizeAmountInput(value) : value;
    const symbol = CURRENCY_SYMBOLS[currency] || 'AR$';
    return symbol + ' ' + num.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Custom exchange rate state (user editable)
  const [customUsdRate, setCustomUsdRate] = useState<number | null>(() => {
    const stored = localStorage.getItem('aikestar_custom_usd_rate');
    return stored ? parseFloat(stored) : null;
  });
  const [customEurRate, setCustomEurRate] = useState<number | null>(() => {
    const stored = localStorage.getItem('aikestar_custom_eur_rate');
    return stored ? parseFloat(stored) : null;
  });
  const [isEditingRates, setIsEditingRates] = useState(false);
  const [editUsdRate, setEditUsdRate] = useState('');
  const [editEurRate, setEditEurRate] = useState('');

  // Exchange rate helper - use custom rate if set, otherwise API rate
  const apiUsdRate = exchangeRates?.usdToLocal || 1050;
  const apiEurRate = exchangeRates?.eurToLocal || 1150;
  const usdRate = customUsdRate || apiUsdRate;
  const eurRate = customEurRate || apiEurRate;
  const rateSource = customUsdRate ? 'personalizado' : (exchangeRates?.source || 'estimado');
  const hasLiveRates = !!exchangeRates?.usdToLocal || !!customUsdRate;
  const rateTimestamp = exchangeRates?.timestamp ? new Date(exchangeRates.timestamp) : null;

  const handleStartEditRates = () => {
    setEditUsdRate(usdRate.toString());
    setEditEurRate(eurRate.toString());
    setIsEditingRates(true);
  };

  const handleSaveRates = () => {
    const newUsd = normalizeAmountInput(editUsdRate);
    const newEur = normalizeAmountInput(editEurRate);
    if (newUsd > 0) {
      setCustomUsdRate(newUsd);
      localStorage.setItem('aikestar_custom_usd_rate', newUsd.toString());
    }
    if (newEur > 0) {
      setCustomEurRate(newEur);
      localStorage.setItem('aikestar_custom_eur_rate', newEur.toString());
    }
    setIsEditingRates(false);
  };

  const handleResetRates = () => {
    setCustomUsdRate(null);
    setCustomEurRate(null);
    localStorage.removeItem('aikestar_custom_usd_rate');
    localStorage.removeItem('aikestar_custom_eur_rate');
    setIsEditingRates(false);
  };
  
  const convertToARS = (amount: number, currency: string): number => {
    if (!currency || currency === 'ARS') return amount;
    if (currency === 'USD' || currency === 'USD_CASH') return amount * usdRate;
    if (currency === 'EUR') return amount * eurRate;
    return amount;
  };

  const getAccountEffectiveBalance = (account: any): number => {
    const isInvestment = account.accountCategory === 'investment';
    if (isInvestment) {
      const accrued = calculateAccruedInterest(account);
      if (accrued > 0) return parseFloat(account.initialInvestment || '0') + accrued;
    }
    return normalizeAmountInput(account.balance);
  };

  const getAccountCurrency = (accountId: string | null): string => {
    if (!accountId) return 'ARS';
    const account = accounts.find(a => a.id === accountId);
    return account?.currency || 'ARS';
  };

  const { arsAccounts, usdAccounts, eurAccounts, totalARS, totalUSD, totalEUR } = useMemo(() => {
    const ars = accounts.filter(a => !a.currency || a.currency === 'ARS');
    const usd = accounts.filter(a => a.currency === 'USD' || a.currency === 'USD_CASH');
    const eur = accounts.filter(a => a.currency === 'EUR');
    return {
      arsAccounts: ars, usdAccounts: usd, eurAccounts: eur,
      totalARS: ars.reduce((acc, account) => acc + getAccountEffectiveBalance(account), 0),
      totalUSD: usd.reduce((acc, account) => acc + getAccountEffectiveBalance(account), 0),
      totalEUR: eur.reduce((acc, account) => acc + getAccountEffectiveBalance(account), 0),
    };
  }, [accounts]);

  const healthResult = useMemo(() => {
    const dashAssetsBookValue = (assetsData || []).reduce((sum: number, asset: any) => {
      const acqVal = parseFloat(asset.acquisitionValue?.toString() || '0');
      const depr = parseFloat(asset.accumulatedDepreciation?.toString() || '0');
      const bv = Math.max(0, acqVal - depr);
      const c = asset.currency || 'ARS';
      if (c === 'USD' || c === 'USD_CASH') return sum + bv * usdRate;
      if (c === 'EUR') return sum + bv * eurRate;
      return sum + bv;
    }, 0);

    const dashInvestmentsValue = (investmentsData || []).reduce((sum: number, inv: any) => {
      const qty = parseFloat(inv.quantity?.toString() || '0');
      const cp = parseFloat(inv.currentPrice?.toString() || '0');
      const tc = parseFloat(inv.totalCost?.toString() || '0');
      const cv = cp > 0 ? qty * cp : tc;
      const c = inv.currency || 'ARS';
      if (c === 'USD' || c === 'USD_CASH') return sum + cv * usdRate;
      if (c === 'EUR') return sum + cv * eurRate;
      return sum + cv;
    }, 0);

    const convertCurrencyToARS = (amount: number, currency: string) => {
      const c = currency || 'ARS';
      if (c === 'USD' || c === 'USD_CASH' || c.toUpperCase().includes('USD')) return amount * usdRate;
      if (c === 'EUR') return amount * eurRate;
      return amount;
    };
    let dashPayrollTotalARS = 0;
    if (payrollSummary && payrollSummary.totalEmployees > 0) {
      Object.entries(payrollSummary.byCurrency).forEach(([c, d]) => {
        dashPayrollTotalARS += convertCurrencyToARS(d.total, c);
      });
    }

    return calculateFinancialHealth({
      transactions, accounts, usdRate, eurRate,
      assetsBookValue: dashAssetsBookValue,
      investmentsValue: dashInvestmentsValue,
      payrollTotalARS: dashPayrollTotalARS
    });
  }, [transactions, accounts, assetsData, investmentsData, usdRate, eurRate, payrollSummary]);
  
  // Extract values from centralized calculation
  const { 
    healthScore, 
    totalBalance,
    pendingPayable,
    pendingReceivable,
    netPosition,
    baseScore,
    effectiveBalance,
    hasInsufficientCoverage,
    structuralDeficitPenalty,
    liquidityCrisisPenalty,
    overduePenalty,
    negativePenalty,
    collectionRiskPenalty,
    profitAdjustment,
    cashFlowPenalty,
    compliancePenalty,
    negativeBalanceCount,
    totalNegativeAmount,
    overduePayablesAmount,
    overdueReceivablesAmount,
    urgentPayablesAmount,
    urgentReceivablesAmount,
    profitMargin,
    invoicedIncomePercent,
    receiptedExpensePercent,
    invoicedIncomesCount,
    completedIncomesCount,
    receiptedExpensesCount,
    completedExpensesCount,
    thirtyDayReceivables,
    thirtyDayPayables,
    projectedBalance30,
    finalScore,
    monthlyIncome,
    monthlyExpense,
    payables0to7Amount,
    payables8to15Amount,
    payables16to30Amount,
    receivables0to7Amount,
    receivables8to15Amount,
    receivables16to30Amount
  } = healthResult;
  
  const {
    prevMonthlyIncome, prevMonthlyExpense, incomeVariation, expenseVariation,
    monthlyCosts, monthlyGastos, monthlyNetProfit, fixedCosts, fixedIncome,
    overduePayables, payables0to7, payables8to15, payables16to30,
    overdueReceivables, receivables0to7, receivables8to15, receivables16to30,
  } = useMemo(() => {
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const prevMo = currentMonth === 0 ? 11 : currentMonth - 1;
    const prevYr = currentMonth === 0 ? currentYear - 1 : currentYear;

    const isIncomeFor = (t: Transaction, mo: number, yr: number) => {
      const isDirectIncome = t.type === 'income';
      const isCompletedReceivable = t.type === 'receivable' && t.status === 'completed';
      if (!isDirectIncome && !isCompletedReceivable) return false;
      const d = getEffectiveTransactionDate(t);
      return d.getMonth() === mo && d.getFullYear() === yr;
    };
    const isExpenseFor = (t: Transaction, mo: number, yr: number) => {
      const isDirectExpense = t.type === 'expense';
      const isCompletedPayable = t.type === 'payable' && t.status === 'completed';
      if (!isDirectExpense && !isCompletedPayable) return false;
      const d = getEffectiveTransactionDate(t);
      return d.getMonth() === mo && d.getFullYear() === yr;
    };

    // Currency priority MUST match the drill-down modal: transaction-level currency wins,
    // then account currency, then ARS. Otherwise a USD transaction recorded against an ARS
    // account is converted as USD by the modal but as ARS by the dashboard, and the totals
    // diverge — which is exactly the class of bug Task #245 fixes.
    const txCurrency = (t: Transaction) => t.currency || getAccountCurrency(t.accountId) || 'ARS';

    const _prevMonthlyIncome = transactions
      .filter(t => isIncomeFor(t, prevMo, prevYr))
      .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);
    const _prevMonthlyExpense = transactions
      .filter(t => isExpenseFor(t, prevMo, prevYr))
      .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);
    const _monthlyIncome = transactions
      .filter(t => isIncomeFor(t, currentMonth, currentYear))
      .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);
    const _incomeVariation = _prevMonthlyIncome > 0 ? Math.round(((_monthlyIncome - _prevMonthlyIncome) / _prevMonthlyIncome) * 100) : (_monthlyIncome > 0 ? 100 : 0);
    const _expenseVariation = _prevMonthlyExpense > 0 ? Math.round(((monthlyExpense - _prevMonthlyExpense) / _prevMonthlyExpense) * 100) : (monthlyExpense > 0 ? 100 : 0);

    const _monthlyCosts = transactions
      .filter(t => isExpenseFor(t, currentMonth, currentYear) && t.expenseSubtype === 'cost')
      .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);
    const _monthlyGastos = transactions
      .filter(t => isExpenseFor(t, currentMonth, currentYear) && t.expenseSubtype !== 'cost')
      .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);

    const _pendingStatuses = ['scheduled'];
    let _fixedCosts = transactions
      .filter(t => t.type === 'payable' && _pendingStatuses.includes(t.status) && !t.isUniquePayment)
      .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);
    if (payrollSummary && payrollSummary.totalEmployees > 0) {
      Object.entries(payrollSummary.byCurrency).forEach(([c, d]) => {
        const curr = c || 'ARS';
        if (curr === 'USD' || curr === 'USD_CASH' || curr.toUpperCase().includes('USD')) _fixedCosts += d.total * usdRate;
        else if (curr === 'EUR') _fixedCosts += d.total * eurRate;
        else _fixedCosts += d.total;
      });
    }
    const _fixedIncome = transactions
      .filter(t => t.type === 'receivable' && _pendingStatuses.includes(t.status) && !t.isUniquePayment)
      .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const sevenDays = new Date(today.getTime() + 7 * 86400000);
    const fifteenDays = new Date(today.getTime() + 15 * 86400000);
    const thirtyDays = new Date(today.getTime() + 30 * 86400000);

    const isPendingPayable = (t: Transaction) => t.type === 'payable' && t.status !== 'completed' && t.status !== 'cancelled';
    const isPendingReceivable = (t: Transaction) => t.type === 'receivable' && t.status !== 'completed' && t.status !== 'cancelled';

    return {
      prevMonthlyIncome: _prevMonthlyIncome, prevMonthlyExpense: _prevMonthlyExpense,
      incomeVariation: _incomeVariation, expenseVariation: _expenseVariation,
      monthlyCosts: _monthlyCosts, monthlyGastos: _monthlyGastos,
      monthlyNetProfit: _monthlyIncome - _monthlyCosts - _monthlyGastos,
      fixedCosts: _fixedCosts, fixedIncome: _fixedIncome,
      overduePayables: transactions.filter(t => isPendingPayable(t) && safeParseDate(t.date) < today),
      payables0to7: transactions.filter(t => isPendingPayable(t) && safeParseDate(t.date) >= today && safeParseDate(t.date) <= sevenDays),
      payables8to15: transactions.filter(t => isPendingPayable(t) && safeParseDate(t.date) > sevenDays && safeParseDate(t.date) <= fifteenDays),
      payables16to30: transactions.filter(t => isPendingPayable(t) && safeParseDate(t.date) > fifteenDays && safeParseDate(t.date) <= thirtyDays),
      overdueReceivables: transactions.filter(t => isPendingReceivable(t) && safeParseDate(t.date) < today),
      receivables0to7: transactions.filter(t => isPendingReceivable(t) && safeParseDate(t.date) >= today && safeParseDate(t.date) <= sevenDays),
      receivables8to15: transactions.filter(t => isPendingReceivable(t) && safeParseDate(t.date) > sevenDays && safeParseDate(t.date) <= fifteenDays),
      receivables16to30: transactions.filter(t => isPendingReceivable(t) && safeParseDate(t.date) > fifteenDays && safeParseDate(t.date) <= thirtyDays),
    };
  }, [transactions, accounts, usdRate, eurRate, monthlyIncome, monthlyExpense, payrollSummary]);
  
  const drillDownData = useMemo(() => {
    if (!drillDownMetric) return null;
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const isInCurrentMonth = (t: Transaction) => {
      const d = getEffectiveTransactionDate(t);
      return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
    };
    const isMonthlyIncome = (t: Transaction) => {
      const ok = t.type === 'income' || (t.type === 'receivable' && t.status === 'completed');
      return ok && isInCurrentMonth(t);
    };
    const isMonthlyExpense = (t: Transaction) => {
      const ok = t.type === 'expense' || (t.type === 'payable' && t.status === 'completed');
      return ok && isInCurrentMonth(t);
    };
    const pendingStatuses = ['scheduled'];

    switch (drillDownMetric) {
      case 'ingresos':
        return {
          title: 'Ingresos del Mes',
          transactions: transactions.filter(isMonthlyIncome),
          totalValue: monthlyIncome,
          totalLabel: 'Total Ingresos (en ARS)',
        };
      case 'costos':
        return {
          title: 'Costos del Mes (Producción / Materiales)',
          transactions: transactions.filter(t => isMonthlyExpense(t) && t.expenseSubtype === 'cost'),
          totalValue: monthlyCosts,
          totalLabel: 'Total Costos (en ARS)',
        };
      case 'gastos':
        return {
          title: 'Gastos del Mes (Operativos / Admin)',
          transactions: transactions.filter(t => isMonthlyExpense(t) && t.expenseSubtype !== 'cost'),
          totalValue: monthlyGastos,
          totalLabel: 'Total Gastos (en ARS)',
        };
      case 'utilidad': {
        const incomeTxs = transactions.filter(isMonthlyIncome);
        const costTxs = transactions.filter(t => isMonthlyExpense(t) && t.expenseSubtype === 'cost');
        const gastoTxs = transactions.filter(t => isMonthlyExpense(t) && t.expenseSubtype !== 'cost');
        return {
          title: 'Utilidad Neta — Detalle',
          groups: [
            { label: 'Ingresos', color: 'bg-green-500', transactions: incomeTxs },
            { label: 'Costos', color: 'bg-orange-500', transactions: costTxs },
            { label: 'Gastos', color: 'bg-purple-500', transactions: gastoTxs },
          ],
          totalValue: monthlyNetProfit,
          totalLabel: 'Utilidad Neta (Ingresos - Costos - Gastos)',
        };
      }
      case 'a-cobrar':
        return {
          title: 'Pendiente de Cobro',
          transactions: transactions.filter(t => t.type === 'receivable' && t.status !== 'completed' && t.status !== 'cancelled'),
          totalValue: pendingReceivable,
          totalLabel: 'Total A Cobrar (en ARS)',
        };
      case 'a-pagar':
        return {
          title: 'Pendiente de Pago',
          transactions: transactions.filter(t => t.type === 'payable' && t.status !== 'completed' && t.status !== 'cancelled'),
          totalValue: pendingPayable,
          totalLabel: 'Total A Pagar (en ARS)',
        };
      case 'egresos':
        return {
          title: 'Egresos Total del Mes',
          transactions: transactions.filter(isMonthlyExpense),
          totalValue: monthlyExpense,
          totalLabel: 'Total Egresos (en ARS)',
        };
      case 'costos-fijos':
        return {
          title: 'Costos Fijos (Compromisos Recurrentes)',
          transactions: transactions.filter(t => t.type === 'payable' && pendingStatuses.includes(t.status) && !t.isUniquePayment),
          totalValue: fixedCosts,
          totalLabel: 'Total Costos Fijos (en ARS)',
        };
      case 'ingresos-fijos':
        return {
          title: 'Ingresos Fijos (Cobros Recurrentes)',
          transactions: transactions.filter(t => t.type === 'receivable' && pendingStatuses.includes(t.status) && !t.isUniquePayment),
          totalValue: fixedIncome,
          totalLabel: 'Total Ingresos Fijos (en ARS)',
        };
      default:
        return null;
    }
  }, [drillDownMetric, transactions, monthlyIncome, monthlyCosts, monthlyGastos, monthlyNetProfit, pendingReceivable, pendingPayable, monthlyExpense, fixedCosts, fixedIncome]);

  // hasNegativeBalance needed for UI logic
  const hasNegativeBalance = accounts.some(a => normalizeAmountInput(a.balance) < 0);
  
  // Legacy compatibility fields
  const payablesPenalty = structuralDeficitPenalty;
  const urgencyPenalty = liquidityCrisisPenalty;
  
  // Health score explanation components (using values from centralized calculation)
  const healthExplanation = {
    profitMargin,
    baseScore,
    structuralDeficitPenalty,
    liquidityCrisisPenalty,
    overduePenalty,
    negativePenalty,
    collectionRiskPenalty,
    profitAdjustment,
    cashFlowPenalty,
    compliancePenalty,
    negativeBalanceCount,
    totalNegativeAmount,
    pendingPayable,
    pendingReceivable,
    effectiveBalance,
    totalBalance,
    netPosition,
    hasInsufficientCoverage,
    urgentPayablesAmount,
    urgentReceivablesAmount,
    overduePayablesAmount,
    overdueReceivablesAmount,
    projectedBalance30,
    thirtyDayPayables,
    thirtyDayReceivables,
    payables0to7Amount,
    payables8to15Amount,
    payables16to30Amount,
    receivables0to7Amount,
    receivables8to15Amount,
    receivables16to30Amount,
    finalScore,
    invoicedIncomePercent,
    receiptedExpensePercent,
    completedIncomesCount,
    invoicedIncomesCount,
    completedExpensesCount: completedExpensesCount,
    receiptedExpensesCount,
    // Multi-currency info
    usdRate,
    eurRate,
    rateSource,
    hasLiveRates,
    totalARS,
    totalUSD,
    totalEUR,
    // Legacy fields
    payablesPenalty,
    urgencyPenalty,
    patrimonialBonus: healthResult.patrimonialBonus,
    patrimonialValue: healthResult.patrimonialValue,
  };

  // AI Analysis state and function
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [isLoadingAi, setIsLoadingAi] = useState(false);
  const [healthDialogOpen, setHealthDialogOpen] = useState(false);
  const [isHealthMaximized, setIsHealthMaximized] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    const handleOpenHealth = () => setHealthDialogOpen(true);
    window.addEventListener('openHealthDialog', handleOpenHealth);
    if (sessionStorage.getItem('openHealthDialog') === 'true') {
      sessionStorage.removeItem('openHealthDialog');
      setTimeout(() => setHealthDialogOpen(true), 300);
    }
    return () => window.removeEventListener('openHealthDialog', handleOpenHealth);
  }, []);
  
  const requestAiAnalysis = async () => {
    if (isLoadingAi) return;
    setIsLoadingAi(true);
    try {
      const data = await fetchWithAuth('/ai/health-analysis', {
        method: 'POST',
        body: JSON.stringify({ metrics: healthExplanation })
      });
      setAiAnalysis(data.analysis);
    } catch (error) {
      setAiAnalysis('Error al conectar con el servicio de IA.');
    } finally {
      setIsLoadingAi(false);
    }
  };
  
  // Reset AI analysis when organization changes
  useEffect(() => {
    setAiAnalysis(null);
    setHealthDialogOpen(false);
    setIsHealthMaximized(false);
  }, [organization?.id]);
  
  // Auto-request AI analysis when dialog opens - always refresh
  useEffect(() => {
    if (healthDialogOpen && !isLoadingAi) {
      setAiAnalysis(null); // Clear previous analysis
      requestAiAnalysis();
    }
  }, [healthDialogOpen]);

  const getHealthColor = (score: number) => {
    if (score >= 80) return 'aikestar-gradient dark:bg-gradient-to-r dark:from-teal-400 dark:to-emerald-300';
    if (score >= 60) return 'bg-gradient-to-r from-primary to-green-400 dark:from-teal-400 dark:to-green-300';
    if (score >= 40) return 'bg-gradient-to-r from-yellow-400 to-amber-500 dark:from-amber-300 dark:to-yellow-400';
    if (score >= 25) return 'bg-gradient-to-r from-orange-400 to-orange-500 dark:from-orange-300 dark:to-amber-400';
    if (score >= 10) return 'bg-gradient-to-r from-red-400 to-red-500 dark:from-rose-400 dark:to-red-400';
    return 'bg-red-700 dark:bg-rose-500';
  };

  const getHealthText = (score: number) => {
    if (score >= 80) return 'Excelente';
    if (score >= 60) return 'Buena';
    if (score >= 40) return 'Regular';
    if (score >= 25) return 'Mala';
    if (score >= 10) return 'Grave';
    return 'Gravísima';
  };

  const getHealthTextColor = (score: number) => {
    if (score >= 60) return 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300';
    if (score >= 40) return 'bg-yellow-100 text-yellow-700 dark:bg-amber-500/15 dark:text-amber-300';
    if (score >= 25) return 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300';
    return 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300';
  };

  const getSymbol = (currency: Currency) => currency === 'USD' || currency === 'USD_CASH' ? 'US$' : currency === 'EUR' ? '€' : 'AR$';
  
  const formatCurrencyFull = (val: number, currency: Currency = 'ARS') => {
    const symbol = getSymbol(currency);
    return symbol + val.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  
  const formatCurrency = (val: number, currency: Currency = 'ARS', abbreviate: boolean = true) => {
    const symbol = getSymbol(currency);
    const absVal = Math.abs(val);
    
    // Abbreviate large numbers for better display
    if (abbreviate) {
      if (absVal >= 1_000_000_000) {
        return symbol + (val / 1_000_000_000).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + 'MM';
      } else if (absVal >= 1_000_000) {
        return symbol + (val / 1_000_000).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + 'M';
      } else if (absVal >= 100_000) {
        return symbol + (val / 1_000).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + 'K';
      }
    }
    // Show full number for everything under 100K
    return symbol + val.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  
  const isAbbreviated = (val: number, currency: Currency = 'ARS') => {
    const absVal = Math.abs(val);
    // Abbreviate at 100K+
    return absVal >= 100_000;
  };
  
  const [showAmountDialog, setShowAmountDialog] = useState(false);
  const [dialogAmount, setDialogAmount] = useState({ value: '', label: '' });
  
  const CurrencyWithTooltip = ({ value, currency = 'ARS' as Currency, className = '', label = 'Monto' }: { value: number; currency?: Currency; className?: string; label?: string }) => {
    const abbreviated = formatCurrency(value, currency);
    const full = formatCurrencyFull(value, currency);
    
    const handleClick = () => {
      setDialogAmount({ value: full, label });
      setShowAmountDialog(true);
    };
    
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span 
            className={`cursor-pointer tabular-nums ${className}`}
            onClick={handleClick}
          >
            {abbreviated}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xl font-bold px-4 py-2 hidden md:block">
          {full}
        </TooltipContent>
      </Tooltip>
    );
  };

  const getCurrencyLabel = (currency: string) => {
    if (currency === 'USD' || currency === 'USD_CASH') return 'USD';
    if (currency === 'EUR') return 'EUR';
    return 'ARS';
  };

  const formatBalanceAbbr = (val: number, symbol: string = 'AR$'): { text: string; isAbbreviated: boolean } => {
    const absVal = Math.abs(val);
    if (absVal >= 1_000_000_000) {
      return { text: symbol + ' ' + (val / 1_000_000_000).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' MM', isAbbreviated: true };
    } else if (absVal >= 1_000_000) {
      return { text: symbol + ' ' + (val / 1_000_000).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' M', isAbbreviated: true };
    } else if (absVal >= 100_000) {
      return { text: symbol + ' ' + (val / 1_000).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' K', isAbbreviated: true };
    } else {
      return { text: symbol + ' ' + val.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), isAbbreviated: false };
    }
  };
  
  const formatBalanceFull = (val: number, symbol: string = 'AR$') => {
    return symbol + ' ' + val.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  
  const BalanceWithTooltip = ({ value, symbol, className, accountName, disableDialog }: { value: number; symbol: string; className?: string; accountName: string; disableDialog?: boolean }) => {
    const { text, isAbbreviated } = formatBalanceAbbr(value, symbol);
    const fullText = formatBalanceFull(value, symbol);
    
    if (!isAbbreviated) {
      return <span className={className}>{text}</span>;
    }
    
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span 
            className={`${disableDialog ? 'cursor-pointer' : 'cursor-help'} underline decoration-dotted underline-offset-2 ${className}`}
            onClick={disableDialog ? undefined : () => {
              setDialogAmount({ value: fullText, label: accountName });
              setShowAmountDialog(true);
            }}
          >
            {text}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-base font-bold px-3 py-2">
          {fullText}
        </TooltipContent>
      </Tooltip>
    );
  };

  const formatCurrencyWithLabel = (val: number, currency: Currency) => {
    const num = val.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return num;
  };

  // Group ARS accounts by type (for stat cards - don't mix currencies)
  const bankAccountsARS = arsAccounts.filter(a => a.type === 'bank');
  const cashAccountsARS = arsAccounts.filter(a => a.type === 'cash');
  const walletAccountsARS = arsAccounts.filter(a => a.type === 'wallet');
  const otherAccountsARS = arsAccounts.filter(a => !['bank', 'cash', 'wallet'].includes(a.type));
  
  // All accounts by type (for listing)
  const bankAccounts = accounts.filter(a => a.type === 'bank');
  const cashAccounts = accounts.filter(a => a.type === 'cash');
  const walletAccounts = accounts.filter(a => a.type === 'wallet');
  const otherAccounts = accounts.filter(a => !['bank', 'cash', 'wallet'].includes(a.type));

  if (accountsLoading || transactionsLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-lg text-muted-foreground">Cargando datos...</div>
      </div>
    );
  }

  return (
    <>
      <TooltipProvider>
      <TiendanubeDashboardAlert />
      <CrmDashboardCards />
      <OpsDashboardCards />
      <InvestmentsDashboardCard />
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
        {/* Hide org header on mobile - shown in top bar instead */}
        <div className="hidden md:flex items-center gap-4">
          {organization && (
            <div className="flex-shrink-0">
              {/* For personal orgs: show user profile icon. For business orgs: show org logo/icon */}
              {organization.type === 'personal' ? (
                user?.profileIconKey ? (
                  <div 
                    className="h-14 w-14 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-lg border-2 border-white"
                    data-testid="dashboard-user-icon"
                  >
                    {(() => {
                      const UserIcon = getProfileIconByKey(user.profileIconKey);
                      return <UserIcon className="h-7 w-7 text-white" />;
                    })()}
                  </div>
                ) : (
                  <div 
                    className="h-14 w-14 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-lg border-2 border-white text-white font-bold text-xl"
                    data-testid="dashboard-user-initials"
                  >
                    {user?.name?.charAt(0)?.toUpperCase() || 'U'}
                  </div>
                )
              ) : organization.logoUrl ? (
                <img 
                  src={organization.logoUrl} 
                  alt={organization.name} 
                  className="h-14 w-14 rounded-xl object-cover shadow-lg border-2 border-white"
                  data-testid="dashboard-org-logo"
                />
              ) : (
                <div 
                  className="h-14 w-14 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-lg border-2 border-white"
                  data-testid="dashboard-org-icon"
                >
                  {(() => {
                    const OrgIcon = getIconByKey(organization.iconKey) || Building;
                    return <OrgIcon className="h-7 w-7 text-white" />;
                  })()}
                </div>
              )}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl md:text-3xl font-bold gradient-text truncate">
              {organization?.type === 'personal' ? 'Mis Finanzas' : (organization?.name || 'Panel de Control')}
            </h1>
            <p className="text-muted-foreground mt-1 text-sm sm:text-base">
              {organization?.type === 'personal' ? 'Resumen de tus finanzas personales.' : 'Resumen financiero de tu organización.'}
            </p>
          </div>
        </div>
        {!isScrolled && <TransactionWizard />}
      </div>

      {/* Task #219: WhatsApp linking reminder banner.
          Fires only for users whose phoneNumber has been unverified for >24h.
          Dismissable; hidden for 7 days after dismiss (handled in component). */}
      {showPhoneVerifyBanner && (
        <div
          className="mb-6 rounded-xl border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 flex items-start gap-3"
          data-testid="banner-phone-verify-pending"
        >
          <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-800/40 flex-shrink-0">
            <Smartphone className="h-5 w-5 text-amber-700 dark:text-amber-300" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
              Tu número de WhatsApp quedó sin verificar
            </p>
            <p className="text-xs text-amber-800 dark:text-amber-200 mt-1">
              Cargaste {user?.phoneNumber} pero no llegaste a confirmar el código.
              Terminá la vinculación para usar el bot por WhatsApp.
            </p>
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <Link href="/settings?tab=whatsapp&openWizard=1">
                <Button
                  size="sm"
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                  data-testid="button-finish-whatsapp-linking"
                >
                  Terminar de vincular WhatsApp
                </Button>
              </Link>
              <Button
                size="sm"
                variant="ghost"
                className="text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-800/30"
                onClick={handleDismissPhoneBanner}
                data-testid="button-dismiss-phone-verify-banner"
              >
                Recordármelo más tarde
              </Button>
            </div>
          </div>
          <button
            type="button"
            onClick={handleDismissPhoneBanner}
            aria-label="Cerrar recordatorio"
            className="text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100 flex-shrink-0"
            data-testid="button-close-phone-verify-banner"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Health Bar - Clickable with explanation */}
      <Dialog open={healthDialogOpen} onOpenChange={setHealthDialogOpen}>
        <DialogTrigger asChild>
          <Card className="mb-6 border border-primary/15 bg-gradient-to-r from-white to-primary/5 dark:from-card dark:to-primary/10 shadow-xl shadow-primary/5 backdrop-blur-sm overflow-hidden cursor-pointer hover:shadow-2xl hover:shadow-primary/10 transition-shadow duration-300" data-testid="health-bar-card">
            <CardContent className="py-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${
                    healthScore >= 60 ? 'bg-green-100 dark:bg-green-500/15' : 
                    healthScore >= 40 ? 'bg-yellow-100 dark:bg-amber-500/15' : 
                    healthScore >= 25 ? 'bg-orange-100 dark:bg-orange-500/15' :
                    'bg-red-100 dark:bg-red-500/15'
                  }`}>
                    <TrendingUp className={`h-4 w-4 ${
                      healthScore >= 60 ? 'text-green-600 dark:text-green-300' : 
                      healthScore >= 40 ? 'text-yellow-600 dark:text-amber-300' : 
                      healthScore >= 25 ? 'text-orange-600 dark:text-orange-300' :
                      'text-red-600 dark:text-red-300'
                    }`} />
                  </div>
                  <span className="text-sm font-semibold">Salud Financiera</span>
                  <span className={`text-xs px-3 py-1 rounded-full font-medium ${getHealthTextColor(healthScore)}`}>
                    {getHealthText(healthScore)}
                  </span>
                  <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-gradient-to-r from-primary/10 to-accent/10 hover:from-primary/20 hover:to-accent/20 transition-colors">
                    <HelpCircle className="h-4 w-4 text-primary" />
                    <span className="text-xs font-medium text-primary hidden sm:inline">Ver detalles</span>
                  </div>
                </div>
                <span className="text-lg font-bold">{Math.round(healthScore)}%</span>
              </div>
              <div className="relative h-4 bg-slate-100 dark:bg-slate-800/80 rounded-full overflow-hidden shadow-inner">
                <div 
                  className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 shadow-sm ${getHealthColor(healthScore)}`}
                  style={{ width: `${healthScore}%` }}
                />
              </div>
            </CardContent>
          </Card>
        </DialogTrigger>
        <DialogContent className={`${isHealthMaximized ? 'sm:max-w-[95vw] h-[95vh]' : 'sm:max-w-[700px] max-h-[90vh]'} overflow-y-auto transition-all duration-200`}>
          <DialogHeader>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setIsHealthMaximized(!isHealthMaximized)}
                data-testid="button-maximize-health"
              >
                {isHealthMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
              <DialogTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                ¿Por qué tu Salud Financiera es {getHealthText(healthScore)}?
              </DialogTitle>
            </div>
          </DialogHeader>
          <div className={`space-y-4 py-4 ${isHealthMaximized ? 'max-h-[85vh]' : 'max-h-[75vh]'} overflow-y-auto`}>
            {/* Score and Net Position Header */}
            <div className="flex items-center justify-between p-3 bg-secondary/50 rounded-lg">
              <div>
                <span className="font-medium text-sm">Puntaje</span>
                <p className={`text-2xl font-bold ${
                  healthScore >= 60 ? 'text-green-600' : 
                  healthScore >= 40 ? 'text-yellow-600' : 
                  healthScore >= 25 ? 'text-orange-600' :
                  'text-red-600'
                }`}>{healthExplanation.finalScore}%</p>
              </div>
              <div className="text-right">
                <span className="font-medium text-sm">Posición Neta</span>
                <p className={`text-lg font-bold ${healthExplanation.netPosition >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                  {formatCurrency(healthExplanation.netPosition)}
                </p>
                {usdRate > 0 && (
                  <p className={`text-xs ${healthExplanation.netPosition >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    US$ {(healthExplanation.netPosition / usdRate).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                )}
              </div>
            </div>
            
            {/* Multi-currency Disclosure - ALWAYS VISIBLE */}
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg" data-testid="exchange-rate-notice">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-start gap-2">
                  <Info className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="font-semibold text-sm text-blue-800">Valuación Multi-Moneda</p>
                    <p className="text-xs text-blue-700 mt-0.5">
                      {customUsdRate ? 'Usando cotizaciones personalizadas.' : 'Cotizaciones del mercado.'}
                    </p>
                  </div>
                </div>
                {!isEditingRates ? (
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="h-7 px-2 text-blue-600 hover:text-blue-800 hover:bg-blue-100"
                    onClick={handleStartEditRates}
                    data-testid="button-edit-rates"
                  >
                    <Pencil className="h-3 w-3 mr-1" />
                    Editar
                  </Button>
                ) : (
                  <div className="flex gap-1">
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="h-7 w-7 p-0 text-green-600 hover:text-green-800 hover:bg-green-100"
                      onClick={handleSaveRates}
                      data-testid="button-save-rates"
                    >
                      <CheckIcon className="h-4 w-4" />
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="h-7 w-7 p-0 text-red-600 hover:text-red-800 hover:bg-red-100"
                      onClick={() => setIsEditingRates(false)}
                      data-testid="button-cancel-rates"
                    >
                      <XIcon className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs mt-2">
                <div className="p-2 bg-white dark:bg-card/60 rounded border border-blue-100">
                  <span className="text-blue-600 block mb-1">Dólar Blue</span>
                  {isEditingRates ? (
                    <div className="flex items-center gap-1">
                      <span className="text-blue-900">$</span>
                      <Input 
                        type="number" 
                        value={editUsdRate}
                        onChange={(e) => setEditUsdRate(e.target.value)}
                        className="h-7 text-sm font-bold"
                        data-testid="input-usd-rate"
                      />
                    </div>
                  ) : (
                    <span className="font-bold text-blue-900">{formatCurrency(usdRate)}</span>
                  )}
                </div>
                <div className="p-2 bg-white dark:bg-card/60 rounded border border-blue-100">
                  <span className="text-blue-600 block mb-1">Euro</span>
                  {isEditingRates ? (
                    <div className="flex items-center gap-1">
                      <span className="text-blue-900">$</span>
                      <Input 
                        type="number" 
                        value={editEurRate}
                        onChange={(e) => setEditEurRate(e.target.value)}
                        className="h-7 text-sm font-bold"
                        data-testid="input-eur-rate"
                      />
                    </div>
                  ) : (
                    <span className="font-bold text-blue-900">{formatCurrency(eurRate)}</span>
                  )}
                </div>
              </div>
              {customUsdRate && !isEditingRates && (
                <Button 
                  variant="link" 
                  size="sm" 
                  className="mt-2 h-auto p-0 text-[10px] text-blue-500 hover:text-blue-700"
                  onClick={handleResetRates}
                  data-testid="button-reset-rates"
                >
                  Volver a cotizaciones automáticas
                </Button>
              )}
              {(totalUSD !== 0 || totalEUR !== 0) && (
                <div className="mt-2 pt-2 border-t border-blue-200 text-xs space-y-1">
                  <p className="text-blue-700 font-medium">Tu patrimonio incluye:</p>
                  {totalARS !== 0 && (
                    <div className="flex justify-between">
                      <span className="text-blue-600">Pesos (ARS)</span>
                      <span className="font-semibold text-blue-900">{formatCurrency(totalARS)}</span>
                    </div>
                  )}
                  {totalUSD !== 0 && (
                    <div className="flex justify-between">
                      <span className="text-blue-600">Dólares</span>
                      <span className="font-semibold text-blue-900">
                        US$ {totalUSD.toLocaleString('es-AR')} = {formatCurrency(totalUSD * usdRate)}
                      </span>
                    </div>
                  )}
                  {totalEUR !== 0 && (
                    <div className="flex justify-between">
                      <span className="text-blue-600">Euros</span>
                      <span className="font-semibold text-blue-900">
                        € {totalEUR.toLocaleString('es-AR')} = {formatCurrency(totalEUR * eurRate)}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between pt-1 border-t border-blue-100 font-bold">
                    <span className="text-blue-700">Total valuado</span>
                    <span className="text-blue-900">{formatCurrency(totalBalance)}</span>
                  </div>
                </div>
              )}
              <p className="text-[10px] text-blue-500 mt-2">
                Fuente: {hasLiveRates ? rateSource : 'Estimación'} 
                {rateTimestamp && hasLiveRates && ` - ${format(rateTimestamp, "d MMM HH:mm", { locale: es })}`}
                {!hasLiveRates && ' (sin conexión al servicio de cotizaciones)'}
              </p>
            </div>
            
            {/* AI Analysis Section */}
            <div className="p-3 bg-gradient-to-br from-[#00D4FF]/10 to-[#FF3366]/10 border border-[#00D4FF]/30 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="h-4 w-4 text-[#00D4FF]" />
                <span className="font-semibold text-sm gradient-text">Diagnóstico de Aike</span>
              </div>
              
              {isLoadingAi && (
                <div className="flex items-center gap-2 py-4 justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-[#00D4FF]" />
                  <span className="text-sm text-[#00D4FF]">Analizando tu situación financiera...</span>
                </div>
              )}
              
              {aiAnalysis && (
                <p className="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-line leading-relaxed">
                  {aiAnalysis}
                </p>
              )}
              
              {!aiAnalysis && !isLoadingAi && (
                <p className="text-sm text-muted-foreground">
                  No se pudo cargar el análisis. 
                  <Button variant="link" size="sm" onClick={() => { setAiAnalysis(null); requestAiAnalysis(); }} className="p-0 h-auto ml-1">
                    Reintentar
                  </Button>
                </p>
              )}
            </div>
            
            {/* Collapsible Details Section */}
            <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="w-full justify-between p-3 h-auto border rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800">
                  <span className="font-medium text-sm">Ver detalles del cálculo</span>
                  {detailsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 pt-3">
                <div className="flex items-center justify-between p-2 border rounded">
                  <div>
                    <p className="font-medium text-sm">Puntaje base</p>
                    <p className="text-xs text-muted-foreground">Punto de partida neutral</p>
                  </div>
                  <span className="text-slate-600 dark:text-slate-300 font-semibold">{healthExplanation.baseScore}</span>
                </div>
                
                {healthExplanation.structuralDeficitPenalty > 0 && (
                  <div className="flex items-center justify-between p-2 border border-red-300 bg-red-100 rounded">
                    <div>
                      <p className="font-medium text-red-800 text-sm">Déficit estructural</p>
                      <p className="text-xs text-red-700">
                        Por pagar: {formatCurrency(healthExplanation.pendingPayable)} vs disponible: {formatCurrency(healthExplanation.effectiveBalance)}
                      </p>
                    </div>
                    <span className="text-red-700 font-semibold">-{healthExplanation.structuralDeficitPenalty}</span>
                  </div>
                )}
                
                {healthExplanation.liquidityCrisisPenalty > 0 && (
                  <div className="flex items-center justify-between p-2 border border-orange-300 bg-orange-100 rounded">
                    <div>
                      <p className="font-medium text-orange-800 text-sm">Crisis de liquidez</p>
                      <p className="text-xs text-orange-700">
                        No podés cubrir pagos de los próximos 7 días
                      </p>
                    </div>
                    <span className="text-orange-700 font-semibold">-{healthExplanation.liquidityCrisisPenalty}</span>
                  </div>
                )}
                
                {healthExplanation.cashFlowPenalty > 0 && (
                  <div className="flex items-center justify-between p-2 border border-yellow-300 bg-yellow-100 rounded">
                    <div>
                      <p className="font-medium text-yellow-800 text-sm">Flujo de caja negativo</p>
                      <p className="text-xs text-yellow-700">
                        Proyección a 30 días: {formatCurrency(healthExplanation.projectedBalance30)}
                      </p>
                    </div>
                    <span className="text-yellow-700 font-semibold">-{healthExplanation.cashFlowPenalty}</span>
                  </div>
                )}
                
                {healthExplanation.overduePenalty > 0 && (
                  <div className="flex items-center justify-between p-2 border border-red-300 bg-red-100 rounded">
                    <div>
                      <p className="font-medium text-red-800 text-sm">Pagos vencidos</p>
                      <p className="text-xs text-red-700">
                        {formatCurrency(healthExplanation.overduePayablesAmount)} pasaron su fecha
                      </p>
                    </div>
                    <span className="text-red-700 font-semibold">-{healthExplanation.overduePenalty}</span>
                  </div>
                )}
                
                {healthExplanation.negativePenalty > 0 && (
                  <div className="flex items-center justify-between p-2 border border-red-200 bg-red-50 rounded">
                    <div>
                      <p className="font-medium text-red-700 text-sm">Cuentas en rojo</p>
                      <p className="text-xs text-red-600">
                        {healthExplanation.negativeBalanceCount} cuenta(s) con saldo negativo
                      </p>
                    </div>
                    <span className="text-red-600 font-semibold">-{healthExplanation.negativePenalty}</span>
                  </div>
                )}
                
                {healthExplanation.collectionRiskPenalty > 0 && (
                  <div className="flex items-center justify-between p-2 border border-purple-200 bg-purple-50 rounded">
                    <div>
                      <p className="font-medium text-purple-700 text-sm">Cobros atrasados</p>
                      <p className="text-xs text-purple-600">
                        {formatCurrency(healthExplanation.overdueReceivablesAmount)} sin cobrar
                      </p>
                    </div>
                    <span className="text-purple-600 font-semibold">-{healthExplanation.collectionRiskPenalty}</span>
                  </div>
                )}
                
                {healthExplanation.profitAdjustment !== 0 && (
                  <div className={`flex items-center justify-between p-2 border rounded ${
                    healthExplanation.profitAdjustment > 0 
                      ? 'border-green-200 bg-green-50' 
                      : 'border-orange-200 bg-orange-50'
                  }`}>
                    <div>
                      <p className={`font-medium text-sm ${healthExplanation.profitAdjustment > 0 ? 'text-green-700' : 'text-orange-700'}`}>
                        Rentabilidad
                      </p>
                      <p className={`text-xs ${healthExplanation.profitAdjustment > 0 ? 'text-green-600' : 'text-orange-600'}`}>
                        Margen: {healthExplanation.profitMargin}%
                      </p>
                    </div>
                    <span className={`font-semibold ${healthExplanation.profitAdjustment > 0 ? 'text-green-600' : 'text-orange-600'}`}>
                      {healthExplanation.profitAdjustment > 0 ? '+' : ''}{healthExplanation.profitAdjustment}
                    </span>
                  </div>
                )}
                
                {healthExplanation.structuralDeficitPenalty === 0 && healthExplanation.liquidityCrisisPenalty === 0 && 
                 healthExplanation.overduePenalty === 0 && healthExplanation.negativePenalty === 0 && 
                 healthExplanation.collectionRiskPenalty === 0 && healthExplanation.cashFlowPenalty === 0 &&
                 healthExplanation.compliancePenalty === 0 && (
                  <div className="flex items-center justify-between p-2 border border-green-200 bg-green-50 rounded">
                    <div>
                      <p className="font-medium text-green-700 text-sm">Finanzas saludables</p>
                      <p className="text-xs text-green-600">Sin problemas detectados</p>
                    </div>
                    <span className="text-green-600 font-semibold">OK</span>
                  </div>
                )}
                
                {healthExplanation.compliancePenalty > 0 && (
                  <div className="flex items-center justify-between p-2 border border-amber-200 bg-amber-50 rounded">
                    <div>
                      <p className="font-medium text-amber-700 text-sm">Formalidad fiscal</p>
                      <p className="text-xs text-amber-600">
                        Ingresos facturados: {healthExplanation.invoicedIncomePercent}% • Gastos con recibo: {healthExplanation.receiptedExpensePercent}%
                      </p>
                    </div>
                    <span className="text-amber-600 font-semibold">-{healthExplanation.compliancePenalty}</span>
                  </div>
                )}

                {healthExplanation.patrimonialBonus > 0 && (
                  <div className="flex items-center justify-between p-2 border border-blue-200 bg-blue-50 rounded">
                    <div>
                      <p className="font-medium text-blue-700 text-sm">Respaldo patrimonial</p>
                      <p className="text-xs text-blue-600">
                        Activos + Inversiones: {formatCurrency(healthExplanation.patrimonialValue)}
                      </p>
                    </div>
                    <span className="text-blue-600 font-semibold">+{healthExplanation.patrimonialBonus}</span>
                  </div>
                )}

                {/* 30-day projection */}
                <div className="pt-2 border-t">
                  <p className="text-sm font-medium mb-2">Proyección a 30 días:</p>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="p-2 bg-green-50 rounded">
                      <p className="text-green-700">Por cobrar</p>
                      <p className="font-bold text-green-800">{formatCurrency(healthExplanation.thirtyDayReceivables)}</p>
                    </div>
                    <div className="p-2 bg-red-50 rounded">
                      <p className="text-red-700">Por pagar</p>
                      <p className="font-bold text-red-800">{formatCurrency(healthExplanation.thirtyDayPayables)}</p>
                    </div>
                  </div>
                </div>
                
                {/* Invoice/Receipt compliance metrics */}
                <div className="pt-2 border-t">
                  <p className="text-sm font-medium mb-2">Formalidad contable:</p>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className={`p-2 rounded ${healthExplanation.invoicedIncomePercent >= 80 ? 'bg-green-50' : healthExplanation.invoicedIncomePercent >= 50 ? 'bg-amber-50' : 'bg-red-50'}`}>
                      <p className={healthExplanation.invoicedIncomePercent >= 80 ? 'text-green-700' : healthExplanation.invoicedIncomePercent >= 50 ? 'text-amber-700' : 'text-red-700'}>
                        Ingresos facturados
                      </p>
                      <p className={`font-bold ${healthExplanation.invoicedIncomePercent >= 80 ? 'text-green-800' : healthExplanation.invoicedIncomePercent >= 50 ? 'text-amber-800' : 'text-red-800'}`}>
                        {healthExplanation.invoicedIncomePercent}%
                        <span className="font-normal text-xs ml-1">({healthExplanation.invoicedIncomesCount}/{healthExplanation.completedIncomesCount})</span>
                      </p>
                    </div>
                    <div className={`p-2 rounded ${healthExplanation.receiptedExpensePercent >= 80 ? 'bg-green-50' : healthExplanation.receiptedExpensePercent >= 50 ? 'bg-amber-50' : 'bg-red-50'}`}>
                      <p className={healthExplanation.receiptedExpensePercent >= 80 ? 'text-green-700' : healthExplanation.receiptedExpensePercent >= 50 ? 'text-amber-700' : 'text-red-700'}>
                        Gastos con comprobante
                      </p>
                      <p className={`font-bold ${healthExplanation.receiptedExpensePercent >= 80 ? 'text-green-800' : healthExplanation.receiptedExpensePercent >= 50 ? 'text-amber-800' : 'text-red-800'}`}>
                        {healthExplanation.receiptedExpensePercent}%
                        <span className="font-normal text-xs ml-1">({healthExplanation.receiptedExpensesCount}/{healthExplanation.completedExpensesCount})</span>
                      </p>
                    </div>
                  </div>
                </div>
                
              </CollapsibleContent>
            </Collapsible>
            
            {/* Tip Section - LAST */}
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="flex items-start gap-2">
                <Lightbulb className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                <div>
                  <p className="font-semibold text-sm text-amber-800">Tip para mejorar</p>
                  <p className="text-xs text-amber-700 mt-1">
                    {healthScore < 40 
                      ? "Acelerá la cobranza de facturas vencidas y renegociá plazos de pago con proveedores."
                      : healthScore < 60 
                        ? "Mantené un colchón de liquidez para cubrir al menos 2 semanas de gastos fijos."
                        : "Seguí así! Considerá invertir el excedente en opciones de bajo riesgo."
                    }
                  </p>
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Main Tabs: Foto and Película */}
      <Tabs defaultValue="foto" className="mb-8">
        <TabsList className="grid w-full grid-cols-2 mb-6 p-1 sm:p-1.5 bg-white dark:bg-card/90 backdrop-blur-sm rounded-full h-12 sm:h-14 shadow-md shadow-primary/5">
          <TabsTrigger 
            value="foto" 
            className="gap-1.5 sm:gap-2 text-xs sm:text-sm font-semibold tracking-wide rounded-full transition-[color,background-color,box-shadow,border-color] duration-300 data-[state=active]:bg-primary/20 data-[state=active]:text-primary data-[state=active]:border-2 data-[state=active]:border-primary data-[state=active]:shadow-md data-[state=active]:shadow-primary/20 data-[state=inactive]:text-slate-700 data-[state=inactive]:bg-slate-100 data-[state=inactive]:hover:text-primary data-[state=inactive]:hover:bg-primary/15" 
            data-testid="tab-foto"
          >
            <Camera className="h-4 w-4 flex-shrink-0" />
            <span className="sm:hidden">FOTO</span>
            <span className="hidden sm:inline">FOTO (CASHFLOW)</span>
          </TabsTrigger>
          <TabsTrigger 
            value="pelicula" 
            className="gap-1.5 sm:gap-2 text-xs sm:text-sm font-semibold tracking-wide rounded-full transition-[color,background-color,box-shadow,border-color] duration-300 data-[state=active]:bg-primary/20 data-[state=active]:text-primary data-[state=active]:border-2 data-[state=active]:border-primary data-[state=active]:shadow-md data-[state=active]:shadow-primary/20 data-[state=inactive]:text-slate-700 data-[state=inactive]:bg-slate-100 data-[state=inactive]:hover:text-primary data-[state=inactive]:hover:bg-primary/15" 
            data-testid="tab-pelicula"
          >
            <Film className="h-4 w-4 flex-shrink-0" />
            <span className="sm:hidden">PELÍCULA</span>
            <span className="hidden sm:inline">PELÍCULA (P&L)</span>
          </TabsTrigger>
        </TabsList>

        {/* FOTO - Estado Financiero Real */}
        <TabsContent value="foto">
          <div className="space-y-6">
            {/* Currency Totals Only */}
            <div className="grid gap-2 sm:gap-3 grid-cols-2 lg:grid-cols-3">
              <StatCard 
                title="Total en Pesos" 
                value={<CurrencyWithTooltip value={totalARS} currency="ARS" label="Total en Pesos" />} 
                icon={Wallet}
                description={`${arsAccounts.length} cuenta(s) en ARS`}
                className="border-l-4 border-l-primary"
              />
              {totalUSD > 0 && (
                <StatCard 
                  title="Total en Dólares" 
                  value={<CurrencyWithTooltip value={totalUSD} currency="USD" label="Total en Dólares" />} 
                  icon={Wallet}
                  description={`${usdAccounts.length} cuenta(s) en USD`}
                  className="border-l-4 border-l-green-500"
                />
              )}
              {totalEUR > 0 && (
                <StatCard 
                  title="Total en Euros" 
                  value={<CurrencyWithTooltip value={totalEUR} currency="EUR" label="Total en Euros" />} 
                  icon={Wallet}
                  description={`${eurAccounts.length} cuenta(s) en EUR`}
                  className="border-l-4 border-l-blue-500"
                />
              )}
            </div>

            {(() => {
              const operativeAccountsAll = accounts.filter((a: any) => {
                return !a.accountCategory || a.accountCategory === 'operative';
              });
              const investmentAccountsAll = accounts.filter((a: any) => {
                return a.accountCategory === 'investment';
              });

              const opARS = operativeAccountsAll.filter(a => !a.currency || a.currency === 'ARS');
              const opUSD = operativeAccountsAll.filter(a => a.currency === 'USD' || a.currency === 'USD_CASH');
              const opEUR = operativeAccountsAll.filter(a => a.currency === 'EUR');

              const invARS = investmentAccountsAll.filter(a => !a.currency || a.currency === 'ARS');
              const invUSD = investmentAccountsAll.filter(a => a.currency === 'USD' || a.currency === 'USD_CASH');
              const invEUR = investmentAccountsAll.filter(a => a.currency === 'EUR');

              const currencyThemes = {
                ARS: { bg: 'bg-gradient-to-br from-slate-50 to-white dark:from-card dark:to-card/80', border: 'border-slate-200 dark:border-slate-800 hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5', borderStyle: 'border-2', iconBg: (type: string) => getAccountBgGradient(type), iconColor: '', textColor: 'text-slate-800 dark:text-slate-100', symbol: 'AR$', dot: 'bg-blue-500', label: 'Pesos Argentinos (ARS)' },
                USD: { bg: 'bg-gradient-to-br from-green-50 to-emerald-50/50 dark:from-green-950/30 dark:to-emerald-950/20', border: 'border-green-100 dark:border-green-900/40 hover:shadow-lg hover:shadow-green-500/10', borderStyle: 'border', iconBg: () => 'bg-gradient-to-br from-green-100 to-emerald-100 dark:from-green-900/40 dark:to-emerald-900/30', iconColor: 'text-green-600 dark:text-green-400', textColor: 'text-green-700 dark:text-green-300', symbol: 'US$', dot: 'bg-green-500', label: 'Dólares (USD)' },
                EUR: { bg: 'bg-gradient-to-br from-amber-50 to-yellow-50/50 dark:from-amber-950/30 dark:to-yellow-950/20', border: 'border-amber-100 dark:border-amber-900/40 hover:shadow-lg hover:shadow-amber-500/10', borderStyle: 'border', iconBg: () => 'bg-gradient-to-br from-amber-100 to-yellow-100 dark:from-amber-900/40 dark:to-yellow-900/30', iconColor: 'text-amber-600 dark:text-amber-400', textColor: 'text-amber-700 dark:text-amber-300', symbol: '€', dot: 'bg-yellow-500', label: 'Euros (EUR)' },
              };

              const renderAccountCard = (acc: any, theme: typeof currencyThemes.ARS) => {
                const balance = getAccountEffectiveBalance(acc);
                const isNegative = balance < 0;
                const isInvestmentAcc = acc.accountCategory === 'investment';
                const accType = (acc.type || 'bank') as FinancialAccountType;
                const typeConfig = FINANCIAL_ACCOUNT_TYPE_CONFIG[accType] || FINANCIAL_ACCOUNT_TYPE_CONFIG['bank'];
                const typeLabel = acc.customTypeLabel || typeConfig.label;
                const currencyLabel = acc.currency === 'USD_CASH' ? 'USD Efectivo' : (acc.currency || 'ARS');
                return (
                  <div key={acc.id} onClick={() => navigate('/accounts')} className={`p-3 sm:p-4 rounded-xl ${theme.borderStyle} hover:-translate-y-0.5 transition-[transform,box-shadow] duration-300 cursor-pointer group overflow-hidden ${
                    isNegative
                      ? 'bg-gradient-to-br from-red-50 to-red-100/50 dark:from-red-950/40 dark:to-red-900/30 border-red-300 dark:border-red-800 animate-pulse-glow'
                      : `${theme.bg} ${theme.border}`
                  }`} data-testid={`dashboard-account-card-${acc.id}`}>
                    {isInvestmentAcc && (
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider truncate">
                          {typeLabel}
                        </span>
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-xs font-medium">
                            {currencyLabel}
                          </Badge>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                              <Button variant="ghost" size="icon" className="h-7 w-7 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity" data-testid={`dashboard-account-menu-${acc.id}`}>
                                <MoreVertical className="h-4 w-4 text-muted-foreground" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                              {canEditAccounts && (
                                <DropdownMenuItem onClick={() => handleDashboardEditOpen(acc)} data-testid={`dashboard-edit-account-${acc.id}`}>
                                  <Pencil className="h-4 w-4 mr-2" />
                                  Editar
                                </DropdownMenuItem>
                              )}
                              {canEditAccounts && (
                                <DropdownMenuItem onClick={() => handleDashboardAdjustOpen(acc)} data-testid={`dashboard-adjust-account-${acc.id}`}>
                                  <Scale className="h-4 w-4 mr-2" />
                                  Ajustar Saldo
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={() => navigate('/accounts')} data-testid={`dashboard-view-accounts-${acc.id}`}>
                                <Wallet className="h-4 w-4 mr-2" />
                                Ver Cuentas
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    )}
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                        <div className={`p-2 sm:p-2.5 rounded-xl shadow-sm transition-transform group-hover:scale-105 flex-shrink-0 ${
                          isNegative ? 'bg-gradient-to-br from-red-100 to-red-200' : theme.iconBg(acc.type)
                        }`}>
                          {getAccountIcon(acc.type, isNegative ? 'text-red-600' : theme.iconColor)}
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold text-sm truncate">{acc.name}</p>
                          <p className="text-xs text-muted-foreground capitalize">
                            {getAccountTypeShortLabel(acc.type)}
                          </p>
                        </div>
                      </div>
                      {!isInvestmentAcc && (
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {isNegative && (
                            <div className="animate-float-warning">
                              <AlertTriangle className="h-5 w-5 text-red-500" />
                            </div>
                          )}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                              <Button variant="ghost" size="icon" className="h-7 w-7 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity" data-testid={`dashboard-account-menu-${acc.id}`}>
                                <MoreVertical className="h-4 w-4 text-muted-foreground" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                              {canEditAccounts && (
                                <DropdownMenuItem onClick={() => handleDashboardEditOpen(acc)} data-testid={`dashboard-edit-account-${acc.id}`}>
                                  <Pencil className="h-4 w-4 mr-2" />
                                  Editar
                                </DropdownMenuItem>
                              )}
                              {canEditAccounts && (
                                <DropdownMenuItem onClick={() => handleDashboardAdjustOpen(acc)} data-testid={`dashboard-adjust-account-${acc.id}`}>
                                  <Scale className="h-4 w-4 mr-2" />
                                  Ajustar Saldo
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={() => navigate('/accounts')} data-testid={`dashboard-view-accounts-${acc.id}`}>
                                <Wallet className="h-4 w-4 mr-2" />
                                Ver Cuentas
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )}
                    </div>
                    <div className={`text-right font-bold text-xs sm:text-sm md:text-lg overflow-hidden ${isNegative ? 'text-red-600' : theme.textColor}`}>
                      <BalanceWithTooltip value={balance} symbol={CURRENCY_SYMBOLS[acc.currency as keyof typeof CURRENCY_SYMBOLS] || theme.symbol} accountName={acc.name} disableDialog />
                    </div>
                    {isInvestmentAcc && acc.interestRate && parseFloat(acc.interestRate) > 0 && (
                      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Percent className="h-3.5 w-3.5 text-emerald-500" />
                        <span>
                          {parseFloat(acc.interestRate).toLocaleString('es-AR', { maximumFractionDigits: 2 })}% {INTEREST_FREQUENCY_LABELS[(acc.interestFrequency || 'monthly') as InterestFrequency]?.toLowerCase() || 'mensual'}
                        </span>
                      </div>
                    )}
                    {isInvestmentAcc && (() => {
                      const totalAccrued = calculateAccruedInterest(acc);
                      const currSymbol = CURRENCY_SYMBOLS[acc.currency as keyof typeof CURRENCY_SYMBOLS] || theme.symbol;
                      return (
                        <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <TrendingUp className="h-3 w-3 text-emerald-500" />
                              Intereses generados
                            </span>
                            <span className={`text-sm font-semibold ${totalAccrued > 0 ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                              {totalAccrued > 0 ? '+' : ''}{currSymbol} {totalAccrued.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                        </div>
                      );
                    })()}
                    {(() => {
                      if (!isInvestmentAcc) return null;
                      const initialInv = acc.initialInvestment ? normalizeAmountInput(acc.initialInvestment) : 0;
                      const hasInitial = initialInv > 0;
                      const gainLoss = hasInitial ? balance - initialInv : 0;
                      const gainLossPercent = hasInitial && initialInv > 0 ? ((gainLoss / initialInv) * 100) : 0;
                      const isPositive = gainLoss >= 0;
                      const currSymbol = CURRENCY_SYMBOLS[acc.currency as keyof typeof CURRENCY_SYMBOLS] || theme.symbol;
                      const matDate = acc.maturityDate ? safeParseDate(acc.maturityDate) : null;
                      const daysRemaining = matDate ? Math.ceil((matDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null;
                      if (!hasInitial && !matDate) return null;
                      return (
                        <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1">
                          {hasInitial && (
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">Capital invertido</span>
                              <span className="text-muted-foreground">{currSymbol} {initialInv.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                            </div>
                          )}
                          {hasInitial && (
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">Rendimiento</span>
                              <div className="flex items-center gap-1">
                                {isPositive ? (
                                  <ArrowUp className="h-3 w-3 text-emerald-600" />
                                ) : (
                                  <ArrowDown className="h-3 w-3 text-red-600" />
                                )}
                                <span className={`font-semibold ${isPositive ? 'text-emerald-600' : 'text-red-600'}`}>
                                  {isPositive ? '+' : ''}{currSymbol} {Math.abs(gainLoss).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                                </span>
                                <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${isPositive ? 'border-emerald-300 text-emerald-700 bg-emerald-50' : 'border-red-300 text-red-700 bg-red-50'}`}>
                                  {isPositive ? '+' : ''}{gainLossPercent.toFixed(1)}%
                                </Badge>
                              </div>
                            </div>
                          )}
                          {matDate && daysRemaining !== null && (
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">Vencimiento</span>
                              <div className="flex items-center gap-1">
                                <Calendar className={`h-3 w-3 ${daysRemaining < 0 ? 'text-red-600' : daysRemaining <= 7 ? 'text-amber-600' : 'text-muted-foreground'}`} />
                                <span className={`font-medium ${daysRemaining < 0 ? 'text-red-600' : daysRemaining <= 7 ? 'text-amber-600' : 'text-muted-foreground'}`}>
                                  {daysRemaining < 0 ? `Vencido hace ${Math.abs(daysRemaining)}d` : daysRemaining === 0 ? 'Vence hoy' : `${daysRemaining}d restantes`}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                );
              };

              const renderCurrencySection = (accs: any[], theme: typeof currencyThemes.ARS) => (
                accs.length > 0 ? (
                  <div>
                    <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${theme.dot}`}></span>
                      {theme.label}
                    </h3>
                    <div className="grid gap-2 sm:gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {accs.map((acc: any) => renderAccountCard(acc, theme))}
                    </div>
                  </div>
                ) : null
              );

              const investmentAccountsWithInitial = investmentAccountsAll.filter(
                (a: any) => a.initialInvestment && normalizeAmountInput(a.initialInvestment) > 0
              );

              const portfolioByCurrency: Record<string, { invested: number; current: number; symbol: string; label: string }> = {};
              investmentAccountsWithInitial.forEach((a: any) => {
                const curr = a.currency || 'ARS';
                const key = (curr === 'USD' || curr === 'USD_CASH') ? 'USD' : curr;
                if (!portfolioByCurrency[key]) {
                  portfolioByCurrency[key] = {
                    invested: 0,
                    current: 0,
                    symbol: CURRENCY_SYMBOLS[curr as keyof typeof CURRENCY_SYMBOLS] || 'AR$',
                    label: key === 'ARS' ? 'Pesos' : key === 'USD' ? 'Dólares' : 'Euros',
                  };
                }
                portfolioByCurrency[key].invested += normalizeAmountInput(a.initialInvestment);
                const accrued = calculateAccruedInterest(a);
                portfolioByCurrency[key].current += accrued > 0 ? parseFloat(a.initialInvestment || '0') + accrued : normalizeAmountInput(a.balance);
              });

              const portfolioCurrencies = Object.keys(portfolioByCurrency);

              return (
                <>
                  <Card className="border border-primary/10 shadow-xl shadow-primary/5 bg-white dark:bg-card/95 backdrop-blur-sm premium-border">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Building2 className="h-5 w-5 text-primary" />
                        Cuentas Operativas
                      </CardTitle>
                      <CardDescription>Cuentas bancarias, efectivo y billeteras</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                      {renderCurrencySection(opARS, currencyThemes.ARS)}
                      {renderCurrencySection(opUSD, currencyThemes.USD)}
                      {renderCurrencySection(opEUR, currencyThemes.EUR)}

                      <Link href="/accounts">
                        <div className="p-4 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-800 hover:border-primary hover:bg-primary/5 transition-[border-color,background-color] duration-300 flex items-center justify-center gap-2 cursor-pointer min-h-[80px] group">
                          <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800 group-hover:bg-primary/10 transition-colors">
                            <Plus className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                          </div>
                          <span className="text-sm text-muted-foreground group-hover:text-primary font-medium transition-colors">Agregar Cuenta</span>
                        </div>
                      </Link>
                    </CardContent>
                  </Card>

                  {investmentAccountsAll.length > 0 && (
                    <Card className="border border-primary/10 shadow-xl shadow-primary/5 bg-white dark:bg-card/95 backdrop-blur-sm premium-border">
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <TrendingUp className="h-5 w-5 text-emerald-600" />
                          Cuentas de Inversión
                        </CardTitle>
                        <CardDescription>Inversiones, brokers, crypto y plazos fijos</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-6">
                        {renderCurrencySection(invARS, currencyThemes.ARS)}
                        {renderCurrencySection(invUSD, currencyThemes.USD)}
                        {renderCurrencySection(invEUR, currencyThemes.EUR)}
                      </CardContent>
                    </Card>
                  )}

                  {portfolioCurrencies.length > 0 && (
                    <Card className="border border-primary/10 shadow-xl shadow-primary/5 bg-white dark:bg-card/95 backdrop-blur-sm premium-border" data-testid="portfolio-summary-card">
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <PieChart className="h-5 w-5 text-emerald-600" />
                          Portafolio de Inversiones
                        </CardTitle>
                        <CardDescription>Resumen de rendimiento de tus inversiones</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-4">
                          {portfolioCurrencies.map((curr) => {
                            const p = portfolioByCurrency[curr];
                            const gainLoss = p.current - p.invested;
                            const pct = p.invested > 0 ? ((gainLoss / p.invested) * 100) : 0;
                            const isPositive = gainLoss >= 0;
                            return (
                              <div key={curr} className="rounded-xl border border-slate-100 dark:border-slate-800 bg-gradient-to-br from-slate-50 to-white dark:from-card dark:to-card/70 p-4">
                                {portfolioCurrencies.length > 1 && (
                                  <p className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wide">{p.label} ({curr})</p>
                                )}
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-4">
                                  <div>
                                    <p className="text-xs text-muted-foreground mb-1">Capital Invertido</p>
                                    <p className="font-bold text-sm sm:text-base tabular-nums" data-testid={`portfolio-invested-${curr}`}>
                                      {p.symbol}{p.invested.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-muted-foreground mb-1">Valor Actual</p>
                                    <p className="font-bold text-sm sm:text-base tabular-nums" data-testid={`portfolio-current-${curr}`}>
                                      {p.symbol}{p.current.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-muted-foreground mb-1">Rendimiento</p>
                                    <div className="flex items-center gap-1" data-testid={`portfolio-gain-${curr}`}>
                                      {isPositive ? (
                                        <ArrowUp className="h-4 w-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                                      ) : (
                                        <ArrowDown className="h-4 w-4 text-red-600 dark:text-red-400 flex-shrink-0" />
                                      )}
                                      <div>
                                        <p className={`font-bold text-sm sm:text-base tabular-nums ${isPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                                          {isPositive ? '+' : ''}{p.symbol}{Math.abs(gainLoss).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                        </p>
                                        <p className={`text-xs font-semibold ${isPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                                          {isPositive ? '▲' : '▼'} {isPositive ? '+' : ''}{pct.toFixed(1)}%
                                        </p>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </>
              );
            })()}
          </div>
        </TabsContent>

        {/* PELÍCULA - Estado Económico */}
        <TabsContent value="pelicula">
          <div className="space-y-6">
            <div className="grid gap-2 sm:gap-3 grid-cols-2 lg:grid-cols-4">
              <StatCard 
                title="Ingresos (Mes)" 
                value={<CurrencyWithTooltip value={monthlyIncome} label="Ingresos del Mes" />} 
                icon={TrendingUp}
                trend={incomeVariation > 0 ? 'up' : incomeVariation < 0 ? 'down' : 'neutral'}
                trendValue={`${incomeVariation >= 0 ? '+' : ''}${incomeVariation}%`}
                description="vs mes anterior"
                className="border-l-4 border-l-green-500"
                onClick={() => setDrillDownMetric('ingresos')}
              />
              <StatCard 
                title="Costos (Mes)" 
                value={<CurrencyWithTooltip value={monthlyCosts} label="Costos del Mes" />} 
                icon={ArrowDownLeft}
                description="Producción / Materiales"
                className="border-l-4 border-l-orange-500"
                onClick={() => setDrillDownMetric('costos')}
              />
              <StatCard 
                title="Gastos (Mes)" 
                value={<CurrencyWithTooltip value={monthlyGastos} label="Gastos del Mes" />} 
                icon={ArrowDownLeft}
                description="Operativos / Admin"
                className="border-l-4 border-l-purple-500"
                onClick={() => setDrillDownMetric('gastos')}
              />
              <StatCard 
                title="Utilidad Neta" 
                value={<CurrencyWithTooltip value={monthlyNetProfit} label="Utilidad Neta" />} 
                icon={TrendingUp}
                description="Ingresos - Costos - Gastos"
                className={`border-l-4 ${monthlyNetProfit >= 0 ? 'border-l-emerald-500' : 'border-l-red-500'}`}
                onClick={() => setDrillDownMetric('utilidad')}
              />
            </div>

            <div className="grid gap-2 sm:gap-3 grid-cols-2 lg:grid-cols-4">
              <StatCard 
                title="A Cobrar" 
                value={<CurrencyWithTooltip value={pendingReceivable} label="A Cobrar" />} 
                icon={ArrowUpRight}
                description="Pendiente de cobro"
                onClick={() => setDrillDownMetric('a-cobrar')}
              />
              <StatCard 
                title="A Pagar" 
                value={<CurrencyWithTooltip value={pendingPayable} label="A Pagar" />} 
                icon={ArrowDownLeft}
                description="Pendiente de pago"
                onClick={() => setDrillDownMetric('a-pagar')}
              />
              <StatCard 
                title="Egresos Total (Mes)" 
                value={<CurrencyWithTooltip value={monthlyExpense} label="Egresos del Mes" />} 
                icon={ArrowDownLeft}
                trend={expenseVariation > 0 ? 'up' : expenseVariation < 0 ? 'down' : 'neutral'}
                trendValue={`${expenseVariation >= 0 ? '+' : ''}${expenseVariation}%`}
                trendColor={expenseVariation <= 0 ? 'positive' : 'negative'}
                description="vs mes anterior"
                onClick={() => setDrillDownMetric('egresos')}
              />
            </div>

            {/* Costos Fijos e Ingresos Fijos */}
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
              <Card className="border-2 border-amber-200 bg-gradient-to-br from-amber-50 to-orange-50/50 shadow-md overflow-hidden cursor-pointer hover:shadow-lg hover:ring-2 hover:ring-amber-300/50 transition-all" onClick={() => setDrillDownMetric('costos-fijos')} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDrillDownMetric('costos-fijos'); } }} role="button" tabIndex={0} data-testid="stat-card-costos-fijos">
                <CardContent className="py-5 px-4 sm:px-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <Repeat className="h-4 w-4 text-amber-600" />
                        <p className="text-sm font-semibold text-amber-800" data-testid="text-fixed-costs-label">Costos Fijos</p>
                      </div>
                      <p className="text-2xl sm:text-3xl font-bold text-amber-700 tabular-nums pointer-events-none" data-testid="text-fixed-costs-amount">
                        <CurrencyWithTooltip value={fixedCosts} label="Costos Fijos" />
                      </p>
                      <p className="text-xs text-amber-600/80 mt-1">Compromisos recurrentes por pagar</p>
                    </div>
                    <div className="p-3 rounded-2xl bg-amber-100/80">
                      <ArrowDownLeft className="h-6 w-6 text-amber-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-2 border-emerald-200 bg-gradient-to-br from-emerald-50 to-green-50/50 shadow-md overflow-hidden cursor-pointer hover:shadow-lg hover:ring-2 hover:ring-emerald-300/50 transition-all" onClick={() => setDrillDownMetric('ingresos-fijos')} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDrillDownMetric('ingresos-fijos'); } }} role="button" tabIndex={0} data-testid="stat-card-ingresos-fijos">
                <CardContent className="py-5 px-4 sm:px-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <Repeat className="h-4 w-4 text-emerald-600" />
                        <p className="text-sm font-semibold text-emerald-800" data-testid="text-fixed-income-label">Ingresos Fijos</p>
                      </div>
                      <p className="text-2xl sm:text-3xl font-bold text-emerald-700 tabular-nums pointer-events-none" data-testid="text-fixed-income-amount">
                        <CurrencyWithTooltip value={fixedIncome} label="Ingresos Fijos" />
                      </p>
                      <p className="text-xs text-emerald-600/80 mt-1">Cobros recurrentes programados</p>
                    </div>
                    <div className="p-3 rounded-2xl bg-emerald-100/80">
                      <ArrowUpRight className="h-6 w-6 text-emerald-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Pending Transactions */}
            <div className="grid gap-4 md:grid-cols-2">
              <Card className="border border-border/50 shadow-lg shadow-slate-200/40 bg-card/80 backdrop-blur-sm overflow-hidden">
                <CardHeader className="border-b border-green-100 bg-gradient-to-r from-green-50/50 to-transparent">
                  <CardTitle className="flex items-center gap-2 text-green-700">
                    <div className="h-8 w-8 rounded-lg bg-green-100 flex items-center justify-center text-lg font-bold">
                      +
                    </div>
                    Por Cobrar
                  </CardTitle>
                  <CardDescription>Ingresos pendientes de recibir</CardDescription>
                </CardHeader>
                <CardContent className="pt-4">
                  <div className="space-y-3">
                    {transactions.filter(t => t.type === 'receivable' && t.status !== 'completed' && t.status !== 'cancelled').slice(0, 5).map((t) => (
                      <div key={t.id} className="flex items-center justify-between p-3 bg-gradient-to-r from-green-50 to-emerald-50/50 rounded-xl border border-green-100 hover:shadow-md transition-shadow">
                        <div>
                          <p className="text-sm font-semibold">{t.description}</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            Vence: {format(safeParseDate(t.imputationDate || t.date), "d MMM", { locale: es })}
                          </p>
                        </div>
                        <span className="font-bold text-green-600">+{formatCurrency(normalizeAmountInput(t.amount))}</span>
                      </div>
                    ))}
                    {transactions.filter(t => t.type === 'receivable' && t.status !== 'completed' && t.status !== 'cancelled').length === 0 && (
                      <p className="text-sm text-muted-foreground text-center py-6">No hay cobros pendientes</p>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="border border-border/50 shadow-lg shadow-slate-200/40 bg-card/80 backdrop-blur-sm overflow-hidden">
                <CardHeader className="border-b border-red-100 bg-gradient-to-r from-red-50/50 to-transparent">
                  <CardTitle className="flex items-center gap-2 text-red-700">
                    <div className="h-8 w-8 rounded-lg bg-red-100 flex items-center justify-center text-lg font-bold">
                      −
                    </div>
                    Por Pagar
                  </CardTitle>
                  <CardDescription>Pagos pendientes</CardDescription>
                </CardHeader>
                <CardContent className="pt-4">
                  <div className="space-y-3">
                    {transactions.filter(t => t.type === 'payable' && t.status !== 'completed' && t.status !== 'cancelled').slice(0, 5).map((t) => (
                      <div key={t.id} className="flex items-center justify-between p-3 bg-gradient-to-r from-red-50 to-rose-50/50 rounded-xl border border-red-100 hover:shadow-md transition-shadow">
                        <div>
                          <p className="text-sm font-semibold">{t.description}</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            Vence: {format(safeParseDate(t.imputationDate || t.date), "d MMM", { locale: es })}
                          </p>
                        </div>
                        <span className="font-bold text-red-600">-{formatCurrency(normalizeAmountInput(t.amount))}</span>
                      </div>
                    ))}
                    {transactions.filter(t => t.type === 'payable' && t.status !== 'completed' && t.status !== 'cancelled').length === 0 && (
                      <p className="text-sm text-muted-foreground text-center py-6">No hay pagos pendientes</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Balance Proyectado */}
            <Card className="border border-primary/20 shadow-lg shadow-primary/10 bg-gradient-to-r from-primary/5 via-primary/10 to-accent/5 backdrop-blur-sm overflow-hidden">
              <CardContent className="py-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Balance Proyectado</p>
                    <p className="text-3xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">{formatCurrency(totalBalance + pendingReceivable - pendingPayable)}</p>
                    <p className="text-xs text-muted-foreground mt-2">
                      Saldo actual {pendingReceivable > 0 ? `+ AR$ ${pendingReceivable.toLocaleString()} por cobrar` : ''} 
                      {pendingPayable > 0 ? ` - AR$ ${pendingPayable.toLocaleString()} por pagar` : ''}
                    </p>
                  </div>
                  <div className="p-4 rounded-2xl bg-gradient-to-br from-primary/20 to-accent/20">
                    <TrendingUp className="h-8 w-8 text-primary" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      {/* Recent Activity */}
      <Card className="border border-primary/10 shadow-xl shadow-primary/5 bg-white dark:bg-card/95 backdrop-blur-sm premium-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5 text-primary" />
            Últimos Movimientos
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {transactions.filter(t => t.status === 'completed').sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5).map((t) => {
              const account = accounts.find(a => a.id === t.accountId);
              const currency = account?.currency || 'ARS';
              return (
              <div key={t.id} className="flex items-center justify-between group p-3 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                <div className="flex items-center gap-4">
                  <div className={`h-9 w-9 rounded-xl flex items-center justify-center text-lg font-bold transition-transform group-hover:scale-105 ${
                    t.type === 'income' ? 'bg-gradient-to-br from-green-100 to-emerald-100 text-green-600' : 
                    t.type === 'expense' ? 'bg-gradient-to-br from-red-100 to-rose-100 text-red-600' :
                    t.type === 'receivable' ? 'bg-gradient-to-br from-blue-100 to-sky-100 text-blue-600' :
                    'bg-gradient-to-br from-orange-100 to-amber-100 text-orange-600'
                  }`}>
                    {(t.type === 'income' || t.type === 'receivable') ? '+' : '−'}
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-semibold leading-none group-hover:text-primary transition-colors">{t.description}</p>
                    <p className="text-xs text-muted-foreground">
                      {format(getEffectiveTransactionDate(t), "d 'de' MMMM", { locale: es })} • {t.category}
                    </p>
                  </div>
                </div>
                <div className={`font-bold ${
                  t.type === 'income' || t.type === 'receivable' ? 'text-green-600' : 'text-slate-700 dark:text-slate-200'
                }`}>
                  {t.type === 'income' || t.type === 'receivable' ? '+' : '-'}{formatCurrency(normalizeAmountInput(t.amount), currency as Currency, false)}
                </div>
              </div>
            );})}
            
            {transactions.filter(t => t.status === 'completed').length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                <div className="p-4 rounded-full bg-slate-100 dark:bg-slate-800 w-fit mx-auto mb-3">
                  <ArrowRightLeft className="h-6 w-6" />
                </div>
                No hay movimientos recientes.
              </div>
            )}

            {transactions.filter(t => t.status === 'completed').length > 0 && (
              <Link href="/transactions">
                <Button variant="ghost" className="w-full mt-4 hover:bg-primary/5 hover:text-primary">
                  Ver todos los movimientos
                </Button>
              </Link>
            )}
          </div>
        </CardContent>
      </Card>
      
      {/* Dialog for showing full amount on mobile */}
      <Dialog open={showAmountDialog} onOpenChange={setShowAmountDialog}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-center text-muted-foreground">{dialogAmount.label}</DialogTitle>
          </DialogHeader>
          <div className="text-center py-4">
            <p className="text-2xl font-bold tabular-nums text-primary">
              {dialogAmount.value}
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Account Dialog */}
      <Dialog open={!!editAccount} onOpenChange={handleDashboardEditClose}>
        <DialogContent className="sm:max-w-[425px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Cuenta</DialogTitle>
          </DialogHeader>
          <Form {...dashboardEditForm}>
            <form onSubmit={dashboardEditForm.handleSubmit(onDashboardEditSubmit)} className="space-y-4 pt-4">
              <FormField control={dashboardEditForm.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Nombre de la Cuenta</FormLabel><FormControl><Input placeholder="Ej: Banco Galicia C/C" {...field} /></FormControl><FormMessage /></FormItem>
              )} />

              <FormField control={dashboardEditForm.control} name="accountCategory" render={({ field }) => (
                <FormItem><FormLabel>Categoría</FormLabel>
                  <Select onValueChange={(val) => {
                    field.onChange(val);
                    dashboardEditForm.setValue('type', val === 'operative' ? 'bank' : 'investment');
                    dashboardEditForm.setValue('customTypeLabel', '');
                  }} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Seleccionar categoría" /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="operative">Cuenta Operativa</SelectItem>
                      <SelectItem value="investment">Cuenta de Inversión</SelectItem>
                    </SelectContent>
                  </Select><FormMessage />
                </FormItem>
              )} />

              <FormField control={dashboardEditForm.control} name="type" render={({ field }) => (
                <FormItem><FormLabel>Tipo</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Seleccionar tipo" /></SelectTrigger></FormControl>
                    <SelectContent>
                      {(dashboardEditForm.watch('accountCategory') === 'investment' ? INVESTMENT_ACCOUNT_TYPES : OPERATIVE_ACCOUNT_TYPES).map((t) => (
                        <SelectItem key={t} value={t}>{FINANCIAL_ACCOUNT_TYPE_CONFIG[t].label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select><FormMessage />
                </FormItem>
              )} />

              {(dashboardEditForm.watch('accountCategory') === 'investment' || dashboardEditForm.watch('type') === 'other') && (
                <FormField control={dashboardEditForm.control} name="customTypeLabel" render={({ field }) => (
                  <FormItem>
                    <FormLabel>{dashboardEditForm.watch('type') === 'other' ? 'Nombre del tipo' : dashboardEditForm.watch('accountCategory') === 'investment' ? 'Nombre personalizado (opcional)' : 'Nombre del tipo'}</FormLabel>
                    <FormControl>
                      <Input placeholder={dashboardEditForm.watch('type') === 'other' ? 'Ej: Autos, Arte, Inmuebles' : dashboardEditForm.watch('accountCategory') === 'investment' ? 'Ej: Mi fondo de bonos, Crypto USDT' : 'Ej: Fideicomiso, Cooperativa'} {...field} />
                    </FormControl><FormMessage />
                  </FormItem>
                )} />
              )}

              <FormField control={dashboardEditForm.control} name="currency" render={({ field }) => (
                <FormItem><FormLabel>Moneda</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Seleccionar moneda" /></SelectTrigger></FormControl>
                    <SelectContent>{CURRENCIES.map((curr) => (<SelectItem key={curr} value={curr}>{CURRENCY_LABELS[curr]}</SelectItem>))}</SelectContent>
                  </Select><FormMessage />
                </FormItem>
              )} />

              {dashboardEditForm.watch('accountCategory') === 'investment' && (
                <>
                  <FormField control={dashboardEditForm.control} name="initialInvestment" render={({ field }) => (
                    <FormItem><FormLabel>Capital Invertido</FormLabel><FormControl>
                      <div className="relative"><span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                        <Input type="text" inputMode="decimal" className="pl-7" placeholder="0"
                          value={editInvestmentDisplayValue}
                          onChange={(e) => {
                            const { displayValue, internalValue } = formatAmountLive(e.target.value, field.value || '');
                            setEditInvestmentDisplayValue(displayValue);
                            field.onChange(internalValue || '');
                          }} />
                      </div>
                    </FormControl><FormDescription>Monto que invertiste originalmente (para calcular rendimiento)</FormDescription><FormMessage /></FormItem>
                  )} />

                  <div className="grid grid-cols-2 gap-3">
                    <FormField control={dashboardEditForm.control} name="interestRate" render={({ field }) => (
                      <FormItem><FormLabel>Tasa de Interés</FormLabel><FormControl>
                        <div className="relative">
                          <Input type="text" inputMode="decimal" className="pr-8" placeholder="0"
                            value={field.value}
                            onChange={(e) => { const val = e.target.value.replace(/[^0-9.,]/g, ''); field.onChange(val); }} />
                          <span className="absolute right-3 top-2.5 text-muted-foreground font-medium">%</span>
                        </div>
                      </FormControl><FormMessage /></FormItem>
                    )} />

                    <FormField control={dashboardEditForm.control} name="interestFrequency" render={({ field }) => (
                      <FormItem><FormLabel>Frecuencia</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value || 'monthly'}>
                          <FormControl><SelectTrigger><SelectValue placeholder="Frecuencia" /></SelectTrigger></FormControl>
                          <SelectContent>
                            {INTEREST_FREQUENCIES.map((freq) => (
                              <SelectItem key={freq} value={freq}>{INTEREST_FREQUENCY_LABELS[freq]}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select><FormMessage />
                      </FormItem>
                    )} />
                  </div>

                  <FormField control={dashboardEditForm.control} name="maturityDate" render={({ field }) => (
                    <FormItem><FormLabel>Fecha de Vencimiento (opcional)</FormLabel><FormControl>
                      <Input type="date" {...field} />
                    </FormControl><FormDescription>Cuándo vence la inversión (ej: plazo fijo)</FormDescription><FormMessage /></FormItem>
                  )} />
                </>
              )}

              <Button type="submit" className="w-full mt-4" disabled={updateAccountMutation.isPending}>
                {updateAccountMutation.isPending ? 'Guardando...' : 'Guardar Cambios'}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Discard Changes Confirmation */}
      <AlertDialog open={confirmDiscardEdit} onOpenChange={(open) => !open && setConfirmDiscardEdit(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Descartar los cambios?</AlertDialogTitle>
            <AlertDialogDescription>
              Si cerrás este formulario, los cambios que hiciste se van a perder. ¿Querés continuar?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Seguir editando</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDashboardDiscard} className="bg-red-600 hover:bg-red-700">
              Descartar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Adjust Balance Dialog */}
      <Dialog open={!!adjustAccount} onOpenChange={(open) => { if (!open) { setAdjustAccount(null); setAdjustAmount(''); setAdjustDisplayValue(''); } }}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Scale className="h-5 w-5 text-primary" />Ajustar Saldo</DialogTitle>
            <DialogDescription>Ajustá el saldo de <span className="font-semibold">{adjustAccount?.name}</span>.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div>
              <p className="text-sm font-medium mb-1">Saldo actual</p>
              <p className="text-lg font-bold text-muted-foreground">
                {adjustAccount && formatCurrencyForAdjust(getAccountEffectiveBalance(adjustAccount), (adjustAccount.currency || 'ARS') as Currency)}
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Nuevo saldo</label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-muted-foreground text-sm">
                  {adjustAccount?.currency === 'USD' || adjustAccount?.currency === 'USD_CASH' ? 'US$' : adjustAccount?.currency === 'EUR' ? '€' : 'AR$'}
                </span>
                <Input type="text" inputMode="decimal" className="pl-12" placeholder="0,00" value={adjustDisplayValue}
                  onChange={(e) => { const { displayValue, internalValue } = formatAmountLive(e.target.value, adjustAmount); setAdjustDisplayValue(displayValue); setAdjustAmount(internalValue); }}
                  data-testid="input-dashboard-adjust-balance" />
              </div>
            </div>
            {!forceMode && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Motivo del ajuste (opcional)</label>
                <Input placeholder="Ej: Corrección por arqueo de caja" value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} data-testid="input-dashboard-adjust-reason" />
              </div>
            )}
            <div className="flex items-center space-x-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <Checkbox id="dashboard-force-mode" checked={forceMode} onCheckedChange={(checked) => setForceMode(checked === true)} data-testid="checkbox-dashboard-force-mode" />
              <label htmlFor="dashboard-force-mode" className="text-sm font-medium cursor-pointer flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                Forzar saldo (sin generar movimiento)
              </label>
            </div>
            {!forceMode && adjustAmount && normalizeAmountInput(adjustAmount) !== (adjustAccount ? getAccountEffectiveBalance(adjustAccount) : 0) && (
              <div className={`p-3 rounded-lg border ${normalizeAmountInput(adjustAmount) > (adjustAccount ? getAccountEffectiveBalance(adjustAccount) : 0) ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                <p className="text-sm font-medium">
                  {normalizeAmountInput(adjustAmount) > (adjustAccount ? getAccountEffectiveBalance(adjustAccount) : 0) ? (
                    <span className="text-green-700">Se registrará un ingreso de {formatCurrencyForAdjust(Math.abs(normalizeAmountInput(adjustAmount) - (adjustAccount ? getAccountEffectiveBalance(adjustAccount) : 0)), (adjustAccount?.currency || 'ARS') as Currency)}</span>
                  ) : (
                    <span className="text-red-700">Se registrará un egreso de {formatCurrencyForAdjust(Math.abs(normalizeAmountInput(adjustAmount) - (adjustAccount ? getAccountEffectiveBalance(adjustAccount) : 0)), (adjustAccount?.currency || 'ARS') as Currency)}</span>
                  )}
                </p>
              </div>
            )}
            {forceMode && adjustAmount && normalizeAmountInput(adjustAmount) !== (adjustAccount ? getAccountEffectiveBalance(adjustAccount) : 0) && (
              <div className="p-3 rounded-lg border bg-amber-50 border-amber-200">
                <p className="text-sm text-amber-700">El saldo se actualizará directamente sin crear ningún movimiento en el historial.</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAdjustAccount(null); setAdjustAmount(''); setAdjustDisplayValue(''); }}>Cancelar</Button>
            <Button onClick={async () => {
              if (!adjustAccount || !adjustAmount) return;
              try {
                const normalizedBalance = normalizeAmountInput(adjustAmount).toString();
                if (forceMode) {
                  await forceBalanceMutation.mutateAsync({ id: adjustAccount.id, newBalance: normalizedBalance });
                  toast({ title: "Saldo forzado", description: `El saldo de ${adjustAccount.name} ha sido actualizado directamente.` });
                } else {
                  await adjustBalanceMutation.mutateAsync({ id: adjustAccount.id, newBalance: normalizedBalance, reason: adjustReason || undefined });
                  toast({ title: "Saldo ajustado", description: `El saldo de ${adjustAccount.name} ha sido actualizado correctamente.` });
                }
                setAdjustAccount(null); setAdjustAmount(''); setAdjustDisplayValue('');
              } catch (error: any) {
                toast({ title: "Error", description: error.message || "No se pudo ajustar el saldo", variant: "destructive" });
              }
            }}
            disabled={(forceMode ? forceBalanceMutation.isPending : adjustBalanceMutation.isPending) || !adjustAmount || normalizeAmountInput(adjustAmount) === (adjustAccount ? getAccountEffectiveBalance(adjustAccount) : 0)}
            data-testid="button-dashboard-confirm-adjust">
              {(forceMode ? forceBalanceMutation.isPending : adjustBalanceMutation.isPending) ? 'Ajustando...' : (forceMode ? 'Forzar Saldo' : 'Confirmar Ajuste')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      </TooltipProvider>

      {drillDownData && (
        <DrillDownModal
          open={!!drillDownMetric}
          onClose={() => setDrillDownMetric(null)}
          title={drillDownData.title}
          transactions={'transactions' in drillDownData ? drillDownData.transactions : undefined}
          groups={'groups' in drillDownData ? drillDownData.groups : undefined}
          totalValue={drillDownData.totalValue}
          totalLabel={drillDownData.totalLabel}
          getAccountCurrency={getAccountCurrency}
          convertToARS={convertToARS}
          clients={clientsData}
          suppliers={suppliersData}
        />
      )}
    </>
  );
}
