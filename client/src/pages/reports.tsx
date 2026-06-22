import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTransactions, useAccounts, useExchangeRates, useOrganization, useOrganizations, useAssets, useInvestments, useClients, useSuppliers, useProducts, useMembers } from '@/lib/hooks';
import { ADMIN_ROLES, CURRENCY_SYMBOLS, FINANCIAL_ACCOUNT_TYPE_CONFIG, type FinancialAccountType, type Organization, type Role, type Transaction } from '@shared/schema';
import { CategoryPicker, type CategoryPickerCategory } from '@/components/CategoryPicker';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell, Legend } from 'recharts';
import { Download, FileSpreadsheet, FileText, TrendingUp, DollarSign, Wallet, Calendar, HelpCircle, ChevronDown, Sparkles, Loader2, Send, Lightbulb, Users, Package, Truck, BarChart3, CreditCard, ArrowRightLeft, Image, Tag, Building2 } from 'lucide-react';
import { DrillDownModal, type GenericDrillDownItem } from '@/components/DrillDownModal';
import { CrossOrgSummaryCard } from '@/components/CrossOrgSummaryCard';
import {
  buildBurnRateDrillDown,
  buildFinancialBarDrillDown,
  buildEconomicChartDrillDown,
  buildIvaDrillDown,
  buildSaldoIvaDrillDown,
  buildVentasDrillDown,
  buildMemberDrillDown,
  buildCostosDrillDown,
  buildGastosDrillDown,
  buildMargenBrutoDrillDown,
  buildResultadoDrillDown,
  buildPatrimonioOperativoDrillDown,
  buildPatrimonioInversionesDrillDown,
  buildActivosFisicosDrillDown,
  buildInversionesValorActualDrillDown,
  buildValoracionTotalDrillDown,
  buildValuationEbitdaDrillDown,
  buildOperativeAvailabilityDrillDown,
  buildFinancialInvestmentsDrillDown,
  buildValuationCostosDrillDown,
  buildValuationGastosDrillDown,
  buildValuationMargenBrutoDrillDown,
  buildExpenseCategoryDrillDown,
} from '@/pages/reports.drilldownBuilders';
import { CategoryDistributionCard } from '@/pages/reports.CategoryDistributionCard';
import {
  selectCostosRows,
  selectGastosRows,
  selectAllExpensesRows,
  selectIngresosRows,
  selectCategoryRows,
  pickCostSubtype,
  pickGastoSubtype,
  selectIncludedTxByType,
  selectMonthRows,
  selectPendingPayables,
  selectPendingReceivables,
  codeAmountFactor,
} from '@/pages/reports.rowSelectors';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { fetchWithAuth } from '@/lib/api';
import html2canvas from 'html2canvas';
import { format, subMonths, startOfMonth, endOfMonth, isWithinInterval } from 'date-fns';
import { es } from 'date-fns/locale';
import { normalizeAmountInput } from '@/lib/currency';
import { safeParseDate, calculateAccruedInterest, getEffectiveTransactionDate, buildReportableTxFilter, txCurrency as pickTxCurrency } from '@/lib/utils';

