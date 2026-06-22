import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useSearch, useLocation } from 'wouter';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransactions, useCreateTransaction, useUpdateTransaction, useDeleteTransaction, useOrganization, useAccounts, useMembership, useExchangeRates, useUser, useUpdateOrganizationById } from '@/lib/hooks';
import { CURRENCY_SYMBOLS, type Currency, type Transaction, type Account, type Client, type Supplier } from '@shared/schema';
import { calculateAllClientsCCTotal, calculateAllSuppliersCCTotal, getCurrencySymbol } from '@/lib/cc-utils';
import { fetchWithAuth, clientAPI, supplierAPI, employeeAPI, quoteAPI, transactionAPI, accountAPI, categoryAPI, productAPI, profitabilityCodeAPI } from '@/lib/api';
import { CreatableCombobox } from '@/components/ui/creatable-combobox';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar as CalendarPicker } from '@/components/ui/calendar';
import { useToast } from '@/hooks/use-toast';
import { pushGlobalUndoAction } from '@/components/UndoButton';
import { 
  Building2, 
  Users, 
  Zap, 
  CreditCard, 
  Plus,
  Calendar,
  Clock,
  ArrowUpRight,
  ArrowDownLeft,
  AlertCircle,
  Pencil,
  Trash2,
  Search,
  X,
  ArrowUpDown,
  ChevronDown,
  Loader2,
  Eye,
  Hash,
  Copy,
  User,
  Building,
  Package,
  Mail,
  Phone,
  MapPin,
  Download,
  Upload,
  Image as ImageIcon,
  CheckCircle2,
  CheckSquare,
  RefreshCw,
  Maximize2,
  Minimize2,
  ArrowUp,
  ArrowDown,
  ExternalLink,
  XCircle,
  Receipt as ReceiptIcon,
  FileText,
  FileSpreadsheet,
  Repeat,
  Wallet,
  ChevronUp,
  Sparkles
} from 'lucide-react';
import { format, isValid } from 'date-fns';
import { es } from 'date-fns/locale';
import { normalizeAmountInput, formatAmountLive, prepareQuoteAmount } from '@/lib/currency';
import { safeParseDate, filterCancellationPairs, cn } from '@/lib/utils';

const FIXED_COST_CATEGORIES = [
  { id: 'rent', label: 'Alquiler', icon: Building2 },
  { id: 'salaries', label: 'Sueldos', icon: Users },
  { id: 'services', label: 'Servicios', icon: Zap },
  { id: 'subscriptions', label: 'Suscripciones', icon: CreditCard },
  { id: 'others', label: 'Otros', icon: CreditCard },
];

const FREQUENCY_OPTIONS = [
  { id: 'one_time', label: 'Pago Único' },
  { id: 'weekly', label: 'Semanal' },
  { id: 'biweekly', label: 'Quincenal' },
  { id: 'monthly', label: 'Mensual' },
  { id: 'annual', label: 'Anual' },
];

const DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => ({ id: String(i + 1), label: String(i + 1) }));

const MONTH_OPTIONS = [
  { id: '0', label: 'Enero' },
  { id: '1', label: 'Febrero' },
  { id: '2', label: 'Marzo' },
  { id: '3', label: 'Abril' },
  { id: '4', label: 'Mayo' },
  { id: '5', label: 'Junio' },
  { id: '6', label: 'Julio' },
  { id: '7', label: 'Agosto' },
  { id: '8', label: 'Septiembre' },
  { id: '9', label: 'Octubre' },
  { id: '10', label: 'Noviembre' },
  { id: '11', label: 'Diciembre' },
];

function getTransactionTypeLabel(type: string, status?: string): string {
  if (type === 'income') return 'Ingreso';
  if (type === 'expense') return 'Egreso';
  if (type === 'transfer_in') return 'Transferencia Entrante';
  if (type === 'transfer_out') return 'Transferencia Saliente';
  if (type === 'receivable') {
    return status === 'completed' ? 'Cobrado' : 'Por Cobrar';
  }
  if (type === 'payable') {
    return status === 'completed' ? 'Pagado' : 'Por Pagar';
  }
  return type;
}

function getTransactionTypeBadgeClass(type: string, status?: string): string {
  if (type === 'income') return 'bg-green-100 text-green-700';
  if (type === 'expense') return 'bg-red-100 text-red-700';
  if (type === 'transfer_in' || type === 'transfer_out') return 'bg-purple-100 text-purple-700';
  if (type === 'receivable') {
    return status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700';
  }
  if (type === 'payable') {
    return status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700';
  }
  return 'bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-200';
}

