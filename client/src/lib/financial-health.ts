import type { Transaction, Account } from '@shared/schema';
import { safeParseDate, calculateAccruedInterest, getEffectiveTransactionDate } from '@/lib/utils';

export interface FinancialHealthInput {
  transactions: Transaction[];
  accounts: Account[];
  usdRate: number;
  eurRate: number;
  assetsBookValue?: number;
  investmentsValue?: number;
  payrollTotalARS?: number;
}

export interface FinancialHealthResult {
  healthScore: number;
  totalBalance: number;
  pendingReceivable: number;
  pendingPayable: number;
  netPosition: number;
  // Detailed explanation data
  baseScore: number;
  structuralDeficitPenalty: number;
  liquidityCrisisPenalty: number;
  overduePenalty: number;
  negativePenalty: number;
  collectionRiskPenalty: number;
  profitAdjustment: number;
  cashFlowPenalty: number;
  compliancePenalty: number;
  negativeBalanceCount: number;
  totalNegativeAmount: number;
  effectiveBalance: number;
  hasInsufficientCoverage: boolean;
  urgentPayablesAmount: number;
  urgentReceivablesAmount: number;
  overduePayablesAmount: number;
  overdueReceivablesAmount: number;
  profitMargin: number;
  invoicedIncomePercent: number;
  receiptedExpensePercent: number;
  invoicedIncomesCount: number;
  completedIncomesCount: number;
  receiptedExpensesCount: number;
  completedExpensesCount: number;
  thirtyDayReceivables: number;
  thirtyDayPayables: number;
  projectedBalance30: number;
  finalScore: number;
  // Monthly data
  monthlyIncome: number;
  monthlyExpense: number;
  monthlyCosts: number;
  monthlyGastos: number;
  // Payables breakdown
  payables0to7Amount: number;
  payables8to15Amount: number;
  payables16to30Amount: number;
  // Receivables breakdown
  receivables0to7Amount: number;
  receivables8to15Amount: number;
  receivables16to30Amount: number;
  patrimonialBonus: number;
  patrimonialValue: number;
}

function normalizeAmountInput(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const numValue = typeof value === 'string' ? parseFloat(value) : value;
  return isNaN(numValue) ? 0 : numValue;
}