const exportToCSV = (data: any[], filename: string) => {
  if (data.length === 0) return;
  const headers = Object.keys(data[0]);
  const csvContent = [
    headers.join(','),
    ...data.map(row => headers.map(h => `"${row[h] ?? ''}"`).join(','))
  ].join('\n');
  
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${filename}_${format(new Date(), 'yyyy-MM-dd')}.csv`;
  link.click();
};

const exportToPDF = (title: string, data: any[]) => {
  if (data.length === 0) return;
  const headers = Object.keys(data[0]);
  const win = window.open('', '_blank');
  if (!win) return;
  
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>${title} - Aikestar</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; }
        h1 { color: #3b82f6; margin-bottom: 8px; }
        .date { color: #666; margin-bottom: 24px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
        th { background: #f5f5f5; font-weight: bold; }
        tr:nth-child(even) { background: #fafafa; }
        .footer { margin-top: 40px; font-size: 12px; color: #999; }
      </style>
    </head>
    <body>
      <h1>${title}</h1>
      <p class="date">Generado: ${format(new Date(), "d 'de' MMMM 'de' yyyy", { locale: es })}</p>
      <table>
        <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${data.map(row => `<tr>${headers.map(h => `<td>${row[h]}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
      <p class="footer">Aikestar - Sistema de Gestion Administrativa</p>
    </body>
    </html>
  `);
  win.document.close();
  win.print();
};

const CURRENCY_LABELS: Record<string, string> = {
  'ARS': 'Pesos (ARS)',
  'USD': 'Dólares (USD)',
  'USD_CASH': 'Dólares Billete',
  'EUR': 'Euros (EUR)',
};


const PERIOD_LABELS: Record<string, string> = {
  '1m': 'Último Mes',
  '3m': 'Últimos 3 Meses',
  '6m': 'Últimos 6 Meses',
};

export default function ReportsPage() {
  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const { data: exchangeRates } = useExchangeRates();
  const { data: organization } = useOrganization();
  const { data: allOrganizations } = useOrganizations() as { data: (Organization & { membershipRole: Role })[] | undefined };
  const adminOrgsCount = useMemo(
    () => (allOrganizations || []).filter((o) => ADMIN_ROLES.includes(o.membershipRole)).length,
    [allOrganizations]
  );
  const showConsolidated = adminOrgsCount >= 2;
  const { data: assets = [] } = useAssets();
  const { data: investments = [] } = useInvestments();
  const { data: clients = [] } = useClients();
  const { data: suppliers = [] } = useSuppliers();
  const { data: products = [] } = useProducts();
  const [period, setPeriod] = useState('6m');
  const [selectedProfitabilityCodeId, setSelectedProfitabilityCodeId] = useState<string>('all');
  // Task #202 — filtro global "Miembro del equipo". 'all' = todos los
  // miembros, 'unassigned' = movimientos sin createdBy (huérfanos), o el
  // userId concreto de un miembro. El filtro se aplica a TODA la página
  // recalculando los mismos selectores compartidos vía passesCodeFilter
  // (que ahora encadena código + miembro). El bloque "Por miembro del
  // equipo" usa SIEMPRE el predicado base sin miembro para que todos
  // los miembros aparezcan en la grilla independientemente del filtro
  // global; el clic en una tarjeta abre el detalle de ese miembro.
  const [selectedMemberId, setSelectedMemberId] = useState<string>('all');
  // Task #250: multi-select. Array vacío = todas las categorías (no filtra).
  // Cualquier subset suma totales de TODAS las categorías elegidas en todas
  // las cards/handlers de Reportes, vía passesCodeFilter.
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  // Lista de categorías presentes en transacciones reportables. Excluimos
  // las pseudo-categorías de transferencia interna. Orden por uso (cantidad
  // de movimientos) descendente, tiebreak alfabético es-AR.
  const availableCategoryItems = useMemo<CategoryPickerCategory[]>(() => {
    const counts = new Map<string, number>();
    (transactions as Transaction[]).forEach((t) => {
      if (t.type === 'transfer_in' || t.type === 'transfer_out') return;
      const cat = (t.category || '').trim();
      if (!cat) return;
      counts.set(cat, (counts.get(cat) || 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0], 'es-AR'))
      .map(([name]) => ({ id: name, name, type: 'expense' as const }));
  }, [transactions]);
  const availableCategories = useMemo(
    () => availableCategoryItems.map((c) => c.name),
    [availableCategoryItems],
  );
  useEffect(() => {
    if (selectedCategories.length === 0) return;
    const pruned = selectedCategories.filter((c) => availableCategories.includes(c));
    if (pruned.length !== selectedCategories.length) setSelectedCategories(pruned);
  }, [availableCategories, selectedCategories]);
  const { data: profitabilityCodes = [] } = useQuery<Array<{id: string; code: string; name: string; color: string | null; isActive: boolean}>>({
    queryKey: ['/api/profitability-codes'],
    queryFn: async () => {
      const res = await fetch('/api/profitability-codes', { credentials: 'include' });
      if (!res.ok) return [];
      return res.json();
    },
  });
  const { data: members = [] } = useMembers();
  // Predicado combinado código + miembro. Es lo que se inyecta en
  // RowSelectorContext de TODAS las cards/handlers existentes, así el
  // filtro global de miembro se aplica automáticamente a todo Reportes
  // (Valoración, Económico, Flujo, Burn Rate, Categorías, Pendientes,
  // Rentabilidad por código y el bloque "Por miembro del equipo"). Cuando
  // el usuario elige "Ana", toda la página — incluida la grilla por miembro
  // — pasa a mostrar SÓLO los movimientos de Ana, como exige el spec.
  const passesCodeFilter = useCallback((t: Transaction) => {
    if (selectedProfitabilityCodeId !== 'all') {
      // Task #475: las transacciones multi-producto guardan el código por
      // renglón (items[]) y dejan el campo legacy en null. Una tx pasa el
      // filtro si CUALQUIER renglón usa el código elegido.
      // SEMÁNTICA: este predicado decide INCLUSIÓN a nivel transacción — una tx
      // pasa si CUALQUIER renglón usa el código (o, legacy, si su campo legacy
      // coincide). El REPARTO del monto por renglón lo hace `codeFactor`
      // (Task #476): todas las cards financieras multiplican el monto por la
      // fracción de los renglones que usan el código, no sólo "Rentabilidad por
      // código". Para tx single-product / legacy el factor es 1, así que el
      // comportamiento histórico no cambia.
      const items = (t as any).items as Array<{ profitabilityCodeId: string | null }> | undefined;
      const matches = items && items.length > 0
        ? items.some((it) => it.profitabilityCodeId === selectedProfitabilityCodeId)
        : t.profitabilityCodeId === selectedProfitabilityCodeId;
      if (!matches) return false;
    }
    if (selectedCategories.length > 0 && !selectedCategories.includes(t.category || '')) return false;
    if (selectedMemberId === 'all') return true;
    if (selectedMemberId === 'unassigned') return t.createdBy == null;
    return t.createdBy === selectedMemberId;
  }, [selectedProfitabilityCodeId, selectedCategories, selectedMemberId]);

  // Task #476 — fracción [0,1] del monto de una tx que corresponde a los
  // renglones que usan el código seleccionado. 1 cuando no hay código activo o
  // la tx no tiene items[] (single-product / legacy). Todas las cards
  // financieras multiplican su monto convertido por este factor para que
  // reflejen sólo la porción del código, igual que "Rentabilidad por código".
  const codeFactor = useCallback(
    (t: any) => codeAmountFactor(t, selectedProfitabilityCodeId),
    [selectedProfitabilityCodeId],
  );
  // Si la lista de miembros cambia (alta/baja, cambio de organización) y el
  // miembro elegido ya no existe — o el filtro está oculto porque la org
  // tiene 1 sólo miembro — reseteamos a "all". Evita un filtro stale activo
  // sin control visible en la UI. IMPORTANTE: el chequeo de members.length
  // se evalúa ANTES de los early-returns por valor, porque incluso
  // 'unassigned' debe resetearse cuando la UI del filtro deja de mostrarse.
  useEffect(() => {
    if (selectedMemberId === 'all') return;
    if (members.length <= 1) {
      setSelectedMemberId('all');
      return;
    }
    if (selectedMemberId === 'unassigned') return;
    const stillExists = members.some((m) => m.userId === selectedMemberId);
    if (!stillExists) setSelectedMemberId('all');
  }, [members, selectedMemberId]);
  const [selectedCurrency, setSelectedCurrency] = useState<string>('ARS');
  const [includedCurrencies, setIncludedCurrencies] = useState<Set<string>>(new Set(['ARS', 'USD', 'EUR']));
  const { toast } = useToast();
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiReport, setAiReport] = useState<{
    titulo: string;
    resumen: string;
    columnas: string[];
    filas: string[][];
    insights: string[];
  } | null>(null);

  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<'csv' | 'pdf'>('csv');
  const [exportSelections, setExportSelections] = useState<Record<string, boolean>>({
    financiera: true,
    economica: false,
    valoracion: false,
    transacciones: false,
    cuentas: false,
    clientes: false,
    proveedores: false,
    productos: false,
  });
  const [exportIncludeCharts, setExportIncludeCharts] = useState(true);
  const [exportPeriod, setExportPeriod] = useState(period);
  const [exportLoading, setExportLoading] = useState(false);

  const chartFinancialRef = useRef<HTMLDivElement>(null);
  const chartEconomicRef = useRef<HTMLDivElement>(null);
  const chartExpensesRef = useRef<HTMLDivElement>(null);

  const EXPORT_SECTIONS = [
    { key: 'financiera', label: 'Visión Financiera', icon: DollarSign, desc: 'Ingresos vs Egresos por mes', group: 'reportes' },
    { key: 'economica', label: 'Visión Económica', icon: TrendingUp, desc: 'Resultado económico (P&L)', group: 'reportes' },
    { key: 'valoracion', label: 'Valoración', icon: BarChart3, desc: 'Composición del patrimonio', group: 'reportes' },
  ];

  const EXPORT_DATA_OPTIONS = [
    { key: 'transacciones', label: 'Transacciones', icon: ArrowRightLeft, desc: 'Todos los movimientos registrados', group: 'datos' },
    { key: 'cuentas', label: 'Cuentas', icon: CreditCard, desc: 'Cuentas con saldos actuales', group: 'datos' },
    { key: 'clientes', label: 'Clientes', icon: Users, desc: 'Listado de clientes', group: 'datos' },
    { key: 'proveedores', label: 'Proveedores', icon: Truck, desc: 'Listado de proveedores', group: 'datos' },
    { key: 'productos', label: 'Productos', icon: Package, desc: 'Inventario y precios', group: 'datos' },
  ];

  const toggleExportSelection = (key: string) => {
    setExportSelections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleOpenExportDialog = (format: 'csv' | 'pdf') => {
    setExportFormat(format);
    setExportPeriod(period);
    setExportDialogOpen(true);
  };

  const handleExportRef = React.useRef<() => void>(() => {});
  
  const availableCurrencies = useMemo(() => {
    const currencies = new Set<string>();
    accounts.forEach((acc: any) => {
      const cur = acc.currency || 'ARS';
      currencies.add(cur === 'USD_CASH' ? 'USD' : cur);
    });
    return Array.from(currencies).sort();
  }, [accounts]);
  
  const accountCurrencyMap = useMemo(() => {
    const map: Record<string, string> = {};
    accounts.forEach((acc: any) => { map[acc.id] = acc.currency || 'ARS'; });
    return map;
  }, [accounts]);

  const initializedRef = React.useRef(false);
  React.useEffect(() => {
    if (availableCurrencies.length > 0 && !initializedRef.current) {
      initializedRef.current = true;
      setIncludedCurrencies(new Set(availableCurrencies));
    }
  }, [availableCurrencies]);

  const toggleIncludedCurrency = (currency: string) => {
    setIncludedCurrencies(prev => {
      const next = new Set(prev);
      if (next.has(currency)) {
        if (next.size > 1) next.delete(currency);
      } else {
        next.add(currency);
      }
      return next;
    });
  };

  const convertAmount = (amount: number, fromCurrency: string, toCurrency: string): number => {
    if (fromCurrency === toCurrency) return amount;
    const usdRate = exchangeRates?.usdToLocal || 1050;
    const eurRate = exchangeRates?.eurToLocal || 1150;
    const toARS = (amt: number, cur: string): number => {
      if (cur === 'ARS') return amt;
      if (cur === 'USD' || cur === 'USD_CASH') return amt * usdRate;
      if (cur === 'EUR') return amt * eurRate;
      return amt;
    };
    const fromARS = (amt: number, cur: string): number => {
      if (cur === 'ARS') return amt;
      if (cur === 'USD' || cur === 'USD_CASH') return usdRate > 0 ? amt / usdRate : 0;
      if (cur === 'EUR') return eurRate > 0 ? amt / eurRate : 0;
      return amt;
    };
    const inARS = toARS(amount, fromCurrency);
    return fromARS(inARS, toCurrency);
  };

  const includedAccountIds = useMemo(() => {
    return accounts
      .filter((acc: any) => {
        const cur = acc.currency || 'ARS';
        return includedCurrencies.has(cur) || (cur === 'USD_CASH' && includedCurrencies.has('USD'));
      })
      .map((acc: any) => acc.id);
  }, [accounts, includedCurrencies]);

  const getBalanceByCurrency = (currency: string) => {
    return accounts
      .filter((acc: any) => acc.currency === currency)
      .reduce((sum: number, acc: any) => {
        if (acc.accountCategory === 'investment') {
          const accrued = calculateAccruedInterest(acc);
          if (accrued > 0) return sum + parseFloat(acc.initialInvestment || '0') + accrued;
        }
        return sum + normalizeAmountInput(acc.balance);
      }, 0);
  };

  const getOperativeBalanceByCurrency = (currency: string) => {
    return accounts
      .filter((acc: any) => {
        return (!acc.accountCategory || acc.accountCategory === 'operative') && acc.currency === currency;
      })
      .reduce((sum: number, acc: any) => sum + normalizeAmountInput(acc.balance), 0);
  };

  const getInvestmentBalanceByCurrency = (currency: string) => {
    return accounts
      .filter((acc: any) => {
        return acc.accountCategory === 'investment' && acc.currency === currency;
      })
      .reduce((sum: number, acc: any) => {
        const accrued = calculateAccruedInterest(acc);
        return sum + (accrued > 0 ? parseFloat(acc.initialInvestment || '0') + accrued : normalizeAmountInput(acc.balance));
      }, 0);
  };

  const getInvestmentInitialByCurrency = (currency: string) => {
    return accounts
      .filter((acc: any) => {
        return acc.accountCategory === 'investment' && acc.currency === currency && acc.initialInvestment;
      })
      .reduce((sum: number, acc: any) => sum + normalizeAmountInput(acc.initialInvestment), 0);
  };

  const hasInvestmentAccounts = accounts.some((acc: any) => {
    return acc.accountCategory === 'investment';
  });

  const getConvertedOperativeBalance = () => {
    return accounts
      .filter((acc: any) => (!acc.accountCategory || acc.accountCategory === 'operative') && includedAccountIds.includes(acc.id))
      .reduce((sum: number, acc: any) => {
        const bal = normalizeAmountInput(acc.balance);
        return sum + convertAmount(bal, acc.currency || 'ARS', selectedCurrency);
      }, 0);
  };

  const getConvertedInvestmentBalance = () => {
    return accounts
      .filter((acc: any) => acc.accountCategory === 'investment' && includedAccountIds.includes(acc.id))
      .reduce((sum: number, acc: any) => {
        const accrued = calculateAccruedInterest(acc);
        const bal = accrued > 0 ? parseFloat(acc.initialInvestment || '0') + accrued : normalizeAmountInput(acc.balance);
        return sum + convertAmount(bal, acc.currency || 'ARS', selectedCurrency);
      }, 0);
  };

  const getConvertedInvestmentInitial = () => {
    return accounts
      .filter((acc: any) => acc.accountCategory === 'investment' && acc.initialInvestment && includedAccountIds.includes(acc.id))
      .reduce((sum: number, acc: any) => {
        const inv = normalizeAmountInput(acc.initialInvestment);
        return sum + convertAmount(inv, acc.currency || 'ARS', selectedCurrency);
      }, 0);
  };

  const getConvertedTotalBalance = () => {
    return accounts
      .filter((acc: any) => includedAccountIds.includes(acc.id))
      .reduce((sum: number, acc: any) => {
        if (acc.accountCategory === 'investment') {
          const accrued = calculateAccruedInterest(acc);
          if (accrued > 0) {
            const bal = parseFloat(acc.initialInvestment || '0') + accrued;
            return sum + convertAmount(bal, acc.currency || 'ARS', selectedCurrency);
          }
        }
        return sum + convertAmount(normalizeAmountInput(acc.balance), acc.currency || 'ARS', selectedCurrency);
      }, 0);
  };

  const formatCurrencyValue = (val: number, currency: string = selectedCurrency) => {
    const symbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || 'AR$';
    return `${symbol}${new Intl.NumberFormat('es-AR', { notation: "compact", maximumFractionDigits: 1 }).format(val)}`;
  };

  const formatCurrencyFull = (val: number, currency: string = selectedCurrency) => {
    const symbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || 'AR$';
    return `${symbol}${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(val)}`;
  };
  
  const periodMonths = period === '1m' ? 1 : period === '3m' ? 3 : period === 'ytd' ? new Date().getMonth() + 1 : 6;
  
  const financialData = useMemo(() => {
    const data = [];
    const today = new Date();
    
    for (let i = periodMonths - 1; i >= 0; i--) {
      const d = subMonths(today, i);
      const monthStart = startOfMonth(d);
      const monthEnd = endOfMonth(d);
      const monthName = format(d, 'MMM', { locale: es });

      const convertTx = (t: any) =>
        convertAmount(normalizeAmountInput(t.amount), pickTxCurrency(t, accountCurrencyMap), selectedCurrency) * codeFactor(t);

      const reportable = buildReportableTxFilter({
        scopeAccountIds: includedAccountIds,
        periodStart: monthStart,
        periodEnd: monthEnd,
        dateField: 'date',
      });
      const monthTx = transactions.filter((t: any) => reportable(t) && passesCodeFilter(t) && t.status === 'completed');

      const monthExpenses = monthTx.filter((t: any) => t.type === 'expense');

      const income = monthTx
        .filter((t: any) => t.type === 'income')
        .reduce((sum: number, t: any) => sum + convertTx(t), 0);

      const expense = monthExpenses
        .reduce((sum: number, t: any) => sum + convertTx(t), 0);

      const costos = monthExpenses
        .filter((t: any) => t.expenseSubtype === 'cost')
        .reduce((sum: number, t: any) => sum + convertTx(t), 0);

      const gastos = monthExpenses
        .filter((t: any) => t.expenseSubtype !== 'cost')
        .reduce((sum: number, t: any) => sum + convertTx(t), 0);

      data.push({
        name: monthName,
        Ingresos: income,
        Egresos: expense,
        Costos: costos,
        Gastos: gastos,
        Neto: income - expense
      });
    }
    return data;
  }, [transactions, selectedCurrency, includedAccountIds, accountCurrencyMap, periodMonths, exchangeRates, passesCodeFilter, codeFactor]);

  handleExportRef.current = async () => {
    const selected = Object.entries(exportSelections).filter(([, v]) => v).map(([k]) => k);
    if (selected.length === 0) {
      toast({ title: 'Seleccioná al menos un tipo de dato para exportar', variant: 'destructive' });
      return;
    }

    setExportLoading(true);

    const typeLabels: Record<string, string> = {
      income: 'Ingreso', expense: 'Egreso', payable: 'Por pagar', receivable: 'Por cobrar',
      transfer_in: 'Transferencia entrada', transfer_out: 'Transferencia salida',
    };
    const statusLabels: Record<string, string> = {
      completed: 'Completada', scheduled: 'Programada', cancelled: 'Cancelada',
    };
    const periodLabel = exportPeriod === '1m' ? 'Último Mes' : exportPeriod === '3m' ? 'Últimos 3 Meses' : exportPeriod === '6m' ? 'Últimos 6 Meses' : 'Año Actual (YTD)';
    const currSymbol = (CURRENCY_SYMBOLS as Record<string, string>)[selectedCurrency] || '$';
    const includedLabel = includedCurrencies.size === availableCurrencies.length 
      ? 'Todas las monedas' 
      : Array.from(includedCurrencies).join('+');
    const tcParts: string[] = [];
    if (exchangeRates) {
      tcParts.push(`TC ${exchangeRates.source}: USD ${exchangeRates.usdToLocal?.toLocaleString('es-AR')}`);
      if (exchangeRates.eurToLocal && exchangeRates.eurToLocal !== 1) {
        tcParts.push(`EUR ${exchangeRates.eurToLocal?.toLocaleString('es-AR')}`);
      }
    }
    const tcLabel = tcParts.length > 0 ? tcParts.join(', ') : '';

    const captureChart = async (ref: React.RefObject<HTMLDivElement | null>): Promise<string | null> => {
      if (!exportIncludeCharts || exportFormat !== 'pdf' || !ref.current) return null;
      try {
        const canvas = await html2canvas(ref.current, { backgroundColor: '#ffffff', scale: 2, useCORS: true, logging: false });
        return canvas.toDataURL('image/png');
      } catch { return null; }
    };

    const buildTableHtml = (data: any[]) => {
      if (data.length === 0) return '';
      const headers = Object.keys(data[0]);
      return `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${data.filter(row => Object.values(row).some(v => v !== '')).map(row => `<tr>${headers.map(h => `<td>${row[h] ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    };

    try {
      const chartImages: Record<string, string | null> = {};
      if (exportFormat === 'pdf' && exportIncludeCharts) {
        const [fin, eco, exp] = await Promise.all([
          captureChart(chartFinancialRef),
          captureChart(chartEconomicRef),
          captureChart(chartExpensesRef),
        ]);
        chartImages.financial = fin;
        chartImages.economic = eco;
        chartImages.expenses = exp;
      }

      const isPdf = exportFormat === 'pdf';
      const fmtCurr = (val: number) => isPdf ? `${currSymbol} ${val.toLocaleString('es-AR')}` : val;
      const fmtMoney = (val: any) => isPdf ? `$ ${parseFloat(val || 0).toLocaleString('es-AR')}` : parseFloat(val || 0);

      interface SectionData { title: string; data: any[]; chartImg?: string | null; extraHtml?: string; }
      const sections: SectionData[] = [];

      for (const key of selected) {
        let data: any[] = [];
        let title = '';
        let chartImg: string | null = null;
        let extraHtml = '';

        switch (key) {
          case 'financiera':
            data = financialData.map(d => ({
              Mes: d.name,
              Ingresos: fmtCurr(d.Ingresos),
              Costos: fmtCurr(d.Costos),
              Gastos: fmtCurr(d.Gastos),
              'Egresos Total': fmtCurr(d.Egresos),
              'Flujo Neto': fmtCurr(d.Neto),
            }));
            title = `Visión Financiera - ${periodLabel} (en ${selectedCurrency}, ${includedLabel})${tcLabel ? ' | ' + tcLabel : ''}`;
            chartImg = chartImages.financial || null;
            break;

          case 'economica':
            data = economicData.map(d => ({
              Mes: d.name,
              Ventas: fmtCurr(d.Ventas),
              Costos: fmtCurr(d.Costos),
              Gastos: fmtCurr(d.Gastos),
              'Margen Bruto': fmtCurr(d['Margen Bruto']),
              Resultado: fmtCurr(d.Resultado),
            }));
            title = `Visión Económica (P&L) - ${periodLabel} (en ${selectedCurrency}, ${includedLabel})${tcLabel ? ' | ' + tcLabel : ''}`;
            chartImg = chartImages.economic || null;
            if (isPdf && expensesByCategory.length > 0) {
              extraHtml = `<h3 style="margin-top:30px;color:#3b82f6;">Gastos por Categoría</h3>
                <table><thead><tr><th>Categoría</th><th>Monto</th></tr></thead><tbody>
                ${expensesByCategory.map(c => `<tr><td>${c.name}</td><td>${currSymbol} ${c.value.toLocaleString('es-AR')}</td></tr>`).join('')}
                </tbody></table>`;
              if (chartImages.expenses) {
                extraHtml += `<div style="margin-top:20px;text-align:center;"><img src="${chartImages.expenses}" style="max-width:100%;height:auto;" /></div>`;
              }
            }
            if (!isPdf && expensesByCategory.length > 0) {
              sections.push({ title, data });
              data = expensesByCategory.map(c => ({ Categoría: c.name, Monto: c.value }));
              title = 'Gastos por Categoría';
            }
            break;

          case 'valoracion': {
            const v = valuationData;
            data = [
              { Concepto: 'Ventas', Valor: isPdf ? v.fmtVal(v.totalRevenue) : v.totalRevenue },
              { Concepto: 'Costos', Valor: isPdf ? v.fmtVal(v.totalCosts) : v.totalCosts },
              { Concepto: 'Gastos Operativos', Valor: isPdf ? v.fmtVal(v.totalGastos) : v.totalGastos },
              { Concepto: 'Margen Bruto', Valor: isPdf ? v.fmtVal(v.margenBruto) : v.margenBruto },
              { Concepto: 'EBITDA (Resultado)', Valor: isPdf ? v.fmtVal(v.ebitda) : v.ebitda },
              { Concepto: '', Valor: '' },
              { Concepto: 'Activos Físicos (Valor Libro)', Valor: isPdf ? v.fmtVal(v.assetsBookValue) : v.assetsBookValue },
              { Concepto: 'Inversiones (Valor Actual)', Valor: isPdf ? v.fmtVal(v.investmentsValue) : v.investmentsValue },
              { Concepto: 'Valoración Total', Valor: isPdf ? v.fmtVal(v.totalValuation) : v.totalValuation },
              { Concepto: '', Valor: '' },
              { Concepto: 'Saldo Operativo', Valor: isPdf ? v.fmtVal(v.operativeBalance) : v.operativeBalance },
              { Concepto: 'Saldo Inversiones', Valor: isPdf ? v.fmtVal(v.investmentBalance) : v.investmentBalance },
              { Concepto: 'Rendimiento Inversiones', Valor: `${v.investmentGainLossPct.toFixed(1)}%` },
            ];
            if (v.hasMultipleCurrencies) {
              data.push(
                { Concepto: '', Valor: '' },
                { Concepto: `TC USD (${v.rateSource})`, Valor: v.usdRate },
              );
            }
            title = `Valoración del Patrimonio (${CURRENCY_LABELS[selectedCurrency] || selectedCurrency})`;
            break;
          }

          case 'transacciones':
            data = transactions.map((t: any) => ({
              Fecha: t.date ? format(getEffectiveTransactionDate(t), 'dd/MM/yyyy') : '-',
              Tipo: typeLabels[t.type] || t.type,
              Descripción: t.description || '-',
              Categoría: t.category || '-',
              Monto: fmtMoney(t.amount),
              Moneda: t.currency || 'ARS',
              Estado: statusLabels[t.status] || t.status,
            }));
            title = 'Transacciones';
            break;

          case 'cuentas':
            data = accounts.map((a: any) => ({
              Nombre: a.name,
              Tipo: FINANCIAL_ACCOUNT_TYPE_CONFIG[a.type as FinancialAccountType]?.label || a.type,
              Categoría: a.accountCategory === 'investment' ? 'Inversión' : 'Operativa',
              Saldo: fmtMoney(a.balance),
              Moneda: a.currency || 'ARS',
            }));
            title = 'Cuentas';
            break;

          case 'clientes':
            data = clients.map((c: any) => ({
              Nombre: c.name || '-',
              Email: c.email || '-',
              Teléfono: c.phone || '-',
              CUIT: c.taxId || '-',
              Dirección: c.address || '-',
            }));
            title = 'Clientes';
            break;

          case 'proveedores':
            data = suppliers.map((s: any) => ({
              Nombre: s.name || '-',
              Email: s.email || '-',
              Teléfono: s.phone || '-',
              CUIT: s.taxId || '-',
            }));
            title = 'Proveedores';
            break;

          case 'productos':
            data = products.map((p: any) => ({
              Nombre: p.name || '-',
              SKU: p.sku || '-',
              'Precio Venta': fmtMoney(p.salePrice),
              Stock: p.stock ?? '-',
              Unidad: p.unit || '-',
            }));
            title = 'Productos';
            break;
        }

        if (data.length > 0) {
          sections.push({ title, data, chartImg, extraHtml });
        }
      }

      if (sections.length === 0) {
        toast({ title: 'No hay datos para exportar', variant: 'destructive' });
        setExportLoading(false);
        return;
      }

      if (exportFormat === 'csv') {
        const csvParts: string[] = [];
        for (const section of sections) {
          const headers = Object.keys(section.data[0]);
          csvParts.push(`"--- ${section.title} ---"`);
          csvParts.push(headers.map(h => `"${h.replace(/"/g, '""')}"`).join(','));
          section.data.forEach(row => {
            csvParts.push(headers.map(h => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(','));
          });
          csvParts.push('');
        }
        const blob = new Blob(['\uFEFF' + csvParts.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `aikestar_reporte_${format(new Date(), 'yyyy-MM-dd')}.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
      } else {
        const dateStr = format(new Date(), "d 'de' MMMM 'de' yyyy", { locale: es });
        let bodyHtml = '';
        sections.forEach((section, idx) => {
          if (idx > 0) bodyHtml += '<div class="page-break"></div>';
          bodyHtml += `<h2>${section.title}</h2>`;
          if (section.chartImg) {
            bodyHtml += `<div class="chart-img"><img src="${section.chartImg}" /></div>`;
          }
          bodyHtml += buildTableHtml(section.data);
          if (section.extraHtml) bodyHtml += section.extraHtml;
        });

        const win = window.open('', '_blank');
        if (!win) {
          toast({ title: 'El navegador bloqueó la ventana de impresión. Permití las ventanas emergentes e intentá de nuevo.', variant: 'destructive' });
          setExportLoading(false);
          return;
        }
        win.document.write(`<!DOCTYPE html><html><head><title>Reporte Aikestar - ${dateStr}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; color: #333; }
            h1 { color: #00D4FF; margin-bottom: 4px; font-size: 28px; }
            h2 { color: #0ea5e9; margin-top: 40px; margin-bottom: 8px; font-size: 20px; border-bottom: 2px solid #e5e7eb; padding-bottom: 6px; }
            h2:first-of-type { margin-top: 20px; }
            h3 { color: #3b82f6; margin-top: 24px; }
            .date { color: #666; margin-bottom: 30px; font-size: 14px; }
            table { width: 100%; border-collapse: collapse; margin-top: 12px; margin-bottom: 20px; font-size: 13px; }
            th, td { border: 1px solid #ddd; padding: 10px 12px; text-align: left; }
            th { background: #f5f5f5; font-weight: bold; }
            tr:nth-child(even) { background: #fafafa; }
            .footer { margin-top: 50px; font-size: 11px; color: #999; text-align: center; border-top: 1px solid #e5e7eb; padding-top: 12px; }
            .chart-img { margin: 16px 0; text-align: center; }
            .chart-img img { max-width: 100%; height: auto; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
            .page-break { page-break-before: always; margin-top: 0; }
            @media print { .page-break { page-break-before: always; } }
          </style></head><body>
          <h1>Reporte Aikestar</h1>
          <p class="date">Generado: ${dateStr}</p>
          ${bodyHtml}
          <p class="footer">Aikestar - Sistema de Gestión Administrativa</p>
        </body></html>`);
        win.document.close();
        setTimeout(() => win.print(), 300);
      }

      setExportDialogOpen(false);
      toast({ title: `Exportación completada (${exportFormat === 'csv' ? 'Excel' : 'PDF'})` });
    } catch (err) {
      console.error('[Export] Error:', err);
      toast({ title: 'Error al exportar', variant: 'destructive' });
    } finally {
      setExportLoading(false);
    }
  };

  const economicData = useMemo(() => {
    const data = [];
    const today = new Date();

    const convertTx = (t: any) =>
      convertAmount(normalizeAmountInput(t.amount), pickTxCurrency(t, accountCurrencyMap), selectedCurrency) * codeFactor(t);

    for (let i = periodMonths - 1; i >= 0; i--) {
      const d = subMonths(today, i);
      const monthStart = startOfMonth(d);
      const monthEnd = endOfMonth(d);
      const monthName = format(d, 'MMM', { locale: es });

      const reportable = buildReportableTxFilter({
        scopeAccountIds: includedAccountIds,
        periodStart: monthStart,
        periodEnd: monthEnd,
        dateField: 'imputationDate',
      });
      const monthTx = transactions.filter((t: any) => reportable(t) && passesCodeFilter(t));

      const income = monthTx
        .filter((t: any) => t.type === 'income' || t.type === 'receivable')
        .reduce((sum: number, t: any) => sum + convertTx(t), 0);

      const costs = monthTx
        .filter((t: any) => (t.type === 'expense' || t.type === 'payable') && t.expenseSubtype === 'cost')
        .reduce((sum: number, t: any) => sum + convertTx(t), 0);

      const gastos = monthTx
        .filter((t: any) => (t.type === 'expense' || t.type === 'payable') && t.expenseSubtype !== 'cost')
        .reduce((sum: number, t: any) => sum + convertTx(t), 0);

      const grossMargin = income - costs;

      data.push({
        name: monthName,
        Ventas: income,
        Costos: costs,
        Gastos: gastos,
        'Margen Bruto': grossMargin,
        Resultado: income - costs - gastos
      });
    }
    return data;
  }, [transactions, selectedCurrency, includedAccountIds, accountCurrencyMap, periodMonths, exchangeRates, passesCodeFilter, codeFactor]);

  const profitabilityByCode = useMemo(() => {
    const reportable = buildReportableTxFilter({ scopeAccountIds: includedAccountIds });
    const codeMap = new Map<string, { id: string | null; code: string; name: string; color: string | null; income: number; costs: number; gastos: number }>();
    const SIN_CODIGO_KEY = '__no_code__';
    // Pre-seed "Sin código" only when filter is "all" so users see it consistently
    const includeSinCodigo = selectedProfitabilityCodeId === 'all';
    // Suma una contribución (income/cost/gasto) a la entrada del código dado.
    const addContribution = (codeId: string | null, amount: number, t: Transaction) => {
      let entry: { id: string | null; code: string; name: string; color: string | null; income: number; costs: number; gastos: number } | undefined;
      if (!codeId) {
        if (!includeSinCodigo) return;
        entry = codeMap.get(SIN_CODIGO_KEY);
        if (!entry) {
          entry = { id: null, code: '—', name: 'Sin código', color: null, income: 0, costs: 0, gastos: 0 };
          codeMap.set(SIN_CODIGO_KEY, entry);
        }
      } else {
        const meta = profitabilityCodes.find((c) => c.id === codeId);
        if (!meta) return;
        entry = codeMap.get(codeId);
        if (!entry) {
          entry = { id: meta.id, code: meta.code, name: meta.name, color: meta.color, income: 0, costs: 0, gastos: 0 };
          codeMap.set(codeId, entry);
        }
      }
      if (t.type === 'income' || t.type === 'receivable') {
        entry.income += amount;
      } else if (t.type === 'expense' || t.type === 'payable') {
        if (t.expenseSubtype === 'cost') entry.costs += amount;
        else entry.gastos += amount;
      }
    };

    transactions.forEach((t: Transaction) => {
      if (!reportable(t)) return;
      if (t.type !== 'income' && t.type !== 'receivable' && t.type !== 'expense' && t.type !== 'payable') return;
      // Apply combined code + member filter so totals match the global filters
      // (Task #202 — el filtro Miembro debe recalcular toda la página, incluida
      // la tabla "Rentabilidad por código").
      if (!passesCodeFilter(t)) return;
      const converted = convertAmount(normalizeAmountInput(t.amount), pickTxCurrency(t, accountCurrencyMap), selectedCurrency);

      // Task #475: las tx multi-producto distribuyen el monto entre los códigos
      // de cada renglón, proporcional al subtotal (cantidad × precio) de cada
      // uno. Las tx de un solo producto usan el código legacy de la tx.
      const items = (t as any).items as Array<{ quantity: string; unitPrice: string; profitabilityCodeId: string | null }> | undefined;
      if (items && items.length > 0) {
        const lineTotals = items.map((it) => {
          const q = parseFloat(it.quantity || '0') || 0;
          const u = parseFloat(it.unitPrice || '0') || 0;
          return q * u;
        });
        const sumLines = lineTotals.reduce((s, v) => s + v, 0);
        items.forEach((it, idx) => {
          // Si hay filtro de código activo, sólo cuenta el renglón coincidente.
          if (selectedProfitabilityCodeId !== 'all' && it.profitabilityCodeId !== selectedProfitabilityCodeId) return;
          const portion = sumLines > 0 ? (lineTotals[idx] / sumLines) : (1 / items.length);
          addContribution(it.profitabilityCodeId ?? null, converted * portion, t);
        });
      } else {
        addContribution(t.profitabilityCodeId ?? null, converted, t);
      }
    });
    return Array.from(codeMap.values()).sort((a, b) => (b.income - b.costs - b.gastos) - (a.income - a.costs - a.gastos));
  }, [transactions, profitabilityCodes, selectedCurrency, includedAccountIds, accountCurrencyMap, exchangeRates, selectedProfitabilityCodeId, passesCodeFilter]);

  const expensesByCategory = useMemo(() => {
    const categories: Record<string, number> = {};

    const reportable = buildReportableTxFilter({ scopeAccountIds: includedAccountIds });
    transactions
      .filter((t: any) => reportable(t) && passesCodeFilter(t) && (t.type === 'expense' || t.type === 'payable'))
      .forEach((t: any) => {
        const converted = convertAmount(normalizeAmountInput(t.amount), pickTxCurrency(t, accountCurrencyMap), selectedCurrency) * codeFactor(t);
        categories[t.category] = (categories[t.category] || 0) + converted;
      });

    return Object.entries(categories)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [transactions, selectedCurrency, includedAccountIds, accountCurrencyMap, exchangeRates, passesCodeFilter, codeFactor]);

  const annualRevenue = useMemo(() => {
    const reportable = buildReportableTxFilter({ scopeAccountIds: includedAccountIds });
    return transactions
      .filter((t: any) => reportable(t) && passesCodeFilter(t) && t.type === 'income')
      .reduce((sum: number, t: any) =>
        sum + convertAmount(normalizeAmountInput(t.amount), pickTxCurrency(t, accountCurrencyMap), selectedCurrency) * codeFactor(t),
      0);
  }, [transactions, selectedCurrency, includedAccountIds, accountCurrencyMap, exchangeRates, passesCodeFilter, codeFactor]);
  
  // Multi-currency valuation calculation (converts all to selectedCurrency)
  const valuationData = useMemo(() => {
    const hasRates = !!exchangeRates?.usdToLocal;
    const usdRate = exchangeRates?.usdToLocal || 1050;
    const eurRate = exchangeRates?.eurToLocal || 1150;
    const rateSource = hasRates ? (exchangeRates?.source || 'DolarApi') : 'estimado';
    const rateTimestamp = exchangeRates?.timestamp;
    const displayCurrency = selectedCurrency;
    const cvt = (amount: number, fromCurrency: string) => convertAmount(amount, fromCurrency, displayCurrency);
    
    const includedAccounts = accounts.filter((acc: any) => includedAccountIds.includes(acc.id));

    // Apply the same exclusion rules used by the rest of Reports/Calendar:
    // skip cancelled originals, [CANCELACIÓN] mirror entries, and internal
    // transfers. Currency precedence: tx.currency wins over account.currency
    // (Task #170 — keep Valoración consistent with the cards above).
    const reportable = buildReportableTxFilter({ scopeAccountIds: includedAccountIds });
    const revenueByCurrency: Record<string, number> = {};
    const expensesByCurrency: Record<string, number> = {};
    const costsByCurrency: Record<string, number> = {};
    const gastosByCurrency: Record<string, number> = {};
    transactions.forEach((t: any) => {
      if (!reportable(t)) return;
      if (!passesCodeFilter(t)) return;
      const cur = pickTxCurrency(t, accountCurrencyMap);
      const amt = normalizeAmountInput(t.amount) * codeFactor(t);
      if (t.type === 'income') {
        revenueByCurrency[cur] = (revenueByCurrency[cur] || 0) + amt;
        return;
      }
      if (t.type === 'expense' && t.assetType !== 'asset_acquisition' && t.assetType !== 'investment') {
        expensesByCurrency[cur] = (expensesByCurrency[cur] || 0) + amt;
        if (t.expenseSubtype === 'cost') {
          costsByCurrency[cur] = (costsByCurrency[cur] || 0) + amt;
        } else {
          gastosByCurrency[cur] = (gastosByCurrency[cur] || 0) + amt;
        }
      }
    });
    
    let totalRevenue = 0;
    let totalExpenses = 0;
    let totalCosts = 0;
    let totalGastos = 0;
    for (const [cur, amt] of Object.entries(revenueByCurrency)) totalRevenue += cvt(amt, cur);
    for (const [cur, amt] of Object.entries(expensesByCurrency)) totalExpenses += cvt(amt, cur);
    for (const [cur, amt] of Object.entries(costsByCurrency)) totalCosts += cvt(amt, cur);
    for (const [cur, amt] of Object.entries(gastosByCurrency)) totalGastos += cvt(amt, cur);
    
    const margenBruto = totalRevenue - totalCosts;
    const ebitda = totalRevenue - totalExpenses;
    
    const assetsTableValue = (assets || []).reduce((sum: number, asset: any) => {
      const acquisitionValue = parseFloat(asset.acquisitionValue?.toString() || '0');
      const depreciation = parseFloat(asset.accumulatedDepreciation?.toString() || '0');
      const bookValue = Math.max(0, acquisitionValue - depreciation);
      return sum + cvt(bookValue, asset.currency || 'ARS');
    }, 0);

    const productAssetsValue = (products || []).filter((p: any) => p.productType === 'asset' && p.isActive !== false).reduce((sum: number, p: any) => {
      const value = parseFloat(p.currentValue?.toString() || '0') || parseFloat(p.costPrice?.toString() || '0');
      return sum + cvt(value, p.costCurrency || 'ARS');
    }, 0);

    // Inventario al costo: productos con stock × costPrice (decisión de
    // producto — no usar precio de venta para no inflar la valoración
    // con margen no realizado). Sólo productType === 'product' activos.
    const productInventoryValue = (products || []).filter((p: any) => p.productType === 'product' && p.isActive !== false).reduce((sum: number, p: any) => {
      const stock = parseFloat(p.stock?.toString() || '0') || 0;
      const cost = parseFloat(p.costPrice?.toString() || '0') || 0;
      if (stock <= 0 || cost <= 0) return sum;
      return sum + cvt(stock * cost, p.costCurrency || 'ARS');
    }, 0);

    const assetsBookValue = assetsTableValue + productAssetsValue + productInventoryValue;
    
    const investmentsValue = (investments || []).reduce((sum: number, inv: any) => {
      const quantity = parseFloat(inv.quantity?.toString() || '0');
      const currentPrice = parseFloat(inv.currentPrice?.toString() || '0');
      const totalCost = parseFloat(inv.totalCost?.toString() || '0');
      const currentValue = currentPrice > 0 ? quantity * currentPrice : totalCost;
      return sum + cvt(currentValue, inv.currency || 'ARS');
    }, 0);
    
    const operativeBalance = includedAccounts.filter((acc: any) => {
      return !acc.accountCategory || acc.accountCategory === 'operative';
    }).reduce((sum: number, acc: any) => {
      const bal = parseFloat(acc.balance?.toString() || '0');
      return sum + cvt(bal, acc.currency || 'ARS');
    }, 0);

    const investmentBalance = includedAccounts.filter((acc: any) => {
      return acc.accountCategory === 'investment';
    }).reduce((sum: number, acc: any) => {
      const accrued = calculateAccruedInterest(acc);
      const bal = accrued > 0 ? parseFloat(acc.initialInvestment || '0') + accrued : parseFloat(acc.balance?.toString() || '0');
      return sum + cvt(bal, acc.currency || 'ARS');
    }, 0);

    const investmentInitial = includedAccounts.filter((acc: any) => {
      return acc.accountCategory === 'investment' && acc.initialInvestment;
    }).reduce((sum: number, acc: any) => {
      const inv = parseFloat(acc.initialInvestment?.toString() || '0');
      return sum + cvt(inv, acc.currency || 'ARS');
    }, 0);

    const investmentGainLoss = investmentBalance - investmentInitial;
    const investmentGainLossPct = investmentInitial > 0 ? ((investmentGainLoss / investmentInitial) * 100) : 0;

    const totalInvestmentsValue = investmentsValue + investmentBalance;
    const totalValuation = ebitda + assetsBookValue + totalInvestmentsValue;
    
    const symbol = CURRENCY_SYMBOLS[displayCurrency as keyof typeof CURRENCY_SYMBOLS] || 'AR$';
    const fmtVal = (v: number) => `${symbol}${new Intl.NumberFormat('es-AR').format(v)}`;
    const fmtValCompact = (v: number) => `${symbol}${new Intl.NumberFormat('es-AR', { notation: 'compact', maximumFractionDigits: 1 }).format(v)}`;
    
    const hasMultipleCurrencies = Object.keys(revenueByCurrency).length > 1 || 
      Object.keys(expensesByCurrency).length > 1 ||
      accounts.some((a: any) => (a.currency || 'ARS') !== 'ARS');
    
    return {
      totalRevenue,
      totalExpenses,
      totalCosts,
      totalGastos,
      margenBruto,
      ebitda,
      assetsBookValue,
      investmentsValue: totalInvestmentsValue,
      totalValuation,
      operativeBalance,
      investmentBalance,
      investmentInitial,
      investmentGainLoss,
      investmentGainLossPct,
      usdRate,
      eurRate,
      rateSource,
      rateTimestamp,
      hasRates,
      hasMultipleCurrencies,
      fmtVal,
      fmtValCompact,
      displayCurrency,
    };
  }, [transactions, accounts, exchangeRates, assets, investments, products, selectedCurrency, includedAccountIds, accountCurrencyMap, passesCodeFilter, selectedProfitabilityCodeId, codeFactor]);
  
  const valuation = annualRevenue * 4;

  // Aikestar brand colors
  const COLORS = ['#00D4FF', '#FF3366', '#10b981', '#f59e0b', '#8b5cf6'];
  const CATEGORY_COLORS = ['#00D4FF', '#FF3366', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#6366f1'];

  const formatCurrency = (val: number) => formatCurrencyValue(val, selectedCurrency);

  interface DrillDownState {
    open: boolean;
    title: string;
    formula?: string;
    formulaLines?: { label: string; value: string; isResult?: boolean; sign?: '+' | '-' | '=' }[];
    transactions?: Transaction[];
    groups?: { label: string; color: string; transactions: Transaction[] }[];
    genericItems?: GenericDrillDownItem[];
    genericItemsLabel?: string;
    totalLabel?: string;
    totalValue?: number;
    totalFormatted?: string;
  }

  const [drillDown, setDrillDown] = useState<DrillDownState>({ open: false, title: '' });

  const closeDrillDown = useCallback(() => setDrillDown(prev => ({ ...prev, open: false })), []);

  const getAccountCurrency = useCallback((accountId: string | null) => {
    if (!accountId) return 'ARS';
    return accountCurrencyMap[accountId] || 'ARS';
  }, [accountCurrencyMap]);

  const convertToSelected = useCallback((amount: number, fromCurrency: string) => {
    return convertAmount(amount, fromCurrency, selectedCurrency);
  }, [selectedCurrency, exchangeRates]);

  const periodStart = useMemo(() => startOfMonth(subMonths(new Date(), periodMonths - 1)), [periodMonths]);
  const periodEnd = useMemo(() => endOfMonth(new Date()), []);

  // Task #200 — both helpers now delegate to the shared selectors in
  // `reports.rowSelectors.ts` so the Económico / Flujo / Burn Rate handlers
  // share the same single source of truth as the Valoración handlers
  // (Task #199). The lint test in tests/reportsRowSelectorsLint.test.ts
  // asserts these wrappers stay thin (no inline `transactions.filter` /
  // `buildReportableTxFilter`) so a future refactor can't silently drift.
  const getIncludedTxByType = useCallback((type: string | string[], dateField: 'date' | 'imputationDate' = 'date', includePayableReceivable = false) => {
    return selectIncludedTxByType(transactions as Transaction[], {
      scopeAccountIds: includedAccountIds,
      passesCodeFilter,
    }, {
      types: type,
      periodStart,
      periodEnd,
      dateField,
      includePayableReceivable,
    });
  }, [transactions, includedAccountIds, periodStart, periodEnd, passesCodeFilter]);

  const getMonthTransactions = useCallback((monthName: string, dateField: 'date' | 'imputationDate' = 'date') => {
    const today = new Date();
    for (let i = periodMonths - 1; i >= 0; i--) {
      const d = subMonths(today, i);
      const mn = format(d, 'MMM', { locale: es });
      if (mn === monthName) {
        return selectMonthRows(transactions as Transaction[], {
          scopeAccountIds: includedAccountIds,
          passesCodeFilter,
        }, {
          monthStart: startOfMonth(d),
          monthEnd: endOfMonth(d),
          dateField,
        });
      }
    }
    return [] as Transaction[];
  }, [transactions, includedAccountIds, periodMonths, passesCodeFilter]);

  const handleFinancialBarClick = useCallback((data: any) => {
    if (!data?.activeLabel) return;
    const monthName = data.activeLabel;
    const monthTx = getMonthTransactions(monthName, 'date');
    setDrillDown(buildFinancialBarDrillDown({
      monthName,
      monthTx,
      helpers: { convertToSelected, getAccountCurrency, formatCurrencyFull, codeAmountFactor: codeFactor },
    }));
  }, [getMonthTransactions, convertToSelected, getAccountCurrency, codeFactor]);

  const handlePieClick = useCallback((_: any, index: number) => {
    const category = expensesByCategory[index];
    if (!category) return;
    // Use the shared row selector so the modal row list matches the
    // expensesByCategory aggregation byte-for-byte.
    const categoryTx = selectCategoryRows(
      transactions,
      { scopeAccountIds: includedAccountIds, passesCodeFilter },
      category.name,
    );
    // Card top equals the converted sum already computed in expensesByCategory.
    // Pass it to the builder so the modal footer can never drift.
    setDrillDown(buildExpenseCategoryDrillDown({
      categoryName: category.name,
      categoryTx,
      totalValue: category.value,
      formatCurrencyFull,
    }));
  }, [transactions, includedAccountIds, expensesByCategory, passesCodeFilter]);

  const handleEconomicChartClick = useCallback((data: any) => {
    if (!data?.activeLabel) return;
    const monthName = data.activeLabel;
    const monthTx = getMonthTransactions(monthName, 'imputationDate');
    setDrillDown(buildEconomicChartDrillDown({
      monthName,
      monthTx,
      helpers: { convertToSelected, getAccountCurrency, formatCurrencyFull, codeAmountFactor: codeFactor },
    }));
  }, [getMonthTransactions, convertToSelected, getAccountCurrency, codeFactor]);

  // Loading state (after all hooks)
  if (transactionsLoading || accountsLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-lg text-muted-foreground">Cargando reportes...</div>
      </div>
    );
  }

  return (
    <>
      <div className="min-w-0 w-full overflow-hidden">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between mb-8 gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold font-display">Reportes e Informes</h1>
          <p className="text-sm sm:text-base text-muted-foreground">Análisis profundo de la salud de tu negocio.</p>
        </div>
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 w-full sm:w-auto items-end">
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider pl-1">Ver en</span>
            <Select value={selectedCurrency} onValueChange={setSelectedCurrency}>
              <SelectTrigger className="w-full sm:w-[180px]" data-testid="select-currency">
                <Wallet className="mr-2 h-4 w-4 shrink-0" />
                <SelectValue placeholder="Ver en..." />
              </SelectTrigger>
              <SelectContent>
                {availableCurrencies.length > 0 ? (
                  availableCurrencies.map(currency => (
                    <SelectItem key={currency} value={currency}>
                      {CURRENCY_LABELS[currency] || currency}
                    </SelectItem>
                  ))
                ) : (
                  <SelectItem value="ARS">Pesos (ARS)</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          {availableCurrencies.length > 1 && (
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider pl-1">Incluir</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="w-full sm:w-auto gap-1.5" data-testid="button-filter-currencies">
                    <DollarSign className="h-4 w-4" />
                    <span className="text-xs">{includedCurrencies.size === availableCurrencies.length ? 'Todas' : `${includedCurrencies.size} moneda(s)`}</span>
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="p-2 min-w-[200px]">
                  <p className="text-xs font-semibold text-muted-foreground px-2 pb-2">Incluir monedas en el cálculo:</p>
                  {availableCurrencies.map(currency => (
                    <label key={currency} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer" data-testid={`filter-currency-${currency}`}>
                      <Checkbox 
                        checked={includedCurrencies.has(currency)} 
                        onCheckedChange={() => toggleIncludedCurrency(currency)}
                      />
                      <span className="text-sm">{CURRENCY_LABELS[currency] || currency}</span>
                    </label>
                  ))}
                  {exchangeRates && (
                    <div className="border-t mt-2 pt-2 px-2">
                      <p className="text-[10px] text-muted-foreground">TC {exchangeRates.source}: USD {exchangeRates.usdToLocal?.toLocaleString('es-AR')}</p>
                    </div>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-full sm:w-[170px]">
              <Calendar className="mr-2 h-4 w-4 shrink-0" />
              <span className="truncate">{period === '1m' ? '1 Mes' : period === '3m' ? '3 Meses' : period === '6m' ? '6 Meses' : 'YTD'}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1m">Último Mes</SelectItem>
              <SelectItem value="3m">Últimos 3 Meses</SelectItem>
              <SelectItem value="6m">Últimos 6 Meses</SelectItem>
              <SelectItem value="ytd">Año Actual (YTD)</SelectItem>
            </SelectContent>
          </Select>
          {profitabilityCodes.length > 0 && (
            <Select value={selectedProfitabilityCodeId} onValueChange={setSelectedProfitabilityCodeId}>
              <SelectTrigger className="w-full sm:w-[200px]" data-testid="filter-profitability-code">
                <span className="truncate">
                  {selectedProfitabilityCodeId === 'all'
                    ? 'Todos los códigos'
                    : (profitabilityCodes.find((c) => c.id === selectedProfitabilityCodeId)?.code || 'Código')}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los códigos</SelectItem>
                {profitabilityCodes.filter((c) => c.isActive).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <span className="flex items-center gap-2">
                      {c.color && <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: c.color }} />}
                      <span className="font-mono text-xs">{c.code}</span>
                      <span>· {c.name}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {availableCategoryItems.length > 0 && (
            <div className="w-full sm:w-[220px]">
              <CategoryPicker
                selectedValues={selectedCategories}
                onValuesChange={setSelectedCategories}
                categories={availableCategoryItems}
                allowInlineCreate={false}
                placeholder="Todas las categorías"
                testId="filter-category"
              />
            </div>
          )}
          {members.length > 1 && (() => {
            // "Sin asignar" sólo aparece como opción del filtro si hay
            // movimientos huérfanos (createdBy null) reportables EN EL
            // PERÍODO + CÓDIGO DE RENTABILIDAD ACTIVOS. Así nunca se
            // ofrece una opción que devolvería 0 resultados al activarse.
            // No incluimos selectedMemberId acá porque la pregunta es
            // "¿tiene sentido mostrar esta opción del propio filtro?"
            // y filtrar por miembro la haría auto-referencial.
            const hasOrphanMovements = transactions.some((t: any) => {
              if (t.createdBy != null) return false;
              if (t.type === 'transfer_in' || t.type === 'transfer_out') return false;
              if (t.status === 'cancelled') return false;
              if ((t.description || '').startsWith('[CANCELACIÓN]')) return false;
              if (selectedProfitabilityCodeId !== 'all' && t.profitabilityCodeId !== selectedProfitabilityCodeId) return false;
              const ref = t.imputationDate || t.date;
              if (!ref) return false;
              const d = new Date(ref);
              if (Number.isNaN(d.getTime())) return false;
              return d >= periodStart && d <= periodEnd;
            });
            return (
              <Select value={selectedMemberId} onValueChange={setSelectedMemberId}>
                <SelectTrigger className="w-full sm:w-[200px]" data-testid="filter-member">
                  <Users className="mr-2 h-4 w-4 shrink-0" />
                  <span className="truncate">
                    {selectedMemberId === 'all'
                      ? 'Todos los miembros'
                      : selectedMemberId === 'unassigned'
                        ? 'Sin asignar'
                        : (members.find((m) => m.userId === selectedMemberId)?.name
                            || members.find((m) => m.userId === selectedMemberId)?.email
                            || 'Miembro')}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" data-testid="filter-member-all">Todos los miembros</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.userId} value={m.userId} data-testid={`filter-member-${m.userId}`}>
                      <span className="truncate">{m.name || m.email}</span>
                    </SelectItem>
                  ))}
                  {hasOrphanMovements && (
                    <SelectItem value="unassigned" data-testid="filter-member-unassigned">Sin asignar</SelectItem>
                  )}
                </SelectContent>
              </Select>
            );
          })()}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="col-span-2 sm:col-span-1" data-testid="button-export">
                <Download className="mr-2 h-4 w-4" /> Exportar
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleOpenExportDialog('csv')} data-testid="export-excel">
                <FileSpreadsheet className="mr-2 h-4 w-4" /> Excel (CSV)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleOpenExportDialog('pdf')} data-testid="export-pdf">
                <FileText className="mr-2 h-4 w-4" /> PDF (Imprimir)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {includedCurrencies.size > 1 && availableCurrencies.length > 1 && exchangeRates && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground bg-blue-50/60 border border-blue-100 rounded-lg px-3 py-2" data-testid="exchange-rate-banner">
          <span>💱</span>
          <span>Montos convertidos a <strong>{CURRENCY_LABELS[selectedCurrency] || selectedCurrency}</strong></span>
          <span className="text-blue-500">|</span>
          <span>TC {exchangeRates.source}{exchangeRates.source === 'default' || exchangeRates.source === 'fallback' ? ' (estimado)' : ''}: 1 USD = AR${exchangeRates.usdToLocal?.toLocaleString('es-AR')}</span>
          {exchangeRates.eurToLocal && exchangeRates.eurToLocal !== 1 && (
            <>
              <span className="text-blue-500">|</span>
              <span>1 EUR = AR${exchangeRates.eurToLocal?.toLocaleString('es-AR')}</span>
            </>
          )}
        </div>
      )}

      <Tabs defaultValue="financial" className="space-y-4 min-w-0">
        <TabsList className="bg-slate-100 dark:bg-slate-800 p-1.5 rounded-xl gap-1.5 sm:gap-2 w-full flex flex-wrap h-auto">
          <TabsTrigger 
            value="financial" 
            className="flex-1 min-w-0 px-2 sm:px-4 py-2 sm:py-2.5 rounded-lg font-medium text-[11px] sm:text-sm transition-all data-[state=inactive]:bg-[#00D4FF]/10 data-[state=inactive]:text-[#00D4FF] data-[state=inactive]:hover:bg-[#00D4FF]/20 data-[state=active]:bg-gradient-to-r data-[state=active]:from-[#00D4FF] data-[state=active]:to-[#FF3366] data-[state=active]:text-white data-[state=active]:shadow-md"
          >
            💰 <span className="hidden xs:inline">Visión </span>Financiera
          </TabsTrigger>
          <TabsTrigger 
            value="economic" 
            className="flex-1 min-w-0 px-2 sm:px-4 py-2 sm:py-2.5 rounded-lg font-medium text-[11px] sm:text-sm transition-all data-[state=inactive]:bg-[#00D4FF]/10 data-[state=inactive]:text-[#00D4FF] data-[state=inactive]:hover:bg-[#00D4FF]/20 data-[state=active]:bg-gradient-to-r data-[state=active]:from-[#00D4FF] data-[state=active]:to-[#FF3366] data-[state=active]:text-white data-[state=active]:shadow-md"
          >
            📊 <span className="hidden xs:inline">Visión </span>Económica
          </TabsTrigger>
          <TabsTrigger 
            value="valuation" 
            className="flex-1 min-w-0 px-2 sm:px-4 py-2 sm:py-2.5 rounded-lg font-medium text-[11px] sm:text-sm transition-all data-[state=inactive]:bg-[#00D4FF]/10 data-[state=inactive]:text-[#00D4FF] data-[state=inactive]:hover:bg-[#00D4FF]/20 data-[state=active]:bg-gradient-to-r data-[state=active]:from-[#00D4FF] data-[state=active]:to-[#FF3366] data-[state=active]:text-white data-[state=active]:shadow-md"
          >
            🏢 Valoración
          </TabsTrigger>
          <TabsTrigger 
            value="ai-report" 
            className="flex-1 min-w-0 px-2 sm:px-4 py-2 sm:py-2.5 rounded-lg font-medium text-[11px] sm:text-sm transition-all data-[state=inactive]:bg-[#00D4FF]/10 data-[state=inactive]:text-[#00D4FF] data-[state=inactive]:hover:bg-[#00D4FF]/20 data-[state=active]:bg-gradient-to-r data-[state=active]:from-[#00D4FF] data-[state=active]:to-[#FF3366] data-[state=active]:text-white data-[state=active]:shadow-md"
            data-testid="tab-ai-report"
          >
            <Sparkles className="h-3.5 w-3.5 mr-1" /> Reporte IA
          </TabsTrigger>
          {showConsolidated && (
            <TabsTrigger
              value="consolidated"
              className="flex-1 min-w-0 px-2 sm:px-4 py-2 sm:py-2.5 rounded-lg font-medium text-[11px] sm:text-sm transition-all data-[state=inactive]:bg-[#00D4FF]/10 data-[state=inactive]:text-[#00D4FF] data-[state=inactive]:hover:bg-[#00D4FF]/20 data-[state=active]:bg-gradient-to-r data-[state=active]:from-[#00D4FF] data-[state=active]:to-[#FF3366] data-[state=active]:text-white data-[state=active]:shadow-md"
              data-testid="tab-consolidated"
            >
              <Building2 className="h-3.5 w-3.5 mr-1" /> Consolidado
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="financial" className="space-y-4 min-w-0">
          <div className={`grid grid-cols-1 sm:grid-cols-2 ${hasInvestmentAccounts ? 'lg:grid-cols-4' : 'lg:grid-cols-3'} gap-4`}>
            <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
              const opAccounts = accounts.filter((acc: any) => (!acc.accountCategory || acc.accountCategory === 'operative') && includedAccountIds.includes(acc.id));
              const items: GenericDrillDownItem[] = opAccounts.map((acc: any) => ({
                id: acc.id,
                label: acc.name,
                sublabel: acc.currency || 'ARS',
                amount: formatCurrencyFull(convertToSelected(normalizeAmountInput(acc.balance), acc.currency || 'ARS')),
                badge: acc.accountType,
              }));
              setDrillDown(buildOperativeAvailabilityDrillDown({
                items,
                totalValue: hasInvestmentAccounts ? getConvertedOperativeBalance() : getConvertedTotalBalance(),
                formatCurrencyFull,
              }));
            }} data-testid="card-financial-operative">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Disponibilidad Operativa</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-primary cursor-default" title={formatCurrencyFull(hasInvestmentAccounts ? getConvertedOperativeBalance() : getConvertedTotalBalance())}>{formatCurrency(hasInvestmentAccounts ? getConvertedOperativeBalance() : getConvertedTotalBalance())}</div>
                <p className="text-xs text-muted-foreground mt-1">Cuentas operativas ({CURRENCY_LABELS[selectedCurrency] || selectedCurrency}){includedCurrencies.size < availableCurrencies.length ? ' *' : ''}</p>
              </CardContent>
            </Card>
            {hasInvestmentAccounts && (() => {
              const invBalance = getConvertedInvestmentBalance();
              const invInitial = getConvertedInvestmentInitial();
              const invGainLoss = invBalance - invInitial;
              const invRendPct = invInitial > 0 ? (invGainLoss / invInitial) * 100 : 0;
              return (
                <Card className="border-violet-200 dark:border-violet-900/50 bg-violet-50/30 dark:bg-violet-950/20 cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
                  const invAccounts = accounts.filter((acc: any) => acc.accountCategory === 'investment' && includedAccountIds.includes(acc.id));
                  const items: GenericDrillDownItem[] = invAccounts.map((acc: any) => ({
                    id: acc.id, label: acc.name, sublabel: acc.currency || 'ARS',
                    amount: formatCurrencyFull(convertToSelected(normalizeAmountInput(acc.balance), acc.currency || 'ARS')),
                    badge: 'inversión',
                  }));
                  setDrillDown(buildFinancialInvestmentsDrillDown({
                    items,
                    totalValue: invBalance,
                    formatCurrencyFull,
                  }));
                }} data-testid="card-inversiones-financiera">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-violet-600 dark:text-violet-300 flex items-center gap-1.5">
                      <TrendingUp className="h-3.5 w-3.5" />
                      Inversiones
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold text-violet-700 dark:text-violet-200 cursor-default" title={formatCurrencyFull(invBalance)}>{formatCurrency(invBalance)}</div>
                    {invInitial > 0 ? (
                      <p className={`text-xs font-medium mt-1 ${invGainLoss >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        Rend: {invGainLoss >= 0 ? '+' : ''}{invRendPct.toFixed(1)}% ({invGainLoss >= 0 ? '+' : ''}{formatCurrency(invGainLoss)})
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground mt-1">Cuentas de inversión ({CURRENCY_LABELS[selectedCurrency] || selectedCurrency})</p>
                    )}
                  </CardContent>
                </Card>
              );
            })()}
            <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
              const lastMonth = financialData[financialData.length-1];
              if (lastMonth) handleFinancialBarClick({ activeLabel: lastMonth.name });
            }} data-testid="card-financial-neto">
               <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Flujo Neto (Mes)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-600 cursor-default" title={formatCurrencyFull(financialData[financialData.length-1].Neto)}>
                  {formatCurrency(financialData[financialData.length-1].Neto)}
                </div>
                <p className="text-xs text-muted-foreground mt-1">Ingresos vs Egresos cobrados</p>
              </CardContent>
            </Card>
            <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
              const allExpenses = getIncludedTxByType('expense');
              const totalEgresos = financialData.reduce((acc, curr) => acc + curr.Egresos, 0);
              setDrillDown(buildBurnRateDrillDown({
                allExpenses, totalEgresos, periodMonths, formatCurrencyFull,
              }));
            }} data-testid="card-financial-burnrate">
               <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Burn Rate Promedio</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-red-600 cursor-default" title={formatCurrencyFull(financialData.reduce((acc, curr) => acc + curr.Egresos, 0) / (periodMonths || 1))}>
                  {formatCurrency(financialData.reduce((acc, curr) => acc + curr.Egresos, 0) / (periodMonths || 1))}
                </div>
                <p className="text-xs text-muted-foreground mt-1">Gasto mensual promedio</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Evolución de Caja</CardTitle>
                <CardDescription>Ingresos vs Costos vs Gastos por mes</CardDescription>
              </CardHeader>
              <CardContent className="h-[290px] sm:h-[340px] overflow-hidden">
                <div ref={chartFinancialRef}>
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={financialData} onClick={handleFinancialBarClick} className="cursor-pointer">
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => formatCurrencyValue(value)} />
                    <RechartsTooltip formatter={(value: number) => formatCurrencyFull(value)} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }} />
                    <Bar dataKey="Ingresos" fill="#00D4FF" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Costos" stackId="egresos" fill="#F97316" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="Gastos" stackId="egresos" fill="#A855F7" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <CategoryDistributionCard
              transactions={transactions as Transaction[]}
              selectedCurrency={selectedCurrency}
              includedAccountIds={includedAccountIds}
              accountCurrencyMap={accountCurrencyMap}
              passesCodeFilter={passesCodeFilter}
              codeAmountFactor={codeFactor}
              convertAmount={convertAmount}
              formatCurrencyFull={formatCurrencyFull}
              formatCurrencyValue={formatCurrencyValue}
              globalRangeStart={periodStart}
              globalRangeEnd={periodEnd}
              setDrillDown={setDrillDown}
              chartRef={chartExpensesRef}
            />
          </div>
        </TabsContent>

        <TabsContent value="economic" className="space-y-4 min-w-0">
           <Card>
              <CardHeader>
                <CardTitle>Resultado Económico (P&L)</CardTitle>
                <CardDescription>Ventas vs Costos vs Gastos</CardDescription>
              </CardHeader>
              <CardContent className="h-[320px] sm:h-[390px] overflow-hidden">
                <div ref={chartEconomicRef}>
                <ResponsiveContainer width="100%" height={370}>
                  <LineChart data={economicData} onClick={handleEconomicChartClick} className="cursor-pointer">
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => formatCurrencyValue(value)} />
                    <RechartsTooltip formatter={(value: number) => formatCurrencyFull(value)} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }} />
                    <Line type="monotone" dataKey="Ventas" stroke="#00D4FF" strokeWidth={2} />
                    <Line type="monotone" dataKey="Costos" stroke="#f97316" strokeWidth={2} />
                    <Line type="monotone" dataKey="Gastos" stroke="#FF3366" strokeWidth={2} />
                    <Line type="monotone" dataKey="Margen Bruto" stroke="#8b5cf6" strokeWidth={1.5} strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="Resultado" stroke="#10b981" strokeWidth={2} strokeDasharray="5 5" />
                  </LineChart>
                </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {(() => {
              const totalVentas = economicData.reduce((s, d) => s + d.Ventas, 0);
              const totalCostos = economicData.reduce((s, d) => s + d.Costos, 0);
              const totalGastos = economicData.reduce((s, d) => s + d.Gastos, 0);
              const margenBruto = totalVentas - totalCostos;
              const resultado = totalVentas - totalCostos - totalGastos;
              const pctCostos = totalVentas > 0 ? Math.round((totalCostos / totalVentas) * 100) : 0;
              const pctGastos = totalVentas > 0 ? Math.round((totalGastos / totalVentas) * 100) : 0;
              const pctMargen = totalVentas > 0 ? Math.round((margenBruto / totalVentas) * 100) : 0;
              return (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3" data-testid="pl-summary">
                  <Card className="bg-cyan-50/50 border-cyan-200 p-3 text-center cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
                    const ventasTx = getIncludedTxByType('income', 'imputationDate', true);
                    setDrillDown(buildVentasDrillDown({ ventasTx, totalVentas, formatCurrencyFull }));
                  }} data-testid="card-pl-ventas">
                    <p className="text-xs font-medium text-cyan-700">Ventas</p>
                    <p className="text-lg font-bold text-cyan-800 cursor-default" title={formatCurrencyFull(totalVentas)}>{formatCurrencyValue(totalVentas)}</p>
                  </Card>
                  <Card className="bg-orange-50/50 border-orange-200 p-3 text-center cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
                    const costosTx = pickCostSubtype(getIncludedTxByType('expense', 'imputationDate', true));
                    setDrillDown(buildCostosDrillDown({ costosTx, totalCostos, formatCurrencyFull }));
                  }} data-testid="card-pl-costos">
                    <p className="text-xs font-medium text-orange-700">Costos ({pctCostos}%)</p>
                    <p className="text-lg font-bold text-orange-800 cursor-default" title={formatCurrencyFull(totalCostos)}>{formatCurrencyValue(totalCostos)}</p>
                  </Card>
                  <Card className="bg-rose-50/50 border-rose-200 p-3 text-center cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
                    const gastosTx = pickGastoSubtype(getIncludedTxByType('expense', 'imputationDate', true));
                    setDrillDown(buildGastosDrillDown({ gastosTx, totalGastos, formatCurrencyFull }));
                  }} data-testid="card-pl-gastos">
                    <p className="text-xs font-medium text-rose-700">Gastos ({pctGastos}%)</p>
                    <p className="text-lg font-bold text-rose-800 cursor-default" title={formatCurrencyFull(totalGastos)}>{formatCurrencyValue(totalGastos)}</p>
                  </Card>
                  <Card className="bg-violet-50/50 border-violet-200 p-3 text-center cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
                    const ventasTx = getIncludedTxByType('income', 'imputationDate', true);
                    const costosTx = pickCostSubtype(getIncludedTxByType('expense', 'imputationDate', true));
                    setDrillDown(buildMargenBrutoDrillDown({
                      ventasTx, costosTx, totalVentas, totalCostos, formatCurrencyFull,
                    }));
                  }} data-testid="card-pl-margen">
                    <p className="text-xs font-medium text-violet-700">Margen Bruto ({pctMargen}%)</p>
                    <p className="text-lg font-bold text-violet-800 cursor-default" title={formatCurrencyFull(margenBruto)}>{formatCurrencyValue(margenBruto)}</p>
                  </Card>
                  <Card className={`p-3 text-center cursor-pointer hover:shadow-md transition-shadow ${resultado >= 0 ? 'bg-emerald-50/50 border-emerald-200' : 'bg-red-50/50 border-red-200'}`} onClick={() => {
                    const ventasTx = getIncludedTxByType('income', 'imputationDate', true);
                    const allExpenses = getIncludedTxByType('expense', 'imputationDate', true);
                    const costosTx = pickCostSubtype(allExpenses);
                    const gastosTx = pickGastoSubtype(allExpenses);
                    setDrillDown(buildResultadoDrillDown({
                      ventasTx, costosTx, gastosTx, totalVentas, totalCostos, totalGastos, formatCurrencyFull,
                    }));
                  }} data-testid="card-pl-resultado">
                    <p className={`text-xs font-medium ${resultado >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>Resultado Neto</p>
                    <p className={`text-lg font-bold cursor-default ${resultado >= 0 ? 'text-emerald-800' : 'text-red-800'}`} title={formatCurrencyFull(resultado)}>{formatCurrencyValue(resultado)}</p>
                  </Card>
                </div>
              );
            })()}

            {/* IVA discriminado en facturas (toma invoiceIvaAmount de cada
                transacción con factura cargada en el período, por fecha de
                imputación). Tarjetas con drill-down. */}
            {(() => {
              const allTx = transactions.filter((t: any) => {
                const reportable = buildReportableTxFilter({
                  scopeAccountIds: includedAccountIds,
                  periodStart,
                  periodEnd,
                  dateField: 'imputationDate',
                });
                return reportable(t) && passesCodeFilter(t);
              });
              const hasIva = (t: any) => {
                const v = parseFloat(t.invoiceIvaAmount || '0');
                return !!t.hasInvoice && !isNaN(v) && v !== 0;
              };
              const sumIva = (arr: any[]) => arr.reduce((s, t) => {
                const cur = pickTxCurrency(t, accountCurrencyMap);
                const iva = parseFloat(t.invoiceIvaAmount || '0') || 0;
                return s + convertAmount(iva, cur, selectedCurrency);
              }, 0);
              const sumNeto = (arr: any[]) => arr.reduce((s, t) => {
                const cur = pickTxCurrency(t, accountCurrencyMap);
                const neto = parseFloat(t.invoiceNetAmount || '0') || 0;
                return s + convertAmount(neto, cur, selectedCurrency);
              }, 0);
              const ivaDebitoTx = allTx.filter((t: any) =>
                (t.type === 'income' || t.type === 'receivable') && hasIva(t),
              );
              const ivaCreditoTx = allTx.filter((t: any) =>
                (t.type === 'expense' || t.type === 'payable') && hasIva(t),
              );
              const totalIvaDebito = sumIva(ivaDebitoTx);
              const totalIvaCredito = sumIva(ivaCreditoTx);
              const totalNetoVentas = sumNeto(ivaDebitoTx);
              const totalNetoCompras = sumNeto(ivaCreditoTx);
              const saldoIva = totalIvaDebito - totalIvaCredito;
              const noData = totalIvaDebito === 0 && totalIvaCredito === 0;
              return (
                <Card data-testid="card-iva-breakdown">
                  <CardHeader>
                    <CardTitle className="text-base">Impuestos en facturas</CardTitle>
                    <CardDescription>
                      IVA discriminado tomado de las facturas cargadas en el período (por fecha de imputación).
                      {' '}Para el detalle completo entrá a Oficina → Impuestos.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {noData ? (
                      <p className="text-sm text-muted-foreground" data-testid="text-iva-empty">
                        No hay facturas con IVA discriminado en el período seleccionado.
                      </p>
                    ) : (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <Card
                          className="bg-cyan-50/50 border-cyan-200 p-3 text-center cursor-pointer hover:shadow-md transition-shadow"
                          onClick={() => setDrillDown(buildIvaDrillDown({
                            title: 'IVA Débito Fiscal (ventas)',
                            formula: `Suma de IVA de facturas emitidas. Neto facturado: ${formatCurrencyFull(totalNetoVentas)}`,
                            transactions: ivaDebitoTx,
                            totalLabel: 'Total IVA Débito',
                            totalValue: totalIvaDebito,
                            formatCurrencyFull,
                          }))}
                          data-testid="card-iva-debito"
                        >
                          <p className="text-xs font-medium text-cyan-700">IVA Débito (ventas)</p>
                          <p className="text-lg font-bold text-cyan-800 cursor-default" title={formatCurrencyFull(totalIvaDebito)}>
                            {formatCurrencyValue(totalIvaDebito)}
                          </p>
                          <p className="text-[10px] text-cyan-700/80 mt-0.5">
                            {ivaDebitoTx.length} factura{ivaDebitoTx.length === 1 ? '' : 's'}
                          </p>
                        </Card>
                        <Card
                          className="bg-orange-50/50 border-orange-200 p-3 text-center cursor-pointer hover:shadow-md transition-shadow"
                          onClick={() => setDrillDown(buildIvaDrillDown({
                            title: 'IVA Crédito Fiscal (compras y gastos)',
                            formula: `Suma de IVA de facturas de compras/gastos. Neto: ${formatCurrencyFull(totalNetoCompras)}`,
                            transactions: ivaCreditoTx,
                            totalLabel: 'Total IVA Crédito',
                            totalValue: totalIvaCredito,
                            formatCurrencyFull,
                          }))}
                          data-testid="card-iva-credito"
                        >
                          <p className="text-xs font-medium text-orange-700">IVA Crédito (compras)</p>
                          <p className="text-lg font-bold text-orange-800 cursor-default" title={formatCurrencyFull(totalIvaCredito)}>
                            {formatCurrencyValue(totalIvaCredito)}
                          </p>
                          <p className="text-[10px] text-orange-700/80 mt-0.5">
                            {ivaCreditoTx.length} factura{ivaCreditoTx.length === 1 ? '' : 's'}
                          </p>
                        </Card>
                        <Card
                          className={`p-3 text-center cursor-pointer hover:shadow-md transition-shadow ${
                            saldoIva >= 0
                              ? 'bg-rose-50/50 border-rose-200'
                              : 'bg-emerald-50/50 border-emerald-200'
                          }`}
                          onClick={() => setDrillDown(buildSaldoIvaDrillDown({
                            ivaDebitoTx, ivaCreditoTx,
                            totalDebito: totalIvaDebito,
                            totalCredito: totalIvaCredito,
                            formatCurrencyFull,
                          }))}
                          data-testid="card-iva-saldo"
                        >
                          <p className={`text-xs font-medium ${saldoIva >= 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                            {saldoIva >= 0 ? 'Saldo a pagar' : 'Saldo a favor'}
                          </p>
                          <p
                            className={`text-lg font-bold cursor-default ${saldoIva >= 0 ? 'text-rose-800' : 'text-emerald-800'}`}
                            title={formatCurrencyFull(Math.abs(saldoIva))}
                          >
                            {formatCurrencyValue(Math.abs(saldoIva))}
                          </p>
                          <p className={`text-[10px] mt-0.5 ${saldoIva >= 0 ? 'text-rose-700/80' : 'text-emerald-700/80'}`}>
                            Débito − Crédito
                          </p>
                        </Card>
                        <Card
                          className="bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 p-3 text-center cursor-pointer hover:shadow-md transition-shadow"
                          onClick={() => setDrillDown(buildIvaDrillDown({
                            title: 'Neto facturado (ventas, sin IVA)',
                            formula: `Suma de invoiceNetAmount de facturas emitidas. IVA asociado: ${formatCurrencyFull(totalIvaDebito)}`,
                            transactions: ivaDebitoTx,
                            totalLabel: 'Total Neto facturado',
                            totalValue: totalNetoVentas,
                            formatCurrencyFull,
                          }))}
                          data-testid="card-iva-neto"
                        >
                          <p className="text-xs font-medium text-slate-700 dark:text-slate-200">Neto facturado (ventas)</p>
                          <p className="text-lg font-bold text-slate-800 dark:text-slate-100 cursor-default" title={formatCurrencyFull(totalNetoVentas)}>
                            {formatCurrencyValue(totalNetoVentas)}
                          </p>
                          <p className="text-[10px] text-slate-600 dark:text-slate-300 mt-0.5">
                            Sin IVA
                          </p>
                        </Card>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })()}

            {/* Task #202 — Bloque "Por miembro del equipo".
                Se oculta si la organización tiene 1 sólo miembro. La columna
                "Sin asignar" sólo aparece si hay movimientos huérfanos en el
                período. Las tarjetas suman Ingresos/Gastos vía los selectores
                compartidos (selectIngresosRows / selectAllExpensesRows) usando
                el MISMO predicado global (passesCodeFilter), por lo que cuando
                el usuario filtra a un miembro específico la grilla colapsa a
                esa sola tarjeta — coherente con "toda la página se recalcula
                viendo únicamente los movimientos de ese miembro" del spec.
                Click → drill-down con buildMemberDrillDown. */}
            {members.length > 1 && (() => {
              const memberCtx = {
                scopeAccountIds: includedAccountIds,
                passesCodeFilter,
              };
              const allIngresos = selectIngresosRows(transactions as Transaction[], memberCtx)
                .filter((t: any) => {
                  const d = safeParseDate(t.imputationDate || t.date);
                  return d >= periodStart && d <= periodEnd;
                });
              const allEgresos = selectAllExpensesRows(transactions as Transaction[], memberCtx)
                .filter((t: any) => {
                  const d = safeParseDate(t.imputationDate || t.date);
                  return d >= periodStart && d <= periodEnd;
                });
              type Bucket = { ingresos: Transaction[]; egresos: Transaction[] };
              const buckets = new Map<string, Bucket>();
              const keyOf = (t: any): string => t.createdBy || '__unassigned__';
              const ensure = (k: string): Bucket => {
                let b = buckets.get(k);
                if (!b) { b = { ingresos: [], egresos: [] }; buckets.set(k, b); }
                return b;
              };
              allIngresos.forEach((t: any) => ensure(keyOf(t)).ingresos.push(t));
              allEgresos.forEach((t: any) => ensure(keyOf(t)).egresos.push(t));
              const sumOf = (txs: Transaction[]) => txs.reduce((s, t: any) => {
                const cur = pickTxCurrency(t, accountCurrencyMap);
                return s + convertAmount(normalizeAmountInput(t.amount), cur, selectedCurrency) * codeFactor(t);
              }, 0);
              type Row = {
                key: string;
                userId: string | null;
                label: string;
                ingresos: Transaction[];
                egresos: Transaction[];
                totalIngresos: number;
                totalEgresos: number;
                neto: number;
              };
              const rows: Row[] = members
                .map((m): Row | null => {
                  const b = buckets.get(m.userId);
                  if (!b) return null;
                  const totalIngresos = sumOf(b.ingresos);
                  const totalEgresos = sumOf(b.egresos);
                  return {
                    key: m.userId,
                    userId: m.userId,
                    label: m.name || m.email || 'Miembro',
                    ingresos: b.ingresos,
                    egresos: b.egresos,
                    totalIngresos,
                    totalEgresos,
                    neto: totalIngresos - totalEgresos,
                  };
                })
                .filter((r): r is Row => r !== null);
              const orphan = buckets.get('__unassigned__');
              if (orphan && (orphan.ingresos.length > 0 || orphan.egresos.length > 0)) {
                const totalIngresos = sumOf(orphan.ingresos);
                const totalEgresos = sumOf(orphan.egresos);
                rows.push({
                  key: '__unassigned__',
                  userId: null,
                  label: 'Sin asignar',
                  ingresos: orphan.ingresos,
                  egresos: orphan.egresos,
                  totalIngresos,
                  totalEgresos,
                  neto: totalIngresos - totalEgresos,
                });
              }
              if (rows.length === 0) return null;
              const totalIngresosAll = rows.reduce((s, r) => s + r.totalIngresos, 0);
              const totalEgresosAll = rows.reduce((s, r) => s + r.totalEgresos, 0);
              const periodLabel = period === '1m' ? 'el último mes'
                : period === '3m' ? 'los últimos 3 meses'
                : period === '6m' ? 'los últimos 6 meses'
                : 'el año actual';
              return (
                <Card data-testid="card-by-member">
                  <CardHeader>
                    <CardTitle>Por miembro del equipo</CardTitle>
                    <CardDescription>
                      Quién cargó qué en {periodLabel}. Tocá una tarjeta para ver el detalle.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" data-testid="grid-by-member">
                      {rows.map((row) => {
                        const pctIngreso = totalIngresosAll > 0 ? Math.round((row.totalIngresos / totalIngresosAll) * 100) : 0;
                        const pctGasto = totalEgresosAll > 0 ? Math.round((row.totalEgresos / totalEgresosAll) * 100) : 0;
                        const isUnassigned = row.userId == null;
                        return (
                          <Card
                            key={row.key}
                            role="button"
                            tabIndex={0}
                            aria-label={`Ver movimientos de ${row.label}`}
                            className={`p-4 cursor-pointer hover:shadow-md transition-shadow focus:outline-none focus:ring-2 focus:ring-cyan-400 focus-visible:ring-2 focus-visible:ring-cyan-400 ${
                              isUnassigned
                                ? 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800'
                                : 'bg-gradient-to-br from-cyan-50/50 to-pink-50/30 border-cyan-100'
                            }`}
                            onClick={() => {
                              setDrillDown(buildMemberDrillDown({
                                memberLabel: row.label,
                                ingresosTx: row.ingresos,
                                egresosTx: row.egresos,
                                totalIngresos: row.totalIngresos,
                                totalEgresos: row.totalEgresos,
                                formatCurrencyFull,
                              }));
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setDrillDown(buildMemberDrillDown({
                                  memberLabel: row.label,
                                  ingresosTx: row.ingresos,
                                  egresosTx: row.egresos,
                                  totalIngresos: row.totalIngresos,
                                  totalEgresos: row.totalEgresos,
                                  formatCurrencyFull,
                                }));
                              }
                            }}
                            data-testid={`card-member-${row.key}`}
                          >
                            <div className="flex items-center gap-2 mb-3">
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                                isUnassigned ? 'bg-slate-200 text-slate-600 dark:text-slate-300' : 'bg-cyan-100 text-cyan-700'
                              }`}>
                                {isUnassigned ? '?' : row.label.charAt(0).toUpperCase()}
                              </div>
                              <p className="text-sm font-semibold truncate flex-1" title={row.label} data-testid={`text-member-name-${row.key}`}>
                                {row.label}
                              </p>
                            </div>
                            <div className="space-y-2 text-xs">
                              <div className="flex justify-between items-center">
                                <span className="text-cyan-700">Ingresos</span>
                                <span className="font-bold text-cyan-800" data-testid={`text-member-income-${row.key}`} title={formatCurrencyFull(row.totalIngresos)}>
                                  {formatCurrencyValue(row.totalIngresos)}
                                </span>
                              </div>
                              <div className="h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                                <div className="h-full bg-cyan-500" style={{ width: `${Math.min(100, pctIngreso)}%` }} />
                              </div>
                              <div className="flex justify-between items-center">
                                <span className="text-rose-700">Gastos</span>
                                <span className="font-bold text-rose-800" data-testid={`text-member-expense-${row.key}`} title={formatCurrencyFull(row.totalEgresos)}>
                                  {formatCurrencyValue(row.totalEgresos)}
                                </span>
                              </div>
                              <div className="h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                                <div className="h-full bg-rose-500" style={{ width: `${Math.min(100, pctGasto)}%` }} />
                              </div>
                              <div className="flex justify-between items-center pt-1 border-t border-slate-200 dark:border-slate-800/60">
                                <span className="font-semibold">Neto</span>
                                <span
                                  className={`font-bold ${row.neto >= 0 ? 'text-emerald-700' : 'text-red-700'}`}
                                  data-testid={`text-member-net-${row.key}`}
                                  title={formatCurrencyFull(row.neto)}
                                >
                                  {formatCurrencyValue(row.neto)}
                                </span>
                              </div>
                              <div className="flex justify-between text-[10px] text-muted-foreground pt-1">
                                <span>{pctIngreso}% del ingreso</span>
                                <span>{pctGasto}% del gasto</span>
                              </div>
                            </div>
                          </Card>
                        );
                      })}
                    </div>
                    {/* Texto guía cuando hay tarjeta "Sin asignar" en la grilla
                        — exigido por el spec del Task #202. */}
                    {rows.some((r) => r.userId == null) && (
                      <p className="mt-3 text-[11px] text-muted-foreground" data-testid="text-unassigned-help">
                        Movimientos sin autor registrado. Podés asignarlos editándolos uno por uno.
                      </p>
                    )}
                  </CardContent>
                </Card>
              );
            })()}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {(() => {
                // Task #201 — pull both lists from the shared row selectors so
                // they apply the same exclusions as every other Reportes card
                // (cancelled originals, [CANCELACIÓN] mirrors, transfers,
                // out-of-scope accounts, código de rentabilidad). Sorting is
                // local UI concern (earliest due date first).
                const pendingCtx = { scopeAccountIds: includedAccountIds, passesCodeFilter };
                const pendingPayables = [...selectPendingPayables(transactions as Transaction[], pendingCtx)]
                  .sort((a: any, b: any) => safeParseDate(a.imputationDate || a.date).getTime() - safeParseDate(b.imputationDate || b.date).getTime());
                const pendingReceivables = [...selectPendingReceivables(transactions as Transaction[], pendingCtx)]
                  .sort((a: any, b: any) => safeParseDate(a.imputationDate || a.date).getTime() - safeParseDate(b.imputationDate || b.date).getTime());
                return (
                  <>
                    <Card className="bg-orange-50/50 border-orange-100">
                      <CardHeader>
                        <CardTitle className="text-orange-900">Cuentas a Pagar</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="text-3xl font-bold text-orange-700">
                          {formatCurrency(pendingPayables.reduce((sum: number, t: any) =>
                            sum + convertAmount(normalizeAmountInput(t.amount), pickTxCurrency(t, accountCurrencyMap), selectedCurrency) * codeFactor(t),
                          0))}
                        </div>
                        <p className="text-sm text-orange-600 mt-2">
                          {pendingPayables.length} compromiso(s) pendiente(s)
                        </p>
                        {pendingPayables.length > 0 && (
                          <Collapsible>
                            <CollapsibleTrigger asChild>
                              <Button
                                variant="outline"
                                className="mt-4 w-full border-orange-200 text-orange-800 hover:bg-orange-100"
                                data-testid="button-toggle-payables"
                              >
                                Ver detalles <ChevronDown className="h-4 w-4 ml-2" />
                              </Button>
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              <div className="mt-3 space-y-2 max-h-60 overflow-y-auto">
                                {pendingPayables.map((t: any) => {
                                  const dueDate = safeParseDate(t.imputationDate || t.date);
                                  const isOverdue = dueDate < new Date();
                                  const txCur = pickTxCurrency(t, accountCurrencyMap);
                                  return (
                                    <div key={t.id} className="flex items-center justify-between p-2 rounded-md bg-orange-100/50 text-sm" data-testid={`payable-item-${t.id}`}>
                                      <div className="min-w-0 flex-1">
                                        <p className="font-medium truncate text-orange-900">{t.description}</p>
                                        <p className={`text-xs ${isOverdue ? 'text-red-600 font-semibold' : 'text-orange-600'}`}>
                                          {isOverdue ? 'VENCIDO - ' : ''}Vence: {format(dueDate, "d MMM yyyy", { locale: es })}
                                        </p>
                                      </div>
                                      <span className="font-bold text-orange-700 ml-2 whitespace-nowrap">
                                        {formatCurrency(convertAmount(normalizeAmountInput(t.amount), txCur, selectedCurrency) * codeFactor(t))}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            </CollapsibleContent>
                          </Collapsible>
                        )}
                      </CardContent>
                    </Card>
                    <Card className="bg-blue-50/50 border-blue-100">
                      <CardHeader>
                        <CardTitle className="text-blue-900">Cuentas a Cobrar</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="text-3xl font-bold text-blue-700">
                          {formatCurrency(pendingReceivables.reduce((sum: number, t: any) =>
                            sum + convertAmount(normalizeAmountInput(t.amount), pickTxCurrency(t, accountCurrencyMap), selectedCurrency) * codeFactor(t),
                          0))}
                        </div>
                        <p className="text-sm text-blue-600 mt-2">
                          {pendingReceivables.length} cobro(s) pendiente(s)
                        </p>
                        {pendingReceivables.length > 0 && (
                          <Collapsible>
                            <CollapsibleTrigger asChild>
                              <Button
                                variant="outline"
                                className="mt-4 w-full border-blue-200 text-blue-800 hover:bg-blue-100"
                                data-testid="button-toggle-receivables"
                              >
                                Ver detalles <ChevronDown className="h-4 w-4 ml-2" />
                              </Button>
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              <div className="mt-3 space-y-2 max-h-60 overflow-y-auto">
                                {pendingReceivables.map((t: any) => {
                                  const dueDate = safeParseDate(t.imputationDate || t.date);
                                  const isOverdue = dueDate < new Date();
                                  const txCur = pickTxCurrency(t, accountCurrencyMap);
                                  return (
                                    <div key={t.id} className="flex items-center justify-between p-2 rounded-md bg-blue-100/50 text-sm" data-testid={`receivable-item-${t.id}`}>
                                      <div className="min-w-0 flex-1">
                                        <p className="font-medium truncate text-blue-900">{t.description}</p>
                                        <p className={`text-xs ${isOverdue ? 'text-red-600 font-semibold' : 'text-blue-600'}`}>
                                          {isOverdue ? 'VENCIDO - ' : ''}Vence: {format(dueDate, "d MMM yyyy", { locale: es })}
                                        </p>
                                      </div>
                                      <span className="font-bold text-blue-700 ml-2 whitespace-nowrap">
                                        {formatCurrency(convertAmount(normalizeAmountInput(t.amount), txCur, selectedCurrency) * codeFactor(t))}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            </CollapsibleContent>
                          </Collapsible>
                        )}
                      </CardContent>
                    </Card>
                  </>
                );
              })()}
            </div>

            {profitabilityCodes.length > 0 && (
              <Card className="mt-6" data-testid="card-profitability-by-code">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Tag className="h-5 w-5 text-pink-500" />
                    Rentabilidad por código
                  </CardTitle>
                  <CardDescription>
                    Ingresos, costos y gastos agrupados por código de análisis. Excluye transferencias y movimientos cancelados.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {profitabilityByCode.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-6" data-testid="text-no-profitability-data">
                      Todavía no hay movimientos asignados a un código.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-muted-foreground text-left">
                            <th className="py-2 pr-3 font-medium">Código</th>
                            <th className="py-2 pr-3 font-medium text-right">Ingresos</th>
                            <th className="py-2 pr-3 font-medium text-right">Costos</th>
                            <th className="py-2 pr-3 font-medium text-right">Gastos</th>
                            <th className="py-2 pr-3 font-medium text-right">Resultado</th>
                            <th className="py-2 pr-3 font-medium text-right">Margen</th>
                          </tr>
                        </thead>
                        <tbody>
                          {profitabilityByCode.map((row) => {
                            const margin = row.income > 0 ? ((row.income - row.costs - row.gastos) / row.income) * 100 : 0;
                            const result = row.income - row.costs - row.gastos;
                            return (
                              <tr key={row.id} className="border-b last:border-0" data-testid={`row-profitability-${row.id}`}>
                                <td className="py-2 pr-3">
                                  <div className="flex items-center gap-2">
                                    {row.color && <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: row.color }} />}
                                    <span className="font-mono font-semibold text-xs">{row.code}</span>
                                    <span className="text-muted-foreground text-xs">· {row.name}</span>
                                  </div>
                                </td>
                                <td className="py-2 pr-3 text-right font-medium text-emerald-600">{formatCurrency(row.income)}</td>
                                <td className="py-2 pr-3 text-right text-orange-600">{formatCurrency(row.costs)}</td>
                                <td className="py-2 pr-3 text-right text-rose-600">{formatCurrency(row.gastos)}</td>
                                <td className={`py-2 pr-3 text-right font-bold ${result >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>{formatCurrency(result)}</td>
                                <td className={`py-2 pr-3 text-right text-xs ${margin >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{margin.toFixed(1)}%</td>
                              </tr>
                            );
                          })}
                          <tr className="font-bold bg-muted/30">
                            <td className="py-2 pr-3">Total</td>
                            <td className="py-2 pr-3 text-right text-emerald-700">{formatCurrency(profitabilityByCode.reduce((s, r) => s + r.income, 0))}</td>
                            <td className="py-2 pr-3 text-right text-orange-700">{formatCurrency(profitabilityByCode.reduce((s, r) => s + r.costs, 0))}</td>
                            <td className="py-2 pr-3 text-right text-rose-700">{formatCurrency(profitabilityByCode.reduce((s, r) => s + r.gastos, 0))}</td>
                            <td className="py-2 pr-3 text-right">{formatCurrency(profitabilityByCode.reduce((s, r) => s + (r.income - r.costs - r.gastos), 0))}</td>
                            <td></td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
        </TabsContent>

        <TabsContent value="valuation" className="space-y-4 min-w-0">
           <div className="grid lg:grid-cols-2 gap-8 items-center">
             <div className="space-y-4">
                <h2 className="text-2xl font-bold font-display">¿Cuánto vale tu empresa?</h2>
                <p className="text-muted-foreground text-lg">
                  Cálculo basado en EBITDA, valor libros de activos y cartera de inversiones.
                  {valuationData.hasMultipleCurrencies && (
                    <span className="block text-sm mt-1 text-blue-600">
                      💱 Montos convertidos a {CURRENCY_LABELS[selectedCurrency] || selectedCurrency} ({valuationData.rateSource})
                    </span>
                  )}
                </p>
                
                <Card className="bg-primary text-primary-foreground border-none shadow-2xl overflow-hidden relative cursor-pointer hover:shadow-3xl transition-shadow" onClick={() => {
                  const valuationItems: GenericDrillDownItem[] = [
                    { id: 'ebitda', label: 'EBITDA', sublabel: 'Ingresos - Gastos Operativos', amount: valuationData.fmtVal(valuationData.ebitda), badge: 'resultado' },
                    ...(assets || []).map((a: any) => {
                      const acqVal = parseFloat(a.acquisitionValue?.toString() || '0');
                      const depr = parseFloat(a.accumulatedDepreciation?.toString() || '0');
                      const bv = Math.max(0, acqVal - depr);
                      return { id: `asset-${a.id}`, label: a.name, sublabel: 'Activo físico', amount: valuationData.fmtVal(convertToSelected(bv, a.currency || 'ARS')), badge: 'activo' };
                    }),
                    ...(products || []).filter((p: any) => p.productType === 'asset' && p.isActive !== false).map((p: any) => {
                      const val = parseFloat(p.currentValue?.toString() || '0') || parseFloat(p.costPrice?.toString() || '0');
                      return { id: `prod-${p.id}`, label: p.name, sublabel: 'Producto/Activo', amount: valuationData.fmtVal(convertToSelected(val, p.costCurrency || 'ARS')), badge: 'producto' };
                    }),
                    ...(products || []).filter((p: any) => p.productType === 'product' && p.isActive !== false).map((p: any) => {
                      const stock = parseFloat(p.stock?.toString() || '0') || 0;
                      const cost = parseFloat(p.costPrice?.toString() || '0') || 0;
                      return { p, stock, cost };
                    }).filter((x: any) => x.stock > 0 && x.cost > 0).map((x: any) => ({
                      id: `inv-prod-${x.p.id}`,
                      label: x.p.name,
                      sublabel: `Inventario (${x.stock.toLocaleString('es-AR')} × ${valuationData.fmtVal(convertToSelected(x.cost, x.p.costCurrency || 'ARS'))})`,
                      amount: valuationData.fmtVal(convertToSelected(x.stock * x.cost, x.p.costCurrency || 'ARS')),
                      badge: 'inventario',
                    })),
                    ...(investments || []).map((inv: any) => {
                      const qty = parseFloat(inv.quantity?.toString() || '0');
                      const cp = parseFloat(inv.currentPrice?.toString() || '0');
                      const tc = parseFloat(inv.totalCost?.toString() || '0');
                      const cv = cp > 0 ? qty * cp : tc;
                      return { id: `inv-${inv.id}`, label: inv.name || inv.symbol, sublabel: 'Inversión', amount: valuationData.fmtVal(convertToSelected(cv, inv.currency || 'ARS')), badge: inv.symbol };
                    }),
                    ...accounts.filter((acc: any) => acc.accountCategory === 'investment' && includedAccountIds.includes(acc.id)).map((acc: any) => ({
                      id: `invacc-${acc.id}`, label: acc.name, sublabel: 'Cuenta inversión', amount: valuationData.fmtVal(convertToSelected(normalizeAmountInput(acc.balance), acc.currency || 'ARS')), badge: acc.currency || 'ARS',
                    })),
                  ];
                  setDrillDown(buildValoracionTotalDrillDown({
                    items: valuationItems,
                    ebitda: valuationData.ebitda,
                    assetsBookValue: valuationData.assetsBookValue,
                    investmentsValue: valuationData.investmentsValue,
                    totalValuation: valuationData.totalValuation,
                    formatValue: valuationData.fmtVal,
                  }));
                }} data-testid="card-valuation-total">
                  <div className="absolute top-0 right-0 p-32 bg-white dark:bg-card/10 rounded-full blur-3xl -mr-16 -mt-16 pointer-events-none"></div>
                  <CardHeader>
                    <CardTitle className="text-primary-foreground/80">Valor Estimado</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-5xl font-bold tracking-tight cursor-default" title={valuationData.fmtVal(valuationData.totalValuation)}>
                      {valuationData.fmtValCompact(valuationData.totalValuation)}
                    </div>
                    <p className="mt-2 text-primary-foreground/70">EBITDA + Activos + Inversiones</p>
                    {valuationData.hasMultipleCurrencies && (
                      <p className="mt-1 text-primary-foreground/60 text-sm">
                        TC {valuationData.rateSource}: AR${new Intl.NumberFormat('es-AR').format(valuationData.usdRate)}/USD
                      </p>
                    )}
                  </CardContent>
                </Card>
                
                <div className="mt-4">
                  <h3 className="text-sm font-semibold text-muted-foreground mb-2">Estado de Resultados</h3>
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <Card className="bg-orange-50 border-orange-200 cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
                      const costosTx = selectCostosRows(transactions, {
                        scopeAccountIds: includedAccountIds, passesCodeFilter,
                      });
                      setDrillDown(buildValuationCostosDrillDown({
                        costosTx,
                        totalValue: valuationData.totalCosts,
                        formatValue: valuationData.fmtVal,
                      }));
                    }} data-testid="card-valuation-costos">
                      <CardContent className="p-4">
                        <p className="text-xs font-medium text-orange-600 mb-1">Costos</p>
                        <p className="text-lg font-bold text-orange-800 cursor-default" title={valuationData.fmtVal(valuationData.totalCosts)}>{valuationData.fmtValCompact(valuationData.totalCosts)}</p>
                      </CardContent>
                    </Card>
                    <Card className="bg-purple-50 border-purple-200 cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
                      const gastosTx = selectGastosRows(transactions, {
                        scopeAccountIds: includedAccountIds, passesCodeFilter,
                      });
                      setDrillDown(buildValuationGastosDrillDown({
                        gastosTx,
                        totalValue: valuationData.totalGastos,
                        formatValue: valuationData.fmtVal,
                      }));
                    }} data-testid="card-valuation-gastos">
                      <CardContent className="p-4">
                        <p className="text-xs font-medium text-purple-600 mb-1">Gastos Operativos</p>
                        <p className="text-lg font-bold text-purple-800 cursor-default" title={valuationData.fmtVal(valuationData.totalGastos)}>{valuationData.fmtValCompact(valuationData.totalGastos)}</p>
                      </CardContent>
                    </Card>
                    <Card className="bg-blue-50 border-blue-200 cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
                      const ctx = { scopeAccountIds: includedAccountIds, passesCodeFilter };
                      const revTx = selectIngresosRows(transactions, ctx);
                      const costTx = selectCostosRows(transactions, ctx);
                      setDrillDown(buildValuationMargenBrutoDrillDown({
                        revTx,
                        costTx,
                        totalRevenue: valuationData.totalRevenue,
                        totalCosts: valuationData.totalCosts,
                        margenBruto: valuationData.margenBruto,
                        formatValue: valuationData.fmtVal,
                      }));
                    }} data-testid="card-valuation-margen">
                      <CardContent className="p-4">
                        <p className="text-xs font-medium text-blue-600 mb-1">Margen Bruto</p>
                        <p className="text-lg font-bold text-blue-800 cursor-default" title={valuationData.fmtVal(valuationData.margenBruto)}>{valuationData.fmtValCompact(valuationData.margenBruto)}</p>
                      </CardContent>
                    </Card>
                    <Card className="bg-cyan-50 border-cyan-200 cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
                      const ctx = { scopeAccountIds: includedAccountIds, passesCodeFilter };
                      const revTx = selectIngresosRows(transactions, ctx);
                      const expTx = selectAllExpensesRows(transactions, ctx);
                      setDrillDown(buildValuationEbitdaDrillDown({
                        revTx, expTx,
                        totalRevenue: valuationData.totalRevenue,
                        totalExpenses: valuationData.totalExpenses,
                        ebitda: valuationData.ebitda,
                        formatValue: valuationData.fmtVal,
                      }));
                    }} data-testid="card-valuation-ebitda">
                      <CardContent className="p-4">
                        <p className="text-xs font-medium text-cyan-600 mb-1">EBITDA</p>
                        <p className="text-lg font-bold text-cyan-800 cursor-default" title={valuationData.fmtVal(valuationData.ebitda)}>{valuationData.fmtValCompact(valuationData.ebitda)}</p>
                      </CardContent>
                    </Card>
                  </div>
                </div>

                <div className="mt-4">
                  <h3 className="text-sm font-semibold text-muted-foreground mb-2">Composición del Patrimonio</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <Card className="bg-emerald-50 border-emerald-200 cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
                      const opAccounts = accounts.filter((acc: any) => (!acc.accountCategory || acc.accountCategory === 'operative') && includedAccountIds.includes(acc.id));
                      const items: GenericDrillDownItem[] = opAccounts.map((acc: any) => ({
                        id: acc.id, label: acc.name, sublabel: acc.currency || 'ARS',
                        amount: valuationData.fmtVal(convertToSelected(normalizeAmountInput(acc.balance), acc.currency || 'ARS')),
                        badge: acc.accountType,
                      }));
                      setDrillDown(buildPatrimonioOperativoDrillDown({
                        items, totalValue: valuationData.operativeBalance, formatValue: valuationData.fmtVal,
                      }));
                    }} data-testid="card-patrimonio-operativo">
                      <CardContent className="p-4">
                        <p className="text-xs font-medium text-emerald-600 mb-1">Patrimonio Operativo</p>
                        <p className="text-lg font-bold text-emerald-800 cursor-default" title={valuationData.fmtVal(valuationData.operativeBalance)}>{valuationData.fmtValCompact(valuationData.operativeBalance)}</p>
                      </CardContent>
                    </Card>
                    <Card className="bg-violet-50 border-violet-200 cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
                      const invAccounts = accounts.filter((acc: any) => acc.accountCategory === 'investment' && includedAccountIds.includes(acc.id));
                      const items: GenericDrillDownItem[] = invAccounts.map((acc: any) => ({
                        id: acc.id, label: acc.name, sublabel: acc.currency || 'ARS',
                        amount: valuationData.fmtVal(convertToSelected(normalizeAmountInput(acc.balance), acc.currency || 'ARS')),
                        badge: 'inversión',
                      }));
                      setDrillDown(buildPatrimonioInversionesDrillDown({
                        items, totalValue: valuationData.investmentBalance, formatValue: valuationData.fmtVal,
                      }));
                    }} data-testid="card-patrimonio-inversion">
                      <CardContent className="p-4">
                        <p className="text-xs font-medium text-violet-600 mb-1">Patrimonio en Inversiones</p>
                        <p className="text-lg font-bold text-violet-800 cursor-default" title={valuationData.fmtVal(valuationData.investmentBalance)}>{valuationData.fmtValCompact(valuationData.investmentBalance)}</p>
                        {valuationData.investmentInitial > 0 && (
                          <p className={`text-xs font-medium mt-1 ${valuationData.investmentGainLoss >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            Rend: {valuationData.investmentGainLoss >= 0 ? '+' : ''}{valuationData.investmentGainLossPct.toFixed(1)}%
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </div>

                <Collapsible className="mt-4">
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" className="w-full justify-between text-muted-foreground hover:text-foreground">
                      <span className="flex items-center gap-2">
                        <HelpCircle className="h-4 w-4" />
                        ¿Cómo calculamos este valor?
                      </span>
                      <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-2 p-4 bg-slate-100 dark:bg-slate-800 rounded-lg text-sm space-y-2">
                    <p className="font-semibold text-slate-900 dark:text-slate-50">📊 Fórmula: EBITDA + Valor Libros Activos + Inversiones</p>
                    
                    <div className="space-y-2 text-slate-700 dark:text-slate-200">
                      <div className="bg-white dark:bg-card p-2 rounded border border-slate-200 dark:border-slate-800">
                        <p className="font-medium text-slate-800 dark:text-slate-100">💰 EBITDA (Ingresos - Gastos Operativos)</p>
                        <ul className="ml-4 mt-1 space-y-0.5">
                          <li>• Ingresos: {valuationData.fmtVal(valuationData.totalRevenue)}</li>
                          <li>• Gastos Operativos: {valuationData.fmtVal(valuationData.totalExpenses)}</li>
                          <li className="font-medium text-green-700">= EBITDA: {valuationData.fmtVal(valuationData.ebitda)}</li>
                        </ul>
                      </div>
                      
                      <div className="bg-white dark:bg-card p-2 rounded border border-slate-200 dark:border-slate-800">
                        <p className="font-medium text-slate-800 dark:text-slate-100">🏢 Activos Físicos (Valor Libros)</p>
                        <p className="ml-4 text-blue-700 font-medium">{valuationData.fmtVal(valuationData.assetsBookValue)}</p>
                        <p className="ml-4 text-xs text-slate-500 dark:text-slate-400">Costo original menos depreciación acumulada</p>
                      </div>
                      
                      <div className="bg-white dark:bg-card p-2 rounded border border-slate-200 dark:border-slate-800">
                        <p className="font-medium text-slate-800 dark:text-slate-100">📈 Inversiones (Valor Actual)</p>
                        <p className="ml-4 text-purple-700 font-medium">{valuationData.fmtVal(valuationData.investmentsValue)}</p>
                        <p className="ml-4 text-xs text-slate-500 dark:text-slate-400">Acciones, bonos, y otros activos financieros</p>
                      </div>
                    </div>
                    
                    <div className="border-t border-slate-300 dark:border-slate-700 pt-2 mt-2">
                      <p className="font-semibold">📋 Cálculo Final:</p>
                      <p className="text-slate-700 dark:text-slate-200">{valuationData.fmtVal(valuationData.ebitda)} + {valuationData.fmtVal(valuationData.assetsBookValue)} + {valuationData.fmtVal(valuationData.investmentsValue)} = <strong className="text-primary">{valuationData.fmtVal(valuationData.totalValuation)}</strong></p>
                    </div>
                    
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                      💱 Cotización: {valuationData.rateSource} {valuationData.hasRates ? '(tiempo real)' : '(valor estimado)'}
                    </p>
                  </CollapsibleContent>
                </Collapsible>

                <div className="flex flex-col sm:flex-row gap-3 mt-6">
                  <Button 
                    className="flex-1 h-12" 
                    variant="outline"
                    onClick={() => {
                      const win = window.open('', '_blank');
                      if (!win) return;
                      win.document.write(`
                        <!DOCTYPE html>
                        <html>
                        <head><title>Informe de Valoración - Aikestar</title>
                        <style>
                          body { font-family: Arial, sans-serif; padding: 40px; color: #1f2937; }
                          h1 { color: #1e40af; }
                          .header { border-bottom: 2px solid #e5e7eb; padding-bottom: 16px; margin-bottom: 24px; }
                          .section { margin: 24px 0; }
                          .value-box { background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: white; padding: 24px; border-radius: 12px; margin: 16px 0; }
                          .value { font-size: 48px; font-weight: bold; }
                          .metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-top: 24px; }
                          .metric { background: #f9fafb; padding: 16px; border-radius: 8px; border: 1px solid #e5e7eb; }
                          .metric-label { font-size: 12px; color: #6b7280; }
                          .metric-value { font-size: 24px; font-weight: bold; margin-top: 4px; }
                          .footer { margin-top: 40px; font-size: 12px; color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 16px; }
                        </style>
                        </head>
                        <body>
                          <div class="header">
                            <h1>Informe de Valoración de Empresa</h1>
                            <p style="color:#6b7280">Generado el ${new Date().toLocaleDateString('es-AR')}</p>
                          </div>
                          <div class="section">
                            <h2>Valor Estimado</h2>
                            <div class="value-box">
                              <div class="value">${valuationData.fmtVal(valuationData.totalValuation)}</div>
                              <p>Fórmula: EBITDA + Activos + Inversiones</p>
                              ${valuationData.hasMultipleCurrencies ? `<p style="font-size:12px;margin-top:8px;opacity:0.8">TC ${valuationData.rateSource}: AR$${new Intl.NumberFormat('es-AR').format(valuationData.usdRate)}/USD</p>` : ''}
                            </div>
                          </div>
                          <div class="section">
                            <h2>Componentes de Valoración</h2>
                            <div class="metrics">
                              <div class="metric"><div class="metric-label">EBITDA</div><div class="metric-value" style="color:#059669">${valuationData.fmtVal(valuationData.ebitda)}</div><div style="font-size:11px;color:#666;margin-top:4px">Ingresos (${valuationData.fmtVal(valuationData.totalRevenue)}) - Gastos (${valuationData.fmtVal(valuationData.totalExpenses)})</div></div>
                              <div class="metric"><div class="metric-label">Activos (Valor Libros)</div><div class="metric-value" style="color:#2563eb">${valuationData.fmtVal(valuationData.assetsBookValue)}</div><div style="font-size:11px;color:#666;margin-top:4px">Costo menos depreciación</div></div>
                              <div class="metric"><div class="metric-label">Inversiones</div><div class="metric-value" style="color:#7c3aed">${valuationData.fmtVal(valuationData.investmentsValue)}</div><div style="font-size:11px;color:#666;margin-top:4px">Valor actual de cartera</div></div>
                              <div class="metric" style="background:#e0f2fe"><div class="metric-label">Valoración Total</div><div class="metric-value" style="color:#0369a1">${valuationData.fmtVal(valuationData.totalValuation)}</div></div>
                            </div>
                          </div>
                          <div class="footer">Aikestar - Sistema de Gestión Administrativa</div>
                        </body>
                        </html>
                      `);
                      win.document.close();
                      win.print();
                    }}
                    data-testid="button-download-report"
                  >
                    <FileSpreadsheet className="mr-2 h-5 w-5" /> Descargar Informe
                  </Button>
                  <Button className="flex-1 h-12 bg-gray-400 hover:bg-gray-400 text-white cursor-not-allowed relative" disabled>
                    <DollarSign className="mr-2 h-5 w-5" /> Contactar Inversor
                    <span className="absolute -top-2 -right-2 text-[10px] px-2 py-0.5 bg-orange-500 text-white rounded-full font-bold">Pronto</span>
                  </Button>
                </div>
             </div>
             
             <div className="bg-secondary/30 p-8 rounded-2xl border border-border">
                <h3 className="font-bold mb-4">Componentes de Valor</h3>
                <div className="space-y-4">
                   <div className="flex justify-between items-center p-3 bg-green-50 rounded-lg border border-green-200 cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
                     // Use the same selectors as card-valuation-ebitda so the
                     // sidebar entry can never drift from the card top number
                     // (Task #199 — previously this row used a looser filter
                     // missing reportable + passesCodeFilter exclusions).
                     const ctx = { scopeAccountIds: includedAccountIds, passesCodeFilter };
                     const revTx = selectIngresosRows(transactions, ctx);
                     const expTx = selectAllExpensesRows(transactions, ctx);
                     setDrillDown(buildValuationEbitdaDrillDown({
                       revTx, expTx,
                       totalRevenue: valuationData.totalRevenue,
                       totalExpenses: valuationData.totalExpenses,
                       ebitda: valuationData.ebitda,
                       formatValue: valuationData.fmtVal,
                     }));
                   }} data-testid="sidebar-ebitda">
                     <div>
                       <span className="text-green-700 font-medium">EBITDA</span>
                       <span className="text-xs text-green-600 ml-2">(Ingresos - Gastos Op.)</span>
                     </div>
                     <span className="font-bold text-green-700 cursor-default" title={valuationData.fmtVal(valuationData.ebitda)}>{valuationData.fmtValCompact(valuationData.ebitda)}</span>
                   </div>
                   <div className="flex justify-between items-center p-3 bg-blue-50 rounded-lg border border-blue-200 cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
                     const assetItems: GenericDrillDownItem[] = [
                       ...(assets || []).map((a: any) => {
                         const acqVal = parseFloat(a.acquisitionValue?.toString() || '0');
                         const depr = parseFloat(a.accumulatedDepreciation?.toString() || '0');
                         const bv = Math.max(0, acqVal - depr);
                         return { id: a.id, label: a.name, sublabel: a.assetType || 'Activo', amount: valuationData.fmtVal(convertToSelected(bv, a.currency || 'ARS')), badge: a.status || 'activo' };
                       }),
                       ...(products || []).filter((p: any) => p.productType === 'asset' && p.isActive !== false).map((p: any) => {
                         const val = parseFloat(p.currentValue?.toString() || '0') || parseFloat(p.costPrice?.toString() || '0');
                         return { id: p.id, label: p.name, sublabel: 'Producto/Activo', amount: valuationData.fmtVal(convertToSelected(val, p.costCurrency || 'ARS')), badge: 'producto' };
                       }),
                       ...(products || []).filter((p: any) => p.productType === 'product' && p.isActive !== false).map((p: any) => {
                         const stock = parseFloat(p.stock?.toString() || '0') || 0;
                         const cost = parseFloat(p.costPrice?.toString() || '0') || 0;
                         return { p, stock, cost };
                       }).filter((x: any) => x.stock > 0 && x.cost > 0).map((x: any) => ({
                         id: x.p.id,
                         label: x.p.name,
                         sublabel: `Inventario (${x.stock.toLocaleString('es-AR')} × ${valuationData.fmtVal(convertToSelected(x.cost, x.p.costCurrency || 'ARS'))})`,
                         amount: valuationData.fmtVal(convertToSelected(x.stock * x.cost, x.p.costCurrency || 'ARS')),
                         badge: 'inventario',
                       })),
                     ];
                     setDrillDown(buildActivosFisicosDrillDown({
                       items: assetItems,
                       totalValue: valuationData.assetsBookValue,
                       formatValue: valuationData.fmtVal,
                     }));
                   }} data-testid="sidebar-assets">
                     <div>
                       <span className="text-blue-700 font-medium">Activos Físicos</span>
                       <span className="text-xs text-blue-600 ml-2">(Valor Libros)</span>
                     </div>
                     <span className="font-bold text-blue-700 cursor-default" title={valuationData.fmtVal(valuationData.assetsBookValue)}>{valuationData.fmtValCompact(valuationData.assetsBookValue)}</span>
                   </div>
                   <div className="flex justify-between items-center p-3 bg-purple-50 rounded-lg border border-purple-200 cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
                     const invItems: GenericDrillDownItem[] = [
                       ...(investments || []).map((inv: any) => {
                         const qty = parseFloat(inv.quantity?.toString() || '0');
                         const cp = parseFloat(inv.currentPrice?.toString() || '0');
                         const tc = parseFloat(inv.totalCost?.toString() || '0');
                         const cv = cp > 0 ? qty * cp : tc;
                         return { id: inv.id, label: inv.name || inv.symbol, sublabel: inv.investmentType || 'Inversión', amount: valuationData.fmtVal(convertToSelected(cv, inv.currency || 'ARS')), badge: inv.symbol };
                       }),
                       ...accounts.filter((acc: any) => acc.accountCategory === 'investment' && includedAccountIds.includes(acc.id)).map((acc: any) => ({
                         id: acc.id, label: acc.name, sublabel: 'Cuenta inversión', amount: valuationData.fmtVal(convertToSelected(normalizeAmountInput(acc.balance), acc.currency || 'ARS')), badge: acc.currency || 'ARS',
                       })),
                     ];
                     setDrillDown(buildInversionesValorActualDrillDown({
                       items: invItems,
                       totalValue: valuationData.investmentsValue,
                       formatValue: valuationData.fmtVal,
                     }));
                   }} data-testid="sidebar-investments">
                     <div>
                       <span className="text-purple-700 font-medium">Inversiones</span>
                       <span className="text-xs text-purple-600 ml-2">(Valor Actual)</span>
                     </div>
                     <span className="font-bold text-purple-700 cursor-default" title={valuationData.fmtVal(valuationData.investmentsValue)}>{valuationData.fmtValCompact(valuationData.investmentsValue)}</span>
                   </div>
                   {valuationData.hasMultipleCurrencies && (
                     <div className="flex justify-between items-center p-3 bg-background rounded-lg border border-border">
                       <span className="text-muted-foreground">Cotización ({valuationData.rateSource})</span>
                       <span className="font-medium">AR${new Intl.NumberFormat('es-AR').format(valuationData.usdRate)}/USD</span>
                     </div>
                   )}
                   <div className="flex justify-between items-center p-3 bg-primary/10 rounded-lg border border-primary/20">
                     <span className="text-primary font-medium">Valoración Total</span>
                     <span className="font-bold text-primary text-lg cursor-default" title={valuationData.fmtVal(valuationData.totalValuation)}>{valuationData.fmtValCompact(valuationData.totalValuation)}</span>
                   </div>
                </div>
             </div>
           </div>
        </TabsContent>

        <TabsContent value="ai-report" className="space-y-6 min-w-0">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-[#00D4FF]" />
                Generador de Reportes con IA
              </CardTitle>
              <CardDescription>
                Describí el reporte que necesitás y la IA lo genera automáticamente a partir de tus datos reales.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <span className="text-xs text-muted-foreground flex items-center gap-1"><Lightbulb className="h-3 w-3" /> Sugerencias:</span>
                  {[
                    { label: 'Gastos por categoría', prompt: 'Reporte de gastos agrupados por categoría del último período' },
                    { label: 'Clientes más activos', prompt: 'Ranking de clientes con más facturación o transacciones asociadas' },
                    { label: 'Flujo de caja mensual', prompt: 'Flujo de caja mensual mostrando ingresos, egresos y saldo neto por mes' },
                    { label: 'Proveedores por gasto', prompt: 'Ranking de proveedores ordenados por el total gastado' },
                    { label: 'Resumen de cuentas', prompt: 'Resumen de todas las cuentas con sus saldos actuales y tipo' },
                    { label: 'Productos por stock', prompt: 'Listado de productos ordenados por stock disponible, indicando los que están bajos' },
                  ].map(s => (
                    <Button
                      key={s.label}
                      variant="outline"
                      size="sm"
                      className="text-xs h-7 border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/10"
                      onClick={() => { setAiPrompt(s.prompt); }}
                      disabled={aiLoading}
                      data-testid={`btn-suggestion-${s.label.toLowerCase().replace(/\s+/g, '-')}`}
                    >
                      {s.label}
                    </Button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Textarea
                    placeholder="Ej: Quiero un resumen de gastos por proveedor del último trimestre..."
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    className="min-h-[60px] resize-none flex-1"
                    disabled={aiLoading}
                    data-testid="input-ai-prompt"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (aiPrompt.trim().length >= 3 && !aiLoading) {
                          generateAiReport();
                        }
                      }
                    }}
                  />
                  <Button
                    onClick={generateAiReport}
                    disabled={aiLoading || aiPrompt.trim().length < 3}
                    className="h-auto bg-gradient-to-r from-[#00D4FF] to-[#FF3366] hover:opacity-90 text-white px-6"
                    data-testid="btn-generate-ai-report"
                  >
                    {aiLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {aiLoading && (
            <Card className="border-[#00D4FF]/20">
              <CardContent className="py-12 flex flex-col items-center gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-[#00D4FF]" />
                <p className="text-muted-foreground">Analizando tus datos y generando el reporte...</p>
              </CardContent>
            </Card>
          )}

          {aiReport && !aiLoading && (
            <Card className="border-[#00D4FF]/20">
              <CardHeader>
                <div className="flex justify-between items-start gap-4 flex-wrap">
                  <div>
                    <CardTitle className="text-xl">{aiReport.titulo}</CardTitle>
                    <CardDescription className="mt-2 text-sm leading-relaxed">{aiReport.resumen}</CardDescription>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" data-testid="btn-export-ai-report">
                        <Download className="h-4 w-4 mr-2" /> Exportar <ChevronDown className="ml-1 h-3 w-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem onClick={() => {
                        if (!aiReport) return;
                        const rows = aiReport.filas.map(row => {
                          const obj: Record<string, string> = {};
                          aiReport.columnas.forEach((col, i) => { obj[col] = row[i] || ''; });
                          return obj;
                        });
                        exportToCSV(rows, aiReport.titulo.replace(/\s+/g, '_'));
                      }} data-testid="btn-export-ai-csv">
                        <FileSpreadsheet className="mr-2 h-4 w-4" /> Excel (CSV)
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => {
                        if (!aiReport) return;
                        const rows = aiReport.filas.map(row => {
                          const obj: Record<string, string> = {};
                          aiReport.columnas.forEach((col, i) => { obj[col] = row[i] || ''; });
                          return obj;
                        });
                        exportToPDF(aiReport.titulo, rows);
                      }} data-testid="btn-export-ai-pdf">
                        <FileText className="mr-2 h-4 w-4" /> PDF (Imprimir)
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                {aiReport.filas.length > 0 && (
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-muted/50">
                          {aiReport.columnas.map((col, i) => (
                            <th key={i} className="px-4 py-3 text-left font-semibold text-foreground whitespace-nowrap">{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {aiReport.filas.map((row, ri) => (
                          <tr key={ri} className={ri % 2 === 0 ? 'bg-background' : 'bg-muted/20'}>
                            {row.map((cell, ci) => (
                              <td key={ci} className="px-4 py-2.5 whitespace-nowrap">{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {aiReport.insights && aiReport.insights.length > 0 && (
                  <div className="bg-gradient-to-r from-[#00D4FF]/5 to-[#FF3366]/5 rounded-xl p-5 border border-[#00D4FF]/20">
                    <h4 className="font-semibold mb-3 flex items-center gap-2">
                      <Lightbulb className="h-4 w-4 text-[#00D4FF]" /> Observaciones de la IA
                    </h4>
                    <ul className="space-y-2">
                      {aiReport.insights.map((insight, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                          <span className="text-[#00D4FF] font-bold mt-0.5">•</span>
                          {insight}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {showConsolidated && (
          <TabsContent value="consolidated" className="space-y-4 min-w-0">
            <div className="text-xs text-muted-foreground">
              Datos agregados de las organizaciones que administrás (no de la organización activa).
            </div>
            <CrossOrgSummaryCard />
          </TabsContent>
        )}
      </Tabs>
      </div>

      <Dialog open={exportDialogOpen} onOpenChange={(open) => { if (!exportLoading) setExportDialogOpen(open); }}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {exportFormat === 'csv' ? <FileSpreadsheet className="h-5 w-5 text-green-600" /> : <FileText className="h-5 w-5 text-red-500" />}
              Exportar como {exportFormat === 'csv' ? 'Excel (CSV)' : 'PDF'}
            </DialogTitle>
            <DialogDescription>Seleccioná qué querés exportar y configurá las opciones</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3">
              <Label className="text-sm font-medium whitespace-nowrap">Período:</Label>
              <Select value={exportPeriod} onValueChange={setExportPeriod}>
                <SelectTrigger className="w-full">
                  <Calendar className="mr-2 h-4 w-4 shrink-0" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1m">Último Mes</SelectItem>
                  <SelectItem value="3m">Últimos 3 Meses</SelectItem>
                  <SelectItem value="6m">Últimos 6 Meses</SelectItem>
                  <SelectItem value="ytd">Año Actual (YTD)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {exportFormat === 'pdf' && (
              <label className="flex items-center gap-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 cursor-pointer" data-testid="export-include-charts">
                <Checkbox checked={exportIncludeCharts} onCheckedChange={(v) => setExportIncludeCharts(!!v)} />
                <Image className="h-4 w-4 text-[#00D4FF] shrink-0" />
                <div>
                  <span className="text-sm font-medium">Incluir gráficos</span>
                  <p className="text-xs text-muted-foreground">Agrega las visualizaciones al PDF</p>
                </div>
              </label>
            )}

            <Separator />

            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Reportes</p>
              <div className="space-y-1">
                {EXPORT_SECTIONS.map(opt => {
                  const Icon = opt.icon;
                  return (
                    <label
                      key={opt.key}
                      className="flex items-center gap-3 p-3 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer transition-colors border border-transparent hover:border-slate-200"
                      data-testid={`export-option-${opt.key}`}
                    >
                      <Checkbox
                        checked={exportSelections[opt.key] || false}
                        onCheckedChange={() => toggleExportSelection(opt.key)}
                      />
                      <Icon className="h-4 w-4 text-[#00D4FF] shrink-0" />
                      <div className="min-w-0">
                        <span className="text-sm font-medium">{opt.label}</span>
                        <p className="text-xs text-muted-foreground">{opt.desc}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            <Separator />

            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Datos</p>
              <div className="space-y-1">
                {EXPORT_DATA_OPTIONS.map(opt => {
                  const Icon = opt.icon;
                  return (
                    <label
                      key={opt.key}
                      className="flex items-center gap-3 p-3 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer transition-colors border border-transparent hover:border-slate-200"
                      data-testid={`export-option-${opt.key}`}
                    >
                      <Checkbox
                        checked={exportSelections[opt.key] || false}
                        onCheckedChange={() => toggleExportSelection(opt.key)}
                      />
                      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <span className="text-sm font-medium">{opt.label}</span>
                        <p className="text-xs text-muted-foreground">{opt.desc}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setExportDialogOpen(false)} disabled={exportLoading} data-testid="export-cancel">
              Cancelar
            </Button>
            <Button
              onClick={() => handleExportRef.current()}
              disabled={!Object.values(exportSelections).some(v => v) || exportLoading}
              className="bg-gradient-to-r from-[#00D4FF] to-[#0ea5e9] hover:opacity-90 text-white"
              data-testid="export-confirm"
            >
              {exportLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
              {exportLoading ? 'Exportando...' : `Exportar (${Object.values(exportSelections).filter(v => v).length})`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DrillDownModal
        open={drillDown.open}
        onClose={closeDrillDown}
        title={drillDown.title}
        formula={drillDown.formula}
        formulaLines={drillDown.formulaLines}
        transactions={drillDown.transactions}
        groups={drillDown.groups}
        genericItems={drillDown.genericItems}
        genericItemsLabel={drillDown.genericItemsLabel}
        totalLabel={drillDown.totalLabel}
        totalValue={drillDown.totalValue}
        totalFormatted={drillDown.totalFormatted}
        getAccountCurrency={getAccountCurrency}
        convertToARS={convertToSelected}
        targetCurrency={selectedCurrency}
        clients={clients}
        suppliers={suppliers}
      />
    </>
  );

  async function generateAiReport() {
    if (aiPrompt.trim().length < 3) return;
    setAiLoading(true);
    setAiReport(null);
    try {
      const result = await fetchWithAuth('/reports/ai', {
        method: 'POST',
        body: JSON.stringify({ prompt: aiPrompt.trim() }),
      });
      setAiReport(result as any);
    } catch (error: any) {
      toast({
        title: 'Error al generar reporte',
        description: error.message || 'No se pudo generar el reporte. Probá con otra descripción.',
        variant: 'destructive',
      });
    } finally {
      setAiLoading(false);
    }
  }
}
