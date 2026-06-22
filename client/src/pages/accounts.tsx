import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAccounts, useCreateAccount, useUpdateAccount, useDeleteAccount, useAdjustAccountBalance, useForceAccountBalance, useOrganization, useMembership } from '@/lib/hooks';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { useUndoDelete } from '@/hooks/use-undo-delete';
import { Wallet, CreditCard, Building2, Plus, Trash2, Pencil, MoreVertical, Scale, AlertTriangle, TrendingUp, TrendingDown, BarChart3, Smartphone, Lock, Zap, MoreHorizontal, Calendar, ArrowUp, ArrowDown, ArrowUpDown, Percent } from 'lucide-react';
import { safeParseDate, calculateAccruedInterest, calculateAccruedInterestForPeriod } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { BackButton } from '@/components/BackButton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { CURRENCY_SYMBOLS, CURRENCY_LABELS, CURRENCIES, ROLE_PERMISSIONS, FINANCIAL_ACCOUNT_TYPES, FINANCIAL_ACCOUNT_TYPE_CONFIG, OPERATIVE_ACCOUNT_TYPES, INVESTMENT_ACCOUNT_TYPES, INTEREST_FREQUENCIES, INTEREST_FREQUENCY_LABELS, type Currency, type Role, type FinancialAccountType, type InterestFrequency } from '@shared/schema';
import { normalizeAmountInput, formatAmountLive } from '@/lib/currency';

const accountSchema = z.object({
  name: z.string().min(2, 'El nombre es requerido'),
  accountCategory: z.enum(['operative', 'investment']),
  type: z.enum(FINANCIAL_ACCOUNT_TYPES),
  customTypeLabel: z.string().optional(),
  currency: z.enum(CURRENCIES),
  balance: z.string().min(1, 'El saldo inicial es requerido'),
  initialInvestment: z.string().optional(),
  maturityDate: z.string().optional(),
  interestRate: z.string().optional().refine(
    (val) => {
      if (!val || val.trim() === '') return true;
      const n = parseFloat(val.replace(',', '.'));
      return !isNaN(n) && n >= 0 && n < 10000;
    },
    { message: 'La tasa debe estar entre 0 y 9999,99 %' }
  ),
  interestFrequency: z.string().optional(),
});

type AccountFormValues = z.infer<typeof accountSchema>;