export function calculateFinancialHealth(input: FinancialHealthInput): FinancialHealthResult {
  const { transactions, accounts, usdRate, eurRate, assetsBookValue = 0, investmentsValue = 0, payrollTotalARS = 0 } = input;

  const convertToARS = (amount: number, currency: string): number => {
    if (currency === 'ARS') return amount;
    if (currency === 'USD' || currency === 'USD_CASH') return amount * usdRate;
    if (currency === 'EUR') return amount * eurRate;
    return amount;
  };

  const getAccountCurrency = (accountId: string | null): string => {
    if (!accountId) return 'ARS';
    const account = accounts.find(a => a.id === accountId);
    return account?.currency || 'ARS';
  };

  // Currency priority MUST match what DrillDownModal uses to compute its visible groups:
  // transaction-level currency wins, then account currency, then ARS. Otherwise the card
  // total derived from this hook can diverge from the modal subtotals (Task #245).
  const txCurrency = (t: Transaction): string =>
    t.currency || getAccountCurrency(t.accountId) || 'ARS';

  const totalBalance = accounts.reduce((acc, account) => {
    const isInvestment = account.accountCategory === 'investment';
    let effectiveBal = normalizeAmountInput(account.balance);
    if (isInvestment) {
      const accrued = calculateAccruedInterest(account);
      if (accrued > 0) effectiveBal = parseFloat(account.initialInvestment || '0') + accrued;
    }
    return acc + convertToARS(effectiveBal, account.currency);
  }, 0);

  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();
  
  const isIncomeForMonth = (t: Transaction) => {
    const isDirectIncome = t.type === 'income';
    const isCompletedReceivable = t.type === 'receivable' && t.status === 'completed';
    if (!isDirectIncome && !isCompletedReceivable) return false;
    const d = getEffectiveTransactionDate(t);
    return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
  };

  const isExpenseForMonth = (t: Transaction) => {
    const isDirectExpense = t.type === 'expense';
    const isCompletedPayable = t.type === 'payable' && t.status === 'completed';
    if (!isDirectExpense && !isCompletedPayable) return false;
    const d = getEffectiveTransactionDate(t);
    return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
  };

  const monthlyIncome = transactions
    .filter(isIncomeForMonth)
    .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);

  const monthlyExpenseTransactions = transactions.filter(isExpenseForMonth);

  const monthlyExpense = monthlyExpenseTransactions
    .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);

  const monthlyCosts = monthlyExpenseTransactions
    .filter(t => t.expenseSubtype === 'cost')
    .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);

  const monthlyGastos = monthlyExpenseTransactions
    .filter(t => t.expenseSubtype !== 'cost')
    .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);

  const profitMargin = monthlyIncome > 0 ? Math.round(((monthlyIncome - monthlyExpense) / monthlyIncome) * 100) : 0;

  const isPendingPayable = (t: Transaction) => t.type === 'payable' && t.status !== 'completed' && t.status !== 'cancelled';
  const isPendingReceivable = (t: Transaction) => t.type === 'receivable' && t.status !== 'completed' && t.status !== 'cancelled';

  const pendingPayable = transactions
    .filter(isPendingPayable)
    .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0)
    + payrollTotalARS;
    
  const pendingReceivable = transactions
    .filter(isPendingReceivable)
    .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const sevenDays = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  const fifteenDays = new Date(today.getTime() + 15 * 24 * 60 * 60 * 1000);
  const thirtyDays = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

  const overduePayablesAmount = transactions
    .filter(t => isPendingPayable(t) && safeParseDate(t.date) < today)
    .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);
  
  const payables0to7Amount = transactions
    .filter(t => isPendingPayable(t) && safeParseDate(t.date) >= today && safeParseDate(t.date) <= sevenDays)
    .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);

  const payables8to15Amount = transactions
    .filter(t => isPendingPayable(t) && safeParseDate(t.date) > sevenDays && safeParseDate(t.date) <= fifteenDays)
    .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);

  const payables16to30Amount = transactions
    .filter(t => isPendingPayable(t) && safeParseDate(t.date) > fifteenDays && safeParseDate(t.date) <= thirtyDays)
    .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);

  const overdueReceivablesAmount = transactions
    .filter(t => isPendingReceivable(t) && safeParseDate(t.date) < today)
    .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);

  const receivables0to7Amount = transactions
    .filter(t => isPendingReceivable(t) && safeParseDate(t.date) >= today && safeParseDate(t.date) <= sevenDays)
    .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);

  const receivables8to15Amount = transactions
    .filter(t => isPendingReceivable(t) && safeParseDate(t.date) > sevenDays && safeParseDate(t.date) <= fifteenDays)
    .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);

  const receivables16to30Amount = transactions
    .filter(t => isPendingReceivable(t) && safeParseDate(t.date) > fifteenDays && safeParseDate(t.date) <= thirtyDays)
    .reduce((acc, t) => acc + convertToARS(normalizeAmountInput(t.amount), txCurrency(t)), 0);

  const negativeBalanceCount = accounts.filter(a => normalizeAmountInput(a.balance) < 0).length;
  const hasNegativeBalance = negativeBalanceCount > 0;
  const totalNegativeAmount = accounts
    .filter(a => normalizeAmountInput(a.balance) < 0)
    .reduce((acc, a) => acc + Math.abs(convertToARS(normalizeAmountInput(a.balance), a.currency)), 0);

  const baseScore = 70;
  let healthScore = baseScore;
  const netPosition = totalBalance + pendingReceivable - pendingPayable;
  const effectiveBalance = totalBalance + pendingReceivable;
  const hasInsufficientCoverage = effectiveBalance < pendingPayable;

  let structuralDeficitPenalty = 0;
  if (netPosition < 0) {
    const deficitRatio = Math.abs(netPosition) / Math.max(pendingPayable, 1);
    structuralDeficitPenalty = Math.min(40, Math.round(deficitRatio * 50));
    healthScore = Math.max(0, healthScore - structuralDeficitPenalty);
  } else if (pendingPayable > 0) {
    const coverageRatio = (totalBalance + pendingReceivable) / pendingPayable;
    if (coverageRatio >= 1.5) healthScore = Math.min(100, healthScore + 10);
    else if (coverageRatio >= 1.2) healthScore = Math.min(100, healthScore + 5);
  }

  let liquidityCrisisPenalty = 0;
  const immediateLiabilities = overduePayablesAmount + payables0to7Amount;
  const immediateResources = totalBalance + receivables0to7Amount;
  if (immediateLiabilities > 0) {
    const shortTermLiquidity = immediateResources / immediateLiabilities;
    if (shortTermLiquidity < 1) {
      liquidityCrisisPenalty = Math.min(35, Math.round((1 - shortTermLiquidity) * 45));
      healthScore = Math.max(0, healthScore - liquidityCrisisPenalty);
    }
  }

  let overduePenalty = 0;
  if (overduePayablesAmount > 0) {
    const overdueRatio = overduePayablesAmount / Math.max(totalBalance, pendingPayable, 1);
    overduePenalty = Math.min(25, 10 + Math.round(overdueRatio * 15));
    healthScore = Math.max(0, healthScore - overduePenalty);
  }

  let negativePenalty = 0;
  if (hasNegativeBalance) {
    negativePenalty = Math.min(20, negativeBalanceCount * 10);
    healthScore = Math.max(0, healthScore - negativePenalty);
  }

  let collectionRiskPenalty = 0;
  if (overdueReceivablesAmount > 0 && pendingReceivable > 0) {
    const collectionRiskRatio = overdueReceivablesAmount / pendingReceivable;
    collectionRiskPenalty = Math.min(15, Math.round(collectionRiskRatio * 20));
    healthScore = Math.max(0, healthScore - collectionRiskPenalty);
  }

  let profitAdjustment = 0;
  if (monthlyIncome > 0) {
    if (profitMargin >= 30) profitAdjustment = 10;
    else if (profitMargin >= 15) profitAdjustment = 5;
    else if (profitMargin < 0) profitAdjustment = -10;
    else if (profitMargin < 10) profitAdjustment = -5;
    healthScore = Math.max(0, Math.min(100, healthScore + profitAdjustment));
  }

  let cashFlowPenalty = 0;
  const thirtyDayPayables = overduePayablesAmount + payables0to7Amount + payables8to15Amount + payables16to30Amount;
  const thirtyDayReceivables = receivables0to7Amount + receivables8to15Amount + receivables16to30Amount;
  const projectedBalance30 = totalBalance + thirtyDayReceivables - thirtyDayPayables;
  if (projectedBalance30 < 0) {
    const projectedDeficitRatio = Math.abs(projectedBalance30) / Math.max(thirtyDayPayables, 1);
    cashFlowPenalty = Math.min(20, Math.round(projectedDeficitRatio * 25));
    healthScore = Math.max(0, healthScore - cashFlowPenalty);
  }

  const completedIncomes = transactions.filter(t => t.type === 'income' && t.status === 'completed');
  const invoicedIncomes = completedIncomes.filter(t => t.hasInvoice);
  const invoicedIncomePercent = completedIncomes.length > 0 
    ? Math.round((invoicedIncomes.length / completedIncomes.length) * 100) 
    : 100;
    
  const completedExpenses = transactions.filter(t => t.type === 'expense' && t.status === 'completed');
  const receiptedExpenses = completedExpenses.filter(t => t.hasInvoice);
  const receiptedExpensePercent = completedExpenses.length > 0 
    ? Math.round((receiptedExpenses.length / completedExpenses.length) * 100) 
    : 100;
    
  let compliancePenalty = 0;
  const avgCompliance = (invoicedIncomePercent + receiptedExpensePercent) / 2;
  if (avgCompliance < 50) {
    compliancePenalty = 10;
  } else if (avgCompliance < 70) {
    compliancePenalty = 5;
  } else if (avgCompliance < 85) {
    compliancePenalty = 2;
  }
  healthScore = Math.max(0, healthScore - compliancePenalty);

  const patrimonialValue = assetsBookValue + investmentsValue;
  let patrimonialBonus = 0;
  if (patrimonialValue > 0) {
    if (pendingPayable > 0) {
      const patrimonialCoverage = patrimonialValue / pendingPayable;
      if (patrimonialCoverage >= 3) patrimonialBonus = 10;
      else if (patrimonialCoverage >= 1.5) patrimonialBonus = 7;
      else if (patrimonialCoverage >= 1) patrimonialBonus = 5;
      else if (patrimonialCoverage >= 0.5) patrimonialBonus = 3;
    } else {
      patrimonialBonus = patrimonialValue > totalBalance * 0.1 ? 8 : 4;
    }
    healthScore = Math.min(100, healthScore + patrimonialBonus);
  }

  if (pendingPayable === 0 && pendingReceivable === 0 && totalBalance > 0) {
    healthScore = Math.max(healthScore, 80);
  }

  const finalScore = Math.round(healthScore);

  return {
    healthScore: finalScore,
    totalBalance,
    pendingReceivable,
    pendingPayable,
    netPosition,
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
    effectiveBalance,
    hasInsufficientCoverage,
    urgentPayablesAmount: payables0to7Amount,
    urgentReceivablesAmount: receivables0to7Amount,
    overduePayablesAmount,
    overdueReceivablesAmount,
    profitMargin,
    invoicedIncomePercent,
    receiptedExpensePercent,
    invoicedIncomesCount: invoicedIncomes.length,
    completedIncomesCount: completedIncomes.length,
    receiptedExpensesCount: receiptedExpenses.length,
    completedExpensesCount: completedExpenses.length,
    thirtyDayReceivables,
    thirtyDayPayables,
    projectedBalance30,
    finalScore,
    monthlyIncome,
    monthlyExpense,
    monthlyCosts,
    monthlyGastos,
    payables0to7Amount,
    payables8to15Amount,
    payables16to30Amount,
    receivables0to7Amount,
    receivables8to15Amount,
    receivables16to30Amount,
    patrimonialBonus,
    patrimonialValue
  };
}