export default function OfficePage() {
  const searchString = useSearch();
  const initialTab = (() => {
    const t = new URLSearchParams(searchString).get('tab');
    return t === 'quotes' || t === 'payables' || t === 'receivables' ? t : 'payables';
  })();
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<string>(initialTab);
  useEffect(() => {
    const t = new URLSearchParams(searchString).get('tab');
    setActiveTab(t === 'quotes' || t === 'payables' || t === 'receivables' ? t : 'payables');
  }, [searchString]);
  const handleTabChange = (v: string) => {
    setActiveTab(v);
    setCategoryFilter('all');
    navigate(`/office?tab=${v}`, { replace: true });
  };
  const { data: transactionsData = [], isLoading } = useTransactions();
  const transactions = useMemo(() => filterCancellationPairs(transactionsData as Transaction[]), [transactionsData]);
  const { data: accountsData = [] } = useAccounts();
  const accounts = accountsData as Account[];
  const { data: organization } = useOrganization();
  const createTransactionMutation = useCreateTransaction();
  const updateTransactionMutation = useUpdateTransaction();
  const deleteTransactionMutation = useDeleteTransaction();
  const { toast } = useToast();
  
  const queryClient = useQueryClient();
  
  const { data: transactionCategories = [] } = useQuery<Array<{id: string; name: string; type: string}>>({
    queryKey: ["/organization/categories"],
    queryFn: () => fetchWithAuth("/organization/categories"),
  });
  
  const { data: clients = [] } = useQuery<any[]>({
    queryKey: ['/api/clients'],
    queryFn: () => clientAPI.getAll(true),
  });
  
  const { data: suppliers = [] } = useQuery<any[]>({
    queryKey: ['/api/suppliers'],
    queryFn: () => supplierAPI.getAll(true),
  });

  const { data: payrollSummary } = useQuery<{
    totalEmployees: number;
    byCurrency: Record<string, { total: number; employees: { id: string; fullName: string; grossSalary: string; currency: string }[] }>;
    payrollPayDay: number | null;
    nextPayDate: string | null;
    payrollStatus: 'not_configured' | 'pending' | 'overdue' | 'paid';
  }>({
    queryKey: ['/api/employees/payroll-summary'],
    queryFn: () => employeeAPI.getPayrollSummary(),
  });

  const clientsCCTotals = useMemo(() => {
    return calculateAllClientsCCTotal(clients, transactionsData as Transaction[]);
  }, [clients, transactionsData]);

  const suppliersCCTotals = useMemo(() => {
    return calculateAllSuppliersCCTotal(suppliers, transactionsData as Transaction[]);
  }, [suppliers, transactionsData]);

  const [payrollExpanded, setPayrollExpanded] = useState(false);
  const [showPayrollConfig, setShowPayrollConfig] = useState(false);
  const [payrollConfigDay, setPayrollConfigDay] = useState('5');
  const [showPayrollPay, setShowPayrollPay] = useState(false);
  const [payrollPayAccountId, setPayrollPayAccountId] = useState('');
  const [payrollPaying, setPayrollPaying] = useState(false);

  const createCategoryMutation = useMutation({
    mutationFn: async ({ name, type }: { name: string; type: 'income' | 'expense' }) => {
      return fetchWithAuth("/organization/categories", {
        method: "POST",
        body: JSON.stringify({ name, type }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/organization/categories"] });
      toast({ title: "Concepto creado", description: "El nuevo concepto fue guardado para uso futuro" });
    },
    onError: (error: any) => {
      toast({ 
        title: "Error al crear concepto", 
        description: error.message || "No se pudo guardar el nuevo concepto",
        variant: "destructive" 
      });
    },
  });
  
  const expenseCategoryOptions = transactionCategories
    .filter(c => c.type === 'expense')
    .map(c => ({ value: c.name, label: c.name }));
    
  const incomeCategoryOptions = transactionCategories
    .filter(c => c.type === 'income')
    .map(c => ({ value: c.name, label: c.name }));
  
  const [isAddingFixed, setIsAddingFixed] = useState(false);
  const [isAddingRecurring, setIsAddingRecurring] = useState(false);
  const [isEditingFixed, setIsEditingFixed] = useState(false);
  const [isEditingPending, setIsEditingPending] = useState(false);
  const [editingCost, setEditingCost] = useState<any>(null);
  const [editingPending, setEditingPending] = useState<any>(null);
  const [newFixedCost, setNewFixedCost] = useState({ description: '', amount: '', category: '', frequency: 'monthly', dueDay: '1', dueMonth: '0', dueDate: '', accountId: '', currency: 'ARS', supplierId: '', installments: '' });
  const [newRecurringIncome, setNewRecurringIncome] = useState({ description: '', amount: '', frequency: 'monthly', dueDate: '', currency: 'ARS', accountId: '', category: '', clientId: '', installments: '' });
  
  // State for adding unique payables/receivables
  const [isAddingUniquePayable, setIsAddingUniquePayable] = useState(false);
  const [isAddingUniqueReceivable, setIsAddingUniqueReceivable] = useState(false);
  const [newUniquePayable, setNewUniquePayable] = useState({ description: '', amount: '', dueDate: '', currency: 'ARS', accountId: '', category: '', supplierId: '' });
  const [newUniqueReceivable, setNewUniqueReceivable] = useState({ description: '', amount: '', dueDate: '', currency: 'ARS', accountId: '', category: '', clientId: '', projectId: '' });
  
  // Sub-tabs state for each main tab
  const [payablesSubTab, setPayablesSubTab] = useState<'recurrentes' | 'unicos'>('recurrentes');
  const [receivablesSubTab, setReceivablesSubTab] = useState<'recurrentes' | 'unicos'>('recurrentes');
  
  // Display amount states for live formatting (with thousand separators)
  const [fixedCostDisplayAmount, setFixedCostDisplayAmount] = useState('');
  const [recurringIncomeDisplayAmount, setRecurringIncomeDisplayAmount] = useState('');
  const [uniquePayableDisplayAmount, setUniquePayableDisplayAmount] = useState('');
  const [uniqueReceivableDisplayAmount, setUniqueReceivableDisplayAmount] = useState('');
  const [editingCostDisplayAmount, setEditingCostDisplayAmount] = useState('');
  const [editingPendingDisplayAmount, setEditingPendingDisplayAmount] = useState('');

  const [showNewSupplierDialog, setShowNewSupplierDialog] = useState<'unique' | 'fixed' | false>(false);
  const [newSupplierName, setNewSupplierName] = useState('');
  const [showNewClientDialog, setShowNewClientDialog] = useState<'unique' | 'recurring' | false>(false);
  const [newClientName, setNewClientName] = useState('');

  const { data: receivableClientProjects = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['/api/clients', newUniqueReceivable.clientId, 'projects'],
    queryFn: () => clientAPI.getProjects(newUniqueReceivable.clientId),
    enabled: !!newUniqueReceivable.clientId,
  });

  const editingPendingClientId = editingPending?.clientId || '';
  const { data: editingPendingProjects = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['/api/clients', editingPendingClientId, 'projects'],
    queryFn: () => clientAPI.getProjects(editingPendingClientId),
    enabled: !!editingPendingClientId,
  });

  // Detail dialog state
  const [viewingOfficeDetail, setViewingOfficeDetail] = useState<string | null>(null);
  const [isDetailsMaximized, setIsDetailsMaximized] = useState(false);
  const [isEditingDetail, setIsEditingDetail] = useState(false);
  const [editDetailAmount, setEditDetailAmount] = useState('');
  const [editDetailCategory, setEditDetailCategory] = useState('');
  const [editDetailAccountId, setEditDetailAccountId] = useState('');
  const [savingDetail, setSavingDetail] = useState(false);
  // Approval state
  const [approvingTransaction, setApprovingTransaction] = useState(false);
  const [showApprovalConfirm, setShowApprovalConfirm] = useState(false);
  const [approvalRecurring, setApprovalRecurring] = useState(false);
  const [approvalFrequency, setApprovalFrequency] = useState<string>('monthly');
  const [approvalAccountId, setApprovalAccountId] = useState<string>('');

  const [selectedPayments, setSelectedPayments] = useState<Set<string>>(new Set());
  const [bulkApproving, setBulkApproving] = useState(false);

  const { data: officeTransactionDetails, isLoading: officeDetailsLoading } = useQuery({
    queryKey: ['transaction', viewingOfficeDetail],
    queryFn: async () => {
      const res = await fetch(`/api/transactions/${viewingOfficeDetail}`, {
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
    enabled: !!viewingOfficeDetail,
  });

  const startEditingDetail = () => {
    if (!officeTransactionDetails) return;
    const num = parseFloat(officeTransactionDetails.amount.toString());
    const formatted = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num);
    setEditDetailAmount(formatted);
    setEditDetailCategory(officeTransactionDetails.category);
    setEditDetailAccountId(officeTransactionDetails.accountId || '');
    setIsEditingDetail(true);
  };

  const cancelEditingDetail = () => {
    setIsEditingDetail(false);
  };

  const saveDetailEdits = async () => {
    if (!officeTransactionDetails) return;
    setSavingDetail(true);
    try {
      const numericAmount = editDetailAmount.replace(/\./g, '').replace(',', '.');
      await fetchWithAuth(`/transactions/${officeTransactionDetails.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          amount: numericAmount,
          category: editDetailCategory,
          accountId: editDetailAccountId,
          // Preservar el estado explícitamente. Editar un compromiso NO debe
          // confirmarlo: si no mandamos status, el backend lo deriva de la
          // fecha de vencimiento y, si vence hoy o ya venció, lo marca como
          // completado (confirmando el pago sin que el usuario lo pida).
          status: officeTransactionDetails.status,
        }),
      });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
      queryClient.invalidateQueries({ queryKey: ['transaction', officeTransactionDetails.id] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast({
        title: "Cambios guardados",
        description: "El movimiento fue actualizado correctamente.",
      });
      setIsEditingDetail(false);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudieron guardar los cambios",
        variant: "destructive",
      });
    } finally {
      setSavingDetail(false);
    }
  };

  const openApprovalConfirm = () => {
    if (!officeTransactionDetails) return;
    const isAlreadyRecurring = officeTransactionDetails.isRecurring || 
      !!officeTransactionDetails.recurrenceSourceId || 
      !!officeTransactionDetails.recurrenceFrequency;
    setApprovalRecurring(isAlreadyRecurring);
    setApprovalFrequency(officeTransactionDetails.recurrenceFrequency || 'monthly');
    const txCurrency = officeTransactionDetails.currency || 'ARS';
    const compatibleAccounts = filterAccountsByCurrency(txCurrency);
    const currentAccountValid = officeTransactionDetails.accountId && 
      compatibleAccounts.some(a => a.id === officeTransactionDetails.accountId);
    setApprovalAccountId(currentAccountValid ? officeTransactionDetails.accountId : 
      (compatibleAccounts.length === 1 ? compatibleAccounts[0].id : ''));
    setShowApprovalConfirm(true);
  };

  const approveTransaction = async () => {
    if (!officeTransactionDetails) return;
    setApprovingTransaction(true);
    try {
      const body: Record<string, any> = { status: 'completed' };
      if (approvalAccountId) {
        body.accountId = approvalAccountId;
      }
      if (approvalRecurring) {
        body.isRecurring = true;
        body.recurrenceFrequency = approvalFrequency;
      }
      const result = await fetchWithAuth(`/transactions/${officeTransactionDetails.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
      queryClient.invalidateQueries({ queryKey: ['transaction', officeTransactionDetails.id] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/notifications'] });
      queryClient.invalidateQueries({ queryKey: ['/api/pending-commitments'] });
      toast({
        title: "Movimiento aprobado",
        description: approvalRecurring
          ? "Completado y programado el próximo compromiso automáticamente."
          : "El movimiento ha sido completado exitosamente.",
      });
      if (result?.undoKey) {
        pushGlobalUndoAction({
          undoKey: result.undoKey,
          entityType: 'transaction_approved',
          entityName: result.description || officeTransactionDetails.description || '',
          expiresAt: Date.now() + 55_000,
        });
      }
      setShowApprovalConfirm(false);
      setViewingOfficeDetail(null);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo aprobar el movimiento",
        variant: "destructive",
      });
    } finally {
      setApprovingTransaction(false);
    }
  };

  const togglePaymentSelection = (id: string) => {
    setSelectedPayments(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllInList = (items: any[]) => {
    const ids = items.map(i => i.id);
    const allSelected = ids.every(id => selectedPayments.has(id));
    setSelectedPayments(prev => {
      const next = new Set(prev);
      if (allSelected) {
        ids.forEach(id => next.delete(id));
      } else {
        ids.forEach(id => next.add(id));
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedPayments(new Set());

  // Search and filter state
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'overdue'>('all');
  const [currencyFilter, setCurrencyFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  
  // Pagination state - "Ver más" approach with initial limit
  const ITEMS_PER_PAGE = 10;
  const [recurringPayablesLimit, setRecurringPayablesLimit] = useState(ITEMS_PER_PAGE);
  const [uniquePayablesLimit, setUniquePayablesLimit] = useState(ITEMS_PER_PAGE);
  const [recurringReceivablesLimit, setRecurringReceivablesLimit] = useState(ITEMS_PER_PAGE);
  const [uniqueReceivablesLimit, setUniqueReceivablesLimit] = useState(ITEMS_PER_PAGE);
  
  // Sorting state
  const [sortBy, setSortBy] = useState<'date' | 'amount' | 'name'>('date');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const supplierNameMap = useMemo(() => {
    const map = new Map<string, string>();
    (suppliers as Supplier[]).forEach(s => map.set(s.id, s.name));
    return map;
  }, [suppliers]);

  const clientNameMap = useMemo(() => {
    const map = new Map<string, string>();
    (clients as Client[]).forEach(c => map.set(c.id, c.name));
    return map;
  }, [clients]);

  const formatCurrency = (val: number | string, currency: Currency = 'ARS') => {
    const num = typeof val === 'string' ? parseFloat(val) : val;
    const symbol = CURRENCY_SYMBOLS[currency] || 'AR$';
    return symbol + new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num);
  };

  const filterAccountsByCurrency = (currency: string) => {
    if (currency === 'USD' || currency === 'USD_CASH') {
      return accounts.filter(a => a.currency === 'USD' || a.currency === 'USD_CASH');
    }
    return accounts.filter(a => a.currency === currency);
  };

  // Get expense and income categories dynamically from the database
  const expenseCategoryNames = transactionCategories
    .filter(c => c.type === 'expense')
    .map(c => c.name);

  // Filter transactions for fixed costs (expenses or payables with expense categories)
  const fixedCosts = transactions.filter(t => 
    (t.type === 'expense' || t.type === 'payable') && expenseCategoryNames.includes(t.category ?? '')
  );

  // Payable/receivable statuses that should show as pending (not yet paid/collected)
  const pendingStatuses = ['scheduled'];
  
  // Filter for unique payables (isUniquePayment = true) - sorted by date (soonest first)
  const pendingPayables = transactions
    .filter(t => t.type === 'payable' && pendingStatuses.includes(t.status) && t.isUniquePayment === true)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  
  const recurringPayables = transactions
    .filter(t => t.type === 'payable' && pendingStatuses.includes(t.status) && !t.isUniquePayment && t.category !== 'Sueldos')
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // Filter for recurring receivables (income categories)
  const recurringReceivables = transactions
    .filter(t => t.type === 'receivable' && pendingStatuses.includes(t.status) && !t.isUniquePayment)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  
  // Filter for unique receivables (isUniquePayment = true) - sorted by date (soonest first)
  const uniqueReceivables = transactions
    .filter(t => t.type === 'receivable' && pendingStatuses.includes(t.status) && t.isUniquePayment === true)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  
  // All pending receivables for total calculation
  const pendingReceivables = transactions
    .filter(t => t.type === 'receivable' && pendingStatuses.includes(t.status))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // Categorías presentes en cada listado (para el filtro por categoría, separadas por pestaña)
  const uniqueCategoriesFrom = (...lists: Transaction[][]) =>
    Array.from(
      new Set(
        lists.flat()
          .map(t => t.category)
          .filter((c): c is string => !!c)
      )
    ).sort((a, b) => a.localeCompare(b));
  const payableCategories = uniqueCategoriesFrom(recurringPayables, pendingPayables);
  const receivableCategories = uniqueCategoriesFrom(recurringReceivables, uniqueReceivables);

  // Calculate totals grouped by currency (transactions + payroll)
  const allPayables = [...recurringPayables, ...pendingPayables];
  const payablesByCurrency = allPayables.reduce((acc, t) => {
    let currency = (t.currency as Currency) || 'ARS';
    if (currency === 'USD_CASH' || currency.toString().toUpperCase().includes('USD')) {
      currency = 'USD' as Currency;
    }
    acc[currency] = (acc[currency] || 0) + normalizeAmountInput(t.amount);
    return acc;
  }, {} as Record<Currency, number>);
  if (payrollSummary && payrollSummary.totalEmployees > 0) {
    Object.entries(payrollSummary.byCurrency).forEach(([c, d]) => {
      const k = ((c === 'USD_CASH' || c.toUpperCase().includes('USD')) ? 'USD' : c) as Currency;
      payablesByCurrency[k] = (payablesByCurrency[k] || 0) + d.total;
    });
  }

  const receivablesByCurrency = pendingReceivables.reduce((acc, t) => {
    let currency = (t.currency as Currency) || 'ARS';
    // Normalize USD variants to consolidate all dollar amounts
    if (currency === 'USD_CASH' || currency.toString().toUpperCase().includes('USD')) {
      currency = 'USD' as Currency;
    }
    acc[currency] = (acc[currency] || 0) + normalizeAmountInput(t.amount);
    return acc;
  }, {} as Record<Currency, number>);

  const recurringPayableTotal = recurringPayables.reduce((acc, t) => acc + normalizeAmountInput(t.amount), 0);
  const uniquePayableTotal = pendingPayables.reduce((acc, t) => acc + normalizeAmountInput(t.amount), 0);
  const recurringReceivableTotal = recurringReceivables.reduce((acc, t) => acc + normalizeAmountInput(t.amount), 0);
  const uniqueReceivableTotal = uniqueReceivables.reduce((acc, t) => acc + normalizeAmountInput(t.amount), 0);

  const groupByCurrency = (items: typeof recurringPayables) => items.reduce((acc, t) => {
    let currency = (t.currency as Currency) || 'ARS';
    if (currency === 'USD_CASH' || currency.toString().toUpperCase().includes('USD')) currency = 'USD' as Currency;
    acc[currency] = (acc[currency] || 0) + normalizeAmountInput(t.amount);
    return acc;
  }, {} as Record<Currency, number>);

  const recurringPayableByCurrency = groupByCurrency(recurringPayables);
  const uniquePayableByCurrency = groupByCurrency(pendingPayables);
  const recurringReceivableByCurrency = groupByCurrency(recurringReceivables);
  const uniqueReceivableByCurrency = groupByCurrency(uniqueReceivables);

  // Helper function to check if a transaction is overdue
  const isOverdue = (item: any) => {
    const dueDate = item.date ? safeParseDate(item.date) : null;
    return dueDate && dueDate < new Date();
  };

  // Sorting function
  const sortItems = (items: any[], sortField: 'date' | 'amount' | 'name', order: 'asc' | 'desc') => {
    return [...items].sort((a, b) => {
      let comparison = 0;
      if (sortField === 'date') {
        comparison = new Date(a.date).getTime() - new Date(b.date).getTime();
      } else if (sortField === 'amount') {
        comparison = normalizeAmountInput(a.amount) - normalizeAmountInput(b.amount);
      } else if (sortField === 'name') {
        comparison = (a.description || '').localeCompare(b.description || '');
      }
      return order === 'asc' ? comparison : -comparison;
    });
  };

  // Filtered and sorted data with search and filters
  const filteredRecurringPayables = useMemo(() => {
    const filtered = recurringPayables.filter(item => {
      const matchesSearch = searchTerm === '' || 
        item.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.category?.toLowerCase().includes(searchTerm.toLowerCase());
      
      const matchesCurrency = currencyFilter === 'all' || item.currency === currencyFilter;
      
      const matchesStatus = statusFilter === 'all' || 
        (statusFilter === 'overdue' && isOverdue(item)) ||
        (statusFilter === 'pending' && !isOverdue(item));
      
      const matchesCategory = categoryFilter === 'all' || item.category === categoryFilter;

      return matchesSearch && matchesCurrency && matchesCategory && matchesStatus;
    });
    return sortItems(filtered, sortBy, sortOrder);
  }, [recurringPayables, searchTerm, currencyFilter, categoryFilter, statusFilter, sortBy, sortOrder]);

  const filteredPendingPayables = useMemo(() => {
    const filtered = pendingPayables.filter(item => {
      const matchesSearch = searchTerm === '' || 
        item.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.category?.toLowerCase().includes(searchTerm.toLowerCase());
      
      const matchesCurrency = currencyFilter === 'all' || item.currency === currencyFilter;
      
      const matchesStatus = statusFilter === 'all' || 
        (statusFilter === 'overdue' && isOverdue(item)) ||
        (statusFilter === 'pending' && !isOverdue(item));
      
      const matchesCategory = categoryFilter === 'all' || item.category === categoryFilter;

      return matchesSearch && matchesCurrency && matchesCategory && matchesStatus;
    });
    return sortItems(filtered, sortBy, sortOrder);
  }, [pendingPayables, searchTerm, currencyFilter, categoryFilter, statusFilter, sortBy, sortOrder]);

  const filteredRecurringReceivables = useMemo(() => {
    const filtered = recurringReceivables.filter(item => {
      const matchesSearch = searchTerm === '' || 
        item.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.category?.toLowerCase().includes(searchTerm.toLowerCase());
      
      const matchesCurrency = currencyFilter === 'all' || item.currency === currencyFilter;
      
      const matchesStatus = statusFilter === 'all' || 
        (statusFilter === 'overdue' && isOverdue(item)) ||
        (statusFilter === 'pending' && !isOverdue(item));
      
      const matchesCategory = categoryFilter === 'all' || item.category === categoryFilter;

      return matchesSearch && matchesCurrency && matchesCategory && matchesStatus;
    });
    return sortItems(filtered, sortBy, sortOrder);
  }, [recurringReceivables, searchTerm, currencyFilter, categoryFilter, statusFilter, sortBy, sortOrder]);

  const filteredUniqueReceivables = useMemo(() => {
    const filtered = uniqueReceivables.filter(item => {
      const matchesSearch = searchTerm === '' || 
        item.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.category?.toLowerCase().includes(searchTerm.toLowerCase());
      
      const matchesCurrency = currencyFilter === 'all' || item.currency === currencyFilter;
      
      const matchesStatus = statusFilter === 'all' || 
        (statusFilter === 'overdue' && isOverdue(item)) ||
        (statusFilter === 'pending' && !isOverdue(item));
      
      const matchesCategory = categoryFilter === 'all' || item.category === categoryFilter;

      return matchesSearch && matchesCurrency && matchesCategory && matchesStatus;
    });
    return sortItems(filtered, sortBy, sortOrder);
  }, [uniqueReceivables, searchTerm, currencyFilter, categoryFilter, statusFilter, sortBy, sortOrder]);

  const selectedItems = useMemo(() => {
    const allPending = [...(filteredRecurringPayables || []), ...(filteredPendingPayables || []), ...(filteredRecurringReceivables || []), ...(filteredUniqueReceivables || [])];
    return allPending.filter(t => selectedPayments.has(t.id));
  }, [selectedPayments, filteredRecurringPayables, filteredPendingPayables, filteredRecurringReceivables, filteredUniqueReceivables]);

  const selectedTotal = useMemo(() => {
    const byCurrency: Record<string, number> = {};
    selectedItems.forEach(item => {
      const curr = (item.currency as string) || 'ARS';
      const amt = typeof item.amount === 'string' ? parseFloat(item.amount) : item.amount;
      byCurrency[curr] = (byCurrency[curr] || 0) + amt;
    });
    return byCurrency;
  }, [selectedItems]);

  const bulkApproveSelected = async () => {
    if (selectedItems.length === 0) return;
    setBulkApproving(true);
    let successCount = 0;
    let failCount = 0;
    for (const item of selectedItems) {
      try {
        const body: Record<string, any> = { status: 'completed' };
        if (item.isRecurring || item.recurrenceSourceId || item.recurrenceFrequency) {
          body.isRecurring = true;
          body.recurrenceFrequency = item.recurrenceFrequency || 'monthly';
        }
        const result = await fetchWithAuth(`/transactions/${item.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        successCount++;
        if (result?.undoKey) {
          pushGlobalUndoAction({
            undoKey: result.undoKey,
            entityType: 'transaction_approved',
            entityName: result.description || item.description || '',
            expiresAt: Date.now() + 55_000,
          });
        }
      } catch {
        failCount++;
      }
    }
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
    queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
    queryClient.invalidateQueries({ queryKey: ['accounts'] });
    queryClient.invalidateQueries({ queryKey: ['/api/notifications'] });
    queryClient.invalidateQueries({ queryKey: ['/api/pending-commitments'] });
    if (failCount === 0) {
      toast({ title: "Movimientos aprobados", description: `Se confirmaron ${successCount} movimientos exitosamente.` });
    } else {
      toast({ title: "Aprobación parcial", description: `${successCount} confirmados, ${failCount} con error.`, variant: "destructive" });
    }
    clearSelection();
    setBulkApproving(false);
  };

  // Paginated data (items visible based on current limit)
  const visibleRecurringPayables = filteredRecurringPayables.slice(0, recurringPayablesLimit);
  const visiblePendingPayables = filteredPendingPayables.slice(0, uniquePayablesLimit);
  const visibleRecurringReceivables = filteredRecurringReceivables.slice(0, recurringReceivablesLimit);
  const visibleUniqueReceivables = filteredUniqueReceivables.slice(0, uniqueReceivablesLimit);
  
  // Check if there are more items to show
  const hasMoreRecurringPayables = filteredRecurringPayables.length > recurringPayablesLimit;
  const hasMorePendingPayables = filteredPendingPayables.length > uniquePayablesLimit;
  const hasMoreRecurringReceivables = filteredRecurringReceivables.length > recurringReceivablesLimit;
  const hasMoreUniqueReceivables = filteredUniqueReceivables.length > uniqueReceivablesLimit;
  
  // Load more functions
  const loadMoreRecurringPayables = () => setRecurringPayablesLimit(prev => prev + ITEMS_PER_PAGE);
  const loadMorePendingPayables = () => setUniquePayablesLimit(prev => prev + ITEMS_PER_PAGE);
  const loadMoreRecurringReceivables = () => setRecurringReceivablesLimit(prev => prev + ITEMS_PER_PAGE);
  const loadMoreUniqueReceivables = () => setUniqueReceivablesLimit(prev => prev + ITEMS_PER_PAGE);

  // Check if any filters are active
  const hasActiveFilters = searchTerm !== '' || statusFilter !== 'all' || currencyFilter !== 'all' || categoryFilter !== 'all';

  // Clear all filters
  const clearFilters = () => {
    setSearchTerm('');
    setStatusFilter('all');
    setCurrencyFilter('all');
    setCategoryFilter('all');
  };

  // Legacy totals (for backwards compatibility)
  const totalFixedCosts = fixedCosts.reduce((acc, t) => acc + normalizeAmountInput(t.amount), 0);
  const totalRecurringPayables = recurringPayables.reduce((acc, t) => acc + normalizeAmountInput(t.amount), 0);
  const totalPendingPayables = pendingPayables.reduce((acc, t) => acc + normalizeAmountInput(t.amount), 0);
  const totalAllPayables = totalRecurringPayables + totalPendingPayables;
  const totalPendingReceivables = pendingReceivables.reduce((acc, t) => acc + normalizeAmountInput(t.amount), 0);

  const clampDay = (day: number, year: number, month: number): number => {
    const lastDay = new Date(year, month + 1, 0).getDate();
    return Math.min(day, lastDay);
  };

  const calculateDueDate = (frequency: string, dueDay: string, specificDate: string, dueMonth?: string) => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    
    if ((frequency === 'one_time' || frequency === 'weekly' || frequency === 'biweekly') && specificDate) {
      return new Date(specificDate + 'T12:00:00');
    }
    
    if (frequency === 'weekly' || frequency === 'biweekly') {
      const nextWeek = new Date(today);
      nextWeek.setDate(today.getDate() + 7);
      return nextWeek;
    }
    
    if (frequency === 'annual') {
      const month = dueMonth ? parseInt(dueMonth) : today.getMonth();
      const day = parseInt(dueDay);
      const clampedDay = clampDay(day, today.getFullYear(), month);
      const dueDate = new Date(today.getFullYear(), month, clampedDay, 12, 0, 0);
      
      if (dueDate < today) {
        const nextYear = today.getFullYear() + 1;
        const clampedDayNextYear = clampDay(day, nextYear, month);
        return new Date(nextYear, month, clampedDayNextYear, 12, 0, 0);
      }
      return dueDate;
    }
    
    const day = parseInt(dueDay);
    let targetMonth = today.getMonth();
    let targetYear = today.getFullYear();
    const clampedDay = clampDay(day, targetYear, targetMonth);
    let dueDate = new Date(targetYear, targetMonth, clampedDay, 12, 0, 0);
    
    if (dueDate < today) {
      targetMonth++;
      if (targetMonth > 11) {
        targetMonth = 0;
        targetYear++;
      }
      const nextClampedDay = clampDay(day, targetYear, targetMonth);
      dueDate = new Date(targetYear, targetMonth, nextClampedDay, 12, 0, 0);
    }
    
    return dueDate;
  };

  const handleAddFixedCost = async () => {
    if (!newFixedCost.description || !newFixedCost.amount || !newFixedCost.category || !newFixedCost.accountId) {
      toast({ title: "Error", description: "Completá todos los campos obligatorios (descripción, monto, categoría y cuenta)", variant: "destructive" });
      return;
    }

    if ((newFixedCost.frequency === 'one_time' || newFixedCost.frequency === 'weekly' || newFixedCost.frequency === 'biweekly') && !newFixedCost.dueDate) {
      toast({ title: "Error", description: "Seleccioná la fecha del primer pago", variant: "destructive" });
      return;
    }

    const dueDate = calculateDueDate(newFixedCost.frequency, newFixedCost.dueDay, newFixedCost.dueDate, newFixedCost.dueMonth);
    const frequencyLabel = FREQUENCY_OPTIONS.find(f => f.id === newFixedCost.frequency)?.label || '';

    const isRecurringPayment = newFixedCost.frequency !== 'one_time';
    const recurrenceFrequencyMap: Record<string, string> = {
      'weekly': 'weekly',
      'biweekly': 'biweekly',
      'monthly': 'monthly',
      'annual': 'yearly',
    };

    let recurrenceTotalInstallments: number | null = null;
    if (isRecurringPayment) {
      const raw = newFixedCost.installments.trim();
      if (raw !== '') {
        if (!/^\d+$/.test(raw)) {
          toast({ title: "Error", description: "La cantidad de cuotas debe ser un número entero mayor o igual a 1", variant: "destructive" });
          return;
        }
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1) {
          toast({ title: "Error", description: "La cantidad de cuotas debe ser un número entero mayor o igual a 1", variant: "destructive" });
          return;
        }
        recurrenceTotalInstallments = parsed;
      }
    }

    try {
      await createTransactionMutation.mutateAsync({
        type: 'payable',
        amount: newFixedCost.amount,
        description: `${newFixedCost.description} [${frequencyLabel}]`,
        category: newFixedCost.category,
        organizationId: organization?.id,
        accountId: newFixedCost.accountId,
        currency: newFixedCost.currency,
        date: dueDate.toISOString(),
        imputationDate: dueDate.toISOString(),
        hasInvoice: false,
        invoiceType: null,
        invoiceNumber: null,
        invoiceTaxId: null,
        status: 'scheduled',
        isRecurring: isRecurringPayment,
        recurrenceFrequency: isRecurringPayment ? recurrenceFrequencyMap[newFixedCost.frequency] : null,
        recurrenceTotalInstallments,
        supplierId: newFixedCost.supplierId || null,
      });

      toast({ title: "Costo fijo agregado", description: `${newFixedCost.description} aparecerá en Por Pagar` });
      setNewFixedCost({ description: '', amount: '', category: '', frequency: 'monthly', dueDay: '1', dueMonth: '0', dueDate: '', accountId: '', currency: 'ARS', supplierId: '', installments: '' });
      setFixedCostDisplayAmount('');
      setIsAddingFixed(false);
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const handleAddRecurringIncome = async () => {
    if (!newRecurringIncome.description || !newRecurringIncome.amount || !newRecurringIncome.dueDate) {
      toast({ title: "Error", description: "Completá todos los campos incluyendo la fecha", variant: "destructive" });
      return;
    }

    // Add noon time to avoid timezone issues (midnight UTC becomes previous day in Argentina)
    const dueDate = new Date(newRecurringIncome.dueDate + 'T12:00:00');
    
    // Get currency from selected account
    let currency = newRecurringIncome.currency || 'ARS';
    if (newRecurringIncome.accountId) {
      const selectedAccount = accounts.find(a => a.id === newRecurringIncome.accountId);
      if (selectedAccount?.currency) {
        currency = selectedAccount.currency;
      }
    }
    
    const isRecurringIncome = newRecurringIncome.frequency !== 'once';
    const recurrenceMap: Record<string, string> = {
      'weekly': 'weekly',
      'biweekly': 'biweekly',
      'monthly': 'monthly',
      'annual': 'yearly',
    };

    let recurrenceTotalInstallments: number | null = null;
    if (isRecurringIncome) {
      const raw = newRecurringIncome.installments.trim();
      if (raw !== '') {
        if (!/^\d+$/.test(raw)) {
          toast({ title: "Error", description: "La cantidad de cuotas debe ser un número entero mayor o igual a 1", variant: "destructive" });
          return;
        }
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1) {
          toast({ title: "Error", description: "La cantidad de cuotas debe ser un número entero mayor o igual a 1", variant: "destructive" });
          return;
        }
        recurrenceTotalInstallments = parsed;
      }
    }

    try {
      await createTransactionMutation.mutateAsync({
        type: 'receivable',
        amount: newRecurringIncome.amount,
        description: newRecurringIncome.description,
        category: newRecurringIncome.category || 'Abonos',
        organizationId: organization?.id,
        accountId: newRecurringIncome.accountId || null,
        currency: currency,
        date: dueDate.toISOString(),
        imputationDate: dueDate.toISOString(),
        hasInvoice: false,
        invoiceType: null,
        invoiceNumber: null,
        invoiceTaxId: null,
        status: 'scheduled',
        isRecurring: isRecurringIncome,
        recurrenceFrequency: isRecurringIncome ? recurrenceMap[newRecurringIncome.frequency] : null,
        recurrenceTotalInstallments,
        clientId: newRecurringIncome.clientId || null,
      });

      toast({ title: "Ingreso futuro agregado", description: `${newRecurringIncome.description} registrado correctamente` });
      setNewRecurringIncome({ description: '', amount: '', frequency: 'monthly', dueDate: '', currency: 'ARS', accountId: '', category: '', clientId: '', installments: '' });
      setRecurringIncomeDisplayAmount('');
      setIsAddingRecurring(false);
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const handleAddUniquePayable = async () => {
    if (!newUniquePayable.description || !newUniquePayable.amount || !newUniquePayable.dueDate) {
      toast({ title: "Error", description: "Completá todos los campos", variant: "destructive" });
      return;
    }

    // Add noon time to avoid timezone issues (midnight UTC becomes previous day in Argentina)
    const dueDate = new Date(newUniquePayable.dueDate + 'T12:00:00');
    
    // Para pagos, auto-asignar cuenta con MÁS saldo (tiene más plata disponible)
    let selectedAccountId = newUniquePayable.accountId;
    if (!selectedAccountId || selectedAccountId === 'auto') {
      const matchingAccounts = filterAccountsByCurrency(newUniquePayable.currency);
      if (matchingAccounts.length > 0) {
        const highestBalanceAccount = matchingAccounts.reduce((prev, curr) => 
          normalizeAmountInput(curr.balance) > normalizeAmountInput(prev.balance) ? curr : prev
        );
        selectedAccountId = highestBalanceAccount.id;
      }
    }
    
    // Get currency from selected account or form state
    let currency = newUniquePayable.currency || 'ARS';
    if (selectedAccountId) {
      const selectedAccount = accounts.find(a => a.id === selectedAccountId);
      if (selectedAccount?.currency) {
        currency = selectedAccount.currency;
      }
    }
    
    try {
      await createTransactionMutation.mutateAsync({
        type: 'payable',
        amount: newUniquePayable.amount,
        description: newUniquePayable.description,
        category: newUniquePayable.category || 'Gastos Varios',
        organizationId: organization?.id,
        accountId: selectedAccountId || null,
        currency: currency,
        date: dueDate.toISOString(),
        imputationDate: dueDate.toISOString(),
        hasInvoice: false,
        invoiceType: null,
        invoiceNumber: null,
        invoiceTaxId: null,
        status: 'scheduled',
        isUniquePayment: true,
        supplierId: newUniquePayable.supplierId || null,
      });

      toast({ title: "Pago único agregado", description: `${newUniquePayable.description} registrado correctamente` });
      setNewUniquePayable({ description: '', amount: '', dueDate: '', currency: 'ARS', accountId: '', category: '', supplierId: '' });
      setUniquePayableDisplayAmount('');
      setIsAddingUniquePayable(false);
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const handleAddUniqueReceivable = async () => {
    if (!newUniqueReceivable.description || !newUniqueReceivable.amount || !newUniqueReceivable.dueDate) {
      toast({ title: "Error", description: "Completá todos los campos", variant: "destructive" });
      return;
    }

    // Add noon time to avoid timezone issues (midnight UTC becomes previous day in Argentina)
    const dueDate = new Date(newUniqueReceivable.dueDate + 'T12:00:00');
    
    // Auto-assign account with lowest balance if not selected
    let selectedAccountId = newUniqueReceivable.accountId;
    if (!selectedAccountId || selectedAccountId === 'auto') {
      const matchingAccounts = filterAccountsByCurrency(newUniqueReceivable.currency);
      if (matchingAccounts.length > 0) {
        const lowestBalanceAccount = matchingAccounts.reduce((prev, curr) => 
          normalizeAmountInput(curr.balance) < normalizeAmountInput(prev.balance) ? curr : prev
        );
        selectedAccountId = lowestBalanceAccount.id;
      }
    }

    // Get currency from selected account or form state
    let currency = newUniqueReceivable.currency || 'ARS';
    if (selectedAccountId) {
      const selectedAccount = accounts.find(a => a.id === selectedAccountId);
      if (selectedAccount?.currency) {
        currency = selectedAccount.currency;
      }
    }
    
    try {
      await createTransactionMutation.mutateAsync({
        type: 'receivable',
        amount: newUniqueReceivable.amount,
        description: newUniqueReceivable.description,
        category: newUniqueReceivable.category || 'Otros Ingresos',
        organizationId: organization?.id,
        accountId: selectedAccountId || null,
        currency: currency,
        date: dueDate.toISOString(),
        imputationDate: dueDate.toISOString(),
        hasInvoice: false,
        invoiceType: null,
        invoiceNumber: null,
        invoiceTaxId: null,
        status: 'scheduled',
        isUniquePayment: true,
        clientId: newUniqueReceivable.clientId || null,
        projectId: newUniqueReceivable.projectId || null,
      });

      toast({ title: "Cobro único agregado", description: `${newUniqueReceivable.description} registrado correctamente` });
      setNewUniqueReceivable({ description: '', amount: '', dueDate: '', currency: 'ARS', accountId: '', category: '', clientId: '', projectId: '' });
      setUniqueReceivableDisplayAmount('');
      setIsAddingUniqueReceivable(false);
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const handleEditFixedCost = (cost: any) => {
    const amountStr = cost.amount.toString();
    const { displayValue } = formatAmountLive(amountStr);
    setEditingCost({
      id: cost.id,
      description: cost.description,
      amount: amountStr,
      category: cost.category,
    });
    setEditingCostDisplayAmount(displayValue);
    setIsEditingFixed(true);
  };

  const handleSaveEdit = async () => {
    if (!editingCost) return;
    
    try {
      await updateTransactionMutation.mutateAsync({
        id: editingCost.id,
        data: {
          description: editingCost.description,
          amount: editingCost.amount,
          category: editingCost.category,
        }
      });
      
      toast({ title: "Costo actualizado", description: "Los cambios se guardaron correctamente" });
      setIsEditingFixed(false);
      setEditingCost(null);
      setEditingCostDisplayAmount('');
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const directDeleteWithUndo = async (id: string, description: string) => {
    try {
      const result = await deleteTransactionMutation.mutateAsync(id);
      if (result?.undoKey) {
        pushGlobalUndoAction({
          undoKey: result.undoKey,
          entityType: 'transaction',
          entityName: description || '',
          expiresAt: Date.now() + 55_000,
        });
      }
      toast({ title: "Eliminado", description: `"${description}" fue eliminado. Tenés 60 segundos para deshacer.` });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const handleEditPending = (item: any) => {
    const dateStr = safeParseDate(item.date).toISOString().split('T')[0];
    const amountStr = item.amount.toString();
    const { displayValue } = formatAmountLive(amountStr);
    setEditingPending({
      id: item.id,
      type: item.type,
      description: item.description,
      amount: amountStr,
      date: dateStr,
      accountId: item.accountId || '',
      category: item.category || '',
      clientId: item.clientId || '',
      supplierId: item.supplierId || '',
      projectId: item.projectId || '',
    });
    setEditingPendingDisplayAmount(displayValue);
    setIsEditingPending(true);
  };

  const handleSavePending = async () => {
    if (!editingPending) return;
    
    try {
      // Add noon time to avoid timezone issues (midnight UTC becomes previous day in Argentina)
      const newDate = new Date(editingPending.date + 'T12:00:00');
      await updateTransactionMutation.mutateAsync({
        id: editingPending.id,
        data: {
          description: editingPending.description,
          amount: editingPending.amount,
          date: newDate.toISOString(),
          imputationDate: newDate.toISOString(),
          accountId: editingPending.accountId || null,
          category: editingPending.category || undefined,
          clientId: editingPending.clientId || null,
          supplierId: editingPending.supplierId || null,
          projectId: editingPending.projectId || null,
        }
      });
      
      toast({ title: "Actualizado", description: "Los cambios se guardaron correctamente" });
      setIsEditingPending(false);
      setEditingPending(null);
      setEditingPendingDisplayAmount('');
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };


  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-lg text-muted-foreground">Cargando datos...</div>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Oficina</h1>
        <p className="text-sm sm:text-base text-muted-foreground">Cobros y pagos pendientes</p>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4 sm:space-y-6">
        <TabsList className="grid w-full grid-cols-3 h-auto p-1.5 bg-muted/80 rounded-xl">
          <TabsTrigger 
            value="payables" 
            data-testid="tab-payables" 
            className="text-sm sm:text-base py-3 px-4 font-semibold rounded-lg data-[state=active]:bg-gradient-to-r data-[state=active]:from-red-500 data-[state=active]:to-red-600 data-[state=active]:text-white data-[state=active]:shadow-md transition-all"
          >
            <ArrowDownLeft className="h-4 w-4 mr-2 inline" />
            Por Pagar
          </TabsTrigger>
          <TabsTrigger 
            value="receivables" 
            data-testid="tab-receivables" 
            className="text-sm sm:text-base py-3 px-4 font-semibold rounded-lg data-[state=active]:bg-gradient-to-r data-[state=active]:from-green-500 data-[state=active]:to-green-600 data-[state=active]:text-white data-[state=active]:shadow-md transition-all"
          >
            <ArrowUpRight className="h-4 w-4 mr-2 inline" />
            Por Cobrar
          </TabsTrigger>
          <TabsTrigger 
            value="quotes" 
            data-testid="tab-quotes" 
            className="text-sm sm:text-base py-3 px-4 font-semibold rounded-lg data-[state=active]:bg-gradient-to-r data-[state=active]:from-cyan-500 data-[state=active]:to-blue-600 data-[state=active]:text-white data-[state=active]:shadow-md transition-all"
          >
            <FileText className="h-4 w-4 mr-2 inline" />
            Presupuestos
          </TabsTrigger>
        </TabsList>

        {/* Presupuestos Tab */}
        <TabsContent value="quotes">
          <QuotesSection />
        </TabsContent>

        {/* Payables Tab - Por Pagar */}
        <TabsContent value="payables">
          <div className="space-y-6">
            {/* Total Summary */}
            <Card className="border-none shadow-sm bg-gradient-to-r from-red-50 to-red-100/50">
              <CardContent className="py-6">
                <p className="text-sm text-red-700 mb-4">Total Por Pagar</p>
                <div className="flex flex-wrap gap-4 mb-4">
                  {Object.entries(payablesByCurrency).length === 0 ? (
                    <div className="flex items-center gap-3 bg-white dark:bg-card/60 rounded-xl px-4 py-3 border border-red-100">
                      <div className="text-center">
                        <p className="text-xs text-red-500 font-medium mb-1">Pesos</p>
                        <p className="text-2xl font-bold text-red-600">{formatCurrency(0)}</p>
                      </div>
                    </div>
                  ) : (
                    Object.entries(payablesByCurrency).map(([currency, total]) => {
                      const currencyLabel = currency === 'ARS' ? 'Pesos' : 
                                           currency === 'USD' || currency === 'USD_CASH' ? 'Dólares' : currency;
                      const icon = currency === 'ARS' ? '🇦🇷' : 
                                  currency === 'USD' || currency === 'USD_CASH' ? '🇺🇸' : '💰';
                      return (
                        <div key={currency} className="flex items-center gap-3 bg-white dark:bg-card/60 rounded-xl px-3 sm:px-4 py-3 border border-red-100 min-w-0">
                          <span className="text-2xl flex-shrink-0">{icon}</span>
                          <div className="min-w-0">
                            <p className="text-xs text-red-500 font-medium mb-0.5">{currencyLabel}</p>
                            <p className="text-base sm:text-2xl font-bold text-red-600 tabular-nums truncate">
                              {formatCurrency(total, currency as Currency)}
                            </p>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="flex items-center gap-2 bg-amber-50/80 rounded-xl px-3 sm:px-4 py-3 border border-amber-200 min-w-0" data-testid="office-fixed-costs">
                    <Repeat className="h-4 w-4 text-amber-600 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs text-amber-700 font-semibold">Costos Fijos</p>
                      {(() => {
                        const merged: Record<string, number> = {};
                        Object.entries(recurringPayableByCurrency).forEach(([c, t]) => { merged[c] = (merged[c] || 0) + t; });
                        if (payrollSummary) Object.entries(payrollSummary.byCurrency).forEach(([c, d]) => { const k = (c === 'USD_CASH' || c.toUpperCase().includes('USD')) ? 'USD' : c; merged[k] = (merged[k] || 0) + d.total; });
                        return Object.keys(merged).length === 0
                          ? <p className="text-sm sm:text-lg font-bold text-amber-800 tabular-nums truncate">{formatCurrency(0)}</p>
                          : Object.entries(merged).map(([curr, total]) => (
                              <p key={curr} className="text-sm sm:text-lg font-bold text-amber-800 tabular-nums truncate">{formatCurrency(total, curr as Currency)}</p>
                            ));
                      })()}
                      <p className="text-[10px] text-amber-600">
                        {recurringPayables.length} recurrente{recurringPayables.length !== 1 ? 's' : ''}
                        {payrollSummary && payrollSummary.totalEmployees > 0 ? ` + ${payrollSummary.totalEmployees} sueldo${payrollSummary.totalEmployees !== 1 ? 's' : ''}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 bg-red-50/80 rounded-xl px-3 sm:px-4 py-3 border border-red-200 min-w-0" data-testid="office-unique-costs">
                    <Calendar className="h-4 w-4 text-red-500 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs text-red-600 font-semibold">Gastos Únicos</p>
                      {Object.keys(uniquePayableByCurrency).length === 0 ? (
                        <p className="text-sm sm:text-lg font-bold text-red-700 tabular-nums truncate">{formatCurrency(0)}</p>
                      ) : (
                        Object.entries(uniquePayableByCurrency).map(([curr, total]) => (
                          <p key={curr} className="text-sm sm:text-lg font-bold text-red-700 tabular-nums truncate">{formatCurrency(total, curr as Currency)}</p>
                        ))
                      )}
                      <p className="text-[10px] text-red-500">{pendingPayables.length} pago{pendingPayables.length !== 1 ? 's' : ''}</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="mb-4 rounded-lg border overflow-hidden border-orange-200 bg-gradient-to-r from-orange-50 to-amber-50" data-testid="office-suppliers-cc-card">
              <div className="p-3">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0 bg-orange-100">
                    <Building2 className="h-4 w-4 text-orange-600" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-orange-800">Deuda con Proveedores</p>
                    <p className="text-[10px] text-orange-500">Saldo total de cuentas corrientes</p>
                  </div>
                </div>
                <div className="mt-2 pl-11 flex flex-wrap gap-x-3">
                  {Object.keys(suppliersCCTotals).length === 0 ? (
                    <p className="text-sm font-bold text-orange-400">Al día</p>
                  ) : (
                    Object.entries(suppliersCCTotals).map(([curr, total]) => (
                      <p key={curr} className="text-sm font-bold tabular-nums text-orange-700" data-testid={`text-office-supplier-cc-${curr}`}>
                        {getCurrencySymbol(curr)} {total.toLocaleString('es-AR', { minimumFractionDigits: 0 })}
                      </p>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Sub-tabs for Recurrentes / Únicos */}
            <div className="flex gap-1 p-1.5 bg-gradient-to-r from-red-100 to-red-50 rounded-xl border border-red-200 w-fit shadow-sm">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPayablesSubTab('recurrentes')}
                className={`px-4 py-2 rounded-lg font-medium transition-all ${
                  payablesSubTab === 'recurrentes' 
                    ? 'bg-white dark:bg-card text-red-700 shadow-md border border-red-200' 
                    : 'text-red-600 hover:bg-white/50'
                }`}
                data-testid="subtab-payables-recurrentes"
              >
                <Clock className="h-4 w-4 mr-2" />
                Recurrentes
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPayablesSubTab('unicos')}
                className={`px-4 py-2 rounded-lg font-medium transition-all ${
                  payablesSubTab === 'unicos' 
                    ? 'bg-white dark:bg-card text-red-700 shadow-md border border-red-200' 
                    : 'text-red-600 hover:bg-white/50'
                }`}
                data-testid="subtab-payables-unicos"
              >
                <Calendar className="h-4 w-4 mr-2" />
                Únicos
              </Button>
            </div>

            {/* Compact Filter Bar */}
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Buscar..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8 h-8 w-40 text-sm"
                  data-testid="input-search-office"
                />
              </div>
              <Select value={statusFilter} onValueChange={(v: 'all' | 'pending' | 'overdue') => setStatusFilter(v)}>
                <SelectTrigger className="h-8 w-24 text-xs" data-testid="select-status-filter">
                  <SelectValue placeholder="Estado" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="pending">Pendiente</SelectItem>
                  <SelectItem value="overdue">Vencido</SelectItem>
                </SelectContent>
              </Select>
              <Select value={currencyFilter} onValueChange={setCurrencyFilter}>
                <SelectTrigger className="h-8 w-24 text-xs" data-testid="select-currency-filter">
                  <SelectValue placeholder="$" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas</SelectItem>
                  <SelectItem value="ARS">ARS</SelectItem>
                  <SelectItem value="USD">USD</SelectItem>
                  <SelectItem value="USD_CASH">USD Efvo</SelectItem>
                  <SelectItem value="EUR">EUR</SelectItem>
                </SelectContent>
              </Select>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="h-8 w-36 text-xs" data-testid="select-category-filter">
                  <SelectValue placeholder="Categoría" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Categorías</SelectItem>
                  {payableCategories.map((cat) => (
                    <SelectItem key={cat} value={cat} data-testid={`select-category-option-${cat}`}>{cat}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={(v: 'date' | 'amount' | 'name') => setSortBy(v)}>
                <SelectTrigger className="h-8 w-24 text-xs" data-testid="select-sort-by">
                  <ArrowUpDown className="h-3 w-3 mr-1" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="date">Fecha</SelectItem>
                  <SelectItem value="amount">Monto</SelectItem>
                  <SelectItem value="name">Nombre</SelectItem>
                </SelectContent>
              </Select>
              <Button 
                variant="ghost" 
                size="icon"
                onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                className="h-8 w-8"
                data-testid="button-toggle-sort-order"
              >
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${sortOrder === 'asc' ? 'rotate-180' : ''}`} />
              </Button>
              {hasActiveFilters && (
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={clearFilters}
                  className="h-8 px-2 text-muted-foreground hover:text-foreground"
                  data-testid="button-clear-filters"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>

            {/* Recurrentes Section */}
            {payablesSubTab === 'recurrentes' && (
            <Card className="border-none shadow-sm">
              <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Clock className="h-5 w-5 text-amber-600" />
                    Pagos Recurrentes
                  </CardTitle>
                  <CardDescription>Gastos que se repiten (alquiler, sueldos, servicios)</CardDescription>
                </div>
                <Dialog open={isAddingFixed} onOpenChange={setIsAddingFixed}>
                  <DialogTrigger asChild>
                    <Button variant="outline" data-testid="button-add-recurring-payable" className="w-full sm:w-auto">
                      <Plus className="h-4 w-4 sm:mr-2" /> <span className="sm:inline hidden">Agregar Recurrente</span><span className="sm:hidden">Agregar</span>
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Agregar Pago Recurrente</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label>Descripción *</Label>
                        <Input 
                          placeholder="Ej: Alquiler oficina, Netflix, Sueldo empleado"
                          value={newFixedCost.description}
                          onChange={(e) => setNewFixedCost({...newFixedCost, description: e.target.value})}
                          data-testid="input-fixed-description"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Proveedor (opcional)</Label>
                        <div className="flex items-center gap-2">
                          <Select 
                            value={newFixedCost.supplierId || '__none__'}
                            onValueChange={(val) => setNewFixedCost({...newFixedCost, supplierId: val === '__none__' ? '' : val})}
                          >
                            <SelectTrigger className="flex-1" data-testid="select-fixed-supplier">
                              <SelectValue placeholder="Sin proveedor" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">Sin proveedor</SelectItem>
                              {suppliers.map((s: any) => (
                                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button type="button" variant="outline" size="icon" className="shrink-0 h-9 w-9" onClick={() => setShowNewSupplierDialog('fixed')} data-testid="button-create-supplier-fixed-inline">
                            <Plus className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Monto *</Label>
                          <Input 
                            type="text"
                            inputMode="decimal"
                            placeholder="0"
                            value={fixedCostDisplayAmount}
                            onChange={(e) => {
                              const { displayValue, internalValue } = formatAmountLive(e.target.value, newFixedCost.amount);
                              setFixedCostDisplayAmount(displayValue);
                              setNewFixedCost({...newFixedCost, amount: internalValue});
                            }}
                            data-testid="input-fixed-amount"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Categoría *</Label>
                          <CreatableCombobox
                            options={expenseCategoryOptions}
                            value={newFixedCost.category}
                            onValueChange={(val) => setNewFixedCost({...newFixedCost, category: val})}
                            onCreateOption={(name) => createCategoryMutation.mutateAsync({ name, type: 'expense' })}
                            placeholder="Seleccionar o crear"
                            searchPlaceholder="Buscar o escribir nuevo..."
                            createText="Crear concepto"
                            data-testid="select-fixed-category"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Moneda</Label>
                          <Select
                            value={newFixedCost.currency}
                            onValueChange={(val) => setNewFixedCost({
                              ...newFixedCost,
                              currency: val,
                              accountId: '',
                            })}
                          >
                            <SelectTrigger data-testid="select-fixed-currency">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="ARS">Pesos (ARS)</SelectItem>
                              <SelectItem value="USD">Dólares (USD)</SelectItem>
                              <SelectItem value="USD_CASH">Dólares Efectivo</SelectItem>
                              <SelectItem value="EUR">Euros (EUR)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>Cuenta origen</Label>
                          <Select 
                            value={newFixedCost.accountId}
                            onValueChange={(val) => setNewFixedCost({...newFixedCost, accountId: val})}
                          >
                            <SelectTrigger data-testid="select-fixed-account">
                              <SelectValue placeholder="Seleccionar cuenta" />
                            </SelectTrigger>
                            <SelectContent>
                              {(newFixedCost.currency ? filterAccountsByCurrency(newFixedCost.currency) : accounts).map((acc) => (
                                <SelectItem key={acc.id} value={acc.id}>
                                  {acc.name} - {formatCurrency(acc.balance, acc.currency as Currency)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Frecuencia</Label>
                          <Select 
                            value={newFixedCost.frequency}
                            onValueChange={(val) => setNewFixedCost({...newFixedCost, frequency: val})}
                          >
                            <SelectTrigger data-testid="select-fixed-frequency">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="weekly">Semanal</SelectItem>
                              <SelectItem value="biweekly">Quincenal</SelectItem>
                              <SelectItem value="monthly">Mensual</SelectItem>
                              <SelectItem value="annual">Anual</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {(newFixedCost.frequency === 'weekly' || newFixedCost.frequency === 'biweekly') ? (
                          <div className="space-y-2">
                            <Label>Fecha del primer pago</Label>
                            <Input 
                              type="date"
                              value={newFixedCost.dueDate}
                              onChange={(e) => setNewFixedCost({...newFixedCost, dueDate: e.target.value})}
                              data-testid="input-fixed-due-date"
                              lang="es"
                            />
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <Label>Día del mes para pagar</Label>
                            <Select 
                              value={newFixedCost.dueDay}
                              onValueChange={(val) => setNewFixedCost({...newFixedCost, dueDay: val})}
                            >
                              <SelectTrigger data-testid="select-fixed-due-day">
                                <SelectValue placeholder="Día del mes" />
                              </SelectTrigger>
                              <SelectContent className="max-h-48 overflow-y-auto">
                                {DAY_OPTIONS.map((day) => (
                                  <SelectItem key={day.id} value={day.id}>Día {day.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                      </div>
                      {newFixedCost.frequency !== 'one_time' && (
                        <div className="space-y-2">
                          <Label>Cantidad de cuotas (opcional)</Label>
                          <Input
                            type="number"
                            min="1"
                            step="1"
                            placeholder="Vacío = sin tope (indefinido)"
                            value={newFixedCost.installments}
                            onChange={(e) => setNewFixedCost({...newFixedCost, installments: e.target.value})}
                            data-testid="input-fixed-installments"
                          />
                          <p className="text-xs text-muted-foreground">Si indicás un número, la serie se cierra al llegar a esa cuota. Si lo dejás vacío, el pago se renueva indefinidamente.</p>
                        </div>
                      )}
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsAddingFixed(false)}>Cancelar</Button>
                      <Button onClick={handleAddFixedCost} data-testid="button-save-fixed-cost">Guardar</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardHeader>
              <CardContent>
                {payrollSummary && payrollSummary.totalEmployees > 0 && (
                  <div className={`mb-4 rounded-lg border overflow-hidden ${payrollSummary.payrollStatus === 'overdue' ? 'border-red-300 bg-gradient-to-r from-red-50 to-orange-50' : 'border-violet-200 bg-gradient-to-r from-violet-50 to-purple-50'}`} data-testid="office-payroll-card">
                    <div className="p-3">
                      <button
                        onClick={() => setPayrollExpanded(!payrollExpanded)}
                        className="w-full flex items-center gap-3 text-left"
                        data-testid="button-toggle-payroll"
                      >
                        <div className={`h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0 ${payrollSummary.payrollStatus === 'overdue' ? 'bg-red-100' : 'bg-violet-100'}`}>
                          <Wallet className={`h-4 w-4 ${payrollSummary.payrollStatus === 'overdue' ? 'text-red-600' : 'text-violet-600'}`} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between">
                            <p className={`text-sm font-semibold ${payrollSummary.payrollStatus === 'overdue' ? 'text-red-800' : 'text-violet-800'}`}>Masa Salarial</p>
                            <div className="flex items-center gap-1.5">
                              {payrollSummary.payrollStatus === 'overdue' && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">Vencido</span>
                              )}
                              {payrollSummary.payrollStatus === 'pending' && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 font-medium">Pendiente</span>
                              )}
                              {payrollSummary.payrollStatus === 'paid' && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-medium">Pagado</span>
                              )}
                              {payrollExpanded ? <ChevronUp className={`h-4 w-4 ${payrollSummary.payrollStatus === 'overdue' ? 'text-red-400' : 'text-violet-400'}`} /> : <ChevronDown className={`h-4 w-4 ${payrollSummary.payrollStatus === 'overdue' ? 'text-red-400' : 'text-violet-400'}`} />}
                            </div>
                          </div>
                          <p className={`text-[10px] ${payrollSummary.payrollStatus === 'overdue' ? 'text-red-500' : 'text-violet-500'}`}>
                            {payrollSummary.totalEmployees} empleado{payrollSummary.totalEmployees !== 1 ? 's' : ''}
                            {payrollSummary.payrollPayDay ? ` · Día ${payrollSummary.payrollPayDay}` : ''}
                            {payrollSummary.nextPayDate ? ` · ${payrollSummary.payrollStatus === 'overdue' ? 'Vencido' : 'Vence'} ${format(new Date(payrollSummary.nextPayDate), "d 'de' MMM", { locale: es })}` : ' · Sin fecha configurada'}
                          </p>
                        </div>
                      </button>
                      <div className="mt-2 pl-11 space-y-2">
                        <div className="flex flex-wrap gap-x-3">
                          {(() => {
                            const normalized: Record<string, number> = {};
                            Object.entries(payrollSummary.byCurrency).forEach(([c, d]) => { const k = (c === 'USD_CASH' || c.toUpperCase().includes('USD')) ? 'USD' : c; normalized[k] = (normalized[k] || 0) + d.total; });
                            return Object.entries(normalized).map(([curr, total]) => (
                              <p key={curr} className={`text-sm font-bold tabular-nums ${payrollSummary.payrollStatus === 'overdue' ? 'text-red-700' : 'text-violet-700'}`}>{formatCurrency(total, curr as Currency)}</p>
                            ));
                          })()}
                        </div>
                        {payrollSummary.payrollPayDay && payrollSummary.payrollStatus !== 'paid' ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-3 text-xs font-medium bg-green-50 text-green-700 border-green-200 hover:bg-green-100 hover:text-green-800"
                            onClick={() => { setPayrollPayAccountId(''); setShowPayrollPay(true); }}
                            data-testid="button-pay-payroll"
                          >
                            Pagar
                          </Button>
                        ) : !payrollSummary.payrollPayDay ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs font-medium bg-violet-50 text-violet-700 border-violet-200 hover:bg-violet-100"
                            onClick={() => { setPayrollConfigDay(String(payrollSummary.payrollPayDay || 5)); setShowPayrollConfig(true); }}
                            data-testid="button-config-payroll"
                          >
                            <Calendar className="h-3 w-3 mr-1" />
                            Configurar fecha de pago
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    {payrollExpanded && (
                      <div className={`border-t px-3 py-2 space-y-1.5 bg-white dark:bg-card/50 ${payrollSummary.payrollStatus === 'overdue' ? 'border-red-200' : 'border-violet-200'}`}>
                        {Object.entries(payrollSummary.byCurrency).map(([curr, data]) => (
                          <div key={curr}>
                            {Object.keys(payrollSummary.byCurrency).length > 1 && (
                              <p className="text-[10px] font-semibold text-violet-500 uppercase mt-1 mb-0.5">{curr}</p>
                            )}
                            {data.employees.map(emp => (
                              <div key={emp.id} className="flex items-center justify-between py-1 text-sm">
                                <span className="text-muted-foreground truncate mr-2" data-testid={`text-payroll-employee-${emp.id}`}>{emp.fullName}</span>
                                <span className="font-medium tabular-nums text-violet-700 flex-shrink-0">{formatCurrency(parseFloat(emp.grossSalary) || 0, curr as Currency)}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                        {payrollSummary.payrollPayDay && (
                          <div className="pt-1 border-t border-violet-100 flex justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-[10px] text-violet-500 hover:text-violet-700"
                              onClick={() => { setPayrollConfigDay(String(payrollSummary.payrollPayDay || 5)); setShowPayrollConfig(true); }}
                              data-testid="button-edit-payroll-day"
                            >
                              <Pencil className="h-3 w-3 mr-1" />
                              Cambiar día de pago
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}


                <AlertDialog open={showPayrollConfig} onOpenChange={setShowPayrollConfig}>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Fecha de pago de sueldos</AlertDialogTitle>
                      <AlertDialogDescription>Seleccioná el día del mes en que se pagan los sueldos. Esto permite hacer seguimiento de vencimientos.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="py-4">
                      <Label>Día del mes (1-28)</Label>
                      <Select value={payrollConfigDay} onValueChange={setPayrollConfigDay}>
                        <SelectTrigger className="mt-2" data-testid="select-payroll-day">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Array.from({ length: 28 }, (_, i) => (
                            <SelectItem key={i + 1} value={String(i + 1)}>{i + 1}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancelar</AlertDialogCancel>
                      <AlertDialogAction
                        data-testid="button-save-payroll-day"
                        onClick={async () => {
                          try {
                            await employeeAPI.setPayrollPayDay(parseInt(payrollConfigDay));
                            queryClient.invalidateQueries({ queryKey: ['/api/employees/payroll-summary'] });
                            toast({ title: "Configurado", description: `Los sueldos se pagan el día ${payrollConfigDay} de cada mes` });
                            setShowPayrollConfig(false);
                          } catch (error: any) {
                            toast({ title: "Error", description: error.message, variant: "destructive" });
                          }
                        }}
                      >Guardar</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                <AlertDialog open={showPayrollPay} onOpenChange={setShowPayrollPay}>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Pagar sueldos</AlertDialogTitle>
                      <AlertDialogDescription>
                        Se registrará un egreso por la masa salarial total.
                        {payrollSummary && Object.entries(payrollSummary.byCurrency).map(([curr, data]) => (
                          <span key={curr} className="block mt-1 font-semibold text-foreground">{formatCurrency(data.total, curr as Currency)} ({data.employees.length} empleado{data.employees.length !== 1 ? 's' : ''})</span>
                        ))}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="py-4">
                      <Label>Cuenta de pago *</Label>
                      <Select value={payrollPayAccountId} onValueChange={setPayrollPayAccountId}>
                        <SelectTrigger className="mt-2" data-testid="select-payroll-account">
                          <SelectValue placeholder="Seleccionar cuenta..." />
                        </SelectTrigger>
                        <SelectContent>
                          {accounts.map(a => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.name} ({a.currency}) - {formatCurrency(a.balance, a.currency as Currency)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={payrollPaying}>Cancelar</AlertDialogCancel>
                      <AlertDialogAction
                        disabled={!payrollPayAccountId || payrollPaying}
                        data-testid="button-confirm-payroll-pay"
                        onClick={async (e) => {
                          e.preventDefault();
                          setPayrollPaying(true);
                          try {
                            const result = await employeeAPI.payPayroll(payrollPayAccountId);
                            queryClient.invalidateQueries({ queryKey: ['transactions'] });
                            queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
                            queryClient.invalidateQueries({ queryKey: ['accounts'] });
                            queryClient.invalidateQueries({ queryKey: ['/api/employees/payroll-summary'] });
                            toast({
                              title: "Sueldos pagados",
                              description: `Se registró el pago de ${result.employeeCount} empleado${result.employeeCount !== 1 ? 's' : ''} por ${formatCurrency(result.paidAmount, result.currency as Currency)}`,
                            });
                            setShowPayrollPay(false);
                          } catch (error: any) {
                            toast({ title: "Error", description: error.message, variant: "destructive" });
                          } finally {
                            setPayrollPaying(false);
                          }
                        }}
                      >
                        {payrollPaying ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Procesando...</> : 'Confirmar pago'}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                {/* Results counter */}
                {filteredRecurringPayables.length > 0 && (
                  <div className="mb-3 text-xs text-muted-foreground">
                    Mostrando {Math.min(recurringPayablesLimit, filteredRecurringPayables.length)} de {filteredRecurringPayables.length} pagos
                  </div>
                )}
                {filteredRecurringPayables.length > 0 && (
                  <div className="flex items-center gap-2 mb-2">
                    <Checkbox
                      checked={filteredRecurringPayables.length > 0 && filteredRecurringPayables.every(i => selectedPayments.has(i.id))}
                      onCheckedChange={() => toggleAllInList(filteredRecurringPayables)}
                      data-testid="checkbox-select-all-recurring-payables"
                    />
                    <span className="text-xs text-muted-foreground">Seleccionar todos</span>
                  </div>
                )}
                <div className="space-y-3">
                  {filteredRecurringPayables.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground">
                      <Clock className="h-10 w-10 mx-auto mb-2 text-muted-foreground/50" />
                      <p className="text-sm">{hasActiveFilters ? 'No hay resultados con los filtros aplicados' : 'No hay pagos recurrentes'}</p>
                    </div>
                  ) : (
                    visibleRecurringPayables.map((cost) => {
                      const dueDate = cost.date ? new Date(cost.date) : null;
                      const costIsOverdue = dueDate && dueDate < new Date();
                      
                      return (
                        <div key={cost.id} className={`flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 p-3 rounded-lg group ${costIsOverdue ? 'bg-red-50 border border-red-200' : 'bg-amber-50 border border-amber-200'}`}>
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <Checkbox
                              checked={selectedPayments.has(cost.id)}
                              onCheckedChange={() => togglePaymentSelection(cost.id)}
                              className="flex-shrink-0"
                              data-testid={`checkbox-select-recurring-payable-${cost.id}`}
                            />
                            <div className={`p-2 rounded-lg flex-shrink-0 ${costIsOverdue ? 'bg-red-100' : 'bg-amber-100'}`}>
                              <Clock className={`h-4 w-4 ${costIsOverdue ? 'text-red-600' : 'text-amber-600'}`} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="font-medium text-sm truncate">{cost.description}</p>
                                {(cost as any).recurrenceTotalInstallments != null && (
                                  <span
                                    className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0 rounded-full font-medium bg-violet-100 text-violet-700"
                                    data-testid={`text-installment-count-payable-${cost.id}`}
                                    title="Cuota dentro de una serie cerrada"
                                  >
                                    <RefreshCw className="h-2.5 w-2.5" />
                                    Cuota {(cost as any).recurrenceCurrentInstallment ?? 1} de {(cost as any).recurrenceTotalInstallments}
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground">{cost.category}{cost.supplierId && supplierNameMap.get(cost.supplierId) ? ` • ${supplierNameMap.get(cost.supplierId)}` : ''} • A pagar: {dueDate && format(dueDate, "d 'de' MMM", { locale: es })}</p>
                              {cost.originalAmount && cost.autoAppliedByTransactionId && normalizeAmountInput(cost.originalAmount) !== normalizeAmountInput(cost.amount) && (
                                <p className="text-xs text-green-600 font-medium" data-testid={`text-partial-payment-recurring-${cost.id}`}>
                                  Pagado parcial: {formatCurrency(String(normalizeAmountInput(cost.originalAmount) - normalizeAmountInput(cost.amount)), cost.currency as Currency)} de {formatCurrency(cost.originalAmount, cost.currency as Currency)}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 flex-wrap pl-9 sm:pl-0">
                            <span className={`text-xs px-2 py-0.5 rounded-full ${costIsOverdue ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                              {costIsOverdue ? 'Vencido' : 'Pendiente'}
                            </span>
                            <span className="font-bold text-red-600 tabular-nums text-xs sm:text-base">-{formatCurrency(cost.amount, cost.currency as Currency)}</span>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-3 text-xs font-medium bg-green-50 text-green-700 border-green-200 hover:bg-green-100 hover:text-green-800"
                              onClick={() => setViewingOfficeDetail(cost.id)}
                              data-testid={`button-pay-recurring-${cost.id}`}
                            >
                              Pagar
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleEditPending(cost)}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => directDeleteWithUndo(cost.id, cost.description)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      );
                    })
                  )}
                  {/* Ver más button */}
                  {hasMoreRecurringPayables && (
                    <Button 
                      variant="outline" 
                      className="w-full mt-4" 
                      onClick={loadMoreRecurringPayables}
                    >
                      <ChevronDown className="h-4 w-4 mr-2" />
                      Ver más ({filteredRecurringPayables.length - recurringPayablesLimit} restantes)
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
            )}

            {/* Pagos Únicos Section */}
            {payablesSubTab === 'unicos' && (
            <Card className="border-none shadow-sm">
              <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Calendar className="h-5 w-5 text-red-600" />
                    Pagos Únicos
                  </CardTitle>
                  <CardDescription>Pagos puntuales que no se repiten</CardDescription>
                </div>
                <Dialog open={isAddingUniquePayable} onOpenChange={setIsAddingUniquePayable}>
                  <DialogTrigger asChild>
                    <Button variant="outline" data-testid="button-add-unique-payable" className="w-full sm:w-auto">
                      <Plus className="h-4 w-4 mr-2" /> Agregar Pago
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Agregar Pago Único</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label>Concepto</Label>
                        <CreatableCombobox
                          options={expenseCategoryOptions}
                          value={newUniquePayable.category}
                          onValueChange={(val) => setNewUniquePayable({...newUniquePayable, category: val})}
                          onCreateOption={(name) => createCategoryMutation.mutateAsync({ name, type: 'expense' })}
                          placeholder="Seleccionar o crear"
                          searchPlaceholder="Buscar o escribir nuevo..."
                          createText="Crear concepto"
                          data-testid="select-unique-payable-category"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Descripción</Label>
                        <Input 
                          placeholder="Ej: Reparación equipo, Compra insumos"
                          value={newUniquePayable.description}
                          onChange={(e) => setNewUniquePayable({...newUniquePayable, description: e.target.value})}
                          data-testid="input-unique-payable-description"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Monto</Label>
                          <Input 
                            type="text"
                            inputMode="decimal"
                            placeholder="0"
                            value={uniquePayableDisplayAmount}
                            onChange={(e) => {
                              const { displayValue, internalValue } = formatAmountLive(e.target.value, newUniquePayable.amount);
                              setUniquePayableDisplayAmount(displayValue);
                              setNewUniquePayable({...newUniquePayable, amount: internalValue});
                            }}
                            data-testid="input-unique-payable-amount"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Moneda</Label>
                          <Select 
                            value={newUniquePayable.currency}
                            onValueChange={(val) => setNewUniquePayable({...newUniquePayable, currency: val})}
                          >
                            <SelectTrigger data-testid="select-unique-payable-currency">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="ARS">Pesos (ARS)</SelectItem>
                              <SelectItem value="USD">Dólares (USD)</SelectItem>
                              <SelectItem value="USD_CASH">Dólares Efectivo</SelectItem>
                              <SelectItem value="EUR">Euros (EUR)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Proveedor (opcional)</Label>
                        <div className="flex items-center gap-2">
                          <Select
                            value={newUniquePayable.supplierId || '__none__'}
                            onValueChange={(val) => setNewUniquePayable({...newUniquePayable, supplierId: val === '__none__' ? '' : val})}
                          >
                            <SelectTrigger className="flex-1" data-testid="select-unique-payable-supplier">
                              <SelectValue placeholder="Sin proveedor" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">Sin proveedor</SelectItem>
                              {suppliers.filter((s: any) => s.isActive !== false).map((supplier: any) => (
                                <SelectItem key={supplier.id} value={supplier.id}>
                                  {supplier.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button type="button" variant="outline" size="icon" className="shrink-0 h-9 w-9" onClick={() => setShowNewSupplierDialog('unique')} data-testid="button-create-supplier-inline">
                            <Plus className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Fecha de vencimiento</Label>
                        <Input 
                          type="date"
                          value={newUniquePayable.dueDate}
                          onChange={(e) => setNewUniquePayable({...newUniquePayable, dueDate: e.target.value})}
                          data-testid="input-unique-payable-date"
                          lang="es"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Cuenta Origen (opcional)</Label>
                        <Select 
                          value={newUniquePayable.accountId}
                          onValueChange={(val) => setNewUniquePayable({...newUniquePayable, accountId: val})}
                        >
                          <SelectTrigger data-testid="select-unique-payable-account">
                            <SelectValue placeholder="Asignar automáticamente" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">Asignar automáticamente</SelectItem>
                            {filterAccountsByCurrency(newUniquePayable.currency).map((account) => (
                              <SelectItem key={account.id} value={account.id}>
                                {account.name} - {formatCurrency(account.balance, account.currency as Currency)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">Si no seleccionás, se usa la cuenta con más saldo</p>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsAddingUniquePayable(false)}>Cancelar</Button>
                      <Button onClick={handleAddUniquePayable} data-testid="button-save-unique-payable">Guardar</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardHeader>
              <CardContent>
                {/* Results counter */}
                {filteredPendingPayables.length > 0 && (
                  <div className="mb-3 text-xs text-muted-foreground">
                    Mostrando {Math.min(uniquePayablesLimit, filteredPendingPayables.length)} de {filteredPendingPayables.length} pagos
                  </div>
                )}
                {filteredPendingPayables.length > 0 && (
                  <div className="flex items-center gap-2 mb-2">
                    <Checkbox
                      checked={filteredPendingPayables.length > 0 && filteredPendingPayables.every(i => selectedPayments.has(i.id))}
                      onCheckedChange={() => toggleAllInList(filteredPendingPayables)}
                      data-testid="checkbox-select-all-pending-payables"
                    />
                    <span className="text-xs text-muted-foreground">Seleccionar todos</span>
                  </div>
                )}
                <div className="space-y-3">
                  {filteredPendingPayables.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground">
                      <AlertCircle className="h-10 w-10 mx-auto mb-2 text-muted-foreground/50" />
                      <p className="text-sm">{hasActiveFilters ? 'No hay resultados con los filtros aplicados' : 'No hay pagos únicos pendientes'}</p>
                      {!hasActiveFilters && <p className="text-xs">Los movimientos "Por Pagar" aparecerán aquí</p>}
                    </div>
                  ) : (
                    visiblePendingPayables.map((item) => (
                      <div key={item.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 p-3 bg-red-50 rounded-lg border border-red-100">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <Checkbox
                            checked={selectedPayments.has(item.id)}
                            onCheckedChange={() => togglePaymentSelection(item.id)}
                            className="flex-shrink-0"
                            data-testid={`checkbox-select-unique-payable-${item.id}`}
                          />
                          <div className="p-2 rounded-lg bg-red-100">
                            <Calendar className="h-4 w-4 text-red-600" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-sm truncate">{item.description}</p>
                            <p className="text-xs text-muted-foreground">{item.category}{item.supplierId && supplierNameMap.get(item.supplierId) ? ` • ${supplierNameMap.get(item.supplierId)}` : ''} • A pagar: {format(safeParseDate(item.date), "d 'de' MMM", { locale: es })}</p>
                            {item.originalAmount && item.autoAppliedByTransactionId && normalizeAmountInput(item.originalAmount) !== normalizeAmountInput(item.amount) && (
                              <p className="text-xs text-green-600 font-medium" data-testid={`text-partial-payment-unique-${item.id}`}>
                                Pagado parcial: {formatCurrency(String(normalizeAmountInput(item.originalAmount) - normalizeAmountInput(item.amount)), item.currency as Currency)} de {formatCurrency(item.originalAmount, item.currency as Currency)}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap pl-9 sm:pl-0">
                          <span className="font-bold text-red-600 tabular-nums text-xs sm:text-base">-{formatCurrency(item.amount, item.currency as Currency)}</span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-3 text-xs font-medium bg-green-50 text-green-700 border-green-200 hover:bg-green-100 hover:text-green-800"
                            onClick={() => setViewingOfficeDetail(item.id)}
                            data-testid={`button-pay-unique-${item.id}`}
                          >
                            Pagar
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleEditPending(item)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => directDeleteWithUndo(item.id, item.description)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                  {/* Ver más button */}
                  {hasMorePendingPayables && (
                    <Button 
                      variant="outline" 
                      className="w-full mt-4" 
                      onClick={loadMorePendingPayables}
                    >
                      <ChevronDown className="h-4 w-4 mr-2" />
                      Ver más ({filteredPendingPayables.length - uniquePayablesLimit} restantes)
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
            )}

            {/* Edit Fixed Cost Dialog */}
            <Dialog open={isEditingFixed} onOpenChange={setIsEditingFixed}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Editar Pago</DialogTitle>
                </DialogHeader>
                {editingCost && (
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label>Descripción</Label>
                      <Input 
                        value={editingCost.description}
                        onChange={(e) => setEditingCost({...editingCost, description: e.target.value})}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Monto</Label>
                      <Input 
                        type="text"
                        inputMode="decimal"
                        placeholder="0"
                        value={editingCostDisplayAmount}
                        onChange={(e) => {
                          const { displayValue, internalValue } = formatAmountLive(e.target.value, editingCost?.amount || '');
                          setEditingCostDisplayAmount(displayValue);
                          setEditingCost({...editingCost, amount: internalValue});
                        }}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Categoría</Label>
                      <Select 
                        value={editingCost.category}
                        onValueChange={(val) => setEditingCost({...editingCost, category: val})}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {FIXED_COST_CATEGORIES.map((cat) => (
                            <SelectItem key={cat.id} value={cat.label}>{cat.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsEditingFixed(false)}>Cancelar</Button>
                  <Button onClick={handleSaveEdit}>Guardar Cambios</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </TabsContent>

        {/* Receivables Tab - Por Cobrar */}
        <TabsContent value="receivables">
          <div className="space-y-6">
            {/* Total Summary */}
            <Card className="border-none shadow-sm bg-gradient-to-r from-green-50 to-green-100/50">
              <CardContent className="py-6">
                <p className="text-sm text-green-700 mb-4">Total Por Cobrar</p>
                <div className="flex flex-wrap gap-4 mb-4">
                  {Object.entries(receivablesByCurrency).length === 0 ? (
                    <div className="flex items-center gap-3 bg-white dark:bg-card/60 rounded-xl px-4 py-3 border border-green-100">
                      <div className="text-center">
                        <p className="text-xs text-green-500 font-medium mb-1">Pesos</p>
                        <p className="text-2xl font-bold text-green-600">{formatCurrency(0)}</p>
                      </div>
                    </div>
                  ) : (
                    Object.entries(receivablesByCurrency).map(([currency, total]) => {
                      const currencyLabel = currency === 'ARS' ? 'Pesos' : 
                                           currency === 'USD' || currency === 'USD_CASH' ? 'Dólares' : currency;
                      const icon = currency === 'ARS' ? '🇦🇷' : 
                                  currency === 'USD' || currency === 'USD_CASH' ? '🇺🇸' : '💰';
                      return (
                        <div key={currency} className="flex items-center gap-3 bg-white dark:bg-card/60 rounded-xl px-3 sm:px-4 py-3 border border-green-100 min-w-0">
                          <span className="text-2xl flex-shrink-0">{icon}</span>
                          <div className="min-w-0">
                            <p className="text-xs text-green-500 font-medium mb-0.5">{currencyLabel}</p>
                            <p className="text-base sm:text-2xl font-bold text-green-600 tabular-nums truncate">
                              {formatCurrency(total, currency as Currency)}
                            </p>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="flex items-center gap-2 bg-emerald-50/80 rounded-xl px-3 sm:px-4 py-3 border border-emerald-200 min-w-0" data-testid="office-fixed-income">
                    <Repeat className="h-4 w-4 text-emerald-600 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs text-emerald-700 font-semibold">Ingresos Fijos</p>
                      {Object.keys(recurringReceivableByCurrency).length === 0 ? (
                        <p className="text-sm sm:text-lg font-bold text-emerald-800 tabular-nums truncate">{formatCurrency(0)}</p>
                      ) : (
                        Object.entries(recurringReceivableByCurrency).map(([curr, total]) => (
                          <p key={curr} className="text-sm sm:text-lg font-bold text-emerald-800 tabular-nums truncate">{formatCurrency(total, curr as Currency)}</p>
                        ))
                      )}
                      <p className="text-[10px] text-emerald-600">{recurringReceivables.length} recurrente{recurringReceivables.length !== 1 ? 's' : ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 bg-green-50/80 rounded-xl px-3 sm:px-4 py-3 border border-green-200 min-w-0" data-testid="office-unique-income">
                    <Calendar className="h-4 w-4 text-green-500 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs text-green-600 font-semibold">Cobros Únicos</p>
                      {Object.keys(uniqueReceivableByCurrency).length === 0 ? (
                        <p className="text-sm sm:text-lg font-bold text-green-700 tabular-nums truncate">{formatCurrency(0)}</p>
                      ) : (
                        Object.entries(uniqueReceivableByCurrency).map(([curr, total]) => (
                          <p key={curr} className="text-sm sm:text-lg font-bold text-green-700 tabular-nums truncate">{formatCurrency(total, curr as Currency)}</p>
                        ))
                      )}
                      <p className="text-[10px] text-green-500">{uniqueReceivables.length} cobro{uniqueReceivables.length !== 1 ? 's' : ''}</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="mb-4 rounded-lg border overflow-hidden border-cyan-200 bg-gradient-to-r from-cyan-50 to-teal-50" data-testid="office-clients-cc-card">
              <div className="p-3">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0 bg-cyan-100">
                    <Users className="h-4 w-4 text-cyan-600" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-cyan-800">Saldo CC Clientes</p>
                    <p className="text-[10px] text-cyan-500">Total a cobrar de cuentas corrientes</p>
                  </div>
                </div>
                <div className="mt-2 pl-11 flex flex-wrap gap-x-3">
                  {Object.keys(clientsCCTotals).length === 0 ? (
                    <p className="text-sm font-bold text-cyan-400">Al día</p>
                  ) : (
                    Object.entries(clientsCCTotals).map(([curr, total]) => (
                      <p key={curr} className="text-sm font-bold tabular-nums text-cyan-700" data-testid={`text-office-client-cc-${curr}`}>
                        {getCurrencySymbol(curr)} {total.toLocaleString('es-AR', { minimumFractionDigits: 0 })}
                      </p>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Sub-tabs for Recurrentes / Únicos */}
            <div className="flex gap-1 p-1.5 bg-gradient-to-r from-green-100 to-green-50 rounded-xl border border-green-200 w-fit shadow-sm">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setReceivablesSubTab('recurrentes')}
                className={`px-4 py-2 rounded-lg font-medium transition-all ${
                  receivablesSubTab === 'recurrentes' 
                    ? 'bg-white dark:bg-card text-green-700 shadow-md border border-green-200' 
                    : 'text-green-600 hover:bg-white/50'
                }`}
                data-testid="subtab-receivables-recurrentes"
              >
                <Clock className="h-4 w-4 mr-2" />
                Recurrentes
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setReceivablesSubTab('unicos')}
                className={`px-4 py-2 rounded-lg font-medium transition-all ${
                  receivablesSubTab === 'unicos' 
                    ? 'bg-white dark:bg-card text-green-700 shadow-md border border-green-200' 
                    : 'text-green-600 hover:bg-white/50'
                }`}
                data-testid="subtab-receivables-unicos"
              >
                <Calendar className="h-4 w-4 mr-2" />
                Únicos
              </Button>
            </div>

            {/* Compact Filter Bar */}
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Buscar..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8 h-8 w-40 text-sm"
                  data-testid="input-search-receivables"
                />
              </div>
              <Select value={statusFilter} onValueChange={(v: 'all' | 'pending' | 'overdue') => setStatusFilter(v)}>
                <SelectTrigger className="h-8 w-24 text-xs" data-testid="select-status-filter-receivables">
                  <SelectValue placeholder="Estado" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="pending">Pendiente</SelectItem>
                  <SelectItem value="overdue">Vencido</SelectItem>
                </SelectContent>
              </Select>
              <Select value={currencyFilter} onValueChange={setCurrencyFilter}>
                <SelectTrigger className="h-8 w-24 text-xs" data-testid="select-currency-filter-receivables">
                  <SelectValue placeholder="$" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas</SelectItem>
                  <SelectItem value="ARS">ARS</SelectItem>
                  <SelectItem value="USD">USD</SelectItem>
                  <SelectItem value="USD_CASH">USD Efvo</SelectItem>
                  <SelectItem value="EUR">EUR</SelectItem>
                </SelectContent>
              </Select>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="h-8 w-36 text-xs" data-testid="select-category-filter-receivables">
                  <SelectValue placeholder="Categoría" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Categorías</SelectItem>
                  {receivableCategories.map((cat) => (
                    <SelectItem key={cat} value={cat} data-testid={`select-category-option-receivables-${cat}`}>{cat}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={(v: 'date' | 'amount' | 'name') => setSortBy(v)}>
                <SelectTrigger className="h-8 w-24 text-xs" data-testid="select-sort-by-receivables">
                  <ArrowUpDown className="h-3 w-3 mr-1" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="date">Fecha</SelectItem>
                  <SelectItem value="amount">Monto</SelectItem>
                  <SelectItem value="name">Nombre</SelectItem>
                </SelectContent>
              </Select>
              <Button 
                variant="ghost" 
                size="icon"
                onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                className="h-8 w-8"
                data-testid="button-toggle-sort-order-receivables"
              >
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${sortOrder === 'asc' ? 'rotate-180' : ''}`} />
              </Button>
              {hasActiveFilters && (
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={clearFilters}
                  className="h-8 px-2 text-muted-foreground hover:text-foreground"
                  data-testid="button-clear-filters-receivables"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>

            {/* Cobros Recurrentes Section */}
            {receivablesSubTab === 'recurrentes' && (
            <Card className="border-none shadow-sm">
              <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Clock className="h-5 w-5 text-green-600" />
                    Cobros Recurrentes
                  </CardTitle>
                  <CardDescription>Ingresos que se repiten (abonos, suscripciones)</CardDescription>
                </div>
                <Dialog open={isAddingRecurring} onOpenChange={setIsAddingRecurring}>
                  <DialogTrigger asChild>
                    <Button variant="outline" data-testid="button-add-recurring-receivable" className="w-full sm:w-auto">
                      <Plus className="h-4 w-4 sm:mr-2" /> <span className="sm:inline hidden">Agregar Recurrente</span><span className="sm:hidden">Agregar</span>
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Agregar Cobro Recurrente</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label>Concepto</Label>
                        <CreatableCombobox
                          options={incomeCategoryOptions}
                          value={newRecurringIncome.category}
                          onValueChange={(val) => setNewRecurringIncome({...newRecurringIncome, category: val})}
                          onCreateOption={(name) => createCategoryMutation.mutateAsync({ name, type: 'income' })}
                          placeholder="Seleccionar o crear"
                          searchPlaceholder="Buscar o escribir nuevo..."
                          createText="Crear concepto"
                          data-testid="select-recurring-income-category"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Descripción</Label>
                        <Input 
                          placeholder="Ej: Abono mensual, Cuota membresía"
                          value={newRecurringIncome.description}
                          onChange={(e) => setNewRecurringIncome({...newRecurringIncome, description: e.target.value})}
                          data-testid="input-recurring-description"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Cliente (opcional)</Label>
                        <div className="flex items-center gap-2">
                          <Select 
                            value={newRecurringIncome.clientId || '__none__'}
                            onValueChange={(val) => setNewRecurringIncome({...newRecurringIncome, clientId: val === '__none__' ? '' : val})}
                          >
                            <SelectTrigger className="flex-1" data-testid="select-recurring-client">
                              <SelectValue placeholder="Sin cliente" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">Sin cliente</SelectItem>
                              {clients.filter((c: any) => c.isActive !== false).map((c: any) => (
                                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button type="button" variant="outline" size="icon" className="shrink-0 h-9 w-9" onClick={() => setShowNewClientDialog('recurring')} data-testid="button-create-client-recurring-inline">
                            <Plus className="h-4 w-4" />
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">Vincular a un cliente para reflejar en su Cuenta Corriente</p>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Monto</Label>
                          <Input 
                            type="text"
                            inputMode="decimal"
                            placeholder="0"
                            value={recurringIncomeDisplayAmount}
                            onChange={(e) => {
                              const { displayValue, internalValue } = formatAmountLive(e.target.value, newRecurringIncome.amount);
                              setRecurringIncomeDisplayAmount(displayValue);
                              setNewRecurringIncome({...newRecurringIncome, amount: internalValue});
                            }}
                            data-testid="input-recurring-amount"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Moneda</Label>
                          <Select 
                            value={newRecurringIncome.currency}
                            onValueChange={(val) => setNewRecurringIncome({...newRecurringIncome, currency: val})}
                          >
                            <SelectTrigger data-testid="select-recurring-currency">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="ARS">Pesos (ARS)</SelectItem>
                              <SelectItem value="USD">Dólares (USD)</SelectItem>
                              <SelectItem value="USD_CASH">Dólares Efectivo</SelectItem>
                              <SelectItem value="EUR">Euros (EUR)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Cuenta Destino</Label>
                          <Select 
                            value={newRecurringIncome.accountId}
                            onValueChange={(val) => setNewRecurringIncome({...newRecurringIncome, accountId: val})}
                          >
                            <SelectTrigger data-testid="select-recurring-account">
                              <SelectValue placeholder="Seleccionar cuenta" />
                            </SelectTrigger>
                            <SelectContent>
                              {(newRecurringIncome.currency ? filterAccountsByCurrency(newRecurringIncome.currency) : accounts).map((account) => (
                                <SelectItem key={account.id} value={account.id}>
                                  {account.name} - {formatCurrency(account.balance, account.currency as Currency)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>Frecuencia</Label>
                          <Select 
                            value={newRecurringIncome.frequency}
                            onValueChange={(val) => setNewRecurringIncome({...newRecurringIncome, frequency: val})}
                          >
                            <SelectTrigger data-testid="select-recurring-frequency">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="weekly">Semanal</SelectItem>
                              <SelectItem value="biweekly">Quincenal</SelectItem>
                              <SelectItem value="monthly">Mensual</SelectItem>
                              <SelectItem value="annual">Anual</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Fecha del primer cobro</Label>
                        <Input 
                          type="date"
                          value={newRecurringIncome.dueDate}
                          onChange={(e) => setNewRecurringIncome({...newRecurringIncome, dueDate: e.target.value})}
                          data-testid="input-recurring-date"
                          lang="es"
                        />
                      </div>
                      {newRecurringIncome.frequency !== 'once' && (
                        <div className="space-y-2">
                          <Label>Cantidad de cuotas (opcional)</Label>
                          <Input
                            type="number"
                            min="1"
                            step="1"
                            placeholder="Vacío = sin tope (indefinido)"
                            value={newRecurringIncome.installments}
                            onChange={(e) => setNewRecurringIncome({...newRecurringIncome, installments: e.target.value})}
                            data-testid="input-recurring-installments"
                          />
                          <p className="text-xs text-muted-foreground">Si indicás un número, la serie se cierra al llegar a esa cuota. Si lo dejás vacío, el cobro se renueva indefinidamente.</p>
                        </div>
                      )}
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsAddingRecurring(false)}>Cancelar</Button>
                      <Button onClick={handleAddRecurringIncome} data-testid="button-save-recurring">Guardar</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardHeader>
              <CardContent>
                {/* Results counter */}
                {filteredRecurringReceivables.length > 0 && (
                  <div className="mb-3 text-xs text-muted-foreground">
                    Mostrando {Math.min(recurringReceivablesLimit, filteredRecurringReceivables.length)} de {filteredRecurringReceivables.length} cobros
                  </div>
                )}
                {filteredRecurringReceivables.length > 0 && (
                  <div className="flex items-center gap-2 mb-2">
                    <Checkbox
                      checked={filteredRecurringReceivables.length > 0 && filteredRecurringReceivables.every(i => selectedPayments.has(i.id))}
                      onCheckedChange={() => toggleAllInList(filteredRecurringReceivables)}
                      data-testid="checkbox-select-all-recurring-receivables"
                    />
                    <span className="text-xs text-muted-foreground">Seleccionar todos</span>
                  </div>
                )}
                <div className="space-y-3">
                  {filteredRecurringReceivables.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground">
                      <Clock className="h-10 w-10 mx-auto mb-2 text-muted-foreground/50" />
                      <p className="text-sm">{hasActiveFilters ? 'No hay resultados con los filtros aplicados' : 'No hay cobros recurrentes pendientes'}</p>
                      {!hasActiveFilters && <p className="text-xs">Los cobros con categorías recurrentes aparecerán aquí</p>}
                    </div>
                  ) : (
                    visibleRecurringReceivables.map((item) => (
                      <div key={item.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 p-3 bg-green-50 rounded-lg border border-green-100">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <Checkbox
                            checked={selectedPayments.has(item.id)}
                            onCheckedChange={() => togglePaymentSelection(item.id)}
                            className="flex-shrink-0"
                            data-testid={`checkbox-select-recurring-receivable-${item.id}`}
                          />
                          <div className="p-2 rounded-lg bg-green-100">
                            <Clock className="h-4 w-4 text-green-600" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium text-sm truncate">{item.description}</p>
                              {(item as any).recurrenceTotalInstallments != null && (
                                <span
                                  className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0 rounded-full font-medium bg-violet-100 text-violet-700"
                                  data-testid={`text-installment-count-receivable-${item.id}`}
                                  title="Cuota dentro de una serie cerrada"
                                >
                                  <RefreshCw className="h-2.5 w-2.5" />
                                  Cuota {(item as any).recurrenceCurrentInstallment ?? 1} de {(item as any).recurrenceTotalInstallments}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">{item.category}{item.clientId && clientNameMap.get(item.clientId) ? ` • ${clientNameMap.get(item.clientId)}` : ''} • A cobrar: {format(safeParseDate(item.date), "d 'de' MMM", { locale: es })}</p>
                            {item.originalAmount && item.autoAppliedByTransactionId && normalizeAmountInput(item.originalAmount) !== normalizeAmountInput(item.amount) && (
                              <p className="text-xs text-blue-600 font-medium" data-testid={`text-partial-collection-recurring-${item.id}`}>
                                Cobrado parcial: {formatCurrency(String(normalizeAmountInput(item.originalAmount) - normalizeAmountInput(item.amount)), item.currency as Currency)} de {formatCurrency(item.originalAmount, item.currency as Currency)}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap pl-9 sm:pl-0">
                          <span className="font-bold text-green-600 tabular-nums text-xs sm:text-base">+{formatCurrency(item.amount, item.currency as Currency)}</span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-3 text-xs font-medium bg-green-50 text-green-700 border-green-200 hover:bg-green-100 hover:text-green-800"
                            onClick={() => setViewingOfficeDetail(item.id)}
                            data-testid={`button-collect-recurring-${item.id}`}
                          >
                            Cobrar
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleEditPending(item)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => directDeleteWithUndo(item.id, item.description)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                  {/* Ver más button */}
                  {hasMoreRecurringReceivables && (
                    <Button 
                      variant="outline" 
                      className="w-full mt-4" 
                      onClick={loadMoreRecurringReceivables}
                    >
                      <ChevronDown className="h-4 w-4 mr-2" />
                      Ver más ({filteredRecurringReceivables.length - recurringReceivablesLimit} restantes)
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
            )}

            {/* Cobros Únicos Section */}
            {receivablesSubTab === 'unicos' && (
            <Card className="border-none shadow-sm">
              <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Calendar className="h-5 w-5 text-green-600" />
                    Cobros Únicos
                  </CardTitle>
                  <CardDescription>Cobros puntuales que no se repiten</CardDescription>
                </div>
                <Dialog open={isAddingUniqueReceivable} onOpenChange={setIsAddingUniqueReceivable}>
                  <DialogTrigger asChild>
                    <Button variant="outline" data-testid="button-add-unique-receivable" className="w-full sm:w-auto">
                      <Plus className="h-4 w-4 mr-2" /> Agregar Cobro
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Agregar Cobro Único</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label>Concepto</Label>
                        <CreatableCombobox
                          options={incomeCategoryOptions}
                          value={newUniqueReceivable.category}
                          onValueChange={(val) => setNewUniqueReceivable({...newUniqueReceivable, category: val})}
                          onCreateOption={(name) => createCategoryMutation.mutateAsync({ name, type: 'income' })}
                          placeholder="Seleccionar o crear"
                          searchPlaceholder="Buscar o escribir nuevo..."
                          createText="Crear concepto"
                          data-testid="select-unique-receivable-category"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Descripción</Label>
                        <Input 
                          placeholder="Ej: Venta producto, Servicio prestado"
                          value={newUniqueReceivable.description}
                          onChange={(e) => setNewUniqueReceivable({...newUniqueReceivable, description: e.target.value})}
                          data-testid="input-unique-receivable-description"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Cliente (opcional)</Label>
                        <div className="flex items-center gap-2">
                          <Select
                            value={newUniqueReceivable.clientId || '__none__'}
                            onValueChange={(val) => setNewUniqueReceivable({...newUniqueReceivable, clientId: val === '__none__' ? '' : val, projectId: ''})}
                          >
                            <SelectTrigger className="flex-1" data-testid="select-unique-receivable-client">
                              <SelectValue placeholder="Sin cliente" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">Sin cliente</SelectItem>
                              {clients.filter((c: any) => c.isActive !== false).map((c: any) => (
                                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button type="button" variant="outline" size="icon" className="shrink-0 h-9 w-9" onClick={() => setShowNewClientDialog('unique')} data-testid="button-create-client-inline">
                            <Plus className="h-4 w-4" />
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">Vincular a un cliente para reflejar en su Cuenta Corriente</p>
                      </div>
                      {newUniqueReceivable.clientId && receivableClientProjects.length > 0 && (
                        <div className="space-y-2">
                          <Label>Proyecto (opcional)</Label>
                          <Select
                            value={newUniqueReceivable.projectId || '__none__'}
                            onValueChange={(val) => setNewUniqueReceivable({...newUniqueReceivable, projectId: val === '__none__' ? '' : val})}
                          >
                            <SelectTrigger data-testid="select-unique-receivable-project">
                              <SelectValue placeholder="Sin proyecto" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">Sin proyecto</SelectItem>
                              {receivableClientProjects.map((p) => (
                                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Monto</Label>
                          <Input 
                            type="text"
                            inputMode="decimal"
                            placeholder="0"
                            value={uniqueReceivableDisplayAmount}
                            onChange={(e) => {
                              const { displayValue, internalValue } = formatAmountLive(e.target.value, newUniqueReceivable.amount);
                              setUniqueReceivableDisplayAmount(displayValue);
                              setNewUniqueReceivable({...newUniqueReceivable, amount: internalValue});
                            }}
                            data-testid="input-unique-receivable-amount"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Moneda</Label>
                          <Select 
                            value={newUniqueReceivable.currency}
                            onValueChange={(val) => setNewUniqueReceivable({...newUniqueReceivable, currency: val})}
                          >
                            <SelectTrigger data-testid="select-unique-receivable-currency">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="ARS">Pesos (ARS)</SelectItem>
                              <SelectItem value="USD">Dólares (USD)</SelectItem>
                              <SelectItem value="USD_CASH">Dólares Efectivo</SelectItem>
                              <SelectItem value="EUR">Euros (EUR)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Fecha esperada de cobro</Label>
                        <Input 
                          type="date"
                          value={newUniqueReceivable.dueDate}
                          onChange={(e) => setNewUniqueReceivable({...newUniqueReceivable, dueDate: e.target.value})}
                          data-testid="input-unique-receivable-date"
                          lang="es"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Cuenta Destino (opcional)</Label>
                        <Select 
                          value={newUniqueReceivable.accountId}
                          onValueChange={(val) => setNewUniqueReceivable({...newUniqueReceivable, accountId: val})}
                        >
                          <SelectTrigger data-testid="select-unique-receivable-account">
                            <SelectValue placeholder="Asignar automáticamente" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">Asignar automáticamente</SelectItem>
                            {filterAccountsByCurrency(newUniqueReceivable.currency).map((account) => (
                              <SelectItem key={account.id} value={account.id}>
                                {account.name} - {formatCurrency(account.balance, account.currency as Currency)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">Si no seleccionás, se usa la cuenta con menos saldo</p>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsAddingUniqueReceivable(false)}>Cancelar</Button>
                      <Button onClick={handleAddUniqueReceivable} data-testid="button-save-unique-receivable">Guardar</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardHeader>
              <CardContent>
                {/* Results counter */}
                {filteredUniqueReceivables.length > 0 && (
                  <div className="mb-3 text-xs text-muted-foreground">
                    Mostrando {Math.min(uniqueReceivablesLimit, filteredUniqueReceivables.length)} de {filteredUniqueReceivables.length} cobros
                  </div>
                )}
                {filteredUniqueReceivables.length > 0 && (
                  <div className="flex items-center gap-2 mb-2">
                    <Checkbox
                      checked={filteredUniqueReceivables.length > 0 && filteredUniqueReceivables.every(i => selectedPayments.has(i.id))}
                      onCheckedChange={() => toggleAllInList(filteredUniqueReceivables)}
                      data-testid="checkbox-select-all-unique-receivables"
                    />
                    <span className="text-xs text-muted-foreground">Seleccionar todos</span>
                  </div>
                )}
                <div className="space-y-3">
                  {filteredUniqueReceivables.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground">
                      <AlertCircle className="h-10 w-10 mx-auto mb-2 text-muted-foreground/50" />
                      <p className="text-sm">{hasActiveFilters ? 'No hay resultados con los filtros aplicados' : 'No hay cobros únicos pendientes'}</p>
                      {!hasActiveFilters && <p className="text-xs">Los cobros puntuales aparecerán aquí</p>}
                    </div>
                  ) : (
                    visibleUniqueReceivables.map((item) => (
                      <div key={item.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 p-3 bg-green-50 rounded-lg border border-green-100">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <Checkbox
                            checked={selectedPayments.has(item.id)}
                            onCheckedChange={() => togglePaymentSelection(item.id)}
                            className="flex-shrink-0"
                            data-testid={`checkbox-select-unique-receivable-${item.id}`}
                          />
                          <div className="p-2 rounded-lg bg-green-100">
                            <Calendar className="h-4 w-4 text-green-600" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium text-sm truncate">{item.description}</p>
                              {(item as any).recurrenceTotalInstallments != null && (
                                <span
                                  className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0 rounded-full font-medium bg-violet-100 text-violet-700"
                                  data-testid={`text-installment-count-receivable-${item.id}`}
                                  title="Cuota dentro de una serie cerrada"
                                >
                                  <RefreshCw className="h-2.5 w-2.5" />
                                  Cuota {(item as any).recurrenceCurrentInstallment ?? 1} de {(item as any).recurrenceTotalInstallments}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">{item.category}{item.clientId && clientNameMap.get(item.clientId) ? ` • ${clientNameMap.get(item.clientId)}` : ''} • A cobrar: {format(safeParseDate(item.date), "d 'de' MMM", { locale: es })}</p>
                            {item.originalAmount && item.autoAppliedByTransactionId && normalizeAmountInput(item.originalAmount) !== normalizeAmountInput(item.amount) && (
                              <p className="text-xs text-blue-600 font-medium" data-testid={`text-partial-collection-unique-${item.id}`}>
                                Cobrado parcial: {formatCurrency(String(normalizeAmountInput(item.originalAmount) - normalizeAmountInput(item.amount)), item.currency as Currency)} de {formatCurrency(item.originalAmount, item.currency as Currency)}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap pl-9 sm:pl-0">
                          <span className="font-bold text-green-600 tabular-nums text-xs sm:text-base">+{formatCurrency(item.amount, item.currency as Currency)}</span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-3 text-xs font-medium bg-green-50 text-green-700 border-green-200 hover:bg-green-100 hover:text-green-800"
                            onClick={() => setViewingOfficeDetail(item.id)}
                            data-testid={`button-collect-unique-${item.id}`}
                          >
                            Cobrar
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleEditPending(item)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => directDeleteWithUndo(item.id, item.description)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                  {/* Ver más button */}
                  {hasMoreUniqueReceivables && (
                    <Button 
                      variant="outline" 
                      className="w-full mt-4" 
                      onClick={loadMoreUniqueReceivables}
                    >
                      <ChevronDown className="h-4 w-4 mr-2" />
                      Ver más ({filteredUniqueReceivables.length - uniqueReceivablesLimit} restantes)
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Edit Pending Dialog */}
      <Dialog open={isEditingPending} onOpenChange={setIsEditingPending}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Editar {editingPending?.type === 'receivable' ? 'Cobro Pendiente' : 'Pago Pendiente'}
            </DialogTitle>
          </DialogHeader>
          {editingPending && (
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Descripción</Label>
                <Input
                  value={editingPending.description}
                  onChange={(e) => setEditingPending({...editingPending, description: e.target.value})}
                  data-testid="input-edit-pending-description"
                />
              </div>
              <div className="space-y-2">
                <Label>Monto</Label>
                <Input
                  type="text"
                  inputMode="decimal"
                  placeholder="0"
                  value={editingPendingDisplayAmount}
                  onChange={(e) => {
                    const { displayValue, internalValue } = formatAmountLive(e.target.value, editingPending?.amount || '');
                    setEditingPendingDisplayAmount(displayValue);
                    setEditingPending({...editingPending, amount: internalValue});
                  }}
                  data-testid="input-edit-pending-amount"
                />
              </div>
              <div className="space-y-2">
                <Label>Fecha de vencimiento</Label>
                <Input
                  type="date"
                  value={editingPending.date}
                  onChange={(e) => setEditingPending({...editingPending, date: e.target.value})}
                  data-testid="input-edit-pending-date"
                />
              </div>
              <div className="space-y-2">
                <Label>Categoría</Label>
                <Select
                  value={editingPending.category}
                  onValueChange={(val) => setEditingPending({...editingPending, category: val})}
                >
                  <SelectTrigger data-testid="select-edit-pending-category">
                    <SelectValue placeholder="Seleccionar categoría" />
                  </SelectTrigger>
                  <SelectContent>
                    {(editingPending.type === 'payable'
                      ? transactionCategories.filter((c: any) => c.type === 'expense')
                      : transactionCategories.filter((c: any) => c.type === 'income')
                    ).map((cat: any) => (
                      <SelectItem key={cat.id} value={cat.name}>
                        {cat.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Cuenta</Label>
                <Select
                  value={editingPending.accountId}
                  onValueChange={(val) => setEditingPending({...editingPending, accountId: val})}
                >
                  <SelectTrigger data-testid="select-edit-pending-account">
                    <SelectValue placeholder="Seleccionar cuenta" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((acc) => (
                      <SelectItem key={acc.id} value={acc.id}>
                        {acc.name} ({formatCurrency(acc.balance, acc.currency as Currency)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {editingPending.type === 'receivable' && (
                <div className="space-y-2">
                  <Label>Cliente</Label>
                  <Select
                    value={editingPending.clientId}
                    onValueChange={(val) => setEditingPending({...editingPending, clientId: val, projectId: ''})}
                  >
                    <SelectTrigger data-testid="select-edit-pending-client">
                      <SelectValue placeholder="Seleccionar cliente" />
                    </SelectTrigger>
                    <SelectContent>
                      {clients.filter((c: any) => c.isActive !== false).map((c: any) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {editingPending.type === 'receivable' && editingPending.clientId && (
                <div className="space-y-2">
                  <Label>Proyecto</Label>
                  <Select
                    value={editingPending.projectId || '__none__'}
                    onValueChange={(val) => setEditingPending({...editingPending, projectId: val === '__none__' ? '' : val})}
                  >
                    <SelectTrigger data-testid="select-edit-pending-project">
                      <SelectValue placeholder="Seleccionar proyecto" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Sin proyecto</SelectItem>
                      {editingPendingProjects.map((p: any) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {editingPending.type === 'payable' && (
                <div className="space-y-2">
                  <Label>Proveedor</Label>
                  <Select
                    value={editingPending.supplierId}
                    onValueChange={(val) => setEditingPending({...editingPending, supplierId: val})}
                  >
                    <SelectTrigger data-testid="select-edit-pending-supplier">
                      <SelectValue placeholder="Seleccionar proveedor" />
                    </SelectTrigger>
                    <SelectContent>
                      {suppliers.filter((s: any) => s.isActive !== false).map((s: any) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditingPending(false)}>Cancelar</Button>
            <Button onClick={handleSavePending} data-testid="button-save-pending-edit">Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* Detail Dialog */}
      <Dialog open={!!viewingOfficeDetail} onOpenChange={(open) => { if (!open) { setViewingOfficeDetail(null); setIsDetailsMaximized(false); setIsEditingDetail(false); } }}>
        <DialogContent className={`${isDetailsMaximized ? 'sm:max-w-[95vw] h-[95vh]' : 'sm:max-w-[700px] max-h-[90vh]'} overflow-y-auto transition-all duration-200`}>
          <DialogHeader>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setIsDetailsMaximized(!isDetailsMaximized)}
                data-testid="button-maximize-office-details"
              >
                {isDetailsMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
              <DialogTitle className="flex items-center gap-2">
                <Eye className="h-5 w-5" />
                Detalle del Movimiento
              </DialogTitle>
            </div>
            <DialogDescription>
              Información completa del movimiento seleccionado
            </DialogDescription>
          </DialogHeader>
          
          {officeDetailsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : officeTransactionDetails ? (
            <div className="space-y-6">
              {officeTransactionDetails.transactionNumber && (
                <div className="flex items-center justify-between p-3 rounded-lg bg-gradient-to-r from-primary/10 to-primary/5 border border-primary/20">
                  <div className="flex items-center gap-2">
                    <Hash className="h-4 w-4 text-primary" />
                    <span className="text-sm text-muted-foreground">N° de Movimiento:</span>
                    <span className="font-mono font-bold text-primary">{officeTransactionDetails.transactionNumber}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={() => {
                      navigator.clipboard.writeText(officeTransactionDetails.transactionNumber);
                      toast({ title: 'Copiado', description: 'Número de movimiento copiado al portapapeles' });
                    }}
                    data-testid="button-copy-office-transaction-number"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              )}

              {(() => {
                const categoryOptions = officeTransactionDetails.type === 'payable' || officeTransactionDetails.type === 'expense'
                  ? transactionCategories.filter((c: any) => c.type === 'expense')
                  : transactionCategories.filter((c: any) => c.type === 'income');
                return (
                  <>
                    <div className="flex items-center justify-between p-4 rounded-lg bg-secondary/30">
                      <div className="flex items-center gap-3">
                        <div className={`h-12 w-12 rounded-full flex items-center justify-center text-xl font-bold ${
                          officeTransactionDetails.type === 'income' ? 'bg-green-100 text-green-600' : 
                          officeTransactionDetails.type === 'expense' ? 'bg-red-100 text-red-600' :
                          officeTransactionDetails.type === 'receivable' ? 'bg-blue-100 text-blue-600' :
                          'bg-orange-100 text-orange-600'
                        }`}>
                          {(officeTransactionDetails.type === 'income' || officeTransactionDetails.type === 'receivable') ? '+' : '−'}
                        </div>
                        <div>
                          <h3 className="font-semibold text-lg">{officeTransactionDetails.description}</h3>
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${getTransactionTypeBadgeClass(officeTransactionDetails.type, officeTransactionDetails.status)}`}>
                            {getTransactionTypeLabel(officeTransactionDetails.type, officeTransactionDetails.status)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {isEditingDetail ? (
                          <div className="flex items-center gap-1">
                            <span className={`text-lg font-bold ${
                              officeTransactionDetails.type === 'income' ? 'text-green-600' : 
                              officeTransactionDetails.type === 'receivable' ? 'text-blue-600' :
                              officeTransactionDetails.type === 'payable' ? 'text-orange-600' :
                              'text-red-600'
                            }`}>
                              {(officeTransactionDetails.type === 'income' || officeTransactionDetails.type === 'receivable') ? '+' : '-'}
                            </span>
                            <Input
                              type="text"
                              inputMode="decimal"
                              value={editDetailAmount}
                              onChange={(e) => {
                                const raw = e.target.value.replace(/\./g, '').replace(',', '.');
                                const cleaned = raw.replace(/[^0-9.]/g, '');
                                const parts = cleaned.split('.');
                                if (parts.length > 2) return;
                                if (parts[1] && parts[1].length > 2) return;
                                const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
                                const formatted = parts.length === 2 ? `${intPart},${parts[1]}` : intPart;
                                setEditDetailAmount(formatted);
                              }}
                              className="w-44 text-right font-bold text-lg h-10"
                              data-testid="input-edit-office-detail-amount"
                            />
                          </div>
                        ) : (
                          <div className={`text-2xl font-bold ${
                            officeTransactionDetails.type === 'income' ? 'text-green-600' : 
                            officeTransactionDetails.type === 'receivable' ? 'text-blue-600' :
                            officeTransactionDetails.type === 'payable' ? 'text-orange-600' :
                            'text-red-600'
                          }`}>
                            {(officeTransactionDetails.type === 'income' || officeTransactionDetails.type === 'receivable') ? '+' : '-'}
                            {formatCurrency(officeTransactionDetails.amount, officeTransactionDetails.account?.currency)}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <Hash className="h-3 w-3" /> Categoría
                        </p>
                        {isEditingDetail ? (
                          <Select value={editDetailCategory} onValueChange={setEditDetailCategory}>
                            <SelectTrigger className="h-9" data-testid="select-edit-office-detail-category">
                              <SelectValue placeholder="Categoría" />
                            </SelectTrigger>
                            <SelectContent>
                              {categoryOptions.map((c: any) => (
                                <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <p className="font-medium">{officeTransactionDetails.category}</p>
                        )}
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <CreditCard className="h-3 w-3" /> Cuenta
                        </p>
                        {isEditingDetail ? (
                          <Select value={editDetailAccountId} onValueChange={setEditDetailAccountId}>
                            <SelectTrigger className="h-9" data-testid="select-edit-office-detail-account">
                              <SelectValue placeholder="Cuenta" />
                            </SelectTrigger>
                            <SelectContent>
                              {accounts.map(acc => (
                                <SelectItem key={acc.id} value={acc.id.toString()}>{acc.name} ({acc.currency})</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <p className="font-medium">
                            {officeTransactionDetails.accountId && !officeTransactionDetails.account ? (
                              <span className="text-destructive flex items-center gap-1">
                                <AlertCircle className="h-3 w-3" />
                                Cuenta eliminada — editá para asignar otra
                              </span>
                            ) : (
                              <>
                                {officeTransactionDetails.account?.name || 'Sin cuenta'}
                                {officeTransactionDetails.account?.currency && (
                                  <span className="text-xs ml-1 text-muted-foreground">({officeTransactionDetails.account.currency})</span>
                                )}
                              </>
                            )}
                          </p>
                        )}
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">
                          {(officeTransactionDetails.type === 'payable' || officeTransactionDetails.type === 'receivable') && officeTransactionDetails.status === 'completed' 
                            ? (officeTransactionDetails.type === 'receivable' ? 'Fecha de cobro' : 'Fecha de pago')
                            : (officeTransactionDetails.type === 'payable' || officeTransactionDetails.type === 'receivable') 
                              ? 'Fecha de vencimiento' 
                              : 'Fecha del movimiento'}
                        </p>
                        <p className="font-medium">
                          {(() => {
                            const isCompletedCommitment = (officeTransactionDetails.type === 'payable' || officeTransactionDetails.type === 'receivable') && officeTransactionDetails.status === 'completed';
                            const dateToShow = isCompletedCommitment && (officeTransactionDetails as any).completedAt 
                              ? (officeTransactionDetails as any).completedAt 
                              : officeTransactionDetails.date;
                            const dateFmt = isCompletedCommitment && (officeTransactionDetails as any).completedAt ? "d 'de' MMMM yyyy, HH:mm" : "d 'de' MMMM yyyy";
                            return dateToShow ? format(safeParseDate(dateToShow), dateFmt, { locale: es }) : '-';
                          })()}
                        </p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Fecha de imputación</p>
                        <p className="font-medium">{officeTransactionDetails.imputationDate ? format(new Date(officeTransactionDetails.imputationDate), "MMMM yyyy", { locale: es }) : '-'}</p>
                      </div>
                    </div>

                    {isEditingDetail && (
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={cancelEditingDetail}
                          disabled={savingDetail}
                          data-testid="button-cancel-edit-office-detail"
                        >
                          Cancelar
                        </Button>
                        <Button
                          size="sm"
                          onClick={saveDetailEdits}
                          disabled={savingDetail}
                          className="bg-primary"
                          data-testid="button-save-edit-office-detail"
                        >
                          {savingDetail ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                          Guardar cambios
                        </Button>
                      </div>
                    )}
                  </>
                );
              })()}

              {officeTransactionDetails.creator && (
                <div className="p-3 rounded-lg bg-blue-50 border border-blue-200">
                  <p className="text-xs text-blue-600 mb-1 flex items-center gap-1">
                    <User className="h-3 w-3" /> Registrado por
                  </p>
                  <p className="font-medium text-blue-900">{officeTransactionDetails.creator.name}</p>
                  <p className="text-xs text-blue-700">{officeTransactionDetails.creator.email}</p>
                </div>
              )}

              {(officeTransactionDetails.type === 'payable' || officeTransactionDetails.type === 'receivable') && 
                officeTransactionDetails.status === 'completed' && (officeTransactionDetails as any).completedByName && (
                <div className="p-3 rounded-lg bg-green-50 border border-green-200">
                  <p className="text-xs text-green-600 mb-1 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Aprobado por
                  </p>
                  <p className="font-medium text-green-900">{(officeTransactionDetails as any).completedByName}</p>
                </div>
              )}

              {officeTransactionDetails.client && (
                <div className="p-3 rounded-lg bg-green-50 border border-green-200">
                  <p className="text-xs text-green-600 mb-2 flex items-center gap-1">
                    <User className="h-3 w-3" /> Cliente
                  </p>
                  <p className="font-semibold text-green-900">{officeTransactionDetails.client.name}</p>
                  <div className="flex flex-wrap gap-3 mt-2 text-xs text-green-700">
                    {officeTransactionDetails.client.cuit && (
                      <span className="flex items-center gap-1"><Hash className="h-3 w-3" /> {officeTransactionDetails.client.cuit}</span>
                    )}
                    {officeTransactionDetails.client.email && (
                      <span className="flex items-center gap-1"><Mail className="h-3 w-3" /> {officeTransactionDetails.client.email}</span>
                    )}
                    {officeTransactionDetails.client.phone && (
                      <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> {officeTransactionDetails.client.phone}</span>
                    )}
                  </div>
                </div>
              )}

              {officeTransactionDetails.supplier && (
                <div className="p-3 rounded-lg bg-orange-50 border border-orange-200">
                  <p className="text-xs text-orange-600 mb-2 flex items-center gap-1">
                    <Building className="h-3 w-3" /> Proveedor
                  </p>
                  <p className="font-semibold text-orange-900">{officeTransactionDetails.supplier.name}</p>
                  <div className="flex flex-wrap gap-3 mt-2 text-xs text-orange-700">
                    {officeTransactionDetails.supplier.cuit && (
                      <span className="flex items-center gap-1"><Hash className="h-3 w-3" /> {officeTransactionDetails.supplier.cuit}</span>
                    )}
                    {officeTransactionDetails.supplier.email && (
                      <span className="flex items-center gap-1"><Mail className="h-3 w-3" /> {officeTransactionDetails.supplier.email}</span>
                    )}
                    {officeTransactionDetails.supplier.phone && (
                      <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> {officeTransactionDetails.supplier.phone}</span>
                    )}
                  </div>
                </div>
              )}

              {officeTransactionDetails.product && (
                <div className="p-3 rounded-lg bg-purple-50 border border-purple-200">
                  <p className="text-xs text-purple-600 mb-2 flex items-center gap-1">
                    <Package className="h-3 w-3" /> Producto
                  </p>
                  <p className="font-semibold text-purple-900">{officeTransactionDetails.product.name}</p>
                  <div className="flex flex-wrap gap-3 mt-2 text-xs text-purple-700">
                    {officeTransactionDetails.product.sku && (
                      <span className="flex items-center gap-1"><Hash className="h-3 w-3" /> SKU: {officeTransactionDetails.product.sku}</span>
                    )}
                    {officeTransactionDetails.productQuantity && (
                      <span className="flex items-center gap-1"><Package className="h-3 w-3" /> Cantidad: {officeTransactionDetails.productQuantity}</span>
                    )}
                    {officeTransactionDetails.product.salePrice && (
                      <span className="flex items-center gap-1"><CreditCard className="h-3 w-3" /> Precio unitario: AR$ {parseFloat(officeTransactionDetails.product.salePrice).toLocaleString('es-AR')}</span>
                    )}
                  </div>
                </div>
              )}

              {officeTransactionDetails.hasInvoice && (
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200">
                  <p className="text-xs text-emerald-600 mb-2 flex items-center gap-1">
                    <ReceiptIcon className="h-3 w-3" /> Factura
                  </p>
                  <div className="flex flex-wrap gap-4 text-sm">
                    <span><strong>Tipo:</strong> {officeTransactionDetails.invoiceType || '-'}</span>
                    <span><strong>Número:</strong> {officeTransactionDetails.invoiceNumber || '-'}</span>
                  </div>
                  {officeTransactionDetails.invoiceFileUrl && (
                    <a 
                      href={officeTransactionDetails.invoiceFileUrl} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 mt-2 text-sm text-primary hover:underline"
                    >
                      <Download className="h-4 w-4" /> Ver archivo adjunto
                    </a>
                  )}
                </div>
              )}

              {officeTransactionDetails.trackingNumber && (
                <div className="p-3 rounded-lg bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-800">
                  <p className="text-xs text-gray-600 dark:text-slate-300 mb-1 flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> Número de Seguimiento
                  </p>
                  <p className="font-mono font-medium">{officeTransactionDetails.trackingNumber}</p>
                </div>
              )}

              {officeTransactionDetails.parentTransaction && (
                <div className="p-3 rounded-lg bg-cyan-50 border border-cyan-200">
                  <p className="text-xs text-cyan-600 mb-2 flex items-center gap-1 font-semibold">
                    <ArrowUp className="h-3 w-3" /> Origen del dinero
                  </p>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-cyan-900">
                        {officeTransactionDetails.parentTransaction.transactionNumber || officeTransactionDetails.parentTransaction.description}
                      </p>
                      <p className="text-xs text-cyan-700">{officeTransactionDetails.parentTransaction.description}</p>
                    </div>
                    <span className="text-sm font-semibold text-green-600">
                      +{formatCurrency(officeTransactionDetails.parentTransaction.amount, officeTransactionDetails.account?.currency)}
                    </span>
                  </div>
                </div>
              )}

              {officeTransactionDetails.childTransactions && officeTransactionDetails.childTransactions.length > 0 && (
                <div className="p-3 rounded-lg bg-pink-50 border border-pink-200">
                  <p className="text-xs text-pink-600 mb-2 flex items-center gap-1 font-semibold">
                    <ArrowDown className="h-3 w-3" /> Gastos vinculados ({officeTransactionDetails.childTransactions.length})
                  </p>
                  <div className="space-y-2">
                    {officeTransactionDetails.childTransactions.map((child: any) => (
                      <div
                        key={child.id}
                        className="flex items-center justify-between py-2 px-2 -mx-2 rounded"
                        data-testid={`office-detail-child-${child.id}`}
                      >
                        <div>
                          <p className="text-sm font-medium text-pink-900">
                            {child.transactionNumber || child.description}
                          </p>
                          <p className="text-xs text-pink-700">{child.description}</p>
                        </div>
                        <span className="text-sm font-semibold text-red-600">
                          -{formatCurrency(child.amount, officeTransactionDetails.account?.currency)}
                        </span>
                      </div>
                    ))}
                    <div className="pt-2 border-t border-pink-200 flex justify-between text-sm font-semibold">
                      <span className="text-pink-700">Total gastado:</span>
                      <span className="text-red-600">
                        -{formatCurrency(
                          officeTransactionDetails.childTransactions.reduce((sum: number, c: any) => sum + normalizeAmountInput(c.amount), 0).toString(),
                          officeTransactionDetails.account?.currency
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {officeTransactionDetails.originalTransactionData && (() => {
                try {
                  const originalData = JSON.parse(officeTransactionDetails.originalTransactionData);
                  const originalTypeLabel = getTransactionTypeLabel(originalData.type, originalData.status);
                  return (
                    <div className="p-3 rounded-lg bg-amber-50 border border-amber-300">
                      <p className="text-xs text-amber-700 mb-2 flex items-center gap-1 font-semibold">
                        <XCircle className="h-3 w-3" /> Movimiento Original Cancelado
                      </p>
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-amber-700">Tipo:</span>
                          <span className="font-medium text-amber-900">{originalTypeLabel}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-amber-700">Descripción:</span>
                          <span className="font-medium text-amber-900">{originalData.description}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-amber-700">Monto:</span>
                          <span className="font-medium text-amber-900">
                            {formatCurrency(originalData.amount, officeTransactionDetails.account?.currency)}
                          </span>
                        </div>
                        {originalData.transactionNumber && (
                          <div className="flex justify-between">
                            <span className="text-amber-700">N° Movimiento:</span>
                            <span className="font-mono text-amber-900">{originalData.transactionNumber}</span>
                          </div>
                        )}
                        {originalData.date && (
                          <div className="flex justify-between">
                            <span className="text-amber-700">Fecha original:</span>
                            <span className="text-amber-900">{format(new Date(originalData.date), "d MMM yyyy", { locale: es })}</span>
                          </div>
                        )}
                        {originalData.hasInvoice && (
                          <div className="flex justify-between">
                            <span className="text-amber-700">Factura:</span>
                            <span className="text-amber-900">{originalData.invoiceType} {originalData.invoiceNumber}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                } catch {
                  return null;
                }
              })()}

              <div className="pt-4 border-t text-xs text-muted-foreground">
                {officeTransactionDetails.createdAt && (
                  <p>Creado: {format(new Date(officeTransactionDetails.createdAt), "d 'de' MMMM yyyy 'a las' HH:mm", { locale: es })}</p>
                )}
                <p>ID: <span className="font-mono">{officeTransactionDetails.id}</span></p>
              </div>

              <div className="pt-4 flex justify-end gap-2">
                {/* Edit button for pending/scheduled commitments: visible and
                    clearly separate from the confirm action so editing a
                    commitment isn't confused with confirming the payment. */}
                {(officeTransactionDetails.type === 'payable' || officeTransactionDetails.type === 'receivable') &&
                 officeTransactionDetails.status === 'scheduled' && !isEditingDetail && (
                  <Button
                    variant="outline"
                    onClick={startEditingDetail}
                    className="gap-2"
                    data-testid="button-edit-office-detail"
                  >
                    <Pencil className="h-4 w-4" />
                    Editar
                  </Button>
                )}
                {(officeTransactionDetails.type === 'payable' || officeTransactionDetails.type === 'receivable') && 
                 officeTransactionDetails.status === 'scheduled' && !isEditingDetail && (
                  <Button
                    onClick={openApprovalConfirm}
                    className="gap-2 bg-green-600 hover:bg-green-700 text-white"
                    data-testid="button-approve-office-transaction"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    {officeTransactionDetails.type === 'payable' ? 'Confirmar Pago' : 'Confirmar Cobro'}
                  </Button>
                )}
                
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      data-testid="button-download-office-transaction"
                    >
                      <Download className="h-4 w-4" />
                      Descargar comprobante
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => {
                        const typeLabel = getTransactionTypeLabel(officeTransactionDetails.type, officeTransactionDetails.status);
                        const win = window.open('', '_blank');
                        if (!win) return;
                        win.document.write(`
                          <!DOCTYPE html>
                          <html>
                          <head>
                            <title>Comprobante - ${officeTransactionDetails.transactionNumber || officeTransactionDetails.id}</title>
                            <style>
                              body { font-family: Arial, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; }
                              h1 { color: #00D4FF; margin-bottom: 8px; font-size: 24px; }
                              .subtitle { color: #666; margin-bottom: 24px; font-size: 14px; }
                              .section { margin: 20px 0; padding: 16px; background: #f8f9fa; border-radius: 8px; }
                              .section-title { font-weight: bold; color: #333; margin-bottom: 8px; font-size: 14px; }
                              .row { display: flex; justify-content: space-between; margin: 8px 0; }
                              .label { color: #666; }
                              .value { font-weight: 500; }
                              .amount { font-size: 28px; font-weight: bold; color: ${(officeTransactionDetails.type === 'income' || officeTransactionDetails.type === 'receivable') ? '#16a34a' : '#dc2626'}; }
                              .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #999; }
                              .id { font-family: monospace; font-size: 11px; color: #999; }
                              @media print { body { padding: 20px; } }
                            </style>
                          </head>
                          <body>
                            <h1>COMPROBANTE DE MOVIMIENTO</h1>
                            <p class="subtitle">Aikestar - Sistema de Gestión Administrativa</p>
                            
                            <div class="section">
                              <div class="row">
                                <span class="label">N° de Movimiento:</span>
                                <span class="value">${officeTransactionDetails.transactionNumber || 'Sin número'}</span>
                              </div>
                              <div class="row">
                                <span class="label">Tipo:</span>
                                <span class="value">${typeLabel}</span>
                              </div>
                              <div class="row">
                                <span class="label">Descripción:</span>
                                <span class="value">${officeTransactionDetails.description}</span>
                              </div>
                              <div style="text-align: right; margin-top: 16px;">
                                <span class="amount">${(officeTransactionDetails.type === 'income' || officeTransactionDetails.type === 'receivable') ? '+' : '-'}${formatCurrency(officeTransactionDetails.amount, officeTransactionDetails.account?.currency)}</span>
                              </div>
                            </div>
                            
                            <div class="section">
                              <div class="row">
                                <span class="label">Categoría:</span>
                                <span class="value">${officeTransactionDetails.category}</span>
                              </div>
                              <div class="row">
                                <span class="label">Cuenta:</span>
                                <span class="value">${officeTransactionDetails.account?.name || 'Sin cuenta'} ${officeTransactionDetails.account?.currency ? `(${officeTransactionDetails.account.currency})` : ''}</span>
                              </div>
                              <div class="row">
                                <span class="label">${(officeTransactionDetails.type === 'payable' || officeTransactionDetails.type === 'receivable') && officeTransactionDetails.status === 'completed' ? (officeTransactionDetails.type === 'receivable' ? 'Fecha de cobro:' : 'Fecha de pago:') : (officeTransactionDetails.type === 'payable' || officeTransactionDetails.type === 'receivable') ? 'Fecha de vencimiento:' : 'Fecha del movimiento:'}</span>
                                <span class="value">${(() => { const isCompletedCommitment = (officeTransactionDetails.type === 'payable' || officeTransactionDetails.type === 'receivable') && officeTransactionDetails.status === 'completed'; const dateToShow = isCompletedCommitment && (officeTransactionDetails as any).completedAt ? (officeTransactionDetails as any).completedAt : officeTransactionDetails.date; const dateFmt = isCompletedCommitment && (officeTransactionDetails as any).completedAt ? "d 'de' MMMM yyyy, HH:mm" : "d 'de' MMMM yyyy"; return dateToShow ? format(safeParseDate(dateToShow), dateFmt, { locale: es }) : '-'; })()}</span>
                              </div>
                              <div class="row">
                                <span class="label">Fecha de imputación:</span>
                                <span class="value">${officeTransactionDetails.imputationDate ? format(new Date(officeTransactionDetails.imputationDate), "MMMM yyyy", { locale: es }) : '-'}</span>
                              </div>
                            </div>
                            
                            ${officeTransactionDetails.creator ? `
                            <div class="section">
                              <div class="section-title">Registrado por</div>
                              <div class="row">
                                <span class="value">${officeTransactionDetails.creator.name}</span>
                                <span class="label">${officeTransactionDetails.creator.email}</span>
                              </div>
                            </div>
                            ` : ''}
                            
                            ${officeTransactionDetails.client ? `
                            <div class="section">
                              <div class="section-title">Cliente</div>
                              <div class="row">
                                <span class="value">${officeTransactionDetails.client.name}</span>
                                ${officeTransactionDetails.client.cuit ? `<span class="label">CUIT: ${officeTransactionDetails.client.cuit}</span>` : ''}
                              </div>
                            </div>
                            ` : ''}
                            
                            ${officeTransactionDetails.supplier ? `
                            <div class="section">
                              <div class="section-title">Proveedor</div>
                              <div class="row">
                                <span class="value">${officeTransactionDetails.supplier.name}</span>
                                ${officeTransactionDetails.supplier.cuit ? `<span class="label">CUIT: ${officeTransactionDetails.supplier.cuit}</span>` : ''}
                              </div>
                            </div>
                            ` : ''}
                            
                            ${officeTransactionDetails.hasInvoice ? `
                            <div class="section">
                              <div class="section-title">Factura</div>
                              <div class="row">
                                <span class="label">Tipo:</span>
                                <span class="value">${officeTransactionDetails.invoiceType || '-'}</span>
                              </div>
                              <div class="row">
                                <span class="label">Número:</span>
                                <span class="value">${officeTransactionDetails.invoiceNumber || '-'}</span>
                              </div>
                            </div>
                            ` : ''}
                            
                            <div class="footer">
                              <p>Creado: ${officeTransactionDetails.createdAt ? format(new Date(officeTransactionDetails.createdAt), "d 'de' MMMM yyyy 'a las' HH:mm", { locale: es }) : '-'}</p>
                              <p class="id">ID: ${officeTransactionDetails.id}</p>
                              <p style="margin-top: 16px;">Generado: ${format(new Date(), "d 'de' MMMM yyyy 'a las' HH:mm", { locale: es })}</p>
                            </div>
                          </body>
                          </html>
                        `);
                        win.document.close();
                        win.print();
                        toast({ title: 'PDF generado', description: 'Usa Guardar como PDF en el diálogo de impresión' });
                      }}
                      data-testid="button-download-office-pdf"
                    >
                      <FileText className="h-4 w-4 mr-2" />
                      Descargar PDF
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        const typeLabel = getTransactionTypeLabel(officeTransactionDetails.type, officeTransactionDetails.status);
                        const content = `
COMPROBANTE DE MOVIMIENTO - AIKESTAR
=====================================

N° de Movimiento: ${officeTransactionDetails.transactionNumber || 'Sin número'}
Tipo: ${typeLabel}
Descripción: ${officeTransactionDetails.description}
Monto: ${(officeTransactionDetails.type === 'income' || officeTransactionDetails.type === 'receivable') ? '+' : '-'}${formatCurrency(officeTransactionDetails.amount, officeTransactionDetails.account?.currency)}

Categoría: ${officeTransactionDetails.category}
Cuenta: ${officeTransactionDetails.account?.name || 'Sin cuenta'} ${officeTransactionDetails.account?.currency ? `(${officeTransactionDetails.account.currency})` : ''}

${(() => { const isCompletedCommitment = (officeTransactionDetails.type === 'payable' || officeTransactionDetails.type === 'receivable') && officeTransactionDetails.status === 'completed'; const label = isCompletedCommitment ? (officeTransactionDetails.type === 'receivable' ? 'Fecha de cobro' : 'Fecha de pago') : (officeTransactionDetails.type === 'payable' || officeTransactionDetails.type === 'receivable') ? 'Fecha de vencimiento' : 'Fecha del movimiento'; const dateToShow = isCompletedCommitment && (officeTransactionDetails as any).completedAt ? (officeTransactionDetails as any).completedAt : officeTransactionDetails.date; const dateFmt = isCompletedCommitment && (officeTransactionDetails as any).completedAt ? "d 'de' MMMM yyyy, HH:mm" : "d 'de' MMMM yyyy"; return `${label}: ${dateToShow ? format(safeParseDate(dateToShow), dateFmt, { locale: es }) : '-'}`; })()}
Fecha de imputación: ${officeTransactionDetails.imputationDate ? format(new Date(officeTransactionDetails.imputationDate), "MMMM yyyy", { locale: es }) : '-'}

${officeTransactionDetails.creator ? `Registrado por: ${officeTransactionDetails.creator.name} (${officeTransactionDetails.creator.email})` : ''}
${officeTransactionDetails.client ? `Cliente: ${officeTransactionDetails.client.name}${officeTransactionDetails.client.cuit ? ` - CUIT: ${officeTransactionDetails.client.cuit}` : ''}` : ''}
${officeTransactionDetails.supplier ? `Proveedor: ${officeTransactionDetails.supplier.name}${officeTransactionDetails.supplier.cuit ? ` - CUIT: ${officeTransactionDetails.supplier.cuit}` : ''}` : ''}
${officeTransactionDetails.product ? `Producto: ${officeTransactionDetails.product.name}${officeTransactionDetails.product.sku ? ` (SKU: ${officeTransactionDetails.product.sku})` : ''}` : ''}

${officeTransactionDetails.hasInvoice ? `Factura: Tipo ${officeTransactionDetails.invoiceType || '-'}, N° ${officeTransactionDetails.invoiceNumber || '-'}` : ''}
${officeTransactionDetails.trackingNumber ? `N° de Seguimiento: ${officeTransactionDetails.trackingNumber}` : ''}

-------------------------------------
Creado: ${officeTransactionDetails.createdAt ? format(new Date(officeTransactionDetails.createdAt), "d 'de' MMMM yyyy 'a las' HH:mm", { locale: es }) : '-'}
ID: ${officeTransactionDetails.id}

Generado: ${format(new Date(), "d 'de' MMMM yyyy 'a las' HH:mm", { locale: es })}
Aikestar - Sistema de Gestión Administrativa
                        `.trim();
                        
                        const blob = new Blob([content], { type: 'application/msword' });
                        const link = document.createElement('a');
                        link.href = URL.createObjectURL(blob);
                        link.download = `movimiento_${officeTransactionDetails.transactionNumber || officeTransactionDetails.id}_${format(new Date(), 'yyyy-MM-dd')}.doc`;
                        link.click();
                        toast({ title: 'Descargado', description: 'Comprobante Word descargado correctamente' });
                      }}
                      data-testid="button-download-office-word"
                    >
                      <FileSpreadsheet className="h-4 w-4 mr-2" />
                      Descargar Word
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No se encontró la información del movimiento
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Approval Confirmation Dialog */}
      <AlertDialog open={showApprovalConfirm} onOpenChange={setShowApprovalConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {officeTransactionDetails?.type === 'receivable' ? 'Confirmar Cobro' : 'Confirmar Pago'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {officeTransactionDetails?.type === 'receivable' 
                ? '¿Confirmás que recibiste este cobro?' 
                : '¿Confirmás que realizaste este pago?'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
                {officeTransactionDetails?.type === 'receivable' ? 'Cuenta destino' : 'Cuenta de pago'}
              </Label>
              <Select value={approvalAccountId} onValueChange={setApprovalAccountId}>
                <SelectTrigger data-testid="select-approval-account">
                  <SelectValue placeholder="Seleccionar cuenta..." />
                </SelectTrigger>
                <SelectContent>
                  {filterAccountsByCurrency(officeTransactionDetails?.currency || 'ARS').map(acc => (
                    <SelectItem key={acc.id} value={acc.id}>
                      {acc.name} ({acc.currency}) - {formatCurrency(acc.balance, acc.currency as Currency)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <RefreshCw className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">¿Es recurrente?</span>
              </div>
              <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5" data-testid="toggle-office-approval-recurring">
                <Button
                  type="button"
                  variant={approvalRecurring ? "default" : "ghost"}
                  size="sm"
                  className={`h-7 px-3 text-xs font-medium ${approvalRecurring ? '' : 'text-muted-foreground'}`}
                  onClick={() => setApprovalRecurring(true)}
                >
                  Sí
                </Button>
                <Button
                  type="button"
                  variant={!approvalRecurring ? "default" : "ghost"}
                  size="sm"
                  className={`h-7 px-3 text-xs font-medium ${!approvalRecurring ? '' : 'text-muted-foreground'}`}
                  onClick={() => setApprovalRecurring(false)}
                >
                  No
                </Button>
              </div>
            </div>
            
            {approvalRecurring && (
              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">Frecuencia</label>
                <Select value={approvalFrequency} onValueChange={setApprovalFrequency}>
                  <SelectTrigger data-testid="select-office-approval-frequency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="weekly">Semanal</SelectItem>
                    <SelectItem value="biweekly">Quincenal</SelectItem>
                    <SelectItem value="monthly">Mensual</SelectItem>
                    <SelectItem value="quarterly">Trimestral</SelectItem>
                    <SelectItem value="yearly">Anual</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Se generará automáticamente el próximo compromiso programado.
                </p>
              </div>
            )}
          </div>
          
          <AlertDialogFooter>
            <AlertDialogCancel disabled={approvingTransaction}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); approveTransaction(); }}
              disabled={approvingTransaction || !approvalAccountId}
              className="bg-green-600 hover:bg-green-700"
              data-testid="button-confirm-office-approval"
            >
              {approvingTransaction ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <CheckCircle2 className="h-4 w-4 mr-2" />
              )}
              Confirmar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>


      {selectedPayments.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white rounded-xl shadow-2xl px-6 py-3 flex items-center gap-4 animate-in slide-in-from-bottom-4">
          <div className="flex items-center gap-2">
            <CheckSquare className="h-5 w-5 text-cyan-400" />
            <span className="font-medium">{selectedPayments.size} seleccionado{selectedPayments.size > 1 ? 's' : ''}</span>
          </div>
          <div className="h-6 w-px bg-slate-600" />
          <div className="text-sm">
            {Object.entries(selectedTotal).map(([curr, amt]) => (
              <span key={curr} className="mr-3">{formatCurrency(amt, curr as Currency)}</span>
            ))}
          </div>
          <div className="h-6 w-px bg-slate-600" />
          <Button
            size="sm"
            variant="default"
            className="bg-green-600 hover:bg-green-700 text-white"
            onClick={bulkApproveSelected}
            disabled={bulkApproving}
            data-testid="button-bulk-approve"
          >
            {bulkApproving ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Procesando...</> : <>Confirmar {selectedPayments.size > 1 ? 'todos' : ''}</>}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-slate-300 hover:text-white hover:bg-slate-700"
            onClick={clearSelection}
            data-testid="button-clear-selection"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      <AlertDialog open={!!showNewSupplierDialog} onOpenChange={(open) => { if (!open) { setShowNewSupplierDialog(false); setNewSupplierName(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Agregar Proveedor</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4 pt-2">
                <div>
                  <label className="text-sm font-medium text-foreground">Nombre del proveedor *</label>
                  <Input
                    value={newSupplierName}
                    onChange={(e) => setNewSupplierName(e.target.value)}
                    placeholder="Ej: Distribuidora ABC, Juan Servicios"
                    className="mt-1"
                    autoFocus
                    data-testid="input-new-supplier-name"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Podés completar más datos después en Base de Datos → Proveedores
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setShowNewSupplierDialog(false); setNewSupplierName(''); }}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!newSupplierName.trim()}
              data-testid="button-confirm-create-supplier"
              onClick={async () => {
                if (!newSupplierName.trim()) return;
                const source = showNewSupplierDialog;
                try {
                  const newSup = await supplierAPI.create({ name: newSupplierName.trim() });
                  queryClient.invalidateQueries({ queryKey: ['/api/suppliers'] });
                  if (source === 'unique') {
                    setNewUniquePayable(prev => ({ ...prev, supplierId: newSup.id }));
                  } else if (source === 'fixed') {
                    setNewFixedCost(prev => ({ ...prev, supplierId: newSup.id }));
                  }
                  setNewSupplierName('');
                  setShowNewSupplierDialog(false);
                  toast({ title: 'Proveedor creado', description: `"${newSup.name}" agregado` });
                } catch (error) {
                  toast({ title: 'Error', description: 'No se pudo crear el proveedor', variant: 'destructive' });
                }
              }}
            >
              Crear proveedor
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!showNewClientDialog} onOpenChange={(open) => { if (!open) { setShowNewClientDialog(false); setNewClientName(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Agregar Cliente</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4 pt-2">
                <div>
                  <label className="text-sm font-medium text-foreground">Nombre del cliente *</label>
                  <Input
                    value={newClientName}
                    onChange={(e) => setNewClientName(e.target.value)}
                    placeholder="Ej: Juan Pérez, Empresa ABC"
                    className="mt-1"
                    autoFocus
                    data-testid="input-new-client-name"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Podés completar más datos después en Base de Datos → Clientes
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setShowNewClientDialog(false); setNewClientName(''); }}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!newClientName.trim()}
              data-testid="button-confirm-create-client"
              onClick={async () => {
                if (!newClientName.trim()) return;
                const source = showNewClientDialog;
                try {
                  const newCli = await clientAPI.create({ name: newClientName.trim() });
                  queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
                  if (source === 'unique') {
                    setNewUniqueReceivable(prev => ({ ...prev, clientId: newCli.id, projectId: '' }));
                  } else if (source === 'recurring') {
                    setNewRecurringIncome(prev => ({ ...prev, clientId: newCli.id }));
                  }
                  setNewClientName('');
                  setShowNewClientDialog(false);
                  toast({ title: 'Cliente creado', description: `"${newCli.name}" agregado` });
                } catch (error) {
                  toast({ title: 'Error', description: 'No se pudo crear el cliente', variant: 'destructive' });
                }
              }}
            >
              Crear cliente
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ============================================================================
// Presupuestos (quotes): cargar un PDF, hacer seguimiento del estado y, si la
// venta se concreta, confirmarlo como movimiento reutilizando la creación de
// transacciones existente.
// ============================================================================
function QuotesSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: membership } = useMembership();
  // Sólo habilitar acciones de mutación cuando la membresía cargó y el rol no es
  // viewer; así no mostramos botones que igualmente devolverían 403.
  const canManage = !!membership && (membership as any)?.role !== 'viewer';
  // Solo el propietario puede fijar el predeterminado de presupuestos de la org.
  const isOwner = (membership as any)?.role === 'owner';
  const updateOrgMutation = useUpdateOrganizationById();

  const todayStr = new Date().toISOString().split('T')[0];

  const { data: quotes = [], isLoading } = useQuery<any[]>({
    queryKey: ['/api/quotes'],
    queryFn: () => quoteAPI.getAll(),
  });
  const { data: clients = [] } = useQuery<any[]>({
    queryKey: ['quotes-clients'],
    queryFn: () => clientAPI.getAll(true),
  });
  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ['quotes-accounts'],
    queryFn: () => accountAPI.getAll(),
  });
  const { data: incomeCategories = [] } = useQuery<any[]>({
    queryKey: ['quotes-income-categories'],
    queryFn: () => categoryAPI.getAll('income'),
  });
  const { data: products = [] } = useQuery<any[]>({
    queryKey: ['quotes-products'],
    queryFn: () => productAPI.getAll(true),
  });
  const { data: profitabilityCodes = [] } = useQuery<any[]>({
    queryKey: ['quotes-profitability'],
    queryFn: () => profitabilityCodeAPI.getAll(true),
  });
  const { data: exchangeRates } = useExchangeRates();
  const { data: organization } = useOrganization();
  const { data: currentUser } = useUser();

  const currencyOptions = Object.keys(CURRENCY_SYMBOLS);

  const emptyForm = { title: '', clientId: 'none', clientName: '', amount: '', currency: 'ARS', date: todayStr, validUntil: '', notes: '', pdfContactEmail: '', pdfContactPhone: '', pdfCompanyName: '', pdfContactName: '' };
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<typeof emptyForm>(emptyForm);
  // Task #481: renglones de productos/servicios del presupuesto. Si hay al menos
  // uno, el total se deriva de la suma; si no hay ninguno, vale el monto único
  // (presupuesto legacy).
  type QuoteLineItem = { productId: string; description: string; quantity: string; unitPrice: string; profitabilityCodeId: string };
  const newLineItem = (): QuoteLineItem => ({ productId: '', description: '', quantity: '1', unitPrice: '', profitabilityCodeId: '' });
  const [items, setItems] = useState<QuoteLineItem[]>([]);
  const itemsTotal = items.reduce((sum, it) => {
    const q = parseFloat(it.quantity);
    const p = parseFloat(it.unitPrice);
    return sum + (Number.isFinite(q) && Number.isFinite(p) ? q * p : 0);
  }, 0);
  const addLineItem = () => setItems((prev) => [...prev, newLineItem()]);
  const removeLineItem = (idx: number) => setItems((prev) => prev.filter((_, i) => i !== idx));
  const updateLineItem = (idx: number, patch: Partial<QuoteLineItem>) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  // Al elegir un producto del catálogo, autocompletamos descripción y precio
  // unitario (precio de venta) si están vacíos, sin pisar lo que el usuario cargó.
  const handleLineProduct = (idx: number, productId: string) => {
    const p = products.find((x: any) => x.id === productId);
    setItems((prev) => prev.map((it, i) => {
      if (i !== idx) return it;
      return {
        ...it,
        productId,
        description: it.description || p?.name || '',
        unitPrice: it.unitPrice || (p?.salePrice != null ? String(p.salePrice) : ''),
      };
    }));
  };
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfName, setPdfName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [aiFileName, setAiFileName] = useState<string | null>(null);
  // Override del logo del PDF SOLO para este presupuesto (objectPath subido).
  const [quoteLogoUrl, setQuoteLogoUrl] = useState<string | null>(null);
  const [quoteLogoUploading, setQuoteLogoUploading] = useState(false);
  // Si está activo, al guardar también se persiste como preset de presupuestos
  // de la organización (solo propietario).
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  // Valor del input "Monto" ya formateado al estilo es-AR (separadores de miles)
  // que se muestra mientras se escribe; form.amount guarda el número crudo.
  const [quoteDisplayAmount, setQuoteDisplayAmount] = useState('');
  const aiFileInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const quoteLogoInputRef = useRef<HTMLInputElement>(null);
  // Devuelve un Date válido a partir del valor guardado (yyyy-MM-dd), o undefined
  // si está vacío o no es una fecha parseable (evita crashear el render).
  const parseQuoteDate = (v: string): Date | undefined => {
    if (!v) return undefined;
    const d = safeParseDate(v);
    return isValid(d) ? d : undefined;
  };
  // Muestra la fecha en formato argentino (dd/MM/yyyy) o null si no es válida.
  const fmtQuoteDate = (v: string): string | null => {
    const d = parseQuoteDate(v);
    return d ? format(d, 'dd/MM/yyyy', { locale: es }) : null;
  };
  const [saving, setSaving] = useState(false);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setItems([]);
    setPdfUrl(null);
    setPdfName(null);
    setAiFileName(null);
    setQuoteLogoUrl(null);
    setSaveAsDefault(false);
    setQuoteDisplayAmount('');
    setIsFormOpen(true);
  };

  const openEdit = (q: any) => {
    setEditingId(q.id);
    setForm({
      title: q.title || '',
      clientId: q.clientId || 'none',
      clientName: q.clientName || '',
      amount: q.amount?.toString() || '',
      currency: q.currency || 'ARS',
      date: q.date ? new Date(q.date).toISOString().split('T')[0] : todayStr,
      validUntil: q.validUntil ? new Date(q.validUntil).toISOString().split('T')[0] : '',
      notes: q.notes || '',
      pdfContactEmail: q.pdfContactEmail || '',
      pdfContactPhone: q.pdfContactPhone || '',
      pdfCompanyName: q.pdfCompanyName || '',
      pdfContactName: q.pdfContactName || '',
    });
    setItems(
      Array.isArray(q.items)
        ? q.items.map((it: any) => ({
            productId: it.productId || '',
            description: it.description || '',
            quantity: it.quantity != null ? String(it.quantity) : '1',
            unitPrice: it.unitPrice != null ? String(it.unitPrice) : '',
            profitabilityCodeId: it.profitabilityCodeId || '',
          }))
        : [],
    );
    setPdfUrl(q.pdfUrl || null);
    setPdfName(q.pdfName || null);
    setAiFileName(null);
    setQuoteLogoUrl(q.pdfLogoUrl || null);
    setSaveAsDefault(false);
    setQuoteDisplayAmount(formatAmountLive(q.amount?.toString() || '').displayValue);
    setIsFormOpen(true);
  };

  // Sube un logo (imagen) a object storage para usarlo SOLO en este presupuesto.
  const handleQuoteLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast({ title: 'Archivo inválido', description: 'Subí una imagen (PNG o JPG).', variant: 'destructive' });
      e.target.value = '';
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: 'Imagen muy grande', description: 'El logo debe pesar menos de 2MB.', variant: 'destructive' });
      e.target.value = '';
      return;
    }
    setQuoteLogoUploading(true);
    try {
      const objectPath = await uploadToStorage(file);
      setQuoteLogoUrl(objectPath);
    } catch (err: any) {
      toast({ title: 'No se pudo subir el logo', description: err?.message || 'Intentá de nuevo.', variant: 'destructive' });
    } finally {
      setQuoteLogoUploading(false);
      e.target.value = '';
    }
  };

  // Sube el archivo (PDF o imagen) a object storage y devuelve su objectPath, o
  // lanza si falla. Reutilizado por la carga manual y por la carga con IA.
  const uploadToStorage = async (file: File): Promise<string> => {
    const { uploadURL, objectPath } = await fetchWithAuth('/uploads/request-url', {
      method: 'POST',
      body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
    });
    const putRes = await fetch(uploadURL, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
    if (!putRes.ok) throw new Error('No se pudo subir el archivo');
    return objectPath;
  };

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isPdf = file.type === 'application/pdf';
    const isImage = file.type.startsWith('image/');
    if (!isPdf && !isImage) {
      toast({ title: 'Archivo inválido', description: 'Subí un PDF o una imagen (JPG/PNG).', variant: 'destructive' });
      e.target.value = '';
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: 'Archivo muy grande', description: 'El archivo no puede superar los 10MB.', variant: 'destructive' });
      e.target.value = '';
      return;
    }
    setUploading(true);
    try {
      const objectPath = await uploadToStorage(file);
      setPdfUrl(objectPath);
      setPdfName(file.name);
      toast({ title: 'Archivo subido', description: file.name });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message || 'No se pudo subir el archivo', variant: 'destructive' });
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  // Carga con IA: sube el PDF/foto, lo manda a interpretar y precompleta el
  // formulario con lo que detectó. El archivo queda adjunto al presupuesto.
  const handleAiUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isPdf = file.type === 'application/pdf';
    const isImage = file.type.startsWith('image/');
    if (!isPdf && !isImage) {
      toast({ title: 'Archivo inválido', description: 'Subí un PDF o una foto (JPG/PNG).', variant: 'destructive' });
      e.target.value = '';
      setAiFileName(null);
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: 'Archivo muy grande', description: 'Para interpretar con IA el archivo no puede superar los 5MB.', variant: 'destructive' });
      e.target.value = '';
      setAiFileName(null);
      return;
    }
    setAiFileName(file.name);
    setAnalyzing(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const result = await fetchWithAuth('/ai/analyze-quote', {
        method: 'POST',
        body: JSON.stringify({ imageBase64: base64, mimeType: file.type }),
      });

      if (result?.error) {
        toast({ title: 'No se pudo interpretar', description: result.error, variant: 'destructive' });
      } else {
        setForm((prev) => {
          const upd = { ...prev };
          // El modelo a veces devuelve el string "null"/"undefined" en vez de
          // null real; lo tratamos como vacío.
          const clean = (v: any): string | null => {
            if (v == null) return null;
            const s = String(v).trim();
            return s && s.toLowerCase() !== 'null' && s.toLowerCase() !== 'undefined' ? s : null;
          };
          // Normaliza fechas que devuelve la IA (ISO o dd/MM/yyyy) a yyyy-MM-dd;
          // descarta lo que no sea una fecha válida para no romper el formulario.
          const cleanDate = (v: any): string | null => {
            const s = clean(v);
            if (!s) return null;
            if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
              const iso = safeParseDate(s);
              if (isValid(iso)) return format(iso, 'yyyy-MM-dd');
            }
            const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
            if (m) {
              const d2 = new Date(+m[3], +m[2] - 1, +m[1], 12, 0, 0);
              if (isValid(d2)) return format(d2, 'yyyy-MM-dd');
            }
            return null;
          };
          const title = clean(result.title);
          if (title) upd.title = title;
          // Derivar el valor crudo del mismo parseo que el display para que lo
          // mostrado (con separadores) y lo guardado nunca se desincronicen.
          // Usamos parseo locale-aware: la IA puede devolver el monto en formato
          // rioplatense ("1.234,56") que Number(...) interpretaría como NaN.
          if (result.amount != null && normalizeAmountInput(result.amount) > 0) upd.amount = formatAmountLive(String(result.amount)).internalValue;
          if (result.currency && currencyOptions.includes(result.currency)) upd.currency = result.currency;
          const date = cleanDate(result.date);
          if (date) upd.date = date;
          const validUntil = cleanDate(result.validUntil);
          if (validUntil) upd.validUntil = validUntil;

          let matched: any = null;
          const clientName = clean(result.clientName);
          if (clientName) {
            const target = clientName.toLocaleLowerCase('es-AR');
            matched = clients.find((c: any) => (c.name || '').trim().toLocaleLowerCase('es-AR') === target);
            if (matched) upd.clientId = matched.id;
          }

          const noteParts: string[] = [];
          const notes = clean(result.notes);
          if (notes) noteParts.push(notes);
          if (clientName && !matched) noteParts.push(`Cliente: ${clientName}`);
          if (noteParts.length) upd.notes = noteParts.join('\n');

          return upd;
        });
        // Sincronizar el monto mostrado (con separadores) con lo que cargó la IA.
        if (result.amount != null && normalizeAmountInput(result.amount) > 0) {
          setQuoteDisplayAmount(formatAmountLive(String(result.amount)).displayValue);
        }
        toast({ title: 'Datos cargados', description: 'Revisá y editá si hace falta, después confirmá.' });
      }

      // Adjuntar el archivo al presupuesto (aunque la IA no haya interpretado
      // todo). Si falla, avisamos para que el usuario lo suba a mano abajo.
      try {
        const objectPath = await uploadToStorage(file);
        setPdfUrl(objectPath);
        setPdfName(file.name);
      } catch {
        toast({
          title: 'No se pudo adjuntar el archivo',
          description: 'Los datos se cargaron, pero el archivo no quedó adjunto. Subilo a mano en "Archivo del presupuesto".',
          variant: 'destructive',
        });
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err.message || 'No se pudo analizar el archivo', variant: 'destructive' });
    } finally {
      setAnalyzing(false);
      e.target.value = '';
    }
  };

  const handleSave = async () => {
    if (!form.title.trim()) {
      toast({ title: 'Falta el título', description: 'Ingresá un título o descripción.', variant: 'destructive' });
      return;
    }
    // Task #481: con renglones, el total se deriva de la suma de líneas; sin
    // renglones, vale el monto único (presupuesto legacy).
    const hasItems = items.length > 0;
    let payloadItems: any[] | undefined;
    let amountValue: number | string;
    if (hasItems) {
      const cleaned: any[] = [];
      for (const it of items) {
        const desc = (it.description || '').trim();
        const q = parseFloat(it.quantity);
        const p = parseFloat(it.unitPrice);
        if (!desc && !it.productId) {
          toast({ title: 'Renglón incompleto', description: 'Cada renglón necesita un producto o una descripción.', variant: 'destructive' });
          return;
        }
        if (!Number.isFinite(q) || q <= 0) {
          toast({ title: 'Cantidad inválida', description: 'La cantidad de cada renglón debe ser mayor a 0.', variant: 'destructive' });
          return;
        }
        if (!Number.isFinite(p) || p < 0) {
          toast({ title: 'Precio inválido', description: 'El precio unitario de cada renglón debe ser 0 o mayor.', variant: 'destructive' });
          return;
        }
        cleaned.push({
          productId: it.productId || null,
          description: desc || null,
          quantity: q,
          unitPrice: p,
          profitabilityCodeId: it.profitabilityCodeId || null,
        });
      }
      payloadItems = cleaned;
      amountValue = parseFloat(itemsTotal.toFixed(2));
      if (amountValue <= 0) {
        toast({ title: 'Total inválido', description: 'El total de los renglones debe ser mayor a 0.', variant: 'destructive' });
        return;
      }
    } else {
      const preparedAmount = prepareQuoteAmount(form.amount);
      if (!preparedAmount.ok) {
        toast({ title: 'Monto inválido', description: 'Ingresá un monto mayor a 0.', variant: 'destructive' });
        return;
      }
      amountValue = preparedAmount.amountValue;
    }
    setSaving(true);
    try {
      const clientId = form.clientId === 'none' ? null : form.clientId;
      const selectedClient = clients.find((c: any) => c.id === clientId);
      const payload: any = {
        title: form.title.trim(),
        clientId,
        clientName: form.clientName.trim() || selectedClient?.name || null,
        amount: amountValue,
        items: payloadItems ?? [],
        currency: form.currency,
        date: new Date(form.date + 'T12:00:00').toISOString(),
        validUntil: form.validUntil ? new Date(form.validUntil + 'T12:00:00').toISOString() : null,
        notes: form.notes.trim() || null,
        pdfUrl,
        pdfName,
        // Datos del membrete del PDF, override por presupuesto (null = cae a la org).
        pdfLogoUrl: quoteLogoUrl || null,
        pdfContactEmail: form.pdfContactEmail.trim() || null,
        pdfContactPhone: form.pdfContactPhone.trim() || null,
        pdfCompanyName: form.pdfCompanyName.trim() || null,
        pdfContactName: form.pdfContactName.trim() || null,
      };
      if (editingId) {
        await quoteAPI.update(editingId, payload);
        toast({ title: 'Presupuesto actualizado' });
      } else {
        await quoteAPI.create(payload);
        toast({ title: 'Presupuesto creado' });
      }
      // El presupuesto ya quedó guardado: cerramos y refrescamos primero para no
      // depender del preset opcional de la organización.
      queryClient.invalidateQueries({ queryKey: ['/api/quotes'] });
      setIsFormOpen(false);
      // Si el propietario marcó "usar como predeterminado", persistir el preset de
      // datos del PDF a nivel organización. Si falla, NO invalidamos el guardado
      // del presupuesto: solo avisamos que el predeterminado no se pudo guardar.
      if (saveAsDefault && isOwner && (organization as any)?.id) {
        try {
          await updateOrgMutation.mutateAsync({
            id: (organization as any).id,
            data: {
              quotePdfLogoUrl: quoteLogoUrl || null,
              quotePdfContactEmail: form.pdfContactEmail.trim() || null,
              quotePdfContactPhone: form.pdfContactPhone.trim() || null,
              quotePdfCompanyName: form.pdfCompanyName.trim() || null,
              quotePdfContactName: form.pdfContactName.trim() || null,
            },
          });
          toast({ title: 'Predeterminado guardado', description: 'Estos datos se usarán en los próximos presupuestos.' });
        } catch (presetErr: any) {
          toast({
            title: 'El presupuesto se guardó',
            description: 'Pero no se pudo fijar como predeterminado de la organización. Probá de nuevo desde otro presupuesto.',
            variant: 'destructive',
          });
        }
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  // Confirmar venta -> crear movimiento (ingreso o a cobrar) y marcar ganado
  const [winQuote, setWinQuote] = useState<any | null>(null);
  const [winType, setWinType] = useState<'income' | 'receivable'>('income');
  const [winAccountId, setWinAccountId] = useState('');
  const [winCategory, setWinCategory] = useState('');
  const [winDate, setWinDate] = useState(todayStr);
  const [winExchangeRate, setWinExchangeRate] = useState('');
  const [winSubmitting, setWinSubmitting] = useState(false);

  // Si el paso "win" falla después de crear el movimiento, guardamos el id del
  // movimiento ya creado para reusarlo en el reintento y no duplicarlo.
  const [pendingTxId, setPendingTxId] = useState<string | null>(null);

  const openWin = (q: any) => {
    setWinQuote(q);
    setWinType('income');
    setWinAccountId('');
    setWinCategory('');
    setWinDate(todayStr);
    setWinExchangeRate('');
    setPendingTxId(null);
  };

  // Normaliza la moneda (USD_CASH cuenta como USD a efectos de comparación/conversión).
  const normWinCurrency = (c: string) => (c === 'USD_CASH' ? 'USD' : c);

  // Cotización contra la moneda local (ARS) para las monedas que el sistema
  // sabe cotizar. Devuelve null si no hay cotización conocida (otras monedas).
  const winRateToArs = (c: string): number | null => {
    const n = normWinCurrency(c);
    if (n === 'ARS') return 1;
    if (n === 'USD') return exchangeRates?.usdToLocal ?? 1050;
    if (n === 'EUR') return exchangeRates?.eurToLocal ?? 1150;
    return null;
  };

  // Tipo de cambio por defecto expresado como "1 [moneda del presupuesto] = X [moneda de la cuenta]".
  const winDefaultRate = (quoteCurrency: string, accountCurrency: string): number | null => {
    const rq = winRateToArs(quoteCurrency);
    const ra = winRateToArs(accountCurrency);
    if (rq == null || ra == null || ra === 0) return null;
    return rq / ra;
  };

  const selectedWinAccount = winAccountId
    ? accounts.find((a: any) => String(a.id) === String(winAccountId))
    : undefined;

  // Hace falta convertir cuando es un ingreso, hay cuenta elegida y la moneda
  // de la cuenta difiere de la del presupuesto.
  const winNeedsConversion = !!(
    winQuote &&
    winType === 'income' &&
    selectedWinAccount &&
    normWinCurrency(selectedWinAccount.currency) !== normWinCurrency(winQuote.currency)
  );

  // Parseo robusto del tipo de cambio. Acepta formato es-AR ("1.050,50") y
  // también punto como separador decimal ("1.25"), sin confundir un punto
  // decimal con uno de miles: si hay coma, manda la coma como decimal y los
  // puntos son miles; si sólo hay puntos, se tratan como miles únicamente
  // cuando hay más de uno o el último grupo tiene 3 dígitos.
  const parseRateInput = (raw: string): number | null => {
    if (!raw || !raw.trim()) return null;
    let s = raw.trim().replace(/\s/g, '');
    if (s.includes(',')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else if (s.includes('.')) {
      const parts = s.split('.');
      const last = parts[parts.length - 1];
      if (parts.length > 2 || last.length === 3) {
        s = parts.join('');
      }
    }
    const n = parseFloat(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // Tipo de cambio efectivo: el editado por el usuario o el default.
  const winEffectiveRate: number | null = (() => {
    if (!winNeedsConversion || !winQuote || !selectedWinAccount) return null;
    const parsed = parseRateInput(winExchangeRate);
    if (parsed != null) return parsed;
    return winDefaultRate(winQuote.currency, selectedWinAccount.currency);
  })();

  const winConvertedAmount: number | null =
    winNeedsConversion && winQuote && winEffectiveRate != null
      ? parseFloat(winQuote.amount) * winEffectiveRate
      : null;

  const compatibleAccounts = winQuote
    ? accounts.filter((a: any) => {
        const ac = a.currency === 'USD_CASH' ? 'USD' : a.currency;
        const qc = winQuote.currency === 'USD_CASH' ? 'USD' : winQuote.currency;
        return ac === qc;
      })
    : [];

  // Al elegir una cuenta para registrar el ingreso, precargamos el tipo de
  // cambio sugerido cuando hace falta convertir (y lo limpiamos si no).
  const handleWinAccountChange = (accountId: string) => {
    setWinAccountId(accountId);
    if (!winQuote) return;
    const acc = accounts.find((a: any) => String(a.id) === String(accountId));
    if (!acc || normWinCurrency(acc.currency) === normWinCurrency(winQuote.currency)) {
      setWinExchangeRate('');
      return;
    }
    const def = winDefaultRate(winQuote.currency, acc.currency);
    setWinExchangeRate(
      def != null
        ? def.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
        : '',
    );
  };

  const handleWin = async () => {
    if (!winQuote) return;
    if (winType === 'income' && !winAccountId) {
      toast({ title: 'Elegí una cuenta', description: 'Indicá en qué cuenta entró el cobro.', variant: 'destructive' });
      return;
    }
    if (!winCategory) {
      toast({ title: 'Elegí un concepto', description: 'Indicá a qué concepto de ingreso corresponde la venta.', variant: 'destructive' });
      return;
    }
    if (winNeedsConversion && (winEffectiveRate == null || !Number.isFinite(winEffectiveRate) || winEffectiveRate <= 0 || winConvertedAmount == null)) {
      toast({ title: 'Revisá el tipo de cambio', description: 'No se pudo calcular el monto convertido. Ingresá un tipo de cambio válido.', variant: 'destructive' });
      return;
    }
    setWinSubmitting(true);
    try {
      let txId = pendingTxId;
      if (!txId) {
        const dateIso = new Date(winDate + 'T12:00:00').toISOString();
        // Cuando la cuenta está en otra moneda que el presupuesto, registramos
        // el ingreso en la moneda de la cuenta con el monto convertido y dejamos
        // constancia del monto/moneda originales en la descripción.
        const txAmount = winNeedsConversion && winConvertedAmount != null
          ? winConvertedAmount.toFixed(2)
          : winQuote.amount;
        const txCurrency = winNeedsConversion && selectedWinAccount
          ? selectedWinAccount.currency
          : winQuote.currency;
        const txDescription = winNeedsConversion && winEffectiveRate != null
          ? `${winQuote.title} (orig. ${fmtMoney(winQuote.amount, winQuote.currency)} · TC ${winEffectiveRate.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 6 })})`
          : winQuote.title;
        // Task #481: precargamos los renglones del presupuesto como items del
        // movimiento (para reportes/stock) SOLO cuando el contrato del backend lo
        // permite: todas las líneas con productId, al menos 2, y sin conversión de
        // moneda (los items van en la moneda original del presupuesto). Si no se
        // cumple, caemos al monto único de siempre.
        const winQuoteItems: any[] = Array.isArray(winQuote.items) ? winQuote.items : [];
        const allHaveProduct = winQuoteItems.length >= 2 && winQuoteItems.every((it: any) => !!it.productId);
        const txItems = !winNeedsConversion && allHaveProduct
          ? winQuoteItems.map((it: any) => ({
              productId: it.productId,
              quantity: Number(it.quantity),
              unitPrice: Number(it.unitPrice),
              description: it.description || undefined,
              profitabilityCodeId: it.profitabilityCodeId || undefined,
            }))
          : undefined;
        const tx = await transactionAPI.create({
          type: winType,
          amount: txAmount,
          currency: txCurrency,
          description: txDescription,
          category: winCategory,
          date: dateIso,
          imputationDate: dateIso,
          accountId: winType === 'income' ? (winAccountId || null) : null,
          clientId: winQuote.clientId || null,
          status: winType === 'income' ? 'completed' : 'scheduled',
          ...(txItems ? { items: txItems } : {}),
        });
        if (!tx?.id) throw new Error('No se pudo crear el movimiento');
        txId = tx.id;
        setPendingTxId(txId);
      }
      if (!txId) throw new Error('No se pudo crear el movimiento');
      await quoteAPI.win(winQuote.id, txId);
      setPendingTxId(null);
      queryClient.invalidateQueries({ queryKey: ['/api/quotes'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/accounts'] });
      toast({ title: 'Venta confirmada', description: winType === 'income' ? 'Se registró el ingreso.' : 'Se registró como cuenta a cobrar.' });
      setWinQuote(null);
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setWinSubmitting(false);
    }
  };

  const [loseId, setLoseId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const handleLose = async () => {
    if (!loseId) return;
    try {
      await quoteAPI.lose(loseId);
      queryClient.invalidateQueries({ queryKey: ['/api/quotes'] });
      toast({ title: 'Marcado como perdido' });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setLoseId(null);
    }
  };

  const handleReopen = async (q: any) => {
    try {
      await quoteAPI.reopen(q.id);
      queryClient.invalidateQueries({ queryKey: ['/api/quotes'] });
      toast({ title: 'Presupuesto reabierto' });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await quoteAPI.delete(deleteId);
      queryClient.invalidateQueries({ queryKey: ['/api/quotes'] });
      toast({ title: 'Presupuesto eliminado' });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setDeleteId(null);
    }
  };

  const fmtMoney = (amount: any, currency: string) =>
    `${getCurrencySymbol(currency)} ${Number(amount).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Carga una imagen y la convierte a dataURL (PNG) junto con sus dimensiones.
  // Si la imagen es de otro origen sin CORS, el canvas queda "tainted" y
  // toDataURL lanza; en ese caso devolvemos null y el PDF se genera sin logo.
  const loadImageData = (url: string): Promise<{ dataUrl: string; w: number; h: number } | null> =>
    new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) return resolve(null);
          ctx.drawImage(img, 0, 0);
          resolve({ dataUrl: canvas.toDataURL('image/png'), w: img.naturalWidth, h: img.naturalHeight });
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });

  // Genera y DESCARGA un archivo PDF del presupuesto con membrete: logo + nombre
  // de la empresa (organización) y datos de contacto de quien lo emite (usuario
  // actual). Si falta el logo, se muestra igual el nombre; los datos de contacto
  // que falten se omiten sin romper el documento.
  const downloadQuotePdf = async (q: any) => {
    try {
      const { jsPDF } = await import('jspdf');
      // Prioridad de datos del membrete: presupuesto -> preset de la org ->
      // datos de la org -> datos del usuario que descarga.
      const orgName = q.pdfCompanyName || (organization as any)?.quotePdfCompanyName || organization?.name || 'Aikestar';
      const rawLogo = q.pdfLogoUrl || (organization as any)?.quotePdfLogoUrl || organization?.logoUrl || '';
      const logoUrl = rawLogo ? (/^https?:\/\//.test(rawLogo) ? rawLogo : `${window.location.origin}${rawLogo}`) : '';
      const contactName = q.pdfContactName || (organization as any)?.quotePdfContactName || (currentUser as any)?.preferredName || (currentUser as any)?.name || '';
      const contactEmail = q.pdfContactEmail || (organization as any)?.quotePdfContactEmail || (organization as any)?.contactEmail || (currentUser as any)?.email || '';
      const contactPhone = q.pdfContactPhone || (organization as any)?.quotePdfContactPhone || (organization as any)?.contactPhone || (currentUser as any)?.phoneNumber || '';
      const recipient = q.clientName || '';
      const dateFmt = q.date ? format(safeParseDate(q.date), "d 'de' MMMM 'de' yyyy", { locale: es }) : '-';
      const validFmt = q.validUntil ? format(safeParseDate(q.validUntil), "d 'de' MMMM 'de' yyyy", { locale: es }) : '';

      const logo = logoUrl ? await loadImageData(logoUrl) : null;

      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const margin = 20;
      const contentW = pageW - margin * 2;
      let y = margin;

      // Membrete: logo + nombre (izquierda), contacto (derecha)
      let leftBottom = y;
      if (logo) {
        const maxH = 18;
        const maxW = 55;
        const ratio = Math.min(maxW / logo.w, maxH / logo.h);
        const w = logo.w * ratio;
        const h = logo.h * ratio;
        doc.addImage(logo.dataUrl, 'PNG', margin, y, w, h);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(16);
        doc.setTextColor(15, 23, 42);
        doc.text(orgName, margin + w + 4, y + h / 2 + 2);
        leftBottom = y + h;
      } else {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(18);
        doc.setTextColor(15, 23, 42);
        doc.text(orgName, margin, y + 6);
        leftBottom = y + 8;
      }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(90, 90, 90);
      let cy = y + 2;
      [contactName, contactEmail, contactPhone].filter(Boolean).forEach((line) => {
        doc.text(line, pageW - margin, cy, { align: 'right' });
        cy += 4.5;
      });

      y = Math.max(leftBottom, cy) + 6;
      doc.setDrawColor(0, 212, 255);
      doc.setLineWidth(0.6);
      doc.line(margin, y, pageW - margin, y);
      y += 11;

      // Título y fechas
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(22);
      doc.setTextColor(15, 23, 42);
      doc.text('Presupuesto', margin, y);
      y += 7;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(100, 100, 100);
      doc.text(`Fecha: ${dateFmt}${validFmt ? `    Valido hasta: ${validFmt}` : ''}`, margin, y);
      y += 11;

      // Para (destinatario)
      if (recipient) {
        doc.setFontSize(8);
        doc.setTextColor(120, 120, 120);
        doc.text('PARA', margin, y);
        y += 5;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.setTextColor(20, 20, 20);
        doc.text(recipient, margin, y);
        y += 9;
        doc.setFont('helvetica', 'normal');
      }

      // Task #481: si el presupuesto tiene renglones, renderizamos una tabla
      // (descripción, cantidad, precio unitario, subtotal) + total. Si no tiene
      // (presupuesto legacy), mostramos la caja clásica con título + monto.
      const quoteItems: any[] = Array.isArray(q.items) ? q.items : [];
      const boxPad = 6;
      if (quoteItems.length > 0) {
        // Columnas: descripción | cant | precio unit | subtotal
        const colQtyW = 18;
        const colUnitW = 30;
        const colSubW = 32;
        const colDescW = contentW - colQtyW - colUnitW - colSubW;
        const descX = margin;
        const qtyX = margin + colDescW;
        const unitX = qtyX + colQtyW;
        const subRightX = pageW - margin;
        // Encabezado
        doc.setFillColor(8, 145, 178);
        doc.rect(margin, y, contentW, 8, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(255, 255, 255);
        doc.text('Descripcion', descX + 2, y + 5.5);
        doc.text('Cant.', qtyX + colQtyW - 2, y + 5.5, { align: 'right' });
        doc.text('P. unit.', unitX + colUnitW - 2, y + 5.5, { align: 'right' });
        doc.text('Subtotal', subRightX - 2, y + 5.5, { align: 'right' });
        y += 8;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        let zebra = false;
        for (const it of quoteItems) {
          const qty = Number(it.quantity) || 0;
          const unit = Number(it.unitPrice) || 0;
          const sub = qty * unit;
          const descLines = doc.splitTextToSize(String(it.description || ''), colDescW - 4);
          const rowH = Math.max(7, descLines.length * 4.5 + 3);
          if (zebra) {
            doc.setFillColor(245, 247, 249);
            doc.rect(margin, y, contentW, rowH, 'F');
          }
          zebra = !zebra;
          doc.setTextColor(40, 40, 40);
          doc.text(descLines, descX + 2, y + 4.5);
          doc.text(String(qty), qtyX + colQtyW - 2, y + 4.5, { align: 'right' });
          doc.text(fmtMoney(unit, q.currency), unitX + colUnitW - 2, y + 4.5, { align: 'right' });
          doc.text(fmtMoney(sub, q.currency), subRightX - 2, y + 4.5, { align: 'right' });
          y += rowH;
        }
        // Línea + total
        doc.setDrawColor(220, 220, 220);
        doc.setLineWidth(0.2);
        doc.line(margin, y, pageW - margin, y);
        y += 6;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(80, 80, 80);
        doc.text('TOTAL', unitX + colUnitW - 2, y + 2, { align: 'right' });
        doc.setFontSize(18);
        doc.setTextColor(8, 145, 178);
        doc.text(fmtMoney(q.amount, q.currency), subRightX - 2, y + 3, { align: 'right' });
        y += 14;
      } else {
        // Caja con descripción y monto (legacy)
        const descLines = doc.splitTextToSize(q.title || '', contentW - boxPad * 2);
        const descBlockH = descLines.length * 5;
        const boxH = boxPad * 2 + descBlockH + 16;
        const boxTop = y;
        doc.setFillColor(248, 249, 250);
        doc.roundedRect(margin, boxTop, contentW, boxH, 2, 2, 'F');
        let by = boxTop + boxPad + 4;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(100, 100, 100);
        doc.text('Descripcion', margin + boxPad, by);
        by += 6;
        doc.setTextColor(20, 20, 20);
        doc.text(descLines, margin + boxPad, by);
        by += descBlockH + 6;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(20);
        doc.setTextColor(8, 145, 178);
        doc.text(fmtMoney(q.amount, q.currency), pageW - margin - boxPad, by, { align: 'right' });
        y = boxTop + boxH + 11;
      }

      // Notas
      if (q.notes) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(120, 120, 120);
        doc.text('NOTAS', margin, y);
        y += 5;
        doc.setFontSize(10);
        doc.setTextColor(50, 50, 50);
        const noteLines = doc.splitTextToSize(q.notes, contentW);
        doc.text(noteLines, margin, y);
        y += noteLines.length * 5 + 6;
      }

      // Pie de página
      const footerY = pageH - 15;
      doc.setDrawColor(220, 220, 220);
      doc.setLineWidth(0.2);
      doc.line(margin, footerY - 5, pageW - margin, footerY - 5);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(
        `Presupuesto generado el ${format(new Date(), "d 'de' MMMM 'de' yyyy 'a las' HH:mm", { locale: es })} desde ${orgName}.`,
        margin,
        footerY,
      );

      const safeName = (q.title || 'presupuesto')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
        .slice(0, 40) || 'presupuesto';
      doc.save(`presupuesto-${safeName}.pdf`);
      const orgHasContact = !!((organization as any)?.contactEmail || (organization as any)?.contactPhone);
      toast({
        title: 'PDF descargado',
        description: orgHasContact
          ? 'Revisá tu carpeta de descargas.'
          : 'Se usaron tus datos de contacto. Para que figuren los de la empresa, cargalos en Configuración (tocá el logo de la organización).',
      });
    } catch {
      toast({ title: 'No se pudo generar el PDF', description: 'Intentá de nuevo en un momento.', variant: 'destructive' });
    }
  };

  const statusBadge = (status: string) => {
    if (status === 'won') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" data-testid={`status-quote-${status}`}>Ganado</span>;
    if (status === 'lost') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-muted text-muted-foreground" data-testid={`status-quote-${status}`}>Perdido</span>;
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" data-testid="status-quote-pending">Pendiente</span>;
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-cyan-500" />
              Presupuestos
            </CardTitle>
            <CardDescription>Cargá presupuestos, hacé seguimiento y confirmá la venta cuando se concrete.</CardDescription>
          </div>
          {canManage && (
            <Button onClick={openCreate} data-testid="button-new-quote" className="bg-gradient-to-r from-cyan-500 to-blue-600 text-white">
              <Plus className="h-4 w-4 mr-2" />
              Nuevo presupuesto
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-12 text-center text-muted-foreground">Cargando presupuestos...</div>
          ) : quotes.length === 0 ? (
            <div className="py-12 text-center" data-testid="empty-quotes">
              <FileText className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
              <p className="text-muted-foreground">Todavía no cargaste ningún presupuesto.</p>
              {canManage && (
                <Button variant="outline" onClick={openCreate} className="mt-4" data-testid="button-new-quote-empty">
                  <Plus className="h-4 w-4 mr-2" />
                  Cargar el primero
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {quotes.map((q: any) => (
                <div
                  key={q.id}
                  data-testid={`card-quote-${q.id}`}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border bg-card hover:bg-muted/40 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold truncate" data-testid={`text-quote-title-${q.id}`}>{q.title}</span>
                      {statusBadge(q.status)}
                    </div>
                    <div className="text-sm text-muted-foreground flex items-center gap-3 flex-wrap mt-1">
                      <span className="font-medium text-foreground" data-testid={`text-quote-amount-${q.id}`}>{fmtMoney(q.amount, q.currency)}</span>
                      {q.clientName && <span className="inline-flex items-center gap-1"><User className="h-3.5 w-3.5" />{q.clientName}</span>}
                      <span className="inline-flex items-center gap-1"><Calendar className="h-3.5 w-3.5" />{new Date(q.date).toLocaleDateString('es-AR')}</span>
                      {q.pdfUrl && (
                        <a
                          href={q.pdfUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-cyan-600 hover:underline"
                          data-testid={`link-quote-pdf-${q.id}`}
                        >
                          <Download className="h-3.5 w-3.5" />
                          {q.pdfName || 'Ver PDF'}
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap shrink-0">
                    <Button size="sm" variant="outline" onClick={() => downloadQuotePdf(q)} data-testid={`button-download-quote-${q.id}`}>
                      <Download className="h-4 w-4 mr-1" />
                      PDF
                    </Button>
                    {canManage && (
                      <>
                      {q.status === 'pending' && (
                        <>
                          <Button size="sm" onClick={() => openWin(q)} data-testid={`button-win-quote-${q.id}`} className="bg-green-600 hover:bg-green-700 text-white">
                            <CheckCircle2 className="h-4 w-4 mr-1" />
                            Ganado
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setLoseId(q.id)} data-testid={`button-lose-quote-${q.id}`}>
                            <XCircle className="h-4 w-4 mr-1" />
                            Perdido
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => openEdit(q)} data-testid={`button-edit-quote-${q.id}`}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                      {q.status === 'lost' && (
                        <Button size="sm" variant="outline" onClick={() => handleReopen(q)} data-testid={`button-reopen-quote-${q.id}`}>
                          <RefreshCw className="h-4 w-4 mr-1" />
                          Reabrir
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setDeleteId(q.id)} data-testid={`button-delete-quote-${q.id}`}>
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Crear / editar presupuesto */}
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent
          className="max-w-lg max-h-[90vh] overflow-y-auto"
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{editingId ? 'Editar presupuesto' : 'Nuevo presupuesto'}</DialogTitle>
            <DialogDescription>Completá los datos a mano o subí el PDF/foto para que la IA los complete. Después revisás y confirmás.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {!editingId && (
              <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Sparkles className="h-4 w-4 text-cyan-500" />
                  Cargar con IA (opcional)
                </div>
                <p className="text-xs text-muted-foreground">
                  Subí el PDF o una foto del presupuesto y la IA completa los datos por vos. Después revisás, editás si hace falta y confirmás.
                </p>
                <div className="flex items-center gap-2">
                  <input
                    ref={aiFileInputRef}
                    type="file"
                    accept="application/pdf,image/*"
                    onChange={handleAiUpload}
                    disabled={analyzing}
                    className="hidden"
                    data-testid="input-quote-ai-file"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => aiFileInputRef.current?.click()}
                    disabled={analyzing}
                    data-testid="button-quote-ai-file"
                  >
                    Elegir archivo
                  </Button>
                  <span className="text-xs text-muted-foreground truncate max-w-[55%]" aria-live="polite" data-testid="text-quote-ai-filename">
                    {aiFileName || 'Ningún archivo seleccionado'}
                  </span>
                  {analyzing && <Loader2 className="h-4 w-4 animate-spin text-cyan-500" />}
                </div>
                {analyzing && <p className="text-xs text-cyan-600" data-testid="text-quote-ai-analyzing">Analizando el documento…</p>}
              </div>
            )}
            <div>
              <Label htmlFor="quote-title">Título o descripción</Label>
              <Input
                id="quote-title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Ej: Diseño de sitio web"
                data-testid="input-quote-title"
              />
            </div>
            <div>
              <Label htmlFor="quote-recipient">Para (destinatario)</Label>
              <Input
                id="quote-recipient"
                value={form.clientName}
                onChange={(e) => setForm({ ...form, clientName: e.target.value })}
                placeholder="Ej: Juan Pérez / Acme S.A."
                data-testid="input-quote-recipient"
              />
              <p className="text-xs text-muted-foreground mt-1">Podés escribirlo a mano; no hace falta guardarlo como cliente.</p>
            </div>
            <div>
              <Label>Cliente (opcional)</Label>
              <Select
                value={form.clientId}
                onValueChange={(v) => {
                  const sel = clients.find((c: any) => c.id === v);
                  setForm((prev) => ({ ...prev, clientId: v, clientName: sel?.name || prev.clientName }));
                }}
              >
                <SelectTrigger data-testid="select-quote-client">
                  <SelectValue placeholder="Sin cliente" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sin cliente</SelectItem>
                  {clients.map((c: any) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">Vinculalo a un cliente guardado para reflejarlo en su Cuenta Corriente al ganar.</p>
            </div>
            {/* Task #481: renglones de productos/servicios. Si hay al menos uno,
                el total se deriva de la suma y el monto manual se reemplaza por
                el total calculado (solo lectura). Sin renglones, sigue el monto
                único de siempre (presupuesto legacy). */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Productos / servicios (opcional)</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addLineItem}
                  data-testid="button-add-quote-item"
                >
                  <Plus className="h-4 w-4 mr-1" /> Agregar renglón
                </Button>
              </div>
              {items.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Agregá renglones para detallar productos o servicios con cantidad y precio. El total se calcula solo. Si no, cargá un monto único abajo.
                </p>
              ) : (
                <div className="space-y-3">
                  {items.map((it, idx) => {
                    const q = parseFloat(it.quantity);
                    const p = parseFloat(it.unitPrice);
                    const sub = Number.isFinite(q) && Number.isFinite(p) ? q * p : 0;
                    return (
                      <div key={idx} className="rounded-lg border border-border/60 p-3 space-y-2" data-testid={`row-quote-item-${idx}`}>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <Label className="text-xs">Producto (opcional)</Label>
                            <Select
                              value={it.productId || 'none'}
                              onValueChange={(v) => (v === 'none' ? updateLineItem(idx, { productId: '' }) : handleLineProduct(idx, v))}
                            >
                              <SelectTrigger data-testid={`select-quote-item-product-${idx}`}>
                                <SelectValue placeholder="Sin producto" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">Sin producto</SelectItem>
                                {products.map((prod: any) => (
                                  <SelectItem key={prod.id} value={prod.id}>{prod.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-xs">Código de rentabilidad (opcional)</Label>
                            <Select
                              value={it.profitabilityCodeId || 'none'}
                              onValueChange={(v) => updateLineItem(idx, { profitabilityCodeId: v === 'none' ? '' : v })}
                            >
                              <SelectTrigger data-testid={`select-quote-item-code-${idx}`}>
                                <SelectValue placeholder="Sin código" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">Sin código</SelectItem>
                                {profitabilityCodes.map((code: any) => (
                                  <SelectItem key={code.id} value={code.id}>{code.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs">Descripción</Label>
                          <Input
                            value={it.description}
                            onChange={(e) => updateLineItem(idx, { description: e.target.value })}
                            placeholder="Ej: Hora de consultoría"
                            data-testid={`input-quote-item-description-${idx}`}
                          />
                        </div>
                        <div className="grid grid-cols-12 gap-2 items-end">
                          <div className="col-span-3">
                            <Label className="text-xs">Cantidad</Label>
                            <Input
                              type="number"
                              min="0"
                              step="any"
                              value={it.quantity}
                              onChange={(e) => updateLineItem(idx, { quantity: e.target.value })}
                              data-testid={`input-quote-item-quantity-${idx}`}
                            />
                          </div>
                          <div className="col-span-4">
                            <Label className="text-xs">Precio unitario</Label>
                            <Input
                              type="number"
                              min="0"
                              step="any"
                              value={it.unitPrice}
                              onChange={(e) => updateLineItem(idx, { unitPrice: e.target.value })}
                              data-testid={`input-quote-item-unit-price-${idx}`}
                            />
                          </div>
                          <div className="col-span-4">
                            <Label className="text-xs">Subtotal</Label>
                            <div className="h-9 flex items-center text-sm font-medium" data-testid={`text-quote-item-subtotal-${idx}`}>
                              {fmtMoney(sub, form.currency)}
                            </div>
                          </div>
                          <div className="col-span-1 flex justify-end">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeLineItem(idx)}
                              data-testid={`button-remove-quote-item-${idx}`}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Label htmlFor="quote-amount">{items.length > 0 ? 'Total (calculado)' : 'Monto'}</Label>
                {items.length > 0 ? (
                  <div
                    className="h-9 flex items-center text-lg font-semibold text-cyan-600"
                    data-testid="text-quote-total"
                  >
                    {fmtMoney(parseFloat(itemsTotal.toFixed(2)), form.currency)}
                  </div>
                ) : (
                  <Input
                    id="quote-amount"
                    type="text"
                    inputMode="decimal"
                    value={quoteDisplayAmount}
                    onChange={(e) => {
                      const { displayValue, internalValue } = formatAmountLive(e.target.value, form.amount);
                      setQuoteDisplayAmount(displayValue);
                      setForm({ ...form, amount: internalValue });
                    }}
                    placeholder="0"
                    data-testid="input-quote-amount"
                  />
                )}
              </div>
              <div>
                <Label>Moneda</Label>
                <Select value={form.currency} onValueChange={(v) => setForm({ ...form, currency: v })}>
                  <SelectTrigger data-testid="select-quote-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {currencyOptions.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="quote-date">Fecha</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      id="quote-date"
                      variant="outline"
                      className={cn(
                        "w-full pl-3 text-left font-normal justify-start",
                        !form.date && "text-muted-foreground"
                      )}
                      data-testid="input-quote-date"
                    >
                      <Calendar className="mr-2 h-4 w-4" />
                      {fmtQuoteDate(form.date) ?? <span>Seleccionar fecha...</span>}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <CalendarPicker
                      mode="single"
                      selected={parseQuoteDate(form.date)}
                      onSelect={(date) => { if (date) setForm({ ...form, date: format(date, 'yyyy-MM-dd') }); }}
                      locale={es}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div>
                <Label htmlFor="quote-valid">Válido hasta (opcional)</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      id="quote-valid"
                      variant="outline"
                      className={cn(
                        "w-full pl-3 text-left font-normal justify-start",
                        !form.validUntil && "text-muted-foreground"
                      )}
                      data-testid="input-quote-valid-until"
                    >
                      <Calendar className="mr-2 h-4 w-4" />
                      {fmtQuoteDate(form.validUntil) ?? <span>Seleccionar fecha...</span>}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <CalendarPicker
                      mode="single"
                      selected={parseQuoteDate(form.validUntil)}
                      onSelect={(date) => setForm({ ...form, validUntil: date ? format(date, 'yyyy-MM-dd') : '' })}
                      locale={es}
                      initialFocus
                    />
                    {form.validUntil && (
                      <div className="border-t p-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full"
                          onClick={() => setForm({ ...form, validUntil: '' })}
                          data-testid="button-clear-valid-until"
                        >
                          Limpiar fecha
                        </Button>
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              </div>
            </div>
            <div>
              <Label htmlFor="quote-notes">Notas (opcional)</Label>
              <Textarea
                id="quote-notes"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Detalles, desglose, condiciones, etc."
                rows={4}
                className="resize-y"
                data-testid="input-quote-notes"
              />
            </div>
            <div>
              <Label>Archivo del presupuesto (PDF o foto, opcional)</Label>
              {pdfUrl ? (
                <div className="flex items-center justify-between gap-2 p-2 rounded-lg border bg-muted/40">
                  <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-cyan-600 hover:underline truncate" data-testid="link-quote-pdf-current">
                    <Download className="h-4 w-4" />
                    {pdfName || 'Ver archivo'}
                  </a>
                  <Button type="button" size="sm" variant="ghost" onClick={() => { setPdfUrl(null); setPdfName(null); }} data-testid="button-remove-quote-pdf">
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    ref={pdfInputRef}
                    type="file"
                    accept="application/pdf,image/*"
                    onChange={handlePdfUpload}
                    disabled={uploading || analyzing}
                    className="hidden"
                    data-testid="input-quote-pdf"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => pdfInputRef.current?.click()}
                    disabled={uploading || analyzing}
                    data-testid="button-quote-pdf"
                  >
                    Elegir archivo
                  </Button>
                  <span className="text-xs text-muted-foreground" data-testid="text-quote-pdf-filename">
                    Ningún archivo seleccionado
                  </span>
                  {uploading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                </div>
              )}
            </div>

            {/* Datos del PDF: logo y contacto del membrete SOLO para este presupuesto.
                Si quedan vacíos, el PDF cae a los datos de la organización. */}
            <div className="rounded-lg border p-3 space-y-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <ImageIcon className="h-4 w-4 text-cyan-500" />
                  Datos del PDF (opcional)
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Logo y contacto que aparecen en el membrete de ESTE presupuesto. Si los dejás vacíos, se usan los de la organización.
                </p>
              </div>

              <div>
                <Label>Logo del presupuesto</Label>
                {quoteLogoUrl ? (
                  <div className="flex items-center justify-between gap-2 p-2 rounded-lg border bg-muted/40 mt-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <img src={quoteLogoUrl} alt="Logo del presupuesto" className="h-9 w-9 rounded object-cover shrink-0" data-testid="img-quote-logo-preview" />
                      <span className="text-xs text-muted-foreground truncate">Logo cargado para este presupuesto</span>
                    </div>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setQuoteLogoUrl(null)} data-testid="button-remove-quote-logo">
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 mt-1">
                    <input
                      ref={quoteLogoInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleQuoteLogoUpload}
                      disabled={quoteLogoUploading}
                      className="hidden"
                      data-testid="input-quote-logo"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => quoteLogoInputRef.current?.click()}
                      disabled={quoteLogoUploading}
                      data-testid="button-quote-logo"
                    >
                      {quoteLogoUploading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
                      Subir logo
                    </Button>
                    <span className="text-xs text-muted-foreground">PNG o JPG. Máx 2MB.</span>
                  </div>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="quote-pdf-company">Nombre de la empresa</Label>
                  <Input
                    id="quote-pdf-company"
                    value={form.pdfCompanyName}
                    onChange={(e) => setForm({ ...form, pdfCompanyName: e.target.value })}
                    placeholder={(organization as any)?.quotePdfCompanyName || organization?.name || 'Mi empresa'}
                    data-testid="input-quote-pdf-company"
                  />
                </div>
                <div>
                  <Label htmlFor="quote-pdf-sender">Nombre de quien envía</Label>
                  <Input
                    id="quote-pdf-sender"
                    value={form.pdfContactName}
                    onChange={(e) => setForm({ ...form, pdfContactName: e.target.value })}
                    placeholder={(organization as any)?.quotePdfContactName || (currentUser as any)?.preferredName || (currentUser as any)?.name || 'Tu nombre'}
                    data-testid="input-quote-pdf-sender"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="quote-pdf-email">Email de contacto</Label>
                  <Input
                    id="quote-pdf-email"
                    type="email"
                    value={form.pdfContactEmail}
                    onChange={(e) => setForm({ ...form, pdfContactEmail: e.target.value })}
                    placeholder={(organization as any)?.quotePdfContactEmail || (organization as any)?.contactEmail || 'contacto@empresa.com'}
                    data-testid="input-quote-pdf-email"
                  />
                </div>
                <div>
                  <Label htmlFor="quote-pdf-phone">Teléfono de contacto</Label>
                  <Input
                    id="quote-pdf-phone"
                    type="tel"
                    value={form.pdfContactPhone}
                    onChange={(e) => setForm({ ...form, pdfContactPhone: e.target.value })}
                    placeholder={(organization as any)?.quotePdfContactPhone || (organization as any)?.contactPhone || '+54 11 1234-5678'}
                    data-testid="input-quote-pdf-phone"
                  />
                </div>
              </div>

              {isOwner ? (
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <Checkbox
                    checked={saveAsDefault}
                    onCheckedChange={(v) => setSaveAsDefault(!!v)}
                    className="mt-0.5"
                    data-testid="checkbox-quote-default"
                  />
                  <span>Usar estos datos como predeterminados para todos los presupuestos de esta organización.</span>
                </label>
              ) : (
                <p className="text-xs text-muted-foreground">
                  El predeterminado para todos los presupuestos lo configura el propietario de la organización.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsFormOpen(false)} data-testid="button-cancel-quote">Cancelar</Button>
            <Button onClick={handleSave} disabled={saving || uploading || analyzing} data-testid="button-save-quote">
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingId ? 'Guardar cambios' : 'Crear presupuesto'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmar venta -> movimiento */}
      <Dialog open={!!winQuote} onOpenChange={(o) => { if (!o) setWinQuote(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirmar venta</DialogTitle>
            <DialogDescription>
              Se va a registrar un movimiento por {winQuote ? fmtMoney(winQuote.amount, winQuote.currency) : ''}
              {winQuote?.clientName ? ` para ${winQuote.clientName}` : ''}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>¿Cómo registrar la venta?</Label>
              <Select value={winType} onValueChange={(v) => setWinType(v as 'income' | 'receivable')}>
                <SelectTrigger data-testid="select-win-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="income">Ya lo cobré (ingreso)</SelectItem>
                  <SelectItem value="receivable">A cobrar (cuenta por cobrar)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {winType === 'income' && (
              <div>
                <Label>Cuenta donde entró el dinero</Label>
                <Select value={winAccountId} onValueChange={handleWinAccountChange}>
                  <SelectTrigger data-testid="select-win-account">
                    <SelectValue placeholder="Elegí una cuenta" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.length === 0 ? (
                      <SelectItem value="none" disabled>No tenés cuentas creadas</SelectItem>
                    ) : (
                      accounts.map((a: any) => (
                        <SelectItem key={a.id} value={a.id}>{a.name} ({a.currency})</SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                {compatibleAccounts.length === 0 && accounts.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    No tenés cuentas en {winQuote?.currency}. Elegí una cuenta en otra moneda y abajo convertís el monto con el tipo de cambio.
                  </p>
                )}
              </div>
            )}
            {winNeedsConversion && (
              <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3 space-y-2">
                <Label htmlFor="win-exchange-rate">
                  Tipo de cambio (1 {normWinCurrency(winQuote.currency)} = {selectedWinAccount ? normWinCurrency(selectedWinAccount.currency) : ''})
                </Label>
                <Input
                  id="win-exchange-rate"
                  inputMode="decimal"
                  value={winExchangeRate}
                  onChange={(e) => setWinExchangeRate(e.target.value)}
                  placeholder="Ingresá el tipo de cambio"
                  data-testid="input-win-exchange-rate"
                />
                {winConvertedAmount != null ? (
                  <p className="text-sm font-medium" data-testid="text-win-converted">
                    {fmtMoney(winQuote.amount, winQuote.currency)} → {selectedWinAccount ? fmtMoney(winConvertedAmount, selectedWinAccount.currency) : ''}
                  </p>
                ) : (
                  <p className="text-xs text-destructive">
                    Ingresá un tipo de cambio válido para calcular el monto.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Se va a registrar el ingreso en la moneda de la cuenta con el monto convertido.
                </p>
              </div>
            )}
            <div>
              <Label>Concepto</Label>
              <Select value={winCategory} onValueChange={setWinCategory}>
                <SelectTrigger data-testid="select-win-category">
                  <SelectValue placeholder="Elegí un concepto de ingreso" />
                </SelectTrigger>
                <SelectContent>
                  {incomeCategories.length === 0 ? (
                    <SelectItem value="none" disabled>No hay conceptos de ingreso</SelectItem>
                  ) : (
                    incomeCategories.map((c: any) => (
                      <SelectItem key={c.id ?? c.name} value={c.name}>{c.name}</SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="win-date">Fecha</Label>
              <Input
                id="win-date"
                type="date"
                value={winDate}
                onChange={(e) => setWinDate(e.target.value)}
                data-testid="input-win-date"
              />
              {winType === 'receivable' && (
                <p className="text-xs text-muted-foreground mt-1">Para cuentas a cobrar la fecha debe ser hoy o futura.</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWinQuote(null)} data-testid="button-cancel-win">Cancelar</Button>
            <Button onClick={handleWin} disabled={winSubmitting} className="bg-green-600 hover:bg-green-700 text-white" data-testid="button-confirm-win">
              {winSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Confirmar venta
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Marcar perdido */}
      <AlertDialog open={!!loseId} onOpenChange={(o) => { if (!o) setLoseId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Marcar como perdido?</AlertDialogTitle>
            <AlertDialogDescription>El presupuesto quedará registrado como perdido. Podés reabrirlo más tarde.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-lose">Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleLose} data-testid="button-confirm-lose">Marcar perdido</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Eliminar */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar presupuesto?</AlertDialogTitle>
            <AlertDialogDescription>Esta acción no se puede deshacer. Si el presupuesto generó un movimiento, ese movimiento no se elimina.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-quote">Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-red-600 hover:bg-red-700" data-testid="button-confirm-delete-quote">Eliminar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