export default function AccountsPage() {
  const { data: accounts = [], isLoading } = useAccounts();
  const { data: organization } = useOrganization();
  const { data: membership } = useMembership();
  const createAccountMutation = useCreateAccount();
  const updateAccountMutation = useUpdateAccount();
  const deleteAccountMutation = useDeleteAccount();
  const adjustBalanceMutation = useAdjustAccountBalance();
  const forceBalanceMutation = useForceAccountBalance();
  const { toast } = useToast();
  const { showUndoToast } = useUndoDelete();
  const [isOpen, setIsOpen] = React.useState(false);
  const [editAccount, setEditAccount] = React.useState<any>(null);
  const [deleteAccountId, setDeleteAccountId] = React.useState<string | null>(null);
  const [deleteAction, setDeleteAction] = React.useState<'transfer' | 'adjust' | null>(null);
  const [deleteTargetAccountId, setDeleteTargetAccountId] = React.useState<string>('');
  const [confirmDiscardType, setConfirmDiscardType] = React.useState<'create' | 'edit' | null>(null);
  const [adjustAccount, setAdjustAccount] = React.useState<any>(null);
  const [adjustAmount, setAdjustAmount] = React.useState('');
  const [adjustDisplayValue, setAdjustDisplayValue] = React.useState('');
  const [adjustReason, setAdjustReason] = React.useState('');
  const [forceMode, setForceMode] = React.useState(false);
  const [showAmountDialog, setShowAmountDialog] = React.useState(false);
  const [dialogAmount, setDialogAmount] = React.useState<{ value: string; label: string } | null>(null);
  const [balanceDisplayValue, setBalanceDisplayValue] = React.useState('0');
  const [selectedAccountForMovements, setSelectedAccountForMovements] = React.useState<any>(null);
  
  // Check permissions based on role
  const userRole = membership?.role as Role | undefined;
  const userPermissions = userRole ? ROLE_PERMISSIONS[userRole] || [] : [];
  const canCreateAccounts = userPermissions.includes('accounts:create');
  const canEditAccounts = userPermissions.includes('accounts:edit');
  const canDeleteAccounts = userPermissions.includes('accounts:delete');

  const [investmentDisplayValue, setInvestmentDisplayValue] = React.useState('');
  const [interestPeriodFilter, setInterestPeriodFilter] = React.useState<string>('all');

  const handleCreateDialogClose = (open: boolean) => {
    if (!open) {
      const values = form.getValues();
      const hasMeaningfulData = values.name.trim() !== '' || (values.balance && values.balance !== '0' && values.balance !== '') || values.accountCategory !== 'operative' || values.type !== 'bank' || values.currency !== 'ARS' || (values.initialInvestment && values.initialInvestment !== '') || (values.interestRate && values.interestRate !== '') || (values.maturityDate && values.maturityDate !== '') || (values.customTypeLabel && values.customTypeLabel !== '') || values.interestFrequency !== 'monthly';
      if (hasMeaningfulData) {
        setConfirmDiscardType('create');
        return;
      }
    }
    setIsOpen(open);
    if (!open) { form.reset(); setBalanceDisplayValue('0'); setInvestmentDisplayValue(''); }
  };

  const handleEditDialogClose = (open: boolean) => {
    if (!open && editAccount) {
      if (editForm.formState.isDirty) {
        setConfirmDiscardType('edit');
        return;
      }
    }
    if (!open) setEditAccount(null);
  };

  const confirmDiscard = () => {
    if (confirmDiscardType === 'create') {
      setIsOpen(false);
      form.reset();
      setBalanceDisplayValue('0');
      setInvestmentDisplayValue('');
    } else if (confirmDiscardType === 'edit') {
      setEditAccount(null);
    }
    setConfirmDiscardType(null);
  };

  const form = useForm<AccountFormValues>({
    resolver: zodResolver(accountSchema),
    defaultValues: {
      name: '',
      accountCategory: 'operative',
      type: 'bank',
      currency: 'ARS',
      balance: '0',
      initialInvestment: '',
      maturityDate: '',
      interestRate: '',
      interestFrequency: 'monthly',
    },
  });

  const onSubmit = async (data: AccountFormValues) => {
    if (!organization) return;
    
    try {
      const needsCustomLabel = data.type === 'other' || data.type === 'other_investment' || (data.accountCategory === 'investment' && data.customTypeLabel);
      const isInvestment = data.accountCategory === 'investment';
      
      let finalBalance = data.balance;
      if (isInvestment && data.initialInvestment) {
        finalBalance = data.initialInvestment;
      }
      
      await createAccountMutation.mutateAsync({
        name: data.name,
        type: data.type,
        currency: data.currency as Currency,
        balance: finalBalance,
        organizationId: organization.id,
        accountCategory: data.accountCategory,
        customTypeLabel: needsCustomLabel ? data.customTypeLabel : null,
        initialInvestment: isInvestment && data.initialInvestment ? data.initialInvestment : null,
        maturityDate: isInvestment && data.maturityDate ? data.maturityDate : null,
        interestRate: isInvestment && data.interestRate ? data.interestRate : null,
        interestFrequency: isInvestment && data.interestFrequency ? data.interestFrequency : null,
      });

      toast({
        title: "Cuenta creada",
        description: `La cuenta ${data.name} ha sido agregada exitosamente.`,
      });

      setIsOpen(false);
      form.reset();
      setBalanceDisplayValue('0');
      setInvestmentDisplayValue('');
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo crear la cuenta",
        variant: "destructive",
      });
    }
  };

  const [editInvestmentDisplayValue, setEditInvestmentDisplayValue] = React.useState('');

  const editForm = useForm<AccountFormValues>({
    resolver: zodResolver(accountSchema),
    defaultValues: {
      name: '',
      accountCategory: 'operative',
      type: 'bank',
      currency: 'ARS',
      balance: '0',
      initialInvestment: '',
      maturityDate: '',
      interestRate: '',
      interestFrequency: 'monthly',
    },
  });

  const handleEditOpen = (acc: any) => {
    const accType = (acc.type || 'bank') as FinancialAccountType;
    const category = acc.accountCategory || 'operative';
    const investmentVal = acc.initialInvestment ? acc.initialInvestment.toString() : '';
    const maturityVal = acc.maturityDate ? (() => {
      const d = safeParseDate(acc.maturityDate);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })() : '';
    editForm.reset({
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

  const onEditSubmit = async (data: AccountFormValues) => {
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

      toast({
        title: "Cuenta actualizada",
        description: `La cuenta ${data.name} ha sido actualizada.`,
      });

      setEditAccount(null);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo actualizar la cuenta",
        variant: "destructive",
      });
    }
  };

  const deleteAccountData = React.useMemo(() => {
    if (!deleteAccountId) return null;
    return accounts.find((a: any) => a.id === deleteAccountId);
  }, [deleteAccountId, accounts]);

  const deleteAccountBalance = deleteAccountData ? parseFloat(deleteAccountData.balance?.toString() || '0') : 0;
  const deleteAccountHasBalance = deleteAccountBalance !== 0;

  const sameCurrencyAccounts = React.useMemo(() => {
    if (!deleteAccountData) return [];
    return accounts.filter((a: any) => a.id !== deleteAccountId && a.currency === deleteAccountData.currency);
  }, [deleteAccountData, deleteAccountId, accounts]);

  React.useEffect(() => {
    if (deleteAccountHasBalance && sameCurrencyAccounts.length === 0) {
      setDeleteAction('adjust');
    }
  }, [deleteAccountId, deleteAccountHasBalance, sameCurrencyAccounts.length]);

  const handleDelete = async () => {
    if (!deleteAccountId) return;
    
    if (deleteAccountHasBalance && !deleteAction) return;
    if (deleteAction === 'transfer' && !deleteTargetAccountId) return;
    
    try {
      await deleteAccountMutation.mutateAsync({ 
        id: deleteAccountId, 
        action: deleteAction || undefined,
        targetAccountId: deleteAction === 'transfer' ? deleteTargetAccountId : undefined,
      });
      const name = deleteAccountData?.name;
      setDeleteAccountId(null);
      setDeleteAction(null);
      setDeleteTargetAccountId('');
      toast({ title: "Cuenta eliminada", description: `"${name}" fue eliminada correctamente` });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo eliminar la cuenta",
        variant: "destructive",
      });
    }
  };

  const formatCurrency = (val: number | string, currency: Currency = 'ARS') => {
    const num = normalizeAmountInput(val);
    const symbol = (CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || 'AR$') + ' ';
    const absVal = Math.abs(num);
    
    if (absVal >= 1_000_000_000) {
      return symbol + (num / 1_000_000_000).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' MM';
    } else if (absVal >= 1_000_000) {
      return symbol + (num / 1_000_000).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' M';
    } else if (absVal >= 100_000) {
      return symbol + (num / 1_000).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' K';
    } else {
      return symbol + num.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
  };

  const formatBalanceAbbr = (val: number, currency: Currency = 'ARS'): { text: string; isAbbreviated: boolean } => {
    const symbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || 'AR$';
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
  
  const formatBalanceFull = (val: number, currency: Currency = 'ARS') => {
    const symbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || 'AR$';
    return symbol + ' ' + val.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  
  const BalanceWithTooltip = ({ value, currency, className, accountName }: { value: number; currency: Currency; className?: string; accountName: string }) => {
    const { text, isAbbreviated } = formatBalanceAbbr(value, currency);
    const fullText = formatBalanceFull(value, currency);
    
    if (!isAbbreviated) {
      return <span className={className}>{text}</span>;
    }
    
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span 
              className={`cursor-help underline decoration-dotted underline-offset-2 ${className}`}
              onClick={() => {
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
      </TooltipProvider>
    );
  };
  
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-lg text-muted-foreground">Cargando cuentas...</div>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <BackButton />
          <h1 className="text-3xl font-bold font-display mt-2">Mis Cuentas</h1>
          <p className="text-muted-foreground">Administra tus cuentas operativas y de inversión.</p>
        </div>

        {canCreateAccounts && (
          <Dialog open={isOpen} onOpenChange={handleCreateDialogClose}>
            <DialogTrigger asChild>
              <Button className="bg-primary text-primary-foreground shadow-lg shadow-primary/20">
                <Plus className="mr-2 h-4 w-4" /> Nueva Cuenta
              </Button>
            </DialogTrigger>
          <DialogContent className="sm:max-w-[425px] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Agregar Cuenta</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Nombre de la Cuenta</FormLabel>
                      <FormControl>
                        <Input placeholder="Ej: Banco Galicia C/C" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="accountCategory"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Categoría</FormLabel>
                      <Select onValueChange={(val) => {
                        field.onChange(val);
                        form.setValue('type', val === 'operative' ? 'bank' : 'investment');
                        form.setValue('customTypeLabel', '');
                      }} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-account-category">
                            <SelectValue placeholder="Seleccionar categoría" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="operative">Cuenta Operativa</SelectItem>
                          <SelectItem value="investment">Cuenta de Inversión</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tipo</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-account-type">
                            <SelectValue placeholder="Seleccionar tipo" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(form.watch('accountCategory') === 'investment' ? INVESTMENT_ACCOUNT_TYPES : OPERATIVE_ACCOUNT_TYPES).map((t) => (
                            <SelectItem key={t} value={t}>
                              {FINANCIAL_ACCOUNT_TYPE_CONFIG[t].label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {(form.watch('accountCategory') === 'investment' || form.watch('type') === 'other') && (
                  <FormField
                    control={form.control}
                    name="customTypeLabel"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{form.watch('type') === 'other' ? 'Nombre del tipo' : form.watch('accountCategory') === 'investment' ? 'Nombre personalizado (opcional)' : 'Nombre del tipo'}</FormLabel>
                        <FormControl>
                          <Input placeholder={form.watch('type') === 'other' ? 'Ej: Autos, Arte, Inmuebles' : form.watch('accountCategory') === 'investment' ? 'Ej: Mi fondo de bonos, Crypto USDT' : 'Ej: Fideicomiso, Cooperativa'} {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                <FormField
                  control={form.control}
                  name="currency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Moneda</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-currency">
                            <SelectValue placeholder="Seleccionar moneda" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {CURRENCIES.map((curr) => (
                            <SelectItem key={curr} value={curr}>{CURRENCY_LABELS[curr]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {form.watch('accountCategory') !== 'investment' && (
                  <FormField
                    control={form.control}
                    name="balance"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Saldo Inicial</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                            <Input 
                              type="text" 
                              inputMode="decimal"
                              className="pl-7" 
                              placeholder="0" 
                              value={balanceDisplayValue}
                              onChange={(e) => {
                                const { displayValue, internalValue } = formatAmountLive(e.target.value, field.value);
                                setBalanceDisplayValue(displayValue);
                                field.onChange(internalValue || '0');
                              }}
                            />
                          </div>
                        </FormControl>
                        <FormDescription>El balance actual de esta cuenta</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {form.watch('accountCategory') === 'investment' && (
                  <>
                    <FormField
                      control={form.control}
                      name="initialInvestment"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Capital Invertido</FormLabel>
                          <FormControl>
                            <div className="relative">
                              <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                              <Input
                                type="text"
                                inputMode="decimal"
                                className="pl-7"
                                placeholder="0"
                                value={investmentDisplayValue}
                                onChange={(e) => {
                                  const { displayValue, internalValue } = formatAmountLive(e.target.value, field.value || '');
                                  setInvestmentDisplayValue(displayValue);
                                  field.onChange(internalValue || '');
                                }}
                                data-testid="input-initial-investment"
                              />
                            </div>
                          </FormControl>
                          <FormDescription>Monto que invertiste originalmente</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <div className="grid grid-cols-2 gap-3">
                      <FormField
                        control={form.control}
                        name="interestRate"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Tasa de Interés</FormLabel>
                            <FormControl>
                              <div className="relative">
                                <Input
                                  type="text"
                                  inputMode="decimal"
                                  className="pr-8"
                                  placeholder="0"
                                  value={field.value}
                                  onChange={(e) => {
                                    const val = e.target.value.replace(/[^0-9.,]/g, '');
                                    field.onChange(val);
                                  }}
                                  data-testid="input-interest-rate"
                                />
                                <span className="absolute right-3 top-2.5 text-muted-foreground font-medium">%</span>
                              </div>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="interestFrequency"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Frecuencia</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value || 'monthly'}>
                              <FormControl>
                                <SelectTrigger data-testid="select-interest-frequency">
                                  <SelectValue placeholder="Frecuencia" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {INTEREST_FREQUENCIES.map((freq) => (
                                  <SelectItem key={freq} value={freq}>
                                    {INTEREST_FREQUENCY_LABELS[freq]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    {(() => {
                      const capitalStr = form.watch('initialInvestment');
                      const rateStr = form.watch('interestRate');
                      const freq = (form.watch('interestFrequency') || 'monthly') as InterestFrequency;
                      const capital = capitalStr ? normalizeAmountInput(capitalStr) : 0;
                      const rate = rateStr ? parseFloat(rateStr.replace(',', '.')) : 0;
                      if (capital > 0 && rate > 0) {
                        const interestAmount = capital * (rate / 100);
                        const currSymbol = CURRENCY_SYMBOLS[(form.watch('currency') || 'ARS') as keyof typeof CURRENCY_SYMBOLS] || '$';
                        const freqLabel = INTEREST_FREQUENCY_LABELS[freq].toLowerCase();
                        const periodsPerYear: Record<string, number> = { daily: 365, weekly: 52, biweekly: 26, monthly: 12, quarterly: 4, yearly: 1 };
                        const periods = periodsPerYear[freq] || 12;
                        const annualGain = interestAmount * periods;
                        return (
                          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                            <p className="text-xs text-emerald-700 font-medium mb-1">Rendimiento estimado</p>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-emerald-600">Ganancia {freqLabel}</span>
                              <span className="font-semibold text-emerald-800">
                                {currSymbol} {interestAmount.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                              </span>
                            </div>
                            <div className="flex items-center justify-between text-sm mt-1">
                              <span className="text-emerald-600">Proyección anual</span>
                              <span className="font-semibold text-emerald-800">
                                {currSymbol} {annualGain.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                              </span>
                            </div>
                            <div className="flex items-center justify-between text-sm mt-1">
                              <span className="text-emerald-600">Saldo después del primer período</span>
                              <span className="font-semibold text-emerald-800">
                                {currSymbol} {(capital + interestAmount).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                              </span>
                            </div>
                          </div>
                        );
                      }
                      return null;
                    })()}

                    <FormField
                      control={form.control}
                      name="maturityDate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Fecha de Vencimiento (opcional)</FormLabel>
                          <FormControl>
                            <Input type="date" {...field} data-testid="input-maturity-date" />
                          </FormControl>
                          <FormDescription>Cuándo vence la inversión (ej: plazo fijo)</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </>
                )}

                <Button type="submit" className="w-full mt-4">Crear Cuenta</Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
        )}
      </div>

      {/* Group accounts by category then type */}
      {(() => {
        const operativeAccounts = accounts.filter((a: any) => {
          return !a.accountCategory || a.accountCategory === 'operative';
        });
        const investmentAccounts = accounts.filter((a: any) => {
          return a.accountCategory === 'investment';
        });

        const renderAccountCard = (acc: any) => {
          const currency = (acc.currency || 'ARS') as Currency;
          const accType = (acc.type || 'bank') as FinancialAccountType;
          const typeConfig = FINANCIAL_ACCOUNT_TYPE_CONFIG[accType] || FINANCIAL_ACCOUNT_TYPE_CONFIG['other'];
          const typeLabel = acc.customTypeLabel || typeConfig.label;
          const currencyLabel = currency === 'USD_CASH' ? 'USD Efectivo' : currency;

          const getIcon = () => {
            switch(accType) {
              case 'bank': return <Building2 className={`h-5 w-5 ${typeConfig.color}`} />;
              case 'cash': return <Wallet className={`h-5 w-5 ${typeConfig.color}`} />;
              case 'wallet': return <Smartphone className={`h-5 w-5 ${typeConfig.color}`} />;
              case 'credit_card': return <CreditCard className={`h-5 w-5 ${typeConfig.color}`} />;
              case 'investment': return <TrendingUp className={`h-5 w-5 ${typeConfig.color}`} />;
              case 'broker': return <BarChart3 className={`h-5 w-5 ${typeConfig.color}`} />;
              case 'crypto': return <Wallet className={`h-5 w-5 ${typeConfig.color}`} />;
              case 'fintech': return <Zap className={`h-5 w-5 ${typeConfig.color}`} />;
              case 'fixed_term': return <Lock className={`h-5 w-5 ${typeConfig.color}`} />;
              default: return <MoreHorizontal className={`h-5 w-5 ${typeConfig.color}`} />;
            }
          };

          return (
            <Card key={acc.id} className="border shadow-sm hover:shadow-lg transition-all group relative overflow-hidden cursor-pointer" data-testid={`account-card-${acc.id}`} onClick={() => setSelectedAccountForMovements(acc)}>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {typeLabel}
                  </span>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-xs font-medium">
                      {currencyLabel}
                    </Badge>
                    {(canEditAccounts || canDeleteAccounts) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={(e) => e.stopPropagation()} data-testid={`account-menu-${acc.id}`}>
                            <MoreVertical className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                          {canEditAccounts && (
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleEditOpen(acc); }} data-testid={`edit-account-${acc.id}`}>
                              <Pencil className="h-4 w-4 mr-2" />
                              Editar
                            </DropdownMenuItem>
                          )}
                          {canEditAccounts && (
                            <DropdownMenuItem onClick={(e) => {
                              e.stopPropagation();
                              setAdjustAccount(acc);
                              const accrued = acc.accountCategory === 'investment' ? calculateAccruedInterest(acc) : 0;
                              const effectiveBal = accrued > 0 ? parseFloat(acc.initialInvestment || '0') + accrued : parseFloat(acc.balance);
                              const balanceStr = effectiveBal.toString();
                              setAdjustAmount(balanceStr);
                              const { displayValue } = formatAmountLive(balanceStr, '');
                              setAdjustDisplayValue(displayValue);
                              setAdjustReason('');
                              setForceMode(false);
                            }} data-testid={`adjust-balance-${acc.id}`}>
                              <Scale className="h-4 w-4 mr-2" />
                              Ajustar Saldo
                            </DropdownMenuItem>
                          )}
                          {canDeleteAccounts && (
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setDeleteAccountId(acc.id); }} className="text-red-600" data-testid={`delete-account-${acc.id}`}>
                              <Trash2 className="h-4 w-4 mr-2" />
                              Eliminar
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 mb-3">
                  <div className={`w-10 h-10 rounded-lg ${typeConfig.bgColor} flex items-center justify-center flex-shrink-0`}>
                    {getIcon()}
                  </div>
                  <h3 className="text-lg font-bold font-display truncate">{acc.name}</h3>
                </div>

                <div className="text-lg sm:text-xl font-semibold tracking-tight text-foreground">
                  {(() => {
                    const accrued = acc.accountCategory === 'investment' ? calculateAccruedInterest(acc) : 0;
                    const effectiveBal = accrued > 0 ? parseFloat(acc.initialInvestment || '0') + accrued : parseFloat(acc.balance);
                    return <BalanceWithTooltip value={effectiveBal} currency={currency} accountName={acc.name} />;
                  })()}
                </div>

                {acc.accountCategory === 'investment' && (!acc.initialInvestment || parseFloat(acc.initialInvestment) <= 0 || !acc.interestRate || parseFloat(acc.interestRate) <= 0) && (
                  <div className="mt-3 pt-3 border-t">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <TrendingUp className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                      <span>Completá el capital invertido y la tasa de interés desde <strong>Editar</strong> para ver tu rendimiento.</span>
                    </div>
                  </div>
                )}

                {acc.accountCategory === 'investment' && acc.initialInvestment && parseFloat(acc.initialInvestment) > 0 && (() => {
                  const initial = parseFloat(acc.initialInvestment);
                  const accrued = calculateAccruedInterest(acc);
                  const current = accrued > 0 ? initial + accrued : parseFloat(acc.balance);
                  const gainLoss = current - initial;
                  const gainLossPct = initial > 0 ? ((gainLoss / initial) * 100) : 0;
                  const isPositive = gainLoss >= 0;
                  const symbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || 'AR$';

                  return (
                    <div className="mt-3 pt-3 border-t space-y-1.5">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>Capital invertido</span>
                        <span>{symbol} {initial.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-xs text-muted-foreground">Rendimiento</span>
                        <div className={`flex items-center gap-1 font-semibold ${isPositive ? 'text-emerald-600' : 'text-red-600'}`}>
                          {isPositive ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
                          <span>{symbol} {Math.abs(gainLoss).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${isPositive ? 'border-emerald-300 text-emerald-700 bg-emerald-50' : 'border-red-300 text-red-700 bg-red-50'}`}>
                            {isPositive ? '+' : ''}{gainLossPct.toFixed(1)}%
                          </Badge>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {acc.accountCategory === 'investment' && acc.interestRate && parseFloat(acc.interestRate) > 0 && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Percent className="h-3.5 w-3.5 text-emerald-500" />
                    <span>
                      {parseFloat(acc.interestRate).toLocaleString('es-AR', { maximumFractionDigits: 2 })}% {INTEREST_FREQUENCY_LABELS[(acc.interestFrequency || 'monthly') as InterestFrequency]?.toLowerCase() || 'mensual'}
                    </span>
                  </div>
                )}

                {acc.accountCategory === 'investment' && acc.maturityDate && (() => {
                  const maturity = safeParseDate(acc.maturityDate);
                  const now = new Date();
                  const diffDays = Math.ceil((maturity.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                  const isOverdue = diffDays < 0;
                  const isNear = diffDays >= 0 && diffDays <= 7;

                  return (
                    <div className={`mt-2 flex items-center gap-1.5 text-xs ${isOverdue ? 'text-red-600 font-semibold' : isNear ? 'text-amber-600 font-medium' : 'text-muted-foreground'}`}>
                      <Calendar className="h-3.5 w-3.5" />
                      {isOverdue 
                        ? `Venció hace ${Math.abs(diffDays)} día(s)`
                        : diffDays === 0 
                          ? 'Vence hoy'
                          : `Vence en ${diffDays} día(s) (${maturity.toLocaleDateString('es-AR')})`
                      }
                    </div>
                  );
                })()}

                {acc.accountCategory === 'investment' && (() => {
                  const totalAccrued = calculateAccruedInterest(acc);
                  const now = new Date();
                  let periodStart: Date | null = null;
                  let periodLabel = 'Total';
                  if (interestPeriodFilter === 'today') {
                    periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                    periodLabel = 'Hoy';
                  } else if (interestPeriodFilter === '7d') {
                    periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                    periodLabel = 'Últimos 7 días';
                  } else if (interestPeriodFilter === '30d') {
                    periodStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                    periodLabel = 'Últimos 30 días';
                  } else if (interestPeriodFilter === '90d') {
                    periodStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
                    periodLabel = 'Últimos 90 días';
                  }
                  const displayAccrued = periodStart ? calculateAccruedInterestForPeriod(acc, periodStart) : totalAccrued;
                  const symbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || 'AR$';
                  return (
                    <div className="mt-3 pt-3 border-t">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <TrendingUp className="h-3 w-3 text-emerald-500" />
                          Intereses {periodLabel !== 'Total' ? `(${periodLabel})` : 'generados'}
                        </span>
                        <span className={`text-sm font-semibold ${displayAccrued > 0 ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                          {displayAccrued > 0 ? '+' : ''}{symbol} {displayAccrued.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </div>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
          );
        };

        const renderCategorySubtotals = (categoryAccounts: any[]) => {
          const subtotals = categoryAccounts.reduce((acc: Record<string, number>, a: any) => {
            const curr = a.currency || 'ARS';
            const normalizedCurr = (curr === 'USD_CASH') ? 'USD' : curr;
            const isInvestment = a.accountCategory === 'investment';
            const effectiveBalance = isInvestment ? (() => {
              const accrued = calculateAccruedInterest(a);
              return accrued > 0 ? parseFloat(a.initialInvestment || '0') + accrued : parseFloat(a.balance || '0');
            })() : parseFloat(a.balance || '0');
            acc[normalizedCurr] = (acc[normalizedCurr] || 0) + effectiveBalance;
            return acc;
          }, {} as Record<string, number>);

          return (
            <div className="flex items-center gap-4">
              {Object.entries(subtotals).map(([curr, total]) => (
                <span key={curr} className="text-lg font-bold text-foreground">
                  {formatCurrency(total, curr as Currency)}
                </span>
              ))}
            </div>
          );
        };

        const groupByType = (categoryAccounts: any[]) => {
          return FINANCIAL_ACCOUNT_TYPES.reduce((acc, type) => {
            const typeAccounts = categoryAccounts.filter((a: any) => (a.type || 'bank') === type);
            if (typeAccounts.length > 0) {
              acc.push({ type, accounts: typeAccounts });
            }
            return acc;
          }, [] as { type: FinancialAccountType; accounts: any[] }[]);
        };

        return (
          <div className="space-y-10">
            {operativeAccounts.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-2xl font-bold font-display flex items-center gap-2">
                    <Building2 className="h-6 w-6 text-blue-600" />
                    Cuentas Operativas
                  </h2>
                  {renderCategorySubtotals(operativeAccounts)}
                </div>
                <div className="space-y-6">
                  {groupByType(operativeAccounts).map(({ type, accounts: typeAccounts }) => {
                    const config = FINANCIAL_ACCOUNT_TYPE_CONFIG[type] || FINANCIAL_ACCOUNT_TYPE_CONFIG['other'];
                    return (
                      <div key={type}>
                        <div className="flex items-center gap-2 mb-3">
                          <span className={`w-2.5 h-2.5 rounded-full ${config.bgColor}`}></span>
                          <h3 className="text-lg font-semibold text-muted-foreground">{config.group}</h3>
                        </div>
                        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                          {typeAccounts.map(renderAccountCard)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {investmentAccounts.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-2xl font-bold font-display flex items-center gap-2">
                    <TrendingUp className="h-6 w-6 text-emerald-600" />
                    Cuentas de Inversión
                  </h2>
                  {renderCategorySubtotals(investmentAccounts)}
                </div>
                <div className="flex items-center gap-2 mb-6 flex-wrap" data-testid="interest-period-filter">
                  <span className="text-xs text-muted-foreground mr-1">Intereses:</span>
                  {[
                    { value: 'all', label: 'Total' },
                    { value: 'today', label: 'Hoy' },
                    { value: '7d', label: '7 días' },
                    { value: '30d', label: '30 días' },
                    { value: '90d', label: '90 días' },
                  ].map(opt => (
                    <Button
                      key={opt.value}
                      variant={interestPeriodFilter === opt.value ? 'default' : 'outline'}
                      size="sm"
                      className="h-7 text-xs px-3"
                      onClick={() => setInterestPeriodFilter(opt.value)}
                      data-testid={`filter-interest-${opt.value}`}
                    >
                      {opt.label}
                    </Button>
                  ))}
                </div>
                <div className="space-y-6">
                  {groupByType(investmentAccounts).map(({ type, accounts: typeAccounts }) => {
                    const config = FINANCIAL_ACCOUNT_TYPE_CONFIG[type] || FINANCIAL_ACCOUNT_TYPE_CONFIG['other'];
                    return (
                      <div key={type}>
                        <div className="flex items-center gap-2 mb-3">
                          <span className={`w-2.5 h-2.5 rounded-full ${config.bgColor}`}></span>
                          <h3 className="text-lg font-semibold text-muted-foreground">{config.group}</h3>
                        </div>
                        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                          {typeAccounts.map(renderAccountCard)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {accounts.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                No tenés cuentas creadas. ¡Creá tu primera cuenta!
              </div>
            )}
          </div>
        );
      })()}

      {/* Edit Account Dialog */}
      <Dialog open={!!editAccount} onOpenChange={handleEditDialogClose}>
        <DialogContent className="sm:max-w-[425px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Cuenta</DialogTitle>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4 pt-4">
              <FormField
                control={editForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nombre de la Cuenta</FormLabel>
                    <FormControl>
                      <Input placeholder="Ej: Banco Galicia C/C" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={editForm.control}
                name="accountCategory"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Categoría</FormLabel>
                    <Select onValueChange={(val) => {
                      field.onChange(val);
                      editForm.setValue('type', val === 'operative' ? 'bank' : 'investment');
                      editForm.setValue('customTypeLabel', '');
                    }} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Seleccionar categoría" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="operative">Cuenta Operativa</SelectItem>
                        <SelectItem value="investment">Cuenta de Inversión</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={editForm.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tipo</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Seleccionar tipo" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(editForm.watch('accountCategory') === 'investment' ? INVESTMENT_ACCOUNT_TYPES : OPERATIVE_ACCOUNT_TYPES).map((t) => (
                          <SelectItem key={t} value={t}>
                            {FINANCIAL_ACCOUNT_TYPE_CONFIG[t].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {(editForm.watch('accountCategory') === 'investment' || editForm.watch('type') === 'other') && (
                <FormField
                  control={editForm.control}
                  name="customTypeLabel"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{editForm.watch('type') === 'other' ? 'Nombre del tipo' : editForm.watch('accountCategory') === 'investment' ? 'Nombre personalizado (opcional)' : 'Nombre del tipo'}</FormLabel>
                      <FormControl>
                        <Input placeholder={editForm.watch('type') === 'other' ? 'Ej: Autos, Arte, Inmuebles' : editForm.watch('accountCategory') === 'investment' ? 'Ej: Mi fondo de bonos, Crypto USDT' : 'Ej: Fideicomiso, Cooperativa'} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={editForm.control}
                name="currency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Moneda</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Seleccionar moneda" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CURRENCIES.map((curr) => (
                          <SelectItem key={curr} value={curr}>{CURRENCY_LABELS[curr]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />


              {editForm.watch('accountCategory') === 'investment' && (
                <>
                  <FormField
                    control={editForm.control}
                    name="initialInvestment"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Capital Invertido</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                            <Input
                              type="text"
                              inputMode="decimal"
                              className="pl-7"
                              placeholder="0"
                              value={editInvestmentDisplayValue}
                              onChange={(e) => {
                                const { displayValue, internalValue } = formatAmountLive(e.target.value, field.value || '');
                                setEditInvestmentDisplayValue(displayValue);
                                field.onChange(internalValue || '');
                              }}
                            />
                          </div>
                        </FormControl>
                        <FormDescription>Monto que invertiste originalmente (para calcular rendimiento)</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-2 gap-3">
                    <FormField
                      control={editForm.control}
                      name="interestRate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Tasa de Interés</FormLabel>
                          <FormControl>
                            <div className="relative">
                              <Input
                                type="text"
                                inputMode="decimal"
                                className="pr-8"
                                placeholder="0"
                                value={field.value}
                                onChange={(e) => {
                                  const val = e.target.value.replace(/[^0-9.,]/g, '');
                                  field.onChange(val);
                                }}
                              />
                              <span className="absolute right-3 top-2.5 text-muted-foreground font-medium">%</span>
                            </div>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={editForm.control}
                      name="interestFrequency"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Frecuencia</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value || 'monthly'}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Frecuencia" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {INTEREST_FREQUENCIES.map((freq) => (
                                <SelectItem key={freq} value={freq}>
                                  {INTEREST_FREQUENCY_LABELS[freq]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={editForm.control}
                    name="maturityDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Fecha de Vencimiento (opcional)</FormLabel>
                        <FormControl>
                          <Input type="date" {...field} />
                        </FormControl>
                        <FormDescription>Cuándo vence la inversión (ej: plazo fijo)</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
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
      <AlertDialog open={!!confirmDiscardType} onOpenChange={(open) => !open && setConfirmDiscardType(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Descartar los datos ingresados?</AlertDialogTitle>
            <AlertDialogDescription>
              Si cerrás este formulario, los datos que ingresaste se van a perder. ¿Querés continuar?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Seguir editando</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDiscard} className="bg-red-600 hover:bg-red-700">
              Descartar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteAccountId} onOpenChange={(open) => { 
        if (!open) { 
          setDeleteAccountId(null); 
          setDeleteAction(null); 
          setDeleteTargetAccountId(''); 
        } 
      }}>
        <DialogContent className="sm:max-w-[450px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-red-600" />
              ¿Eliminar "{deleteAccountData?.name}"?
            </DialogTitle>
            <DialogDescription>
              {deleteAccountHasBalance && sameCurrencyAccounts.length > 0 ? (
                <>Esta cuenta tiene un saldo de <strong>{formatCurrency(deleteAccountBalance, deleteAccountData?.currency)}</strong>. Elegí qué hacer con ese saldo antes de eliminarla.</>
              ) : deleteAccountHasBalance ? (
                <>Esta cuenta tiene un saldo de <strong>{formatCurrency(deleteAccountBalance, deleteAccountData?.currency)}</strong>. Como no hay otras cuentas en {deleteAccountData?.currency}, se registrará un movimiento de ajuste para llevar el saldo a $0.</>
              ) : (
                <>Esta cuenta tiene saldo $0. Se eliminará directamente.</>
              )}
            </DialogDescription>
          </DialogHeader>

          {deleteAccountHasBalance && (
            <div className="space-y-3 py-2">
              {sameCurrencyAccounts.length > 0 && (
                <>
                  <div 
                    onClick={() => { setDeleteAction('transfer'); setDeleteTargetAccountId(''); }}
                    className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${deleteAction === 'transfer' ? 'border-primary bg-primary/5' : 'border-muted hover:border-muted-foreground/30'}`}
                    data-testid="delete-option-transfer"
                  >
                    <div className="flex items-center gap-2 font-medium text-sm">
                      <ArrowUp className="h-4 w-4 text-blue-600" />
                      Transferir saldo a otra cuenta
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">El saldo se mueve a otra cuenta y queda registrado como transferencia</p>
                  </div>

                  {deleteAction === 'transfer' && (
                    <div className="pl-6">
                      <Select value={deleteTargetAccountId} onValueChange={setDeleteTargetAccountId}>
                        <SelectTrigger data-testid="delete-transfer-target">
                          <SelectValue placeholder="Elegí la cuenta destino" />
                        </SelectTrigger>
                        <SelectContent>
                          {sameCurrencyAccounts.map((acc: any) => (
                            <SelectItem key={acc.id} value={acc.id} data-testid={`delete-target-${acc.id}`}>
                              {acc.name} ({formatCurrency(acc.balance, acc.currency)})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </>
              )}

              <div 
                onClick={() => { setDeleteAction('adjust'); setDeleteTargetAccountId(''); }}
                className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${deleteAction === 'adjust' ? 'border-primary bg-primary/5' : 'border-muted hover:border-muted-foreground/30'}`}
                data-testid="delete-option-adjust"
              >
                <div className="flex items-center gap-2 font-medium text-sm">
                  <Scale className="h-4 w-4 text-amber-600" />
                  Registrar como movimiento y eliminar
                </div>
                <p className="text-xs text-muted-foreground mt-1">Se crea un {deleteAccountBalance > 0 ? 'egreso' : 'ingreso'} automático para llevar el saldo a $0 y luego se elimina la cuenta</p>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => { setDeleteAccountId(null); setDeleteAction(null); setDeleteTargetAccountId(''); }}>
              Cancelar
            </Button>
            <Button 
              variant="destructive" 
              onClick={handleDelete}
              disabled={deleteAccountMutation.isPending || (deleteAccountHasBalance && !deleteAction) || (deleteAction === 'transfer' && !deleteTargetAccountId)}
              data-testid="confirm-delete-account"
            >
              {deleteAccountMutation.isPending ? 'Eliminando...' : 'Eliminar cuenta'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Adjust Balance Dialog */}
      <Dialog open={!!adjustAccount} onOpenChange={(open) => {
          if (!open) {
            setAdjustAccount(null);
            setAdjustAmount('');
            setAdjustDisplayValue('');
          }
        }}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Scale className="h-5 w-5 text-primary" />
              Ajustar Saldo
            </DialogTitle>
            <DialogDescription>
              Ajustá el saldo de <span className="font-semibold">{adjustAccount?.name}</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div>
              <p className="text-sm font-medium mb-1">Saldo actual</p>
              <p className="text-lg font-bold text-muted-foreground">
                {adjustAccount && formatCurrency(
                  (() => { const a = adjustAccount; const acc2 = a.accountCategory === 'investment' ? calculateAccruedInterest(a) : 0; return acc2 > 0 ? parseFloat(a.initialInvestment || '0') + acc2 : parseFloat(a.balance); })(),
                  (adjustAccount.currency || 'ARS') as Currency
                )}
              </p>
            </div>
            
            <div className="space-y-2">
              <label className="text-sm font-medium">Nuevo saldo</label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-muted-foreground text-sm">
                  {adjustAccount?.currency === 'USD' || adjustAccount?.currency === 'USD_CASH' ? 'US$' : adjustAccount?.currency === 'EUR' ? '€' : 'AR$'}
                </span>
                <Input 
                  type="text"
                  inputMode="decimal"
                  className="pl-12" 
                  placeholder="0,00" 
                  value={adjustDisplayValue}
                  onChange={(e) => {
                    const { displayValue, internalValue } = formatAmountLive(e.target.value, adjustAmount);
                    setAdjustDisplayValue(displayValue);
                    setAdjustAmount(internalValue);
                  }}
                  data-testid="input-adjust-balance"
                />
              </div>
            </div>

            {!forceMode && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Motivo del ajuste (opcional)</label>
                <Input 
                  placeholder="Ej: Corrección por arqueo de caja"
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  data-testid="input-adjust-reason"
                />
              </div>
            )}

            <div className="flex items-center space-x-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <Checkbox 
                id="force-mode"
                checked={forceMode}
                onCheckedChange={(checked) => setForceMode(checked === true)}
                data-testid="checkbox-force-mode"
              />
              <label 
                htmlFor="force-mode" 
                className="text-sm font-medium cursor-pointer flex items-center gap-2"
              >
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                Forzar saldo (sin generar movimiento)
              </label>
            </div>

            {adjustAccount?.accountCategory === 'investment' && (
              <div className="p-3 rounded-lg border bg-cyan-50 border-cyan-200" data-testid="note-investment-reset">
                <p className="text-sm text-cyan-800">
                  Al confirmar, el rendimiento se reinicia desde este momento. El saldo que ingresaste pasa a ser el nuevo capital invertido y los intereses empiezan a devengarse de nuevo.
                </p>
              </div>
            )}

            {(() => {
              const effBal = adjustAccount ? (() => { const a = adjustAccount; const acc2 = a.accountCategory === 'investment' ? calculateAccruedInterest(a) : 0; return acc2 > 0 ? parseFloat(a.initialInvestment || '0') + acc2 : parseFloat(a.balance); })() : 0;
              return !forceMode && adjustAmount && normalizeAmountInput(adjustAmount) !== effBal ? (
              <div className={`p-3 rounded-lg border ${
                normalizeAmountInput(adjustAmount) > effBal
                  ? 'bg-green-50 border-green-200'
                  : 'bg-red-50 border-red-200'
              }`}>
                <p className="text-sm font-medium">
                  {normalizeAmountInput(adjustAmount) > effBal ? (
                    <span className="text-green-700">
                      Se registrará un ingreso de {formatCurrency(
                        Math.abs(normalizeAmountInput(adjustAmount) - effBal),
                        (adjustAccount?.currency || 'ARS') as Currency
                      )}
                    </span>
                  ) : (
                    <span className="text-red-700">
                      Se registrará un egreso de {formatCurrency(
                        Math.abs(normalizeAmountInput(adjustAmount) - effBal),
                        (adjustAccount?.currency || 'ARS') as Currency
                      )}
                    </span>
                  )}
                </p>
              </div>
            ) : null;
            })()}

            {(() => {
              const effBal = adjustAccount ? (() => { const a = adjustAccount; const acc2 = a.accountCategory === 'investment' ? calculateAccruedInterest(a) : 0; return acc2 > 0 ? parseFloat(a.initialInvestment || '0') + acc2 : parseFloat(a.balance); })() : 0;
              return forceMode && adjustAmount && normalizeAmountInput(adjustAmount) !== effBal ? (
              <div className="p-3 rounded-lg border bg-amber-50 border-amber-200">
                <p className="text-sm text-amber-700">
                  El saldo se actualizará directamente sin crear ningún movimiento en el historial.
                </p>
              </div>
            ) : null;
            })()}
          </div>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => {
                setAdjustAccount(null);
                setAdjustAmount('');
                setAdjustDisplayValue('');
              }}
            >
              Cancelar
            </Button>
            <Button 
              onClick={async () => {
                if (!adjustAccount || !adjustAmount) return;
                try {
                  const normalizedBalance = normalizeAmountInput(adjustAmount).toString();
                  if (forceMode) {
                    await forceBalanceMutation.mutateAsync({
                      id: adjustAccount.id,
                      newBalance: normalizedBalance,
                    });
                    toast({
                      title: "Saldo forzado",
                      description: `El saldo de ${adjustAccount.name} ha sido actualizado directamente.`,
                    });
                  } else {
                    await adjustBalanceMutation.mutateAsync({
                      id: adjustAccount.id,
                      newBalance: normalizedBalance,
                      reason: adjustReason || undefined,
                    });
                    toast({
                      title: "Saldo ajustado",
                      description: `El saldo de ${adjustAccount.name} ha sido actualizado correctamente.`,
                    });
                  }
                  setAdjustAccount(null);
                  setAdjustAmount('');
                  setAdjustDisplayValue('');
                } catch (error: any) {
                  toast({
                    title: "Error",
                    description: error.message || "No se pudo ajustar el saldo",
                    variant: "destructive",
                  });
                }
              }}
              disabled={(forceMode ? forceBalanceMutation.isPending : adjustBalanceMutation.isPending) || !adjustAmount || normalizeAmountInput(adjustAmount) === (() => { if (!adjustAccount) return 0; const a = adjustAccount; const acc2 = a.accountCategory === 'investment' ? calculateAccruedInterest(a) : 0; return acc2 > 0 ? parseFloat(a.initialInvestment || '0') + acc2 : parseFloat(a.balance); })()}
              data-testid="button-confirm-adjust"
            >
              {(forceMode ? forceBalanceMutation.isPending : adjustBalanceMutation.isPending) ? 'Ajustando...' : (forceMode ? 'Forzar Saldo' : 'Confirmar Ajuste')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mobile tap dialog for full amount */}
      <Dialog open={showAmountDialog} onOpenChange={setShowAmountDialog}>
        <DialogContent className="sm:max-w-[300px]">
          <DialogHeader>
            <DialogTitle className="text-center text-lg">{dialogAmount?.label}</DialogTitle>
          </DialogHeader>
          <div className="text-center py-4">
            <p className="text-2xl font-bold">{dialogAmount?.value}</p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Account movements dialog */}
      <AccountMovementsDialog
        account={selectedAccountForMovements}
        onClose={() => setSelectedAccountForMovements(null)}
      />

    </>
  );
}

function AccountMovementsDialog({ account, onClose }: { account: any; onClose: () => void }) {
  const { data: transactions = [], isLoading } = useQuery({
    queryKey: ['/api/transactions', 'account-movements', account?.id],
    queryFn: async () => {
      const res = await fetch('/api/transactions?limit=500', {
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Error al cargar movimientos');
      return res.json();
    },
    enabled: !!account,
  });

  const [sortColumn, setSortColumn] = React.useState<'date' | 'amount'>('date');
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('desc');

  // Al abrir el modal (cambia la cuenta) volvemos al orden por defecto:
  // fecha descendente. El componente queda montado entre aperturas, así que
  // sin este reset el orden elegido persistiría al reabrir otra cuenta.
  React.useEffect(() => {
    if (account?.id) {
      setSortColumn('date');
      setSortDir('desc');
    }
  }, [account?.id]);

  const toggleSort = (column: 'date' | 'amount') => {
    if (sortColumn === column) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDir('desc');
    }
  };

  const accountTransactions = React.useMemo(() => {
    if (!account) return [];
    const getValue = (t: any): number => {
      if (sortColumn === 'amount') {
        const v = Math.abs(parseFloat(t.amount) || 0);
        return (t.type === 'income' || t.type === 'receivable' || t.type === 'transfer_in') ? v : -v;
      }
      const ts = safeParseDate(t.date).getTime();
      return Number.isFinite(ts) ? ts : 0;
    };
    return transactions
      .filter((t: any) => t.accountId?.toString() === account.id?.toString())
      .sort((a: any, b: any) => {
        let cmp = getValue(a) - getValue(b);
        if (!Number.isFinite(cmp) || cmp === 0) {
          // Desempate estable: más recientemente creado primero.
          cmp = safeParseDate(a.createdAt || a.date).getTime()
            - safeParseDate(b.createdAt || b.date).getTime();
        }
        if (!Number.isFinite(cmp)) cmp = 0;
        return sortDir === 'asc' ? cmp : -cmp;
      });
  }, [transactions, account, sortColumn, sortDir]);

  const getTypeLabel = (type: string, status?: string) => {
    if (type === 'income') return 'Ingreso';
    if (type === 'expense') return 'Egreso';
    if (type === 'transfer_in') return 'Transferencia entrada';
    if (type === 'transfer_out') return 'Transferencia salida';
    if (type === 'receivable') return status === 'completed' ? 'Cobrado' : 'Por Cobrar';
    if (type === 'payable') return status === 'completed' ? 'Pagado' : 'Por Pagar';
    return type;
  };

  const getTypeBadgeClass = (type: string) => {
    if (type === 'income' || type === 'receivable') return 'bg-green-100 text-green-700';
    if (type === 'expense' || type === 'payable') return 'bg-red-100 text-red-700';
    if (type === 'transfer_in') return 'bg-blue-100 text-blue-700';
    if (type === 'transfer_out') return 'bg-orange-100 text-orange-700';
    return 'bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-200';
  };

  const isPositive = (type: string) => type === 'income' || type === 'receivable' || type === 'transfer_in';

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch { return dateStr; }
  };

  const formatAmount = (amount: string | number, currency?: string) => {
    const num = parseFloat(String(amount));
    const curr = (currency || 'ARS').replace('_CASH', '');
    try {
      return new Intl.NumberFormat('es-AR', { style: 'currency', currency: curr, minimumFractionDigits: 2 }).format(Math.abs(num));
    } catch {
      const sym = CURRENCY_SYMBOLS[curr as keyof typeof CURRENCY_SYMBOLS] || '$';
      return `${sym} ${Math.abs(num).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
    }
  };

  const currency = account?.currency || 'ARS';

  return (
    <Dialog open={!!account} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Movimientos de {account?.name || ''}
          </DialogTitle>
          <DialogDescription>
            {accountTransactions.length} movimiento{accountTransactions.length !== 1 ? 's' : ''} registrado{accountTransactions.length !== 1 ? 's' : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 -mt-1">
          <span className="text-xs text-muted-foreground">Ordenar por:</span>
          {([
            { col: 'date' as const, label: 'Fecha' },
            { col: 'amount' as const, label: 'Importe' },
          ]).map(({ col, label }) => {
            const active = sortColumn === col;
            const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
            return (
              <button
                key={col}
                type="button"
                onClick={() => toggleSort(col)}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${active ? 'border-border bg-muted text-foreground font-medium' : 'border-transparent text-muted-foreground hover:bg-muted/50'}`}
                data-testid={`button-sort-movement-${col}`}
                aria-label={`Ordenar por ${label}`}
              >
                <span>{label}</span>
                <Icon className={`h-3 w-3 shrink-0 ${active ? 'opacity-100' : 'opacity-40'}`} />
              </button>
            );
          })}
        </div>
        <div className="flex-1 overflow-y-auto -mx-6 px-6">
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">Cargando movimientos...</div>
          ) : accountTransactions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">No hay movimientos en esta cuenta.</div>
          ) : (
            <div className="space-y-2">
              {accountTransactions.map((t: any) => (
                <div key={t.id} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 border border-transparent hover:border-border transition-colors" data-testid={`movement-${t.id}`}>
                  <div className="flex-1 min-w-0 mr-3">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs text-muted-foreground">{formatDate(t.date)}</span>
                      <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${getTypeBadgeClass(t.type)}`}>
                        {getTypeLabel(t.type, t.status)}
                      </Badge>
                    </div>
                    <p className="text-sm font-medium truncate">{t.description || 'Sin descripción'}</p>
                  </div>
                  <span className={`text-sm font-semibold whitespace-nowrap ${isPositive(t.type) ? 'text-green-600' : 'text-red-600'}`}>
                    {isPositive(t.type) ? '+' : '-'}{formatAmount(t.amount, currency)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
