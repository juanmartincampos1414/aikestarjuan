import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useAccounts, useCreateTransaction, useOrganization, useClients, useSuppliers, useProducts, useCreateClient, useCreateSupplier, useCreateProduct, useMembership, useLinkableTransactions, useExchangeRates, useUser, useTransactions, useIsPersonalBasic } from '@/lib/hooks';
import { clientAPI } from '@/lib/api';
import { ensureCategoryExists } from '@/lib/categories';
import { ROLE_PERMISSIONS, type Role, ASSET_TYPE_LABELS, ASSET_CATEGORY_LABELS, type AssetType, CURRENCY_SYMBOLS, CURRENCIES, PRODUCT_TYPES, PRODUCT_TYPE_LABELS, type ProductType, isValidArcaInvoiceNumber, normalizeArcaInvoiceNumber } from '@shared/schema';
import { FEATURE_FLAGS } from '@/lib/constants';
import { Dialog, DialogContent, DialogTrigger, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ArrowUpRight, ArrowDownLeft, Clock, CalendarClock, Receipt, Wallet, AlertTriangle, AlertCircle, Check, Plus, Trash2, HelpCircle, Upload, FileText, X, Loader2, Maximize2, Minimize2, ShieldAlert, Building2, TrendingUp, Sparkles, RefreshCw, CalendarIcon, ChevronsUpDown, ArrowLeftRight, Zap } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { CategoryPicker } from '@/components/CategoryPicker';
import { Calendar } from "@/components/ui/calendar";
import { useToast } from '@/hooks/use-toast';
import { cn, getArgentinaToday } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/api';
import { pushGlobalUndoAction } from '@/components/UndoButton';
import { format, parseISO } from 'date-fns';
import { es } from 'date-fns/locale';
import { type Currency } from '@shared/schema';
import { type Step, type TransactionFormValues, type ClassificationResult, type NegativeBalanceInfo, transactionSchema } from './transaction-wizard/types';
import { formatAmountForDisplay, validateImputationDate, formatAmountAR } from './transaction-wizard/utils';
import { formatAmountLive, normalizeAmountInput } from '@/lib/currency';
import { MONOTRIBUTO_MAX_UNIT_PRICE } from '@shared/constants';
import { CURRENCY_SYMBOLS as SYMBOLS } from '@shared/schema';
import PaymentMethodEditorDialog from '@/components/PaymentMethodEditorDialog';
import { ReceiverPicker, type ReceiverPickerOption } from '@/components/ReceiverPicker';

const FormattedAmount = ({ amount, currency = 'ARS', showSign = false, isPositive = true }: { 
  amount: string | number; 
  currency?: string;
  showSign?: boolean;
  isPositive?: boolean;
}) => {
  const { integer, cents } = formatAmountAR(amount);
  const currencySymbol = SYMBOLS[currency as keyof typeof SYMBOLS] || 'AR$';
  const sign = showSign ? (isPositive ? '+' : '-') : '';
  
  return (
    <span className="inline-flex items-baseline">
      <span>{sign}{currencySymbol}{integer}</span>
      {cents && (
        <sup className="text-[0.6em] ml-0.5 font-medium opacity-70">{cents}</sup>
      )}
    </span>
  );
};

const getAccTypeLabel = (type: string) => {
  const labels: Record<string, string> = {
    'bank': 'Banco', 'cash': 'Efectivo', 'wallet': 'Billetera', 'credit_card': 'Tarjeta',
    'investment': 'Inversión', 'broker': 'Broker', 'crypto': 'Cripto',
    'fintech': 'Fintech', 'fixed_term': 'Plazo Fijo', 'other': 'Otro'
  };
  return labels[type] || type;
};

// Ítem editable del paso de emisión de factura del asistente. Espeja el
// DraftItem del modal EmitInvoiceModal: permite cargar varios renglones para
// que un monotributista pueda dividir un monto alto y no choque con el tope de
// precio unitario por ítem que aplica ARCA (MONOTRIBUTO_MAX_UNIT_PRICE).
interface EmitDraftItem {
  id: string;
  description: string;
  quantity: string;
  unitNet: string;
  aliquot: number;
}

let emitDraftItemSeq = 0;
const newEmitDraftItemId = () => `wizard-emit-item-${emitDraftItemSeq++}`;

// Task #475: renglón de producto adicional cargado en el asistente.
interface ExtraLineItem {
  id: string;
  productId: string;
  quantity: string;
  unitPrice: number;
  profitabilityCodeId: string;
}

let extraItemSeq = 0;
const newExtraItemId = () => `wizard-extra-item-${extraItemSeq++}`;

export function TransactionWizard({
  children,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  preset,
  onCreated,
}: {
  children?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  preset?: {
    type?: 'income' | 'expense' | 'payable' | 'receivable' | 'transfer';
    hasInvoice?: boolean;
    emitInvoice?: boolean;
    startStep?: Step;
  };
  onCreated?: (transaction: any) => void;
}) {
  const queryClient = useQueryClient();
  const { data: accounts = [] } = useAccounts();
  const { data: organization } = useOrganization();
  const { data: clients = [] } = useClients(true); // Active only
  const { data: suppliers = [] } = useSuppliers(true); // Active only
  const { data: products = [] } = useProducts(true); // Active only
  const { data: profitabilityCodes = [] } = useQuery<Array<{id: string; code: string; name: string; color: string | null; isActive: boolean}>>({
    queryKey: ['/api/profitability-codes'],
    queryFn: async () => {
      const res = await fetch('/api/profitability-codes', { credentials: 'include' });
      if (!res.ok) return [];
      return res.json();
    },
  });
  // Task #229: payment methods (only used for income/receivable parents).
  const { data: paymentMethods = [] } = useQuery<Array<{
    id: string; name: string; isActive: boolean;
    concepts: Array<{ id: string; name: string; kind: 'percentage' | 'fixed'; value: string }>;
  }>>({
    queryKey: ['/api/payment-methods'],
    queryFn: async () => {
      const res = await fetch('/api/payment-methods', { credentials: 'include' });
      if (!res.ok) return [];
      return res.json();
    },
  });
  const { data: linkableTransactions = [] } = useLinkableTransactions();
  const { data: allTransactions = [] } = useTransactions();
  const { data: membership } = useMembership();
  const { data: exchangeRates } = useExchangeRates();
  const { data: transactionCategories = [] } = useQuery<Array<{id: string; name: string; type: string; expenseSubtype: string | null}>>({
    queryKey: ["/organization/categories"],
    queryFn: async () => {
      const res = await fetch("/api/organization/categories", { credentials: 'include' });
      if (!res.ok) return [];
      return res.json();
    },
  });
  const { data: dashboardPrefs } = useQuery<{
    preferredAccountId: string | null;
    preferredCurrency: string | null;
    preferredExpenseCategory: string | null;
    preferredIncomeCategory: string | null;
    defaultHasInvoice: boolean | null;
    lastEmitSendEmail: boolean | null;
    lastEmitSendSelfCopy: boolean | null;
    lastEmitCcList: string[] | null;
  }>({
    queryKey: ["/dashboard-preferences", organization?.id],
    queryFn: () => fetchWithAuth(`/dashboard-preferences?organizationId=${organization?.id}`),
    enabled: !!organization?.id,
  });
  const createTransactionMutation = useCreateTransaction();
  const { toast } = useToast();
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpenControlled = controlledOpen !== undefined;
  const open = isOpenControlled ? !!controlledOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (isOpenControlled) controlledOnOpenChange?.(next);
    else setInternalOpen(next);
  };
  
  // Check permissions
  const userRole = (membership?.role as Role) || 'viewer';
  const userPermissions = ROLE_PERMISSIONS[userRole] || [];
  const canCreateTransactions = userPermissions.includes('transactions:create');
  // Inline category create requires the same permission as
  // `POST /api/organization/categories` (`organization:settings`), which only
  // owners/admins have. If we let an operator type a new category, the server
  // rejects the transaction with "La categoría X no existe en la organización"
  // (task #337). Mismo criterio que ya se usa con medios de pago inline.
  const canWriteTransactionCategory = userRole === 'owner' || userRole === 'admin';
  // Task #230: only owners/admins can create payment methods inline
  // (mirrors the gating in Settings → Medios de Cobro).
  const canCreatePaymentMethod = userRole === 'owner' || userRole === 'admin';
  
  // Hide product/client/supplier/invoicing fields when org is Personal AND
  // the plan is the basic 'personal'. Personal Pro and higher unlock all of
  // these features even on Personal-type orgs.
  const isPersonalContext = useIsPersonalBasic();
  
  const [step, setStep] = useState<Step>('type');
  const [selectedCurrency, setSelectedCurrency] = useState<'ARS' | 'USD' | 'EUR' | null>(null);
  const [showNegativeBalanceWarning, setShowNegativeBalanceWarning] = useState(false);
  const [negativeBalanceInfo, setNegativeBalanceInfo] = useState<NegativeBalanceInfo | null>(null);
  const [showMoreDetails, setShowMoreDetails] = useState(false);
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [invoiceFileUrl, setInvoiceFileUrl] = useState<string | null>(null);
  const [emitWithArcaRaw, setEmitWithArca] = useState(false);
  const emitWithArca = FEATURE_FLAGS.INVOICING_ENABLED ? emitWithArcaRaw : false;
  // Inline emit-step state (only used when wizard advances through 'emit')
  const { data: currentUser } = useUser();
  const { data: invoicingAccount } = useQuery<any>({
    queryKey: ['/api/invoicing/account'],
    queryFn: async () => fetchWithAuth('/invoicing/account'),
  });
  const isInvoicingProduction = invoicingAccount?.account?.environment === 'production';
  const [emitReceiverName, setEmitReceiverName] = useState('');
  const [emitReceiverTaxId, setEmitReceiverTaxId] = useState('');
  const [emitReceiverIva, setEmitReceiverIva] = useState<'responsable_inscripto' | 'monotributo' | 'exento' | 'consumidor_final'>('consumidor_final');
  const [emitReceiverEmail, setEmitReceiverEmail] = useState('');
  const [emitReceiverAddress, setEmitReceiverAddress] = useState('');
  const [emitReceiverPhone, setEmitReceiverPhone] = useState('');
  // Tracks which counterparty (client/supplier) populated the receiver fields.
  // 'manual' = user typed by hand; null = not yet seeded. Used by the
  // ReceiverPicker combobox in the 'emit' step. Mirrors the modal behavior:
  // editing a receiver input flips this to 'manual' so the combobox no
  // longer pretends the data still matches the chosen counterparty.
  const [emitSelectedClientId, setEmitSelectedClientId] = useState<string | 'manual' | null>(null);
  const markEmitReceiverManual = () => {
    if (emitSelectedClientId && emitSelectedClientId !== 'manual') {
      setEmitSelectedClientId('manual');
    }
  };
  // Renglones del comprobante. Por defecto un único ítem derivado del
  // movimiento, pero el usuario puede agregar más — necesario para
  // monotributistas cuyo precio unitario por ítem ARCA limita
  // (ver MONOTRIBUTO_MAX_UNIT_PRICE).
  const [emitItems, setEmitItems] = useState<EmitDraftItem[]>([]);
  const updateEmitItem = (id: string, patch: Partial<EmitDraftItem>) =>
    setEmitItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  const addEmitItem = () =>
    setEmitItems((prev) => {
      const emitterDiscriminates = invoicingAccount?.account?.ivaCondition === 'responsable_inscripto';
      return [
        ...prev,
        { id: newEmitDraftItemId(), description: '', quantity: '1', unitNet: '', aliquot: emitterDiscriminates ? 21 : 0 },
      ];
    });
  const removeEmitItem = (id: string) =>
    setEmitItems((prev) => (prev.length > 1 ? prev.filter((it) => it.id !== id) : prev));
  // Totales por suma de todos los renglones (neto, IVA y total con IVA).
  const emitTotals = useMemo(() => {
    let net = 0;
    let iva = 0;
    for (const it of emitItems) {
      const lineNet = (Number(it.quantity) || 0) * (Number(it.unitNet) || 0);
      net += lineNet;
      iva += lineNet * ((Number(it.aliquot) || 0) / 100);
    }
    net = +net.toFixed(2);
    iva = +iva.toFixed(2);
    const total = +(net + iva).toFixed(2);
    return { net, iva, total };
  }, [emitItems]);
  // Tope de precio unitario por ítem que ARCA aplica a monotributo/exento
  // (Factura C). Si un renglón lo supera, ARCA rechaza toda la factura, así que
  // avisamos en forma preventiva y explicamos cómo dividirlo.
  const emitterIsFacturaC =
    invoicingAccount?.account?.ivaCondition === 'monotributo' ||
    invoicingAccount?.account?.ivaCondition === 'exento';
  const [emitObservations, setEmitObservations] = useState('');
  // Concepto del comprobante (ARCA). Por defecto "producto". Cuando es servicio
  // o ambos, ARCA exige el período del servicio y el vencimiento de pago.
  const [emitItemType, setEmitItemType] = useState<'product' | 'service' | 'product_and_service'>('product');
  const [emitServiceFrom, setEmitServiceFrom] = useState('');
  const [emitServiceTo, setEmitServiceTo] = useState('');
  const [emitPaymentDueDate, setEmitPaymentDueDate] = useState('');
  const emitIncludesService = emitItemType === 'service' || emitItemType === 'product_and_service';
  // El tope de precio unitario del monotributo (Factura C) solo aplica a
  // PRODUCTOS. En facturas de servicio puro ARCA no lo restringe, así que no
  // avisamos ni bloqueamos. En "productos y servicios" lo mantenemos porque la
  // factura contiene productos.
  const emitCapApplies = emitterIsFacturaC && emitItemType !== 'service';
  const emitOverCapItems = useMemo(() => {
    if (!emitCapApplies) return [] as { index: number; minUnits: number }[];
    const out: { index: number; minUnits: number }[] = [];
    emitItems.forEach((it, index) => {
      const unit = Number(it.unitNet) || 0;
      if (unit > MONOTRIBUTO_MAX_UNIT_PRICE) {
        const qty = Number(it.quantity) || 1;
        const lineNet = unit * qty;
        out.push({ index, minUnits: Math.ceil(lineNet / MONOTRIBUTO_MAX_UNIT_PRICE) });
      }
    });
    return out;
  }, [emitItems, emitCapApplies]);
  const emitHasOverCap = emitOverCapItems.length > 0;
  // For supplier-directed comprobantes (devoluciones de compra), choose
  // between Nota de Crédito and Nota de Débito. The letter (A/B/C) is
  // derived from emitter+receiver IVA condition. Ignored for client flow.
  const [emitSupplierNoteKind, setEmitSupplierNoteKind] = useState<'credit' | 'debit'>('credit');
  // ND to suppliers is not supported in production (provider returns 501).
  // Reset to 'credit' as soon as the invoicing account resolves to production
  // — this covers the case where the user picked debit while the account was
  // still loading or while in sandbox, and then env switched to production.
  // Default OFF — el usuario que necesita mandar el PDF lo prende explícitamente
  // (UX: emitir factura sin obligar a completar email del cliente cada vez).
  const [emitSendEmail, setEmitSendEmail] = useState(false);
  const [emitCcInput, setEmitCcInput] = useState('');
  const [emitCcList, setEmitCcList] = useState<string[]>([]);
  const [emitSendSelfCopy, setEmitSendSelfCopy] = useState(false);
  // Snapshot of the counterparty's persisted email preferences loaded when
  // entering the 'emit' step. Used to detect changes and persist them after
  // emission. `kind` distinguishes whether the prefs came from the client's
  // ficha or the supplier's ficha.
  const [emitLoadedPrefs, setEmitLoadedPrefs] = useState<{ kind: 'client'; clientId: string; defaultCcEmails: string[]; sendCopyToSelf: boolean } | { kind: 'supplier'; supplierId: string; defaultCcEmails: string[]; sendCopyToSelf: boolean } | null>(null);
  const [emitSubmitting, setEmitSubmitting] = useState(false);
  const [isUploadingInvoice, setIsUploadingInvoice] = useState(false);
  const invoiceFileInputRef = useRef<HTMLInputElement>(null);
  
  // Dialog maximize state
  const [isMaximized, setIsMaximized] = useState(false);
  
  // Close confirmation dialog state
  const [showCloseConfirmation, setShowCloseConfirmation] = useState(false);
  
  // AI Classification state
  const [classification, setClassification] = useState<ClassificationResult | null>(null);
  const [isClassifying, setIsClassifying] = useState(false);
  const [classificationOverride, setClassificationOverride] = useState<AssetType | null>(null);
  
  // Inline creation states
  const [showNewSupplierDialog, setShowNewSupplierDialog] = useState(false);
  const [showNewClientDialog, setShowNewClientDialog] = useState(false);
  const [showNewProductDialog, setShowNewProductDialog] = useState(false);
  const [showNewPaymentMethodDialog, setShowNewPaymentMethodDialog] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState('');
  const [newClientName, setNewClientName] = useState('');
  const [newProductName, setNewProductName] = useState('');
  
  const [newProductDescription, setNewProductDescription] = useState('');
  const [newProductCategory, setNewProductCategory] = useState('');
  const [newProductSku, setNewProductSku] = useState('');
  const [newProductType, setNewProductType] = useState<string>('product');
  const [newProductBarcode, setNewProductBarcode] = useState('');
  const [newProductCostCurrency, setNewProductCostCurrency] = useState('ARS');
  const [newProductCostPrice, setNewProductCostPrice] = useState('');
  const [newProductSalePrice, setNewProductSalePrice] = useState('');
  const [newProductStock, setNewProductStock] = useState('');
  const [newProductMinStock, setNewProductMinStock] = useState('');
  const [newProductUnit, setNewProductUnit] = useState('unidad');
  const [newProductPurchaseDate, setNewProductPurchaseDate] = useState('');
  const [newProductUsefulLife, setNewProductUsefulLife] = useState('');
  const [newProductCurrentValue, setNewProductCurrentValue] = useState('');
  
  // Local state for amount input (preserves user typing, only normalized on blur)
  const [amountDisplay, setAmountDisplay] = useState('');
  
  // Linkable transaction combobox state
  const [linkableOpen, setLinkableOpen] = useState(false);
  
  // Transfer with currency exchange state
  const [isCurrencyExchange, setIsCurrencyExchange] = useState(false);
  const [customExchangeRate, setCustomExchangeRate] = useState<string>('');

  const [productUnitPrice, setProductUnitPrice] = useState<number>(0);

  // Task #475: renglones de productos adicionales. El primer producto vive en
  // los campos legacy (productId/productQuantity); a partir del segundo se
  // cargan acá. Al guardar: 0/1 producto → payload legacy; 2+ → items[].
  const [extraItems, setExtraItems] = useState<ExtraLineItem[]>([]);

  const getProductUnitPrice = (product: any, transactionType: string): number => {
    const salePrice = product.salePrice ? parseFloat(product.salePrice) : 0;
    const costPrice = product.costPrice ? parseFloat(product.costPrice) : 0;
    if (transactionType === 'income' || transactionType === 'receivable') {
      return salePrice > 0 ? salePrice : costPrice;
    }
    return costPrice > 0 ? costPrice : salePrice;
  };

  // Suma del total combinando el renglón principal (legacy) + los adicionales.
  const computeCombinedTotal = (primaryQty: number, primaryUnit: number, extras: ExtraLineItem[]) => {
    const primaryTotal = primaryQty > 0 && primaryUnit > 0 ? primaryQty * primaryUnit : 0;
    const extrasTotal = extras.reduce((sum, it) => {
      const q = parseFloat(it.quantity) || 0;
      return sum + (q > 0 && it.unitPrice > 0 ? q * it.unitPrice : 0);
    }, 0);
    return primaryTotal + extrasTotal;
  };

  const updateAmountFromQuantity = (qty: number, unitPrice: number) => {
    const total = computeCombinedTotal(qty, unitPrice, extraItems);
    if (total > 0) {
      const totalStr = total.toFixed(2);
      form.setValue('amount', totalStr);
      setAmountDisplay(formatAmountForDisplay(totalStr));
    }
  };

  // Recalcula el monto del formulario cuando cambian los renglones adicionales.
  const syncAmountFromExtras = (extras: ExtraLineItem[]) => {
    const primaryQty = parseFloat(form.getValues('productQuantity') || '0') || 0;
    const total = computeCombinedTotal(primaryQty, productUnitPrice, extras);
    if (total > 0) {
      const totalStr = total.toFixed(2);
      form.setValue('amount', totalStr);
      setAmountDisplay(formatAmountForDisplay(totalStr));
    }
  };

  const addExtraItem = () => {
    setExtraItems((prev) => [
      ...prev,
      { id: newExtraItemId(), productId: '', quantity: '1', unitPrice: 0, profitabilityCodeId: '' },
    ]);
  };

  const updateExtraItem = (id: string, patch: Partial<ExtraLineItem>) => {
    setExtraItems((prev) => {
      const next = prev.map((it) => (it.id === id ? { ...it, ...patch } : it));
      syncAmountFromExtras(next);
      return next;
    });
  };

  const handleExtraProductSelect = (id: string, productId: string) => {
    const selectedProduct = products.find((p: any) => p.id === productId);
    const unitPrice = selectedProduct ? getProductUnitPrice(selectedProduct, form.getValues('type')) : 0;
    const defaultCode = selectedProduct?.defaultProfitabilityCodeId || '';
    setExtraItems((prev) => {
      const next = prev.map((it) =>
        it.id === id ? { ...it, productId, unitPrice, profitabilityCodeId: it.profitabilityCodeId || defaultCode } : it,
      );
      syncAmountFromExtras(next);
      return next;
    });
  };

  const removeExtraItem = (id: string) => {
    setExtraItems((prev) => {
      const next = prev.filter((it) => it.id !== id);
      syncAmountFromExtras(next);
      return next;
    });
  };

  const handleProductSelect = (productId: string) => {
    if (productId === '__none__' || productId === '__add_new__') {
      setProductUnitPrice(0);
      form.setValue('productQuantity', '');
      // Task #502: al sacar el producto, limpiar el IVA que había precargado
      // para que no quede una alícuota "explícita" stale en el paso de emisión.
      form.setValue('invoiceIvaAliquot', '');
      // Task #475: sin producto principal no puede haber renglones adicionales;
      // limpiarlos evita enviar items[] stale en modo single/sin producto.
      setExtraItems([]);
      return;
    }
    const selectedProduct = products.find((p: any) => p.id === productId);
    if (selectedProduct) {
      if (selectedProduct.name) {
        form.setValue('description', selectedProduct.name);
      }
      if (selectedProduct.category) {
        form.setValue('category', selectedProduct.category);
      }
      if (selectedProduct.defaultProfitabilityCodeId && !form.getValues('profitabilityCodeId')) {
        form.setValue('profitabilityCodeId', selectedProduct.defaultProfitabilityCodeId);
      }
      // Task #502: precargar el IVA del producto en el detalle de factura.
      // El usuario lo puede cambiar a mano; al emitir, Monotributo/Exento
      // (Factura C) lo fuerza a 0% igual.
      if ((selectedProduct as any).ivaAliquot != null) {
        form.setValue('invoiceIvaAliquot', String((selectedProduct as any).ivaAliquot));
      }
      const currentType = form.getValues('type');
      const unitPrice = getProductUnitPrice(selectedProduct, currentType);
      setProductUnitPrice(unitPrice);
      form.setValue('productQuantity', '1');

      if (unitPrice > 0) {
        const total = unitPrice.toFixed(2);
        form.setValue('amount', total);
        setAmountDisplay(formatAmountForDisplay(total));
      }
      if (currentType !== 'payable' && currentType !== 'receivable') {
        const today = getArgentinaToday();
        form.setValue('imputationDate', today);
      }
    }
  };
  
  const createSupplierMutation = useCreateSupplier();
  const createClientMutation = useCreateClient();
  const createProductMutation = useCreateProduct();
  
  const form = useForm<TransactionFormValues>({
    resolver: zodResolver(transactionSchema),
    defaultValues: {
      type: 'expense',
      amount: '',
      description: '',
      category: '',
      imputationDate: getArgentinaToday(),
      hasInvoice: false,
      invoiceType: 'C',
    },
  });

  // Force supplier note kind to 'credit' whenever the invoicing account is in
  // production — NDs to suppliers are not supported there (backend returns 501).
  useEffect(() => {
    if (isInvoicingProduction && emitSupplierNoteKind === 'debit') {
      setEmitSupplierNoteKind('credit');
    }
  }, [isInvoicingProduction, emitSupplierNoteKind]);

  // Refresh clients, suppliers, products and reset date when dialog opens
  useEffect(() => {
    if (open) {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      form.setValue('imputationDate', getArgentinaToday());
      if (dashboardPrefs?.defaultHasInvoice !== null && dashboardPrefs?.defaultHasInvoice !== undefined) {
        form.setValue('hasInvoice', dashboardPrefs.defaultHasInvoice);
      }
    }
  }, [open, queryClient, form, dashboardPrefs]);

  // Apply external preset (e.g. when launched from the Facturas page in
  // "Nueva Factura" mode: type=receivable + factura + emisión ARCA, jumping
  // past the type-selection step). Runs once per open transition so user
  // edits aren't clobbered on subsequent re-renders.
  const presetAppliedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      presetAppliedRef.current = false;
      return;
    }
    if (presetAppliedRef.current || !preset) return;
    if (preset.type) form.setValue('type', preset.type as any);
    if (preset.hasInvoice || preset.emitInvoice) form.setValue('hasInvoice', true);
    if (preset.emitInvoice) setEmitWithArca(true);
    if (preset.startStep) setStep(preset.startStep);
    presetAppliedRef.current = true;
  }, [open, preset, form]);

  const values = form.watch();
  const isPending = values.type === 'payable' || values.type === 'receivable';

  // Tracks whether the user manually picked an invoice type. While false, the
  // wizard auto-fills the type based on ARCA / last invoice for the counterparty.
  const userPickedInvoiceTypeRef = useRef(false);

  // Tracks whether the user manually flipped the ARCA toggle this session.
  // While false, the wizard auto-enables ARCA for income+factura (default ON).
  // Reset on every dialog open and on "Sin Factura" so each Con Factura flip
  // gets a fresh default. Flipped to true the first time the user toggles
  // ARCA by hand so we never re-enable it behind their back.
  const userToggledArcaRef = useRef(false);
  useEffect(() => {
    if (!open) {
      userToggledArcaRef.current = false;
    }
  }, [open]);
  // Default ARCA = ON for income with "Con Factura" (and the invoicing flag
  // active, non-Personal context). Respects userToggledArcaRef so the user
  // can always turn it off manually without us flipping it back on.
  useEffect(() => {
    if (!open) return;
    if (userToggledArcaRef.current) return;
    if (
      values.type === 'income' &&
      values.hasInvoice === true &&
      FEATURE_FLAGS.INVOICING_ENABLED &&
      !isPersonalContext
    ) {
      setEmitWithArca(true);
    }
  }, [open, values.type, values.hasInvoice, isPersonalContext]);

  // Smart pre-selection of invoice type (A/B/C):
  //   1. Most recent invoice type used with the same client/supplier.
  //   2. Otherwise, derived from emitter + receiver IVA condition (same heuristic
  //      shown in the Confirm step's "Tipo estimado" hint).
  useEffect(() => {
    if (!values.hasInvoice) {
      userPickedInvoiceTypeRef.current = false;
      return;
    }
    if (userPickedInvoiceTypeRef.current) return;
    if (emitWithArca && (values.type === 'income' || values.type === 'receivable')) return;

    const isOutgoing = values.type === 'income' || values.type === 'receivable';
    const counterpartyId = isOutgoing ? values.clientId : values.supplierId;

    let suggested: 'A' | 'B' | 'C' | null = null;

    // 1. Last invoice with this counterparty
    if (counterpartyId && Array.isArray(allTransactions)) {
      const matches = (allTransactions as any[])
        .filter((t) =>
          t?.hasInvoice &&
          t?.invoiceType &&
          ['A', 'B', 'C'].includes(t.invoiceType) &&
          (isOutgoing ? t.clientId === counterpartyId : t.supplierId === counterpartyId)
        )
        .sort((a, b) => {
          const da = new Date(a.date || a.imputationDate || 0).getTime();
          const db = new Date(b.date || b.imputationDate || 0).getTime();
          return db - da;
        });
      if (matches.length > 0) {
        suggested = matches[0].invoiceType as 'A' | 'B' | 'C';
      }
    }

    // 2. Derive from IVA conditions
    if (!suggested) {
      const emitterIva = (invoicingAccount as any)?.account?.ivaCondition as string | undefined;
      if (isOutgoing) {
        const c = clients.find((x: any) => x.id === values.clientId) as any;
        const receiverIva: string | null =
          c?.ivaCondition || (c?.taxId ? 'responsable_inscripto' : 'consumidor_final');
        if (emitterIva === 'monotributo' || emitterIva === 'exento') {
          suggested = 'C';
        } else if (emitterIva === 'responsable_inscripto') {
          suggested = receiverIva === 'responsable_inscripto' ? 'A' : 'B';
        }
      } else {
        const s = suppliers.find((x: any) => x.id === values.supplierId) as any;
        const supplierIva: string | null =
          s?.ivaCondition || (s?.taxId ? 'responsable_inscripto' : null);
        if (supplierIva === 'monotributo' || supplierIva === 'exento') {
          suggested = 'C';
        } else if (supplierIva === 'responsable_inscripto') {
          suggested = emitterIva === 'responsable_inscripto' ? 'A' : 'B';
        }
      }
    }

    if (suggested && suggested !== values.invoiceType) {
      form.setValue('invoiceType', suggested);
    }
  }, [
    values.hasInvoice,
    values.clientId,
    values.supplierId,
    values.type,
    emitWithArca,
    allTransactions,
    clients,
    suppliers,
    invoicingAccount,
    form,
  ]);

  const { data: clientProjectsList = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['/api/clients', values.clientId, 'projects'],
    queryFn: () => clientAPI.getProjects(values.clientId!),
    enabled: !!values.clientId,
  });

  // Auto-select default account when entering account step (uses dashboard preferences if set)
  useEffect(() => {
    if (step === 'account' && accounts.length > 0 && !selectedCurrency) {
      const prefAccountId = dashboardPrefs?.preferredAccountId;
      const prefCurrency = dashboardPrefs?.preferredCurrency as 'ARS' | 'USD' | 'EUR' | null;
      const prefAccount = prefAccountId ? accounts.find((a: any) => a.id === prefAccountId) : null;

      if (prefAccount) {
        const currency = (prefAccount.currency || 'ARS') as 'ARS' | 'USD' | 'EUR';
        setSelectedCurrency(currency);
        if (!isPending) {
          form.setValue('accountId', prefAccount.id);
        }
      } else if (prefCurrency) {
        const currencyAccounts = accounts.filter((a: any) => (a.currency || 'ARS') === prefCurrency);
        if (currencyAccounts.length > 0) {
          setSelectedCurrency(prefCurrency);
          if (!isPending) {
            form.setValue('accountId', currencyAccounts[0].id);
          }
        }
      } else {
        const arsAccounts = accounts.filter((a: any) => (a.currency || 'ARS') === 'ARS');
        if (arsAccounts.length > 0) {
          setSelectedCurrency('ARS');
          if (!isPending) {
            form.setValue('accountId', arsAccounts[0].id);
          }
        }
      }
    }
  }, [step, accounts, selectedCurrency, isPending, form, dashboardPrefs]);

  useEffect(() => {
    if (!open || !dashboardPrefs) return;
    const currentCategory = form.getValues('category');
    const isIncomeType = values.type === 'income' || values.type === 'receivable';
    const matchingType = isIncomeType ? 'income' : 'expense';
    if (currentCategory) {
      const currentCatValid = transactionCategories.some(
        cat => cat.name === currentCategory && cat.type === matchingType
      );
      if (currentCatValid) return;
      form.setValue('category', '');
    }
    const prefCategory = isIncomeType 
      ? dashboardPrefs.preferredIncomeCategory 
      : dashboardPrefs.preferredExpenseCategory;
    if (prefCategory) {
      const categoryExists = transactionCategories.some(
        cat => cat.name === prefCategory && cat.type === matchingType
      );
      if (categoryExists) {
        form.setValue('category', prefCategory);
      }
    }
  }, [open, values.type, dashboardPrefs, transactionCategories, form]);

  const showRecurrence = true;

  // Classify transaction using AI
  const classifyTransactionWithAI = async () => {
    const data = form.getValues();
    if (!data.description || !data.amount) return;
    
    setIsClassifying(true);
    setClassification(null);
    setClassificationOverride(null);
    
    try {
      const account = accounts.find((a: any) => a.id === data.accountId);
      
      const result = await fetchWithAuth('/ai/classify-transaction', {
        method: 'POST',
        body: JSON.stringify({
          description: data.description,
          amount: data.amount,
          category: data.category,
          type: data.type,
          currency: account?.currency || 'ARS',
        }),
      });
      
      setClassification(result);
    } catch (error) {
      console.error('AI Classification error:', error);
    } finally {
      setIsClassifying(false);
    }
  };

  const handleNext = async () => {
    // Get fresh values from form (important for async setValue calls)
    const currentValues = form.getValues();
    
    // Validate current step fields if needed
    // Flow: type -> account -> details -> invoice -> confirm
    // Transfer flow: type -> transfer -> confirm
    if (step === 'type') {
      // For transfers, go to transfer step instead of account
      if (currentValues.type === 'transfer') {
        setStep('transfer');
      } else {
        setStep('account');
      }
    } else if (step === 'transfer') {
      // Validate transfer fields
      if (!currentValues.accountId) {
        form.setError('accountId', { message: 'Seleccioná la cuenta de origen' });
        return;
      }
      if (!currentValues.destinationAccountId) {
        form.setError('destinationAccountId' as any, { message: 'Seleccioná la cuenta de destino' });
        toast({
          title: "Error",
          description: "Seleccioná la cuenta de destino",
          variant: "destructive",
        });
        return;
      }
      if (currentValues.accountId === currentValues.destinationAccountId) {
        toast({
          title: "Error",
          description: "La cuenta de origen y destino no pueden ser la misma",
          variant: "destructive",
        });
        return;
      }
      // Validate amount
      const amount = parseFloat(currentValues.amount?.replace(/\./g, '').replace(',', '.') || '0');
      if (!amount || amount <= 0) {
        toast({
          title: "Error",
          description: "Ingresá un monto válido",
          variant: "destructive",
        });
        return;
      }
      setStep('confirm');
    } else if (step === 'account') {
       const isPendingType = currentValues.type === 'payable' || currentValues.type === 'receivable';
       if (!isPendingType && !currentValues.accountId) {
          form.setError('accountId', { message: 'Debes seleccionar una cuenta' });
          return;
       }
       // Set default date when entering amount step
       if (!isPendingType) {
         const today = getArgentinaToday();
         form.setValue('imputationDate', today);
       }
       setStep('amount');
    } else if (step === 'amount') {
      const scrollToTestId = (testId: string) => {
        if (typeof document === 'undefined') return;
        const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          if (typeof el.focus === 'function') {
            try { el.focus({ preventScroll: true }); } catch { /* noop */ }
          }
        }
      };
      const amount = parseFloat(currentValues.amount?.replace(/\./g, '').replace(',', '.') || '0');
      if (!amount || amount <= 0) {
        form.setError('amount', { message: 'Ingresá un monto válido' });
        toast({ title: 'Falta el monto', description: 'Ingresá un monto válido para continuar.', variant: 'destructive' });
        scrollToTestId('input-amount');
        return;
      }
      const isPendingType = currentValues.type === 'payable' || currentValues.type === 'receivable';
      // For pending types, date is required (visible in UI) and must be valid
      if (isPendingType) {
        if (!currentValues.imputationDate || currentValues.imputationDate.trim() === '') {
          toast({ title: "Fecha requerida", description: "Seleccioná la fecha de vencimiento del compromiso", variant: "destructive" });
          return;
        }
        const dateError = validateImputationDate(currentValues.imputationDate, currentValues.type);
        if (dateError) {
          toast({ title: "Fecha inválida", description: dateError, variant: "destructive" });
          return;
        }
      }
      // Apply defaults for fields not filled if details weren't expanded
      if (!currentValues.category || currentValues.category.trim() === '') {
        form.setError('category', { message: 'Seleccioná un concepto' });
        toast({ title: 'Falta el concepto', description: 'Elegí un concepto antes de continuar.', variant: 'destructive' });
        scrollToTestId('select-category');
        return;
      }
      if (!currentValues.description || currentValues.description.trim() === '') {
        const typeLabels: Record<string, string> = { income: 'Ingreso', expense: 'Egreso', receivable: 'A cobrar', payable: 'A pagar' };
        form.setValue('description', typeLabels[currentValues.type] || 'Movimiento');
      }
      if (!isPendingType && (!currentValues.imputationDate || currentValues.imputationDate.trim() === '')) {
        const today = getArgentinaToday();
        form.setValue('imputationDate', today);
      }
      // Validate date for non-pending types if it was set in "more details"
      if (!isPendingType && currentValues.imputationDate) {
        const dateError = validateImputationDate(currentValues.imputationDate, currentValues.type);
        if (dateError) {
          toast({ title: "Fecha inválida", description: dateError, variant: "destructive" });
          return;
        }
      }
      // Validate manually-entered invoice number format when ARCA emission is OFF.
      // (When ARCA is ON the number is auto-generated and the input is hidden.)
      if (
        currentValues.hasInvoice &&
        !emitWithArca &&
        currentValues.invoiceNumber &&
        currentValues.invoiceNumber.toString().trim() !== ''
      ) {
        const normalized = normalizeArcaInvoiceNumber(currentValues.invoiceNumber);
        if (!isValidArcaInvoiceNumber(normalized)) {
          form.setError('invoiceNumber' as any, { message: 'Formato inválido (ej: 0001-00001234)' });
          toast({
            title: 'Número de comprobante inválido',
            description: 'Usá el formato 0001-00001234 (4 dígitos, guion, 8 dígitos).',
            variant: 'destructive',
          });
          scrollToTestId('input-invoice-number');
          return;
        }
        if (normalized !== currentValues.invoiceNumber) {
          form.setValue('invoiceNumber', normalized);
        }
        form.clearErrors('invoiceNumber' as any);
      }
      classifyTransactionWithAI();
      // If ARCA emission was requested for an income/receivable with invoice,
      // detour through the dedicated 'emit' step (receiver + email block)
      // before reaching Confirm.
      // Income / receivable -> client is the receiver.
      // Expense / payable   -> supplier is the receiver (for own notas de
      // débito/crédito propias dirigidas al proveedor, p. ej. devoluciones
      // de compra). Both flows reuse the same emit step.
      const isSupplierDirectedEmit =
        (currentValues.type === 'expense' || currentValues.type === 'payable') &&
        !!currentValues.supplierId;
      const isClientDirectedEmit =
        currentValues.type === 'income' || currentValues.type === 'receivable';
      const goesThroughEmit =
        emitWithArca &&
        currentValues.hasInvoice &&
        (isClientDirectedEmit || isSupplierDirectedEmit);
      if (goesThroughEmit) {
        // Seed emit-step defaults from the form + selected counterparty.
        // Both Client and Supplier expose the same emit-relevant fields
        // (name, email, taxId, ivaCondition), so we type the picked
        // counterparty as the intersection rather than reaching for `any`.
        type EmitCounterparty = {
          id?: string;
          name?: string | null;
          email?: string | null;
          taxId?: string | null;
          ivaCondition?: string | null;
        };
        const selectedClient: EmitCounterparty | undefined = isClientDirectedEmit
          ? clients?.find((c) => c.id === currentValues.clientId)
          : undefined;
        const selectedSupplier: EmitCounterparty | undefined = isSupplierDirectedEmit
          ? suppliers?.find((s) => s.id === currentValues.supplierId)
          : undefined;
        const counterparty: EmitCounterparty | undefined = selectedClient ?? selectedSupplier;
        const receiverName = counterparty?.name ?? '';
        const receiverTaxId = counterparty?.taxId ?? '';
        const receiverEmail = counterparty?.email ?? '';
        setEmitReceiverName(receiverName);
        setEmitReceiverTaxId(receiverTaxId);
        // Seed the picker: if a counterparty was picked in a previous step,
        // start with that selection so the user doesn't have to choose again.
        // Otherwise leave null so the combobox shows the placeholder.
        setEmitSelectedClientId(counterparty?.id ?? null);
        // Prefer the explicit IVA condition stored on the counterparty
        // (clients and suppliers both expose `ivaCondition`). Fall back to
        // a heuristic only when the field is empty.
        const ivaFallback = receiverTaxId ? 'responsable_inscripto' : 'consumidor_final';
        const counterpartyIva = counterparty?.ivaCondition ?? ivaFallback;
        const allowedIva = ['responsable_inscripto', 'monotributo', 'exento', 'consumidor_final'] as const;
        type ReceiverIva = typeof allowedIva[number];
        const safeIva: ReceiverIva = (allowedIva as readonly string[]).includes(counterpartyIva)
          ? (counterpartyIva as ReceiverIva)
          : 'consumidor_final';
        setEmitReceiverIva(safeIva);
        setEmitReceiverEmail(receiverEmail);
        setEmitReceiverAddress((selectedClient as any)?.address || (selectedSupplier as any)?.address || '');
        setEmitReceiverPhone((selectedClient as any)?.phone || (selectedSupplier as any)?.phone || '');
        setEmitObservations('');
        setEmitItemType('product');
        setEmitServiceFrom('');
        setEmitServiceTo('');
        setEmitPaymentDueDate('');
        // Seed Net + IVA aliquot from the amount the user already entered
        // so they don't have to retype it. Only seed if the field is blank
        // (don't overwrite values the user previously edited in this wizard).
        // Use the shared normalizer so both dot-decimal (internal form value)
        // and AR-formatted "1.234,56" inputs are parsed correctly.
        const totalNum = normalizeAmountInput((currentValues.amount || '').toString());
        const emitterIvaCond = invoicingAccount?.account?.ivaCondition;
        const emitterAccountLoaded = !!invoicingAccount?.account;
        const emitterDiscriminatesIva = emitterIvaCond === 'responsable_inscripto';
        const currentNetRaw = (currentValues.invoiceNetAmount || '').toString().trim();
        const currentNetNum = currentNetRaw ? normalizeAmountInput(currentNetRaw) : 0;
        // Aliquot default depends on the emitter's IVA condition:
        //   - Responsable Inscripto → 21% (most common AR default; user can change)
        //   - Monotributo / Exento → 0% (Factura C does NOT discriminate IVA;
        //     defaulting to 21% used to silently turn $5000 into $4132.23 by
        //     dividing by 1.21 here even though the emitted comprobante was C.)
        // Task #502: respetar una alícuota explícita ya cargada (incluido 0%,
        // p.ej. un producto exento), no solo valores > 0. Si no hay ninguna,
        // usar el default según condición del emisor.
        const rawAliq = (currentValues.invoiceIvaAliquot ?? '').toString().trim();
        const existingAliq = rawAliq !== '' ? parseFloat(rawAliq) : NaN;
        const hasExplicitAliq = Number.isFinite(existingAliq) && existingAliq >= 0;
        const seedAliquot = hasExplicitAliq
          ? (emitterDiscriminatesIva ? existingAliq : 0)
          : (emitterDiscriminatesIva ? 21 : 0);
        // Seed net por ítem: si el usuario ya tipeó un neto antes, respetarlo;
        // si no, derivarlo del total que cargó (sacando el IVA cuando aplica).
        const seedNet = currentNetNum > 0
          ? currentNetNum
          : (totalNum > 0
              ? (seedAliquot > 0 ? totalNum / (1 + seedAliquot / 100) : totalNum)
              : 0);
        // Inicializar el detalle con un único renglón. El usuario puede agregar
        // más (necesario para monotributistas que superan el tope por ítem).
        setEmitItems([{
          id: newEmitDraftItemId(),
          description: currentValues.description || currentValues.category || 'Servicio',
          quantity: '1',
          unitNet: seedNet > 0 ? seedNet.toFixed(2) : '',
          aliquot: seedAliquot,
        }]);
        if (emitterAccountLoaded && totalNum > 0 && currentNetNum <= 0) {
          if (!currentValues.invoiceIvaAliquot || !emitterDiscriminatesIva) {
            form.setValue('invoiceIvaAliquot', String(seedAliquot));
          }
          form.setValue('invoiceNetAmount', seedNet.toFixed(2));
        }
        setEmitSendEmail(
          dashboardPrefs?.lastEmitSendEmail !== null && dashboardPrefs?.lastEmitSendEmail !== undefined
            ? dashboardPrefs.lastEmitSendEmail
            : false
        );
        setEmitCcInput('');
        // Preference resolution order for CC list / "send copy to me":
        //   1. Per-client overrides stored in `client_invoice_email_prefs`
        //   2. User+org defaults stored in `dashboard_preferences`
        //   3. Empty defaults
        const orgDefaultCc = Array.isArray(dashboardPrefs?.lastEmitCcList) ? dashboardPrefs!.lastEmitCcList! : [];
        const orgDefaultSelfCopy =
          dashboardPrefs?.lastEmitSendSelfCopy !== null && dashboardPrefs?.lastEmitSendSelfCopy !== undefined
            ? dashboardPrefs.lastEmitSendSelfCopy
            : false;
        let initialCc: string[] = orgDefaultCc;
        let initialSelfCopy: boolean = orgDefaultSelfCopy;
        let loadedPrefs:
          | { kind: 'client'; clientId: string; defaultCcEmails: string[]; sendCopyToSelf: boolean }
          | { kind: 'supplier'; supplierId: string; defaultCcEmails: string[]; sendCopyToSelf: boolean }
          | null = null;
        if (selectedClient?.id) {
          try {
            const prefs: any = await fetchWithAuth(`/clients/${selectedClient.id}/invoice-email-prefs`);
            const hasOverride =
              prefs && (prefs.id || (Array.isArray(prefs?.defaultCcEmails) && prefs.defaultCcEmails.length > 0) || prefs?.sendCopyToSelf);
            if (hasOverride) {
              const cc = Array.isArray(prefs?.defaultCcEmails) ? prefs.defaultCcEmails : [];
              const self = !!prefs?.sendCopyToSelf;
              initialCc = cc;
              initialSelfCopy = self;
              loadedPrefs = { kind: 'client', clientId: selectedClient.id, defaultCcEmails: cc, sendCopyToSelf: self };
            }
          } catch (err) {
            // Ignore — fall back to org-level defaults.
          }
        } else if (currentValues.supplierId) {
          // Same precedence as clients but for supplier-directed comprobantes
          // (e.g. notas de débito/crédito propias). Loads the CCs and "send
          // me a copy" flag the user previously saved on the supplier's ficha.
          try {
            const prefs: any = await fetchWithAuth(`/suppliers/${currentValues.supplierId}/invoice-email-prefs`);
            const hasOverride =
              prefs && (prefs.id || (Array.isArray(prefs?.defaultCcEmails) && prefs.defaultCcEmails.length > 0) || prefs?.sendCopyToSelf);
            if (hasOverride) {
              const cc = Array.isArray(prefs?.defaultCcEmails) ? prefs.defaultCcEmails : [];
              const self = !!prefs?.sendCopyToSelf;
              initialCc = cc;
              initialSelfCopy = self;
              loadedPrefs = { kind: 'supplier', supplierId: currentValues.supplierId, defaultCcEmails: cc, sendCopyToSelf: self };
            }
          } catch (err) {
            // Ignore — fall back to org-level defaults.
          }
        }
        setEmitCcList(initialCc);
        setEmitSendSelfCopy(initialSelfCopy);
        setEmitLoadedPrefs(loadedPrefs);
        setStep('emit');
      } else {
        setStep('confirm');
      }
    } else if (step === 'emit') {
      // Validate the emission form before allowing the user to reach Confirm.
      if (!emitReceiverName.trim()) {
        toast({ title: 'Falta el receptor', description: 'Ingresá la razón social o nombre del cliente.', variant: 'destructive' });
        return;
      }
      // Cada renglón necesita cantidad y precio unitario mayores a 0.
      const invalidItem = emitItems.some(
        (it) => (Number(it.quantity) || 0) <= 0 || (Number(it.unitNet) || 0) <= 0,
      );
      if (invalidItem) {
        toast({ title: 'Revisá el detalle', description: 'Cada ítem necesita una cantidad y un precio unitario mayores a 0.', variant: 'destructive' });
        return;
      }
      if (!emitTotals.net || emitTotals.net <= 0) {
        toast({ title: 'Falta el neto', description: 'Ingresá el monto neto de la factura.', variant: 'destructive' });
        return;
      }
      // Bloquear cuando un precio unitario supera el tope de ARCA para
      // monotributo/exento: ARCA rechazaría toda la factura.
      if (emitHasOverCap) {
        toast({
          title: 'Precio unitario por encima del tope de ARCA',
          description: `Para monotributo, el precio unitario de cada ítem no puede superar $${MONOTRIBUTO_MAX_UNIT_PRICE.toLocaleString('es-AR')}. Dividilo en varios ítems o subí la cantidad antes de emitir.`,
          variant: 'destructive',
        });
        return;
      }
      if (emitSendEmail) {
        const isValidEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim());
        if (!emitReceiverEmail.trim() || !isValidEmail(emitReceiverEmail)) {
          toast({ title: 'Email inválido', description: 'Ingresá un email válido del cliente o desactivá el envío por email.', variant: 'destructive' });
          return;
        }
        for (const cc of emitCcList) {
          if (!isValidEmail(cc)) {
            toast({ title: 'CC inválido', description: `El email "${cc}" no es válido.`, variant: 'destructive' });
            return;
          }
        }
      }
      if (emitIncludesService) {
        if (!emitServiceFrom || !emitServiceTo || !emitPaymentDueDate) {
          toast({ title: 'Faltan datos del servicio', description: 'Para facturar servicios completá el período del servicio (desde y hasta) y el vencimiento de pago.', variant: 'destructive' });
          return;
        }
        if (emitServiceTo < emitServiceFrom) {
          toast({ title: 'Fechas inválidas', description: 'La fecha "hasta" del servicio no puede ser anterior a la fecha "desde".', variant: 'destructive' });
          return;
        }
      }
      setStep('confirm');
    }
  };

  const handleBack = () => {
    if (step === 'account') {
      setSelectedCurrency(null);
      form.setValue('accountId', '');
      setStep('type');
    }
    else if (step === 'transfer') setStep('type');
    else if (step === 'amount') setStep('account');
    else if (step === 'emit') setStep('amount');
    else if (step === 'confirm') {
      if (values.type === 'transfer') {
        setStep('transfer');
      } else if (
        emitWithArca &&
        values.hasInvoice &&
        ((values.type === 'income' || values.type === 'receivable') ||
          ((values.type === 'expense' || values.type === 'payable') && !!values.supplierId))
      ) {
        setStep('emit');
      } else {
        setStep('amount');
      }
    }
  };

  // Check if form has any data entered (to show close confirmation)
  const hasFormData = () => {
    return step !== 'type' || 
           values.amount !== '' || 
           values.description !== '' || 
           values.category !== '' ||
           values.accountId ||
           values.clientId ||
           values.supplierId;
  };

  // Handle close attempt - show confirmation if data exists
  const handleCloseAttempt = (newOpenState: boolean) => {
    if (!newOpenState && hasFormData()) {
      setShowCloseConfirmation(true);
    } else {
      setOpen(newOpenState);
    }
  };

  // Confirm close and reset form
  const handleConfirmClose = () => {
    setShowCloseConfirmation(false);
    form.reset();
    setStep('type');
    setSelectedCurrency(null);
    setClassification(null);
    setClassificationOverride(null);
    setInvoiceFile(null);
    setInvoiceFileUrl(null);
    setExtraItems([]);
    setAmountDisplay('');
    setShowMoreDetails(false);
    setIsCurrencyExchange(false);
    setCustomExchangeRate('');
    setOpen(false);
  };

  const handleInvoiceFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowedTypes.includes(file.type)) {
      toast({
        title: "Formato no válido",
        description: "Solo se permiten archivos JPG, PNG, WebP o PDF",
        variant: "destructive",
      });
      return;
    }
    
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "Archivo muy grande",
        description: "El archivo no puede superar los 10MB",
        variant: "destructive",
      });
      return;
    }
    
    setIsUploadingInvoice(true);
    setInvoiceFile(file);
    
    try {
      const { uploadURL, objectPath } = await fetchWithAuth('/uploads/request-url', {
        method: 'POST',
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          contentType: file.type,
        }),
      });
      
      await fetch(uploadURL, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      
      setInvoiceFileUrl(objectPath);
      
      toast({
        title: "Archivo subido",
        description: "La factura se subió correctamente.",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo subir el archivo",
        variant: "destructive",
      });
      setInvoiceFile(null);
      setInvoiceFileUrl(null);
    } finally {
      setIsUploadingInvoice(false);
      e.target.value = '';
    }
  };

  const removeInvoiceFile = () => {
    setInvoiceFile(null);
    setInvoiceFileUrl(null);
  };

  // Check if expense/payable would cause negative balance
  const checkNegativeBalance = () => {
    const data = form.getValues();
    if ((data.type !== 'expense' && data.type !== 'payable') || !data.accountId) return null;
    
    const account = accounts.find((a: any) => a.id === data.accountId);
    if (!account) return null;
    
    const currentBalance = parseFloat(account.balance);
    const amount = parseFloat(data.amount) || 0;
    const newBalance = currentBalance - amount;
    
    if (newBalance < 0) {
      return { accountName: account.name, newBalance, currentBalance, isPayable: data.type === 'payable' };
    }
    return null;
  };

  // Calculate default exchange rate for cross-currency transfers
  // Always returns rate as "1 USD/EUR = X ARS"
  const getDefaultExchangeRateForAccounts = (fromAccountId: number | string, toAccountId: number | string) => {
    // Compare IDs as strings (UUIDs) - don't convert to Number
    const fromAcc = accounts.find((a: any) => String(a.id) === String(fromAccountId));
    const toAcc = accounts.find((a: any) => String(a.id) === String(toAccountId));
    if (!fromAcc || !toAcc || fromAcc.currency === toAcc.currency) return '1';
    
    const originCurrency = fromAcc.currency;
    const destCurrency = toAcc.currency;
    const usdRate = exchangeRates?.usdToLocal || 1050;
    const eurRate = exchangeRates?.eurToLocal || 1150;
    
    // USD involved (always return "1 USD = X ARS")
    if ((originCurrency === 'USD' || originCurrency === 'USD_CASH') || 
        (destCurrency === 'USD' || destCurrency === 'USD_CASH')) {
      return String(usdRate);
    }
    // EUR involved (always return "1 EUR = X ARS")
    if (originCurrency === 'EUR' || destCurrency === 'EUR') {
      return String(eurRate);
    }
    return '1';
  };

  const onSubmit = async (forceSubmit = false, allowOverdraft = false) => {
    const data = form.getValues();
    
    // Handle transfers separately
    if (data.type === 'transfer') {
      try {
        const amount = parseFloat(data.amount?.replace(/\./g, '').replace(',', '.') || '0');
        
        // Get accounts to check currencies
        const fromAcc = accounts.find((a: any) => a.id === data.accountId);
        const toAcc = accounts.find((a: any) => a.id === data.destinationAccountId);
        const isCrossCurrency = fromAcc && toAcc && fromAcc.currency !== toAcc.currency;
        
        // Calculate effective exchange rate (custom or default from API)
        // For cross-currency transfers, ALWAYS calculate the rate (regardless of isCurrencyExchange state)
        let effectiveExchangeRate: string | undefined;
        if (isCrossCurrency && data.accountId && data.destinationAccountId) {
          // Get default rate from API
          const defaultRate = getDefaultExchangeRateForAccounts(data.accountId, data.destinationAccountId);
          
          if (customExchangeRate && customExchangeRate.trim()) {
            // Parse local format: replace dots (thousand sep) and comma (decimal sep)
            const parsedCustomRate = parseFloat(customExchangeRate.replace(/\./g, '').replace(',', '.'));
            effectiveExchangeRate = isNaN(parsedCustomRate) || parsedCustomRate <= 1 
              ? defaultRate
              : String(parsedCustomRate);
          } else {
            effectiveExchangeRate = defaultRate;
          }
          
          // Validate exchange rate
          const rateValue = parseFloat(effectiveExchangeRate || '0');
          if (isNaN(rateValue) || rateValue <= 1) {
            toast({
              title: "Error",
              description: "No se pudo obtener el tipo de cambio. Por favor, esperá un momento e intentá de nuevo.",
              variant: "destructive",
            });
            return;
          }
        }
        
        const response = await fetchWithAuth('/transactions/transfer', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fromAccountId: data.accountId,
            toAccountId: data.destinationAccountId,
            amount,
            description: data.description || 'Transferencia interna',
            organizationId: organization?.id,
            isCurrencyExchange: isCrossCurrency,
            exchangeRate: effectiveExchangeRate,
          }),
        });
        
        if (response?.undoKey) {
          pushGlobalUndoAction({
            undoKey: response.undoKey,
            entityType: 'transfer_created',
            entityName: data.description || 'Transferencia interna',
            expiresAt: Date.now() + 60000,
          });
        }
        
        toast({
          title: "Transferencia realizada",
          description: "El dinero se movió correctamente entre las cuentas.",
        });
        
        // Invalidate queries to refresh dashboard data
        queryClient.invalidateQueries({ queryKey: ['accounts'] });
        queryClient.invalidateQueries({ queryKey: ['transactions'] });
        queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
        queryClient.invalidateQueries({ queryKey: ['/api/audit-logs'] });
        queryClient.invalidateQueries({ queryKey: ['calendar'] });
        
        setOpen(false);
        setTimeout(() => {
          setStep('type');
          setSelectedCurrency(null);
          setInvoiceFile(null);
          setInvoiceFileUrl(null);
          setClassification(null);
          setClassificationOverride(null);
          setAmountDisplay('');
          setShowMoreDetails(false);
          setIsCurrencyExchange(false);
          setCustomExchangeRate('');
          setExtraItems([]);
          form.reset();
        }, 300);
        return;
      } catch (error: any) {
        toast({
          title: "Error",
          description: error.message || "No se pudo completar la transferencia",
          variant: "destructive",
        });
        return;
      }
    }
    
    // Submit-time date validation for pending types
    const isPendingSubmit = data.type === 'payable' || data.type === 'receivable';
    if (isPendingSubmit) {
      if (!data.imputationDate || data.imputationDate.trim() === '') {
        toast({ title: "Fecha requerida", description: "Seleccioná la fecha de vencimiento del compromiso", variant: "destructive" });
        return;
      }
      const dateError = validateImputationDate(data.imputationDate, data.type);
      if (dateError) {
        toast({ title: "Fecha inválida", description: dateError, variant: "destructive" });
        setStep('amount');
        return;
      }
    }

    // Check for negative balance warning (for expenses and payables)
    if (!forceSubmit && (data.type === 'expense' || data.type === 'payable')) {
      const negativeInfo = checkNegativeBalance();
      if (negativeInfo) {
        setNegativeBalanceInfo(negativeInfo);
        setShowNegativeBalanceWarning(true);
        return;
      }
    }
    
    try {
      // Determine final asset type (use override if set, otherwise AI classification)
      const finalAssetType = classificationOverride || classification?.assetType || 
        (data.type === 'income' || data.type === 'receivable' ? 'income' : 'expense');
      
      // Mandamos siempre `YYYY-MM-DD` (el server lo fija al mediodía con
      // parseLocalDate, evitando el corrimiento de día por UTC). Para
      // movimientos inmediatos usamos el día de hoy en hora argentina; para
      // pendientes, la fecha de vencimiento elegida por el usuario. Ver #376.
      const txDate = isPending ? data.imputationDate : getArgentinaToday();

      // Si el usuario tipeó un concepto nuevo ("Usar 'X'") hay que persistirlo
      // en `transactionCategories` antes de mandar el movimiento; el server
      // valida contra el catálogo y rechaza con 400 si no existe (task #337).
      let canonicalCategory: string | null;
      try {
        canonicalCategory = await ensureCategoryExists(
          data.category,
          data.type,
          transactionCategories,
          queryClient,
        );
      } catch (catErr: any) {
        toast({
          title: 'No se pudo crear el concepto',
          description: catErr?.message || 'Intentá de nuevo en unos segundos.',
          variant: 'destructive',
        });
        return;
      }
      const matchedCategory = canonicalCategory
        ? transactionCategories.find(cat => cat.name === canonicalCategory && cat.type === 'expense')
        : undefined;
      const txExpenseSubtype = (data.type === 'expense' || data.type === 'payable') 
        ? (matchedCategory?.expenseSubtype || 'expense') 
        : null;

      // Cuando el alta pasa por el paso de emisión ARCA, la metadata fiscal del
      // movimiento (neto/IVA/alícuota) debe reflejar la SUMA de todos los ítems
      // cargados, no el campo de un único renglón del formulario.
      const willEmitWithArca =
        emitWithArca &&
        data.hasInvoice &&
        ((data.type === 'income' || data.type === 'receivable') ||
          ((data.type === 'expense' || data.type === 'payable') && !!data.supplierId));
      const emitMetaNet = willEmitWithArca ? emitTotals.net : 0;
      const emitMetaIva = willEmitWithArca ? emitTotals.iva : 0;
      const emitMetaAliquot = willEmitWithArca && emitMetaNet > 0
        ? +((emitMetaIva / emitMetaNet) * 100).toFixed(2)
        : 0;

      // Task #475: combinar el renglón principal (legacy) con los adicionales.
      // 0/1 producto → payload legacy (productId/productQuantity); 2+ → items[]
      // y campos legacy en null.
      const hasPrimaryProduct = !!data.productId && data.productId !== '__none__';
      const validExtras = extraItems.filter(
        (it) => it.productId && (parseFloat(it.quantity) || 0) > 0,
      );
      const useItems = hasPrimaryProduct && validExtras.length > 0;
      const combinedItems = useItems
        ? [
            {
              productId: data.productId,
              quantity: parseFloat(data.productQuantity || '0'),
              unitPrice: productUnitPrice,
              profitabilityCodeId: data.profitabilityCodeId || null,
            },
            ...validExtras.map((it) => ({
              productId: it.productId,
              quantity: parseFloat(it.quantity),
              unitPrice: it.unitPrice,
              profitabilityCodeId: it.profitabilityCodeId || null,
            })),
          ]
        : undefined;

      const createdTransaction = await createTransactionMutation.mutateAsync({
        type: data.type,
        amount: data.amount,
        description: data.description,
        category: canonicalCategory ?? data.category,
        imputationDate: data.imputationDate,
        date: txDate,
        accountId: data.accountId || null,
        currency: selectedCurrency || undefined,
        organizationId: organization?.id,
        hasInvoice: data.hasInvoice,
        invoiceType: data.hasInvoice ? data.invoiceType : null,
        invoiceNumber: data.hasInvoice ? data.invoiceNumber : null,
        invoiceTaxId: null,
        invoiceFileUrl: data.hasInvoice ? invoiceFileUrl : null,
        invoiceNetAmount: willEmitWithArca
          ? (emitMetaNet > 0 ? emitMetaNet.toFixed(2) : null)
          : (data.hasInvoice && data.invoiceNetAmount ? data.invoiceNetAmount : null),
        invoiceIvaAmount: willEmitWithArca
          ? (emitMetaNet > 0 ? emitMetaIva.toFixed(2) : null)
          : (data.hasInvoice
              ? (data.invoiceIvaAmount
                  ? data.invoiceIvaAmount
                  : (data.invoiceNetAmount && data.invoiceIvaAliquot
                      ? (parseFloat(data.invoiceNetAmount) * parseFloat(data.invoiceIvaAliquot) / 100).toFixed(2)
                      : null))
              : null),
        invoiceIvaAliquot: willEmitWithArca
          ? (emitMetaNet > 0 ? String(emitMetaAliquot) : null)
          : (data.hasInvoice && data.invoiceIvaAliquot ? data.invoiceIvaAliquot : null),
        invoiceOtherTaxes: data.hasInvoice && data.invoiceOtherTaxes ? data.invoiceOtherTaxes : null,
        status: isPending ? 'scheduled' : 'completed',
        allowOverdraft,
        clientId: data.clientId || null,
        projectId: data.projectId || null,
        supplierId: data.supplierId || null,
        productId: useItems ? null : (data.productId || null),
        productQuantity: useItems ? null : (data.productQuantity ? parseFloat(data.productQuantity) : null),
        profitabilityCodeId: useItems ? null : (data.profitabilityCodeId || null),
        items: combinedItems,
        paymentMethodId: data.paymentMethodId || null,
        assetType: finalAssetType,
        aiClassificationConfidence: classification?.confidence ? String(classification.confidence) : null,
        linkedTransactionId: data.linkedTransactionId || null,
        isRecurring: data.isRecurring || false,
        recurrenceFrequency: data.isRecurring ? data.recurrenceFrequency : null,
        // Task #353: closed-series counter. Empty = serie infinita (legacy).
        // Si el usuario indicó N cuotas, esta primera vence en la cuota 1.
        recurrenceTotalInstallments:
          data.isRecurring && data.recurrenceTotalInstallments
            ? data.recurrenceTotalInstallments
            : null,
        recurrenceCurrentInstallment:
          data.isRecurring && data.recurrenceTotalInstallments ? 1 : null,
        isUniquePayment: isPending ? !(data.isRecurring || false) : false,
        expenseSubtype: txExpenseSubtype,
      });

      if (createdTransaction?.undoKey) {
        pushGlobalUndoAction({
          undoKey: createdTransaction.undoKey,
          entityType: 'transaction_created',
          entityName: data.description || data.category,
          expiresAt: Date.now() + 60000,
        });
      }

      const isScheduledTransaction = data.type === 'payable' || data.type === 'receivable';

      const shouldEmitAfterSave =
        emitWithArca &&
        data.hasInvoice &&
        ((data.type === 'income' || data.type === 'receivable') ||
          ((data.type === 'expense' || data.type === 'payable') && !!data.supplierId)) &&
        createdTransaction?.id;

      // When the emit flow runs we'll fire a single consolidated toast below;
      // skip the generic "Movimiento Guardado" toast in that case.
      if (!shouldEmitAfterSave) {
        toast({
          title: "Movimiento Guardado",
          description: isScheduledTransaction
            ? "El compromiso fue registrado. Podés verlo en Oficina."
            : "La operación se ha registrado correctamente.",
        });
      }

      // When the user went through the dedicated 'emit' step we run
      // emission + (optional) email send inline and report the full
      // outcome with a single consolidated toast.
      if (shouldEmitAfterSave) {
        setEmitSubmitting(true);
        // Replace the generic "Movimiento Guardado" toast with a richer one
        // built from the actual emit/send results below.
        try {
          const isSupplierEmit = data.type === 'expense' || data.type === 'payable';
          const emitterIvaCondition: string | undefined = invoicingAccount?.account?.ivaCondition;
          const noteLetter: 'A' | 'B' | 'C' =
            emitterIvaCondition !== 'responsable_inscripto'
              ? 'C'
              : emitReceiverIva === 'responsable_inscripto'
                ? 'A'
                : 'B';
          // In production, NDs to suppliers are not supported by the provider
          // (backend returns 501). Force credit so we never build an ND payload
          // even if the kind state lagged behind an env change.
          const isProductionEnv = invoicingAccount?.account?.environment === 'production';
          const safeSupplierKind = isProductionEnv ? 'credit' : emitSupplierNoteKind;
          const supplierDocType: 'NCA' | 'NCB' | 'NCC' | 'NDA' | 'NDB' | 'NDC' =
            safeSupplierKind === 'debit'
              ? (`ND${noteLetter}` as 'NDA' | 'NDB' | 'NDC')
              : (`NC${noteLetter}` as 'NCA' | 'NCB' | 'NCC');
          type EmitBody = {
            docType?: 'NCA' | 'NCB' | 'NCC' | 'NDA' | 'NDB' | 'NDC';
            receiver: {
              name: string;
              taxId: string | null;
              ivaCondition: typeof emitReceiverIva;
              address: string | null;
              phone: string | null;
              email: string | null;
            };
            items: Array<{
              description: string;
              quantity: number;
              unitPriceNet: number;
              ivaAliquot: number;
            }>;
            observations: string | null;
            itemType?: 'product' | 'service' | 'product_and_service';
            serviceFrom?: string;
            serviceTo?: string;
            paymentDueDate?: string;
          };
          const emitBody: EmitBody = {
            ...(isSupplierEmit ? { docType: supplierDocType } : {}),
            receiver: {
              name: emitReceiverName.trim(),
              taxId: emitReceiverTaxId.trim() || null,
              ivaCondition: emitReceiverIva,
              address: emitReceiverAddress.trim() || null,
              phone: emitReceiverPhone.trim() || null,
              email: emitReceiverEmail.trim() || null,
            },
            items: emitItems.map((it) => ({
              description: it.description.trim() || data.description || 'Servicio',
              quantity: Number(it.quantity) || 1,
              unitPriceNet: Number(it.unitNet) || 0,
              ivaAliquot: it.aliquot,
            })),
            observations: emitObservations.trim() || null,
            itemType: emitItemType,
            ...(emitIncludesService
              ? { serviceFrom: emitServiceFrom, serviceTo: emitServiceTo, paymentDueDate: emitPaymentDueDate }
              : {}),
          };

          const emitResp: any = await fetchWithAuth(
            `/invoicing/transactions/${createdTransaction.id}/emit`,
            { method: 'POST', body: JSON.stringify(emitBody) }
          );

          const emittedLabel =
            `${emitResp?.invoice?.docType || ''} ${emitResp?.invoice?.voucherNumber || ''}`.trim() ||
            'Comprobante emitido';

          let emailSummary = '';
          let emailFailed: string[] = [];
          if (emitSendEmail && emitReceiverEmail.trim()) {
            try {
              const ccList = [...emitCcList];
              const bccList: string[] = [];
              if (emitSendSelfCopy && currentUser?.email) bccList.push(currentUser.email);
              const sendResp: any = await fetchWithAuth(
                `/invoicing/transactions/${createdTransaction.id}/send-pdf`,
                {
                  method: 'POST',
                  body: JSON.stringify({
                    to: emitReceiverEmail.trim(),
                    cc: ccList,
                    bcc: bccList,
                    message: emitObservations.trim() || null,
                  }),
                }
              );
              const sent: string[] = sendResp?.sent || [];
              emailFailed = sendResp?.failed || [];
              if (sent.length > 0) {
                emailSummary = ` · Enviado a ${sent.join(', ')}`;
              }
            } catch (mailErr: any) {
              emailFailed = [emitReceiverEmail.trim()];
            }
          }

          const emittedDocType: string = emitResp?.invoice?.docType || '';
          const isNoteEmission = emittedDocType.startsWith('NC') || emittedDocType.startsWith('ND');
          const emissionLabel = isNoteEmission
            ? `${emittedDocType.startsWith('ND') ? 'Nota de Débito' : 'Nota de Crédito'} emitida correctamente`
            : 'Factura emitida correctamente';
          toast({
            title: `Movimiento guardado · ${emittedLabel}`,
            description:
              `${emissionLabel}${emailSummary}.` +
              (emailFailed.length > 0
                ? ` No se pudo enviar el email a ${emailFailed.join(', ')} — podés reintentarlo desde Oficina → Facturas.`
                : ''),
            variant: emailFailed.length > 0 ? 'default' : 'default',
          });

          queryClient.invalidateQueries({ queryKey: ['transactions'] });
          queryClient.invalidateQueries({ queryKey: ['invoicing', 'invoices'] });

          // Persist email-sending preferences for next emission.
          // Two layers: (1) per-client overrides (CC list, self-copy) so the
          // next invoice for the same client is pre-filled with their CCs;
          // (2) user+org defaults (lastEmit*) used as fallback when a client
          // has no override yet. Both are best-effort.
          try {
            if (organization?.id) {
              await fetchWithAuth('/dashboard-preferences', {
                method: 'PUT',
                body: JSON.stringify({
                  organizationId: organization.id,
                  lastEmitSendEmail: emitSendEmail,
                  lastEmitSendSelfCopy: emitSendSelfCopy,
                  lastEmitCcList: emitCcList,
                }),
              });
              queryClient.invalidateQueries({ queryKey: ['/dashboard-preferences', organization.id] });
            }
          } catch {
            // Non-blocking: preference persistence is best-effort.
          }
          try {
            // Persist back to whichever counterparty drove this emission.
            // For income/receivable comprobantes the target is the client;
            // for supplier-directed ones it's the supplier. We compare the
            // current CC list / self-copy against the snapshot loaded when
            // entering the emit step and PUT only when something changed.
            const loadedClientId = emitLoadedPrefs?.kind === 'client' ? emitLoadedPrefs.clientId : undefined;
            const loadedSupplierId = emitLoadedPrefs?.kind === 'supplier' ? emitLoadedPrefs.supplierId : undefined;
            const targetClientId = data.clientId || loadedClientId;
            const targetSupplierId = !targetClientId ? (data.supplierId || loadedSupplierId) : undefined;
            const target = targetClientId
              ? { url: `/clients/${targetClientId}/invoice-email-prefs`, matches: emitLoadedPrefs?.kind === 'client' && emitLoadedPrefs.clientId === targetClientId }
              : targetSupplierId
                ? { url: `/suppliers/${targetSupplierId}/invoice-email-prefs`, matches: emitLoadedPrefs?.kind === 'supplier' && emitLoadedPrefs.supplierId === targetSupplierId }
                : null;
            if (target) {
              const loaded = target.matches && emitLoadedPrefs
                ? { defaultCcEmails: emitLoadedPrefs.defaultCcEmails, sendCopyToSelf: emitLoadedPrefs.sendCopyToSelf }
                : { defaultCcEmails: [] as string[], sendCopyToSelf: false };
              const sortedA = [...(loaded.defaultCcEmails || [])].map(s => s.trim().toLowerCase()).sort();
              const sortedB = [...emitCcList].map(s => s.trim().toLowerCase()).sort();
              const ccChanged = sortedA.length !== sortedB.length || sortedA.some((v, i) => v !== sortedB[i]);
              const selfChanged = !!loaded.sendCopyToSelf !== !!emitSendSelfCopy;
              if (ccChanged || selfChanged) {
                await fetchWithAuth(target.url, {
                  method: 'PUT',
                  body: JSON.stringify({
                    defaultCcEmails: emitCcList,
                    sendCopyToSelf: emitSendSelfCopy,
                  }),
                });
              }
            }
          } catch (prefsErr) {
            // Non-blocking — preferences are a nice-to-have.
          }
        } catch (emitErr: any) {
          const raw =
            emitErr?.body?.message ||
            emitErr?.message ||
            'El movimiento quedó guardado. Podés reintentar la emisión desde el detalle.';
          // ARCA rechaza facturas de monotributo cuyo precio unitario por ítem
          // supera su tope, devolviendo un mensaje técnico que incluye el valor
          // del tope (ej. "... supera el máximo permitido ... (613492)"). Mostramos
          // una explicación clara con el tope real que reportó ARCA y qué hacer.
          const capMatch = /m[aá]ximo permitido[^()]*\((\d+)\)/i.exec(String(raw));
          const description = capMatch
            ? `El movimiento quedó guardado, pero ARCA rechazó la factura: para monotributo, el precio unitario de cada ítem no puede superar $${Number(capMatch[1]).toLocaleString('es-AR')}. Dividí el monto en varios ítems (o subí la cantidad) para que cada precio unitario quede por debajo de ese tope, y reintentá la emisión desde el detalle.`
            : raw;
          toast({
            title: 'Movimiento guardado, pero no se pudo emitir la factura',
            description,
            variant: 'destructive',
          });
        } finally {
          setEmitSubmitting(false);
        }
      }

      if (createdTransaction) {
        try { onCreated?.(createdTransaction); } catch { /* non-blocking */ }
      }

      setOpen(false);
      setTimeout(() => {
        setStep('type');
        setSelectedCurrency(null);
        setInvoiceFile(null);
        setInvoiceFileUrl(null);
        setClassification(null);
        setClassificationOverride(null);
        setAmountDisplay('');
        setShowMoreDetails(false);
        setIsCurrencyExchange(false);
        setCustomExchangeRate('');
        setEmitWithArca(false);
        setExtraItems([]);
        form.reset();
      }, 300);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo guardar el movimiento",
        variant: "destructive",
      });
    }
  };

  const handleConfirmNegativeBalance = async () => {
    setShowNegativeBalanceWarning(false);
    setNegativeBalanceInfo(null);
    await onSubmit(true, true); // forceSubmit=true, allowOverdraft=true
  };

  // Helper to detect White Invoice + Black Account mismatch
  const hasComplianceWarning = () => {
    if (!values.hasInvoice || !values.accountId) return false;
    const account = accounts.find((a: any) => a.id === values.accountId);
    // Logic: If Invoice is present, but Account is "Caja B" (Cash B) or similar "Black" account
    // For demo, let's assume "Caja B" is the black one.
    return account?.name.includes('Caja B');
  };

  return (
    <>
    <Dialog open={open} onOpenChange={handleCloseAttempt}>
      {!isOpenControlled && (
        <DialogTrigger asChild>
          {children || (
            <Button className="aikestar-gradient hover:opacity-90 text-white shadow-lg teal-glow h-10 sm:h-12 px-3 sm:px-6 text-sm sm:text-lg rounded-full font-semibold transition-all duration-200">
              <Plus className="h-4 w-4 sm:h-5 sm:w-5 sm:mr-2" />
              <span className="hidden sm:inline">CARGAR MOVIMIENTO</span>
              <span className="sm:hidden">Cargar</span>
            </Button>
          )}
        </DialogTrigger>
      )}
      <DialogContent 
          className={cn(
            "p-0 gap-0 overflow-hidden border-none shadow-2xl flex flex-col transition-all duration-200",
            isMaximized
              ? "w-[95vw] h-[95vh] max-w-[95vw] max-h-[95vh]"
              // En pantallas chicas (<sm) ocupamos casi todo el viewport con
              // un pequeño margen lateral; a partir de sm crecemos hasta 700px
              // y limitamos la altura para que el contenido pueda scrollear.
              : "w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] sm:w-full sm:max-w-[700px] max-h-[90vh] sm:max-h-[85vh]"
          )}
          onOpenAutoFocus={(e) => e.preventDefault()}
          aria-describedby={undefined}
        >
        <DialogTitle className="sr-only">Asistente de movimientos</DialogTitle>
        <div className="bg-sidebar p-6 text-sidebar-foreground shrink-0">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold font-display tracking-tight flex items-center gap-2">
              {step === 'type' && "Seleccioná el tipo de operación"}
              {step === 'account' && (isPending ? "¿En qué moneda será?" : "¿Dónde impacta el dinero?")}
              {step === 'transfer' && "Transferencia entre cuentas"}
              {step === 'amount' && "¿Cuánto?"}
              {step === 'emit' && "Datos para la factura"}
              {step === 'confirm' && "Confirmar operación"}
              {/* Show transaction type badge on all steps after 'type' */}
              {step !== 'type' && step !== 'transfer' && values.type && values.type !== 'transfer' && (
                <Badge 
                  variant="outline" 
                  className={cn(
                    "ml-2 text-xs font-medium",
                    values.type === 'income' && "bg-green-100 text-green-700 border-green-300",
                    values.type === 'expense' && "bg-red-100 text-red-700 border-red-300",
                    values.type === 'receivable' && "bg-blue-100 text-blue-700 border-blue-300",
                    values.type === 'payable' && "bg-orange-100 text-orange-700 border-orange-300"
                  )}
                >
                  {values.type === 'income' ? 'Ingreso' : 
                   values.type === 'expense' ? 'Egreso' : 
                   values.type === 'receivable' ? 'A Cobrar' : 
                   'A Pagar'}
                </Badge>
              )}
              {(step === 'transfer' || (step === 'confirm' && values.type === 'transfer')) && (
                <Badge 
                  variant="outline" 
                  className="ml-2 text-xs font-medium bg-purple-100 text-purple-700 border-purple-300"
                >
                  Transferencia
                </Badge>
              )}
            </h2>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setIsMaximized(!isMaximized)}
                className="rounded-full p-1.5 hover:bg-sidebar-accent transition-colors"
                data-testid="button-maximize-wizard"
                title={isMaximized ? "Minimizar" : "Maximizar"}
              >
                {isMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => handleCloseAttempt(false)}
                className="rounded-full p-1.5 hover:bg-sidebar-accent transition-colors"
                data-testid="button-close-wizard"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
          {(() => {
            const goesThroughEmit =
              emitWithArca &&
              values.hasInvoice &&
              ((values.type === 'income' || values.type === 'receivable') ||
                ((values.type === 'expense' || values.type === 'payable') && !!values.supplierId));
            const stepsList = goesThroughEmit
              ? ['type', 'account', 'amount', 'emit', 'confirm']
              : ['type', 'account', 'amount', 'confirm'];
            return (
              <div className="flex gap-2 mt-4">
                {stepsList.map((s, i) => (
                  <div
                    key={s}
                    className={cn(
                      "h-1 flex-1 rounded-full transition-all duration-500",
                      stepsList.indexOf(step) >= i
                        ? "bg-primary"
                        : "bg-sidebar-accent"
                    )}
                  />
                ))}
              </div>
            );
          })()}
        </div>

        <div className="p-6 bg-background min-h-[300px] flex-1 overflow-y-auto">
          {!canCreateTransactions ? (
            <div className="flex flex-col items-center justify-center h-full py-12 text-center">
              <div className="w-20 h-20 rounded-full bg-gradient-to-br from-amber-100 to-orange-100 flex items-center justify-center mb-6">
                <ShieldAlert className="h-10 w-10 text-amber-600" />
              </div>
              <h3 className="text-xl font-bold text-gray-800 dark:text-slate-100 mb-3">Acceso restringido</h3>
              <p className="text-muted-foreground max-w-sm mb-6">
                Tu rol actual (<span className="font-medium text-amber-600">{userRole === 'viewer' ? 'Veedor' : userRole}</span>) no tiene permiso para crear movimientos.
              </p>
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-6 py-4 max-w-sm">
                <p className="text-sm text-amber-800">
                  <strong>¿Necesitás crear movimientos?</strong><br />
                  Contactá al administrador de la cuenta para que te asigne un rol con más permisos.
                </p>
              </div>
              <Button 
                variant="outline" 
                className="mt-6"
                onClick={() => setOpen(false)}
              >
                Entendido
              </Button>
            </div>
          ) : (
          <Form {...form}>
            {step === 'type' && (
              <div className="space-y-4 h-full">
                <div className="grid grid-cols-2 gap-4">
                 {[
                   { id: 'income', label: 'Ingreso', icon: ArrowDownLeft, color: 'text-green-600', bg: 'bg-green-50 hover:bg-green-100', desc: 'Dinero que ya cobraste y suma a tu caja.' },
                   { id: 'expense', label: 'Egreso', icon: ArrowUpRight, color: 'text-red-600', bg: 'bg-red-50 hover:bg-red-100', desc: 'Dinero que ya pagaste y resta de tu caja.' },
                   { id: 'receivable', label: 'A Cobrar', icon: CalendarClock, color: 'text-blue-600', bg: 'bg-blue-50 hover:bg-blue-100', desc: 'Compromiso de un cliente de pagarte a futuro.' },
                   { id: 'payable', label: 'A Pagar', icon: Clock, color: 'text-orange-600', bg: 'bg-orange-50 hover:bg-orange-100', desc: 'Compromiso de pago tuyo a futuro.' },
                 ].map((opt) => (
                   <TooltipProvider key={opt.id} delayDuration={500}>
                     <Tooltip>
                       <TooltipTrigger asChild>
                         <button
                           type="button"
                           onClick={() => {
                             form.setValue('type', opt.id as any);
                             // Clear date for pending types, will be set in handleNext for completed types
                             if (opt.id === 'payable' || opt.id === 'receivable') {
                               form.setValue('imputationDate', '');
                             }
                             // ARCA solo aplica a income/receivable: reseteamos el toggle
                             // si el usuario cambia a un tipo no elegible para evitar que
                             // los campos manuales queden ocultos por error.
                             if (opt.id !== 'income' && opt.id !== 'receivable') {
                               setEmitWithArca(false);
                             }
                             handleNext();
                           }}
                           className={cn(
                             "flex flex-col items-center justify-center p-6 rounded-xl border-2 border-transparent transition-all duration-200 gap-3",
                             opt.bg,
                             values.type === opt.id ? "border-primary ring-2 ring-primary/20" : "border-transparent"
                           )}
                         >
                           <div className={cn("p-3 rounded-full bg-white dark:bg-card shadow-sm", opt.color)}>
                             <opt.icon className="h-8 w-8" />
                           </div>
                           <span className={cn("font-bold text-lg", opt.color)}>{opt.label}</span>
                         </button>
                       </TooltipTrigger>
                       <TooltipContent side="bottom" className="max-w-[200px] text-center">
                         <p>{opt.desc}</p>
                       </TooltipContent>
                     </Tooltip>
                   </TooltipProvider>
                 ))}
                </div>
                
                {/* Transfer button - full width below the 2x2 grid */}
                <TooltipProvider delayDuration={500}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => {
                          form.setValue('type', 'transfer' as any);
                          handleNext();
                        }}
                        className={cn(
                          "w-full flex items-center justify-center p-4 rounded-xl border-2 border-transparent transition-all duration-200 gap-3",
                          "bg-purple-50 hover:bg-purple-100",
                          values.type === 'transfer' ? "border-primary ring-2 ring-primary/20" : "border-transparent"
                        )}
                      >
                        <div className="p-3 rounded-full bg-white dark:bg-card shadow-sm text-purple-600">
                          <ArrowLeftRight className="h-6 w-6" />
                        </div>
                        <span className="font-bold text-lg text-purple-600">Transferencia entre cuentas</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[250px] text-center">
                      <p>Mover dinero de una cuenta a otra sin afectar tu balance total.</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            )}

            {step === 'amount' && (() => {
              const selectedAccount = accounts.find((a: any) => a.id === values.accountId);
              const currency = selectedAccount?.currency 
                ? (selectedAccount.currency as Currency) 
                : (selectedCurrency || 'ARS') as Currency;
              const currencySymbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || 'AR$';
              const currencyLabel = currency === 'USD' || currency === 'USD_CASH' ? 'USD' : currency === 'EUR' ? 'EUR' : 'ARS';
              const isBankingAccount = selectedAccount?.type === 'bank';

              // Bloque "Con Factura / Sin Factura" + toggle ARCA. Lo definimos
              // una sola vez y lo usamos en dos lados: para ingresos va arriba
              // (encima de "Agregar más detalles", abajo de la sección de
              // recurrencia); para el resto de los tipos queda dentro del
              // colapsable, como estaba históricamente.
              const invoiceChoiceBlock = (
                <div className="border-t border-border pt-4 space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div
                      onClick={() => form.setValue('hasInvoice', true)}
                      className={cn(
                        "cursor-pointer p-3 rounded-lg border-2 flex items-center justify-center gap-2 transition-all text-sm",
                        values.hasInvoice
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:bg-secondary/50"
                      )}
                      data-testid="button-has-invoice-yes"
                    >
                      <Receipt className={cn("h-4 w-4", values.hasInvoice ? "text-primary" : "text-muted-foreground")} />
                      <span className="font-medium">Con Factura</span>
                    </div>
                    <div
                      onClick={() => {
                        form.setValue('hasInvoice', false);
                        setEmitWithArca(false);
                        // Resetear el ref deja que cada Sin Factura → Con
                        // Factura siguiente aplique el default ON automático
                        // para ingresos.
                        userToggledArcaRef.current = false;
                      }}
                      className={cn(
                        "cursor-pointer p-3 rounded-lg border-2 flex items-center justify-center gap-2 transition-all text-sm",
                        !values.hasInvoice
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:bg-secondary/50"
                      )}
                      data-testid="button-has-invoice-no"
                    >
                      <span className="font-medium">Sin Factura</span>
                    </div>
                  </div>

                  {isBankingAccount && !values.hasInvoice && (
                    <p className="text-xs text-amber-600 flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                      Las operaciones bancarias suelen requerir comprobante fiscal
                    </p>
                  )}

                  {values.type === 'income' && !values.hasInvoice && (
                    <p className="text-xs text-amber-600 flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                      Los ingresos sin factura pueden limitar tus deducciones fiscales
                    </p>
                  )}

                  {FEATURE_FLAGS.INVOICING_ENABLED && !isPersonalContext && values.hasInvoice &&
                    ((values.type === 'income' || values.type === 'receivable') ||
                      ((values.type === 'expense' || values.type === 'payable') && !!values.supplierId)) && (
                    <div className="p-3 rounded-lg border border-pink-200 bg-gradient-to-r from-pink-50 to-cyan-50 animate-in fade-in">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-pink-700 flex items-center gap-1">
                            <Zap className="h-3.5 w-3.5" /> Emitir comprobante electrónico (ARCA)
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {emitWithArca
                              ? 'Después de guardar se abrirá el emisor con los datos prellenados.'
                              : 'Ya generás el comprobante al guardar el movimiento.'}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            // Marcar que el usuario lo tocó a mano para que el
                            // efecto auto-ON ya no lo vuelva a prender.
                            userToggledArcaRef.current = true;
                            setEmitWithArca((v) => {
                              const next = !v;
                              // Cuando se activa ARCA, los devuelve el proveedor: limpiamos
                              // los campos manuales para no enviar datos basura al backend.
                              if (next) {
                                form.setValue('invoiceType', '');
                                form.setValue('invoiceNumber', '');
                              }
                              return next;
                            });
                          }}
                          className={cn(
                            'shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                            emitWithArca ? 'bg-pink-500' : 'bg-gray-300'
                          )}
                          data-testid="toggle-emit-with-arca"
                          aria-pressed={emitWithArca}
                        >
                          <span
                            className={cn(
                              'inline-block h-4 w-4 transform rounded-full bg-white dark:bg-card transition-transform',
                              emitWithArca ? 'translate-x-6' : 'translate-x-1'
                            )}
                          />
                        </button>
                      </div>
                      {emitWithArca && (
                        <p className="text-[11px] text-muted-foreground mt-2 italic">
                          No hace falta completar Tipo y Número: los devuelve ARCA al emitir.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );

              return (
              <div className="space-y-5 animate-in slide-in-from-right-4 fade-in duration-300">
                <FormField
                  control={form.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel className="text-sm text-muted-foreground">Monto Total ({currencyLabel})</FormLabel>
                        {selectedAccount ? (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Wallet className="h-3 w-3" /> {selectedAccount.name}
                            <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">{currencyLabel}</Badge>
                          </span>
                        ) : isPending && selectedCurrency && (
                          <span className="text-xs text-orange-600 flex items-center gap-1">
                            <Clock className="h-3 w-3" /> Sin cuenta
                            <Badge variant="outline" className="text-[10px] px-1 py-0 ml-1 border-orange-300 text-orange-600">{currencyLabel}</Badge>
                          </span>
                        )}
                      </div>
                      <FormControl>
                        <div className="flex items-center gap-3 py-2">
                          <span className="text-3xl font-bold text-primary min-w-[60px]">{currencySymbol}</span>
                          <Input 
                            type="text"
                            inputMode="decimal"
                            className="h-16 text-4xl font-bold font-display flex-1 border-2 border-primary/30 focus:border-primary" 
                            placeholder="0,00" 
                            autoFocus
                            value={amountDisplay}
                            onChange={(e) => {
                              const { displayValue, internalValue } = formatAmountLive(e.target.value, field.value);
                              setAmountDisplay(displayValue);
                              field.onChange(internalValue);
                            }}
                            onWheel={(e) => e.currentTarget.blur()}
                            data-testid="input-amount"
                          />
                        </div>
                      </FormControl>
                      <p className="text-xs text-muted-foreground">Usá coma para centavos (ej: 1234,50)</p>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="category"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Concepto</FormLabel>
                      <FormControl>
                        <CategoryPicker
                          value={field.value || ''}
                          onChange={field.onChange}
                          type={values.type as 'income' | 'expense' | 'payable' | 'receivable'}
                          categories={transactionCategories}
                          placeholder="Seleccioná un concepto..."
                          testId="select-category"
                          allowInlineCreate={canWriteTransactionCategory}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {!isPersonalContext && (() => {
                  const accountCurrency = selectedAccount?.currency || selectedCurrency || 'ARS';
                  const normalizedCurrency = accountCurrency === 'USD_CASH' ? 'USD' : accountCurrency;
                  const filteredProducts = products.filter((p: any) => {
                    if (!p.costCurrency) return true;
                    const normalizedProdCurrency = p.costCurrency === 'USD_CASH' ? 'USD' : p.costCurrency;
                    return normalizedProdCurrency === normalizedCurrency;
                  });
                  const hiddenCount = products.length - filteredProducts.length;

                  return (
                  <div className="space-y-3 p-3 bg-secondary/20 rounded-lg border border-border/50">
                    <FormField
                      control={form.control}
                      name="productId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs text-muted-foreground">Producto (opcional)</FormLabel>
                          <Select 
                            onValueChange={(val) => {
                              if (val === '__add_new__') {
                                setShowNewProductDialog(true);
                                return;
                              }
                              if (val === '__none__') {
                                field.onChange('');
                                setProductUnitPrice(0);
                                form.setValue('productQuantity', '');
                                form.setValue('amount', '');
                                setAmountDisplay('');
                                form.setValue('description', '');
                                form.setValue('category', '');
                                setExtraItems([]);
                              } else {
                                field.onChange(val);
                                handleProductSelect(val);
                              }
                            }} 
                            value={field.value || '__none__'}
                          >
                            <FormControl>
                              <SelectTrigger data-testid="select-product" className="h-9 text-sm">
                                <SelectValue placeholder="Seleccionar producto..." />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="__none__">Sin producto</SelectItem>
                              {filteredProducts.map((product: any) => (
                                <SelectItem key={product.id} value={product.id}>
                                  {product.name}{product.category ? ` - ${product.category}` : ''}
                                </SelectItem>
                              ))}
                              <SelectItem value="__add_new__" className="text-primary font-medium">
                                <span className="flex items-center gap-1"><Plus className="h-3 w-3" /> Agregar producto</span>
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          {hiddenCount > 0 && (
                            <p className="text-xs text-orange-500">{hiddenCount} producto{hiddenCount > 1 ? 's' : ''} en otra moneda no se muestra{hiddenCount > 1 ? 'n' : ''}</p>
                          )}
                        </FormItem>
                      )}
                    />

                    {values.productId && values.productId !== '__none__' && (() => {
                      const selectedProd = products.find((p: any) => p.id === values.productId);
                      const currentStock = selectedProd ? parseFloat(selectedProd.stock || '0') : 0;
                      const unitLabel = selectedProd?.unit || 'unidades';
                      const qty = parseFloat(values.productQuantity || '0');
                      return (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <FormField
                              control={form.control}
                              name="productQuantity"
                              render={({ field }) => (
                                <FormItem className="flex-1">
                                  <FormLabel className="text-xs text-muted-foreground">Cantidad</FormLabel>
                                  <FormControl>
                                    <Input
                                      type="number"
                                      min="0.01"
                                      step="0.01"
                                      placeholder="1"
                                      className="h-9 text-sm"
                                      {...field}
                                      onChange={(e) => {
                                        field.onChange(e.target.value);
                                        const newQty = parseFloat(e.target.value) || 0;
                                        updateAmountFromQuantity(newQty, productUnitPrice);
                                      }}
                                      data-testid="input-product-quantity"
                                    />
                                  </FormControl>
                                </FormItem>
                              )}
                            />
                            {currentStock > 0 && (
                              <div className="text-xs text-muted-foreground pt-5">
                                Stock: {currentStock} {unitLabel}
                              </div>
                            )}
                          </div>
                          {qty > 0 && productUnitPrice > 0 && (
                            <p className="text-xs text-muted-foreground">
                              {qty} × {currencySymbol} {productUnitPrice.toLocaleString('es-AR', { minimumFractionDigits: 2 })} = <span className="font-semibold text-foreground">{currencySymbol} {(qty * productUnitPrice).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                            </p>
                          )}
                        </div>
                      );
                    })()}

                    {/* Task #475: renglones de productos adicionales */}
                    {values.productId && values.productId !== '__none__' && extraItems.map((item, index) => {
                      const itemProduct = products.find((p: any) => p.id === item.productId);
                      const itemStock = itemProduct ? parseFloat(itemProduct.stock || '0') : 0;
                      const itemUnitLabel = itemProduct?.unit || 'unidades';
                      const itemQty = parseFloat(item.quantity || '0');
                      return (
                        <div key={item.id} className="space-y-2 pt-3 mt-1 border-t border-border/50" data-testid={`row-extra-item-${index}`}>
                          <div className="flex items-center justify-between">
                            <Label className="text-xs text-muted-foreground">Producto adicional {index + 2}</Label>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                              onClick={() => removeExtraItem(item.id)}
                              data-testid={`button-remove-extra-item-${index}`}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                          <Select
                            value={item.productId || undefined}
                            onValueChange={(val) => handleExtraProductSelect(item.id, val)}
                          >
                            <SelectTrigger data-testid={`select-extra-product-${index}`} className="h-9 text-sm">
                              <SelectValue placeholder="Seleccionar producto..." />
                            </SelectTrigger>
                            <SelectContent>
                              {filteredProducts.map((product: any) => (
                                <SelectItem key={product.id} value={product.id}>
                                  {product.name}{product.category ? ` - ${product.category}` : ''}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {item.productId && (
                            <>
                              <div className="flex items-center gap-2">
                                <div className="flex-1">
                                  <Label className="text-xs text-muted-foreground">Cantidad</Label>
                                  <Input
                                    type="number"
                                    min="0.01"
                                    step="0.01"
                                    placeholder="1"
                                    className="h-9 text-sm"
                                    value={item.quantity}
                                    onChange={(e) => updateExtraItem(item.id, { quantity: e.target.value })}
                                    data-testid={`input-extra-quantity-${index}`}
                                  />
                                </div>
                                {itemStock > 0 && (
                                  <div className="text-xs text-muted-foreground pt-5">
                                    Stock: {itemStock} {itemUnitLabel}
                                  </div>
                                )}
                              </div>
                              {profitabilityCodes.filter((c) => c.isActive).length > 0 && (
                                <div>
                                  <Label className="text-xs text-muted-foreground">Código de rentabilidad (opcional)</Label>
                                  <Select
                                    value={item.profitabilityCodeId || '__none__'}
                                    onValueChange={(val) => updateExtraItem(item.id, { profitabilityCodeId: val === '__none__' ? '' : val })}
                                  >
                                    <SelectTrigger data-testid={`select-extra-profitability-${index}`} className="h-9 text-sm">
                                      <SelectValue placeholder="Sin código" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="__none__">Sin código</SelectItem>
                                      {profitabilityCodes.filter((c) => c.isActive).map((c) => (
                                        <SelectItem key={c.id} value={c.id}>{c.code} - {c.name}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              )}
                              {itemQty > 0 && item.unitPrice > 0 && (
                                <p className="text-xs text-muted-foreground">
                                  {itemQty} × {currencySymbol} {item.unitPrice.toLocaleString('es-AR', { minimumFractionDigits: 2 })} = <span className="font-semibold text-foreground">{currencySymbol} {(itemQty * item.unitPrice).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                                </p>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}

                    {values.productId && values.productId !== '__none__' && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full h-8 text-xs"
                        onClick={addExtraItem}
                        data-testid="button-add-extra-product"
                      >
                        <Plus className="h-3 w-3 mr-1" /> Agregar otro producto
                      </Button>
                    )}
                  </div>
                  );
                })()}

                {isPending && (
                  <FormField
                    control={form.control}
                    name="imputationDate"
                    render={({ field }) => {
                      const dateError = validateImputationDate(field.value, values.type);
                      return (
                        <FormItem>
                          <FormLabel>Fecha de vencimiento <span className="text-red-500">*</span></FormLabel>
                          <Popover>
                            <PopoverTrigger asChild>
                              <FormControl>
                                <Button
                                  variant="outline"
                                  className={cn(
                                    "w-full pl-3 text-left font-normal justify-start",
                                    !field.value && "text-muted-foreground",
                                    dateError && "border-red-500 focus:ring-red-500"
                                  )}
                                >
                                  <CalendarIcon className="mr-2 h-4 w-4" />
                                  {field.value ? (
                                    format(parseISO(field.value), "d 'de' MMMM 'de' yyyy", { locale: es })
                                  ) : (
                                    <span>Seleccionar fecha...</span>
                                  )}
                                </Button>
                              </FormControl>
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-0" align="start">
                              <Calendar
                                mode="single"
                                selected={field.value ? parseISO(field.value) : undefined}
                                onSelect={(date) => {
                                  if (date) {
                                    field.onChange(format(date, 'yyyy-MM-dd'));
                                  }
                                }}
                                disabled={(date) => date < new Date(new Date().setHours(0,0,0,0))}
                                locale={es}
                                initialFocus
                              />
                            </PopoverContent>
                          </Popover>
                          {dateError ? (
                            <p className="text-xs text-red-500 flex items-center gap-1 mt-1">
                              <AlertCircle className="h-3 w-3" /> {dateError}
                            </p>
                          ) : (
                            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                              <HelpCircle className="h-3 w-3" /> Cuándo vence el compromiso
                            </p>
                          )}
                          <FormMessage />
                        </FormItem>
                      );
                    }}
                  />
                )}

                {showRecurrence && (
                  <div className="p-4 bg-secondary/30 rounded-lg border border-border space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <RefreshCw className="h-4 w-4 text-muted-foreground" />
                        <Label className="font-medium">¿Es recurrente?</Label>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant={values.isRecurring ? "default" : "outline"}
                          size="sm"
                          data-testid="button-recurrence-yes"
                          onClick={() => {
                            form.setValue('isRecurring', true);
                            form.setValue('recurrenceFrequency', 'monthly');
                          }}
                        >
                          Sí
                        </Button>
                        <Button
                          type="button"
                          variant={!values.isRecurring ? "default" : "outline"}
                          size="sm"
                          data-testid="button-recurrence-no"
                          onClick={() => {
                            form.setValue('isRecurring', false);
                            form.setValue('recurrenceFrequency', undefined);
                          }}
                        >
                          No
                        </Button>
                      </div>
                    </div>
                    
                    {values.isRecurring && (
                      <>
                        <FormField
                          control={form.control}
                          name="recurrenceFrequency"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Frecuencia</FormLabel>
                              <Select onValueChange={field.onChange} value={field.value || 'monthly'}>
                                <FormControl>
                                  <SelectTrigger>
                                    <SelectValue placeholder="Seleccionar frecuencia..." />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectItem value="weekly">Semanal</SelectItem>
                                  <SelectItem value="biweekly">Quincenal</SelectItem>
                                  <SelectItem value="monthly">Mensual</SelectItem>
                                  <SelectItem value="quarterly">Trimestral</SelectItem>
                                  <SelectItem value="yearly">Anual</SelectItem>
                                </SelectContent>
                              </Select>
                              <p className="text-xs text-muted-foreground">
                                Se generará automáticamente el siguiente movimiento según la frecuencia
                              </p>
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="recurrenceTotalInstallments"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Cantidad de cuotas (opcional)</FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  min={1}
                                  step={1}
                                  inputMode="numeric"
                                  placeholder="Sin límite"
                                  data-testid="input-recurrence-installments"
                                  value={
                                    field.value === null || field.value === undefined
                                      ? ''
                                      : String(field.value)
                                  }
                                  onChange={(e) => {
                                    const raw = e.target.value.trim();
                                    if (raw === '') {
                                      field.onChange(null);
                                      return;
                                    }
                                    const n = parseInt(raw, 10);
                                    if (Number.isFinite(n) && n >= 1) {
                                      field.onChange(n);
                                    } else {
                                      field.onChange(null);
                                    }
                                  }}
                                />
                              </FormControl>
                              <p className="text-xs text-muted-foreground">
                                Dejá vacío para que sea infinito. Si indicás un número, al confirmar la última cuota no se generará la próxima.
                              </p>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </>
                    )}
                  </div>
                )}

                {!isPersonalContext && (values.type === 'income' || values.type === 'receivable') && (
                      <FormField
                        control={form.control}
                        name="clientId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-muted-foreground">Cliente (opcional)</FormLabel>
                            <Select 
                              onValueChange={(val) => {
                                if (val === '__add_new__') {
                                  setShowNewClientDialog(true);
                                } else {
                                  field.onChange(val === '__none__' ? undefined : val);
                                  form.setValue('projectId', undefined);
                                }
                              }} 
                              value={field.value || '__none__'}
                            >
                              <FormControl>
                                <SelectTrigger data-testid="select-client">
                                  <SelectValue placeholder="Seleccionar cliente..." />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="__none__">Sin cliente</SelectItem>
                                {clients.map((client: any) => (
                                  <SelectItem key={client.id} value={client.id}>
                                    {client.name}
                                  </SelectItem>
                                ))}
                                <SelectItem value="__add_new__" className="text-primary font-medium">
                                  <span className="flex items-center gap-1"><Plus className="h-3 w-3" /> Agregar cliente</span>
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </FormItem>
                        )}
                      />
                    )}

                    {!isPersonalContext && values.clientId && (values.type === 'income' || values.type === 'receivable') && (
                      <FormField
                        control={form.control}
                        name="projectId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-muted-foreground">Proyecto (opcional)</FormLabel>
                            {clientProjectsList.length > 0 ? (
                              <Select
                                onValueChange={(val) => field.onChange(val === '__none__' ? undefined : val)}
                                value={field.value || '__none__'}
                              >
                                <FormControl>
                                  <SelectTrigger data-testid="select-project">
                                    <SelectValue placeholder="Sin proyecto" />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectItem value="__none__">Sin proyecto (general)</SelectItem>
                                  {clientProjectsList.map((p: any) => (
                                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : (
                              <p className="text-xs text-muted-foreground italic py-1" data-testid="text-no-client-projects">
                                Este cliente no tiene proyectos. Podés crearlos desde Clientes.
                              </p>
                            )}
                          </FormItem>
                        )}
                      />
                    )}

                    {values.type !== 'transfer' && (
                      <FormField
                        control={form.control}
                        name="profitabilityCodeId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-muted-foreground">Código de rentabilidad (opcional)</FormLabel>
                            <Select
                              onValueChange={(val) => field.onChange(val === '__none__' ? undefined : val)}
                              value={field.value || '__none__'}
                            >
                              <FormControl>
                                <SelectTrigger data-testid="select-profitability-code">
                                  <SelectValue placeholder="Sin código" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="__none__">Sin código</SelectItem>
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
                          </FormItem>
                        )}
                      />
                    )}

                    {(values.type === 'income' || values.type === 'receivable') && (
                      <FormField
                        control={form.control}
                        name="paymentMethodId"
                        render={({ field }) => {
                          const selected = paymentMethods.find((m) => m.id === field.value);
                          const grossAmount = parseFloat(values.amount || '0');
                          const breakdown = selected && Number.isFinite(grossAmount) && grossAmount > 0
                            ? selected.concepts.map((c) => {
                                const v = parseFloat(c.value);
                                const cost = c.kind === 'percentage' ? (grossAmount * v) / 100 : v;
                                return { name: c.name, cost: Math.round(cost * 100) / 100 };
                              })
                            : [];
                          const totalCost = breakdown.reduce((acc, b) => acc + b.cost, 0);
                          const net = grossAmount - totalCost;
                          return (
                            <FormItem>
                              <FormLabel className="text-muted-foreground">Medio de cobro (opcional)</FormLabel>
                              <Select
                                onValueChange={(val) => {
                                  if (val === '__add_new__') {
                                    setShowNewPaymentMethodDialog(true);
                                  } else {
                                    field.onChange(val === '__none__' ? undefined : val);
                                  }
                                }}
                                value={field.value || '__none__'}
                              >
                                <FormControl>
                                  <SelectTrigger data-testid="select-payment-method">
                                    <SelectValue placeholder="Sin medio (no genera costos)" />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectItem value="__none__">Sin medio</SelectItem>
                                  {paymentMethods.filter((m) => m.isActive).map((m) => (
                                    <SelectItem key={m.id} value={m.id}>
                                      <span className="flex items-center gap-2">
                                        <span>{m.name}</span>
                                        <span className="text-xs text-muted-foreground">({m.concepts.length} concepto{m.concepts.length === 1 ? '' : 's'})</span>
                                      </span>
                                    </SelectItem>
                                  ))}
                                  {canCreatePaymentMethod && (
                                    <SelectItem value="__add_new__" className="text-primary font-medium" data-testid="option-add-new-payment-method">
                                      <span className="flex items-center gap-1"><Plus className="h-3 w-3" /> Agregar medio de cobro</span>
                                    </SelectItem>
                                  )}
                                </SelectContent>
                              </Select>
                              {selected && breakdown.length > 0 && (
                                <div className="mt-2 rounded-md border border-cyan-500/20 bg-cyan-500/5 p-3 text-xs space-y-1" data-testid="payment-method-breakdown">
                                  <div className="font-semibold text-cyan-700 uppercase tracking-wide">
                                    Costos automáticos {values.type === 'receivable' ? '(quedan pendientes hasta cobrar)' : ''}
                                  </div>
                                  {breakdown.map((b, i) => (
                                    <div key={i} className="flex justify-between text-muted-foreground">
                                      <span>{b.name}</span>
                                      <span>− {b.cost.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' })}</span>
                                    </div>
                                  ))}
                                  <div className="flex justify-between pt-1 mt-1 border-t border-cyan-500/20 font-semibold">
                                    <span>Recibís neto</span>
                                    <span data-testid="text-payment-method-net">
                                      {net.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' })}
                                    </span>
                                  </div>
                                </div>
                              )}
                            </FormItem>
                          );
                        }}
                      />
                    )}

                    {!isPersonalContext && (values.type === 'expense' || values.type === 'payable') && (
                      <FormField
                        control={form.control}
                        name="supplierId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-muted-foreground">Proveedor (opcional)</FormLabel>
                            <Select 
                              onValueChange={(val) => {
                                if (val === '__add_new__') {
                                  setShowNewSupplierDialog(true);
                                } else {
                                  field.onChange(val === '__none__' ? undefined : val);
                                }
                              }} 
                              value={field.value || '__none__'}
                            >
                              <FormControl>
                                <SelectTrigger data-testid="select-supplier">
                                  <SelectValue placeholder="Seleccionar proveedor..." />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="__none__">Sin proveedor</SelectItem>
                                {suppliers.map((supplier: any) => (
                                  <SelectItem key={supplier.id} value={supplier.id}>
                                    {supplier.name}
                                  </SelectItem>
                                ))}
                                <SelectItem value="__add_new__" className="text-primary font-medium">
                                  <span className="flex items-center gap-1"><Plus className="h-3 w-3" /> Agregar proveedor</span>
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </FormItem>
                        )}
                      />
                    )}

                {/* Para ingresos, surfaceamos la elección Con/Sin Factura y el
                    toggle ARCA arriba de "Más detalles" (debajo de recurrencia).
                    Para otros tipos sigue dentro del colapsable. */}
                {values.type === 'income' && invoiceChoiceBlock}

                <button
                  type="button"
                  onClick={() => setShowMoreDetails(!showMoreDetails)}
                  className="w-full flex items-center justify-center gap-2 py-3 text-sm font-medium text-primary border border-primary/30 rounded-lg hover:bg-primary/5 hover:border-primary/50 transition-all"
                  data-testid="button-toggle-more-details"
                >
                  <Plus className={cn("h-4 w-4 transition-transform", showMoreDetails && "rotate-45")} />
                  {showMoreDetails ? 'Ocultar detalles' : 'Agregar más detalles'}
                </button>

                {showMoreDetails && (
                  <div className="space-y-4 p-4 bg-secondary/20 rounded-xl border border-border animate-in fade-in slide-in-from-top-2 duration-200">
                    {/* Task #226: para 'payable' / 'receivable' la "Fecha de vencimiento"
                        ya se renderiza arriba (campo principal con asterisco *).
                        Acá sólo mostramos el selector de mes/año para income/expense
                        ("Imputar al mes de"). */}
                    {!(values.type === 'payable' || values.type === 'receivable') && (
                      <FormField
                        control={form.control}
                        name="imputationDate"
                        render={({ field }) => {
                          const dateError = validateImputationDate(field.value, values.type);

                          return (
                            <FormItem>
                              <FormLabel>Imputar al mes de</FormLabel>
                              <FormControl>
                                <div className="flex gap-2">
                                  <Select
                                    value={field.value ? field.value.split('-')[1] : ''}
                                    onValueChange={(month) => {
                                      const year = field.value ? field.value.split('-')[0] : new Date().getFullYear().toString();
                                      field.onChange(`${year}-${month}`);
                                    }}
                                  >
                                    <SelectTrigger className={cn("flex-1", dateError && "border-red-500 focus:ring-red-500")}>
                                      <SelectValue placeholder="Mes..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="01">Enero</SelectItem>
                                      <SelectItem value="02">Febrero</SelectItem>
                                      <SelectItem value="03">Marzo</SelectItem>
                                      <SelectItem value="04">Abril</SelectItem>
                                      <SelectItem value="05">Mayo</SelectItem>
                                      <SelectItem value="06">Junio</SelectItem>
                                      <SelectItem value="07">Julio</SelectItem>
                                      <SelectItem value="08">Agosto</SelectItem>
                                      <SelectItem value="09">Septiembre</SelectItem>
                                      <SelectItem value="10">Octubre</SelectItem>
                                      <SelectItem value="11">Noviembre</SelectItem>
                                      <SelectItem value="12">Diciembre</SelectItem>
                                    </SelectContent>
                                  </Select>
                                  <Select
                                    value={field.value ? field.value.split('-')[0] : ''}
                                    onValueChange={(year) => {
                                      const month = field.value ? field.value.split('-')[1] : '01';
                                      field.onChange(`${year}-${month}`);
                                    }}
                                  >
                                    <SelectTrigger className={cn("w-24", dateError && "border-red-500 focus:ring-red-500")}>
                                      <SelectValue placeholder="Año..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {Array.from({ length: 5 }, (_, i) => {
                                        const year = new Date().getFullYear() - 2 + i;
                                        return (
                                          <SelectItem key={year} value={year.toString()}>{year}</SelectItem>
                                        );
                                      })}
                                    </SelectContent>
                                  </Select>
                                </div>
                              </FormControl>
                              {dateError ? (
                                <p className="text-xs text-red-500 flex items-center gap-1 mt-1">
                                  <AlertCircle className="h-3 w-3" /> {dateError}
                                </p>
                              ) : (
                                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                                  <HelpCircle className="h-3 w-3" /> Mes contable
                                </p>
                              )}
                              <FormMessage />
                            </FormItem>
                          );
                        }}
                      />
                    )}

                    <FormField
                      control={form.control}
                      name="description"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Descripción</FormLabel>
                          <FormControl>
                            <Input placeholder="Ej: Pago de flete a Ramos Mejía" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {(values.type === 'expense' || values.type === 'payable') && linkableTransactions.length > 0 && (
                      <FormField
                        control={form.control}
                        name="linkedTransactionId"
                        render={({ field }) => {
                          const selectedTx = linkableTransactions.find((tx) => tx.id === field.value);
                          return (
                            <FormItem className="flex flex-col">
                              <FormLabel className="text-muted-foreground flex items-center gap-2">
                                <span>Origen del dinero (opcional)</span>
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                                    </TooltipTrigger>
                                    <TooltipContent className="max-w-xs">
                                      <p>Vincular este gasto a un ingreso o cobro anterior permite hacer seguimiento del flujo de dinero.</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              </FormLabel>
                              <Popover open={linkableOpen} onOpenChange={setLinkableOpen}>
                                <PopoverTrigger asChild>
                                  <FormControl>
                                    <Button
                                      variant="outline"
                                      role="combobox"
                                      aria-expanded={linkableOpen}
                                      className={cn(
                                        "w-full justify-between font-normal",
                                        !field.value && "text-muted-foreground"
                                      )}
                                      data-testid="linkable-transaction-combobox"
                                    >
                                      {selectedTx ? (
                                        <span className="flex items-center gap-2 truncate">
                                          <span className="truncate">{selectedTx.transactionNumber || selectedTx.description.slice(0, 25)}</span>
                                          <span className="text-xs text-muted-foreground">
                                            (Disp: ${selectedTx.availableBalance.toLocaleString('es-AR')})
                                          </span>
                                        </span>
                                      ) : (
                                        "Sin vincular"
                                      )}
                                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                    </Button>
                                  </FormControl>
                                </PopoverTrigger>
                                <PopoverContent className="w-[400px] p-0" align="start">
                                  <Command>
                                    <CommandInput placeholder="Buscar por descripción o número..." />
                                    <CommandList>
                                      <CommandEmpty>No se encontraron transacciones.</CommandEmpty>
                                      <CommandGroup>
                                        <CommandItem
                                          value="__none__"
                                          onSelect={() => {
                                            field.onChange(undefined);
                                            setLinkableOpen(false);
                                          }}
                                        >
                                          <Check
                                            className={cn(
                                              "mr-2 h-4 w-4",
                                              !field.value ? "opacity-100" : "opacity-0"
                                            )}
                                          />
                                          Sin vincular
                                        </CommandItem>
                                        {linkableTransactions.map((tx) => (
                                          <CommandItem
                                            key={tx.id}
                                            value={`${tx.transactionNumber || ''} ${tx.description} ${tx.availableBalance}`}
                                            onSelect={() => {
                                              if (tx.availableBalance > 0) {
                                                field.onChange(tx.id);
                                                setLinkableOpen(false);
                                              }
                                            }}
                                            disabled={tx.availableBalance <= 0}
                                            className={cn(tx.availableBalance <= 0 && "opacity-50")}
                                          >
                                            <Check
                                              className={cn(
                                                "mr-2 h-4 w-4",
                                                field.value === tx.id ? "opacity-100" : "opacity-0"
                                              )}
                                            />
                                            <div className="flex flex-col flex-1 min-w-0">
                                              <div className="flex items-center gap-2">
                                                <span className="truncate font-medium">
                                                  {tx.transactionNumber || tx.description.slice(0, 30)}
                                                </span>
                                                <Badge variant={tx.type === 'income' ? 'default' : 'secondary'} className="text-xs shrink-0">
                                                  {tx.type === 'income' ? 'Ingreso' : 'Por cobrar'}
                                                </Badge>
                                              </div>
                                              <div className="flex items-center justify-between text-xs text-muted-foreground">
                                                <span className="truncate">{tx.description.slice(0, 40)}</span>
                                                <span className="font-medium text-primary shrink-0">
                                                  Disp: ${tx.availableBalance.toLocaleString('es-AR')}
                                                </span>
                                              </div>
                                            </div>
                                          </CommandItem>
                                        ))}
                                      </CommandGroup>
                                    </CommandList>
                                  </Command>
                                </PopoverContent>
                              </Popover>
                            </FormItem>
                          );
                        }}
                      />
                    )}

                    {/* Para ingresos el bloque de elección Con/Sin Factura ya
                        se renderizó arriba de "Más detalles" (mejor UX). Para
                        el resto de los tipos sigue acá adentro, como estaba. */}
                    {values.type !== 'income' && invoiceChoiceBlock}

                    <div className="space-y-4">
                      {values.hasInvoice && (
                        <div className="space-y-3 animate-in fade-in slide-in-from-top-2">
                          {!(emitWithArca && (
                            (values.type === 'income' || values.type === 'receivable') ||
                            ((values.type === 'expense' || values.type === 'payable') && !!values.supplierId)
                          )) && (
                            <div className="grid grid-cols-2 gap-3">
                              <FormField
                                control={form.control}
                                name="invoiceType"
                                render={({ field }) => (
                                  <FormItem>
                                    <FormLabel>Tipo</FormLabel>
                                    <Select
                                      onValueChange={(v) => {
                                        userPickedInvoiceTypeRef.current = true;
                                        field.onChange(v);
                                      }}
                                      value={field.value || undefined}
                                    >
                                      <FormControl>
                                        <SelectTrigger data-testid="select-invoice-type">
                                          <SelectValue placeholder="Tipo" />
                                        </SelectTrigger>
                                      </FormControl>
                                      <SelectContent>
                                        <SelectItem value="A">Factura A</SelectItem>
                                        <SelectItem value="B">Factura B</SelectItem>
                                        <SelectItem value="C">Factura C</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </FormItem>
                                )}
                              />
                              <FormField
                                control={form.control}
                                name="invoiceNumber"
                                render={({ field }) => {
                                  const raw = (field.value ?? '').toString();
                                  const trimmed = raw.trim();
                                  const inlineErr =
                                    trimmed !== '' && !isValidArcaInvoiceNumber(trimmed)
                                      ? 'Formato inválido. Usá PPPP-NNNNNNNN (ej: 0001-00001234).'
                                      : null;
                                  return (
                                    <FormItem>
                                      <FormLabel>Número</FormLabel>
                                      <FormControl>
                                        <Input
                                          placeholder="0001-00001234"
                                          data-testid="input-invoice-number"
                                          {...field}
                                          value={field.value ?? ''}
                                          onBlur={(e) => {
                                            const v = e.target.value;
                                            if (v && v.trim() !== '') {
                                              const norm = normalizeArcaInvoiceNumber(v);
                                              if (norm !== v) form.setValue('invoiceNumber', norm);
                                            }
                                            field.onBlur();
                                          }}
                                        />
                                      </FormControl>
                                      <p className="text-[11px] text-muted-foreground mt-1">
                                        Formato: 0001-00001234 (4 dígitos · 8 dígitos)
                                      </p>
                                      {inlineErr && (
                                        <p
                                          className="text-xs text-destructive mt-1"
                                          data-testid="error-invoice-number"
                                        >
                                          {inlineErr}
                                        </p>
                                      )}
                                      <FormMessage />
                                    </FormItem>
                                  );
                                }}
                              />
                            </div>
                          )}

                          <div>
                            <input
                              ref={invoiceFileInputRef}
                              type="file"
                              accept=".jpg,.jpeg,.png,.webp,.pdf"
                              onChange={handleInvoiceFileUpload}
                              className="hidden"
                              data-testid="input-invoice-file"
                            />
                            {!invoiceFile && !invoiceFileUrl ? (
                              <button
                                type="button"
                                onClick={() => invoiceFileInputRef.current?.click()}
                                disabled={isUploadingInvoice}
                                className="w-full p-3 border-2 border-dashed border-border rounded-lg hover:border-primary hover:bg-primary/5 transition-all flex items-center justify-center gap-2 text-muted-foreground hover:text-primary text-sm"
                                data-testid="button-upload-invoice"
                              >
                                <Upload className="h-4 w-4" />
                                <span className="font-medium">Adjuntar comprobante (opcional)</span>
                              </button>
                            ) : isUploadingInvoice ? (
                              <div className="w-full p-3 border-2 border-primary/30 bg-primary/5 rounded-lg flex items-center justify-center gap-2">
                                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                                <span className="text-sm text-primary font-medium">Subiendo...</span>
                              </div>
                            ) : (
                              <div className="w-full p-2 border-2 border-green-200 bg-green-50 rounded-lg flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <FileText className="h-4 w-4 text-green-600" />
                                  <span className="text-sm font-medium text-green-700 truncate max-w-[200px]">
                                    {invoiceFile?.name || 'Factura adjunta'}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  onClick={removeInvoiceFile}
                                  className="p-1 hover:bg-red-100 rounded text-red-500 hover:text-red-700 transition-colors"
                                  data-testid="button-remove-invoice"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </div>
                            )}
                          </div>
                          {values.type === 'expense' && (
                            <div className="space-y-2 p-3 rounded-lg bg-cyan-500/5 border border-cyan-500/20">
                              <p className="text-xs font-medium text-cyan-700 dark:text-cyan-300 flex items-center gap-1">
                                Datos fiscales (opcional · para sección Impuestos)
                              </p>
                              <div className="grid grid-cols-3 gap-2">
                                <FormField
                                  control={form.control}
                                  name="invoiceNetAmount"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel className="text-xs">Neto</FormLabel>
                                      <FormControl><Input type="number" step="0.01" placeholder="0.00" {...field} data-testid="input-wizard-fiscal-net" /></FormControl>
                                    </FormItem>
                                  )}
                                />
                                <FormField
                                  control={form.control}
                                  name="invoiceIvaAliquot"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel className="text-xs">Alícuota %</FormLabel>
                                      <Select onValueChange={field.onChange} value={field.value || ''}>
                                        <FormControl><SelectTrigger><SelectValue placeholder="—" /></SelectTrigger></FormControl>
                                        <SelectContent>
                                          <SelectItem value="0">0%</SelectItem>
                                          <SelectItem value="2.5">2.5%</SelectItem>
                                          <SelectItem value="5">5%</SelectItem>
                                          <SelectItem value="10.5">10.5%</SelectItem>
                                          <SelectItem value="21">21%</SelectItem>
                                          <SelectItem value="27">27%</SelectItem>
                                        </SelectContent>
                                      </Select>
                                    </FormItem>
                                  )}
                                />
                                <FormField
                                  control={form.control}
                                  name="invoiceIvaAmount"
                                  render={({ field }) => {
                                    const net = parseFloat(values.invoiceNetAmount || '');
                                    const aliq = parseFloat(values.invoiceIvaAliquot || '');
                                    const auto = isFinite(net) && isFinite(aliq) ? (net * aliq / 100).toFixed(2) : '';
                                    return (
                                      <FormItem>
                                        <FormLabel className="text-xs">IVA</FormLabel>
                                        <FormControl><Input type="number" step="0.01" placeholder={auto || '0.00'} {...field} value={field.value || auto} onChange={(e) => field.onChange(e.target.value)} data-testid="input-wizard-fiscal-iva" /></FormControl>
                                      </FormItem>
                                    );
                                  }}
                                />
                              </div>
                              <FormField
                                control={form.control}
                                name="invoiceOtherTaxes"
                                render={({ field }) => (
                                  <FormItem>
                                    <FormLabel className="text-xs">Otros impuestos</FormLabel>
                                    <FormControl><Input type="number" step="0.01" placeholder="0.00" {...field} data-testid="input-wizard-fiscal-other" /></FormControl>
                                  </FormItem>
                                )}
                              />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
              );
            })()}

            {step === 'account' && (
              <div className="space-y-6 animate-in slide-in-from-right-4 fade-in duration-300">
                {/* Check if user has no accounts - only block for non-pending types */}
                {accounts.length === 0 && !isPending ? (
                  <div className="text-center py-8 space-y-4">
                    <div className="mx-auto w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center">
                      <Wallet className="h-8 w-8 text-amber-600" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-lg">No tenés cuentas creadas</h3>
                      <p className="text-muted-foreground text-sm mt-1">
                        Para registrar movimientos, primero debés crear al menos una cuenta (efectivo, banco, billetera, etc.)
                      </p>
                    </div>
                    <Button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        window.location.href = '/accounts';
                      }}
                      className="mt-2"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Ir a crear cuentas
                    </Button>
                  </div>
                ) : (
                  <>
                    {/* Currency selector */}
                    <div>
                      <p className="text-sm font-medium mb-3">¿En qué moneda?</p>
                      <div className="flex gap-3">
                        {[
                          { id: 'ARS', label: 'Pesos', symbol: 'AR$' },
                          { id: 'USD', label: 'Dólares', symbol: 'US$' },
                          { id: 'EUR', label: 'Euros', symbol: '€' },
                        ].map((curr) => {
                          const hasAccounts = accounts.some((a: any) => {
                            const accCurrency = a.currency || 'ARS';
                            if (curr.id === 'USD') return accCurrency === 'USD' || accCurrency === 'USD_CASH';
                            return accCurrency === curr.id;
                          });
                          // For pending types, always allow currency selection even without accounts
                          const isEnabled = isPending || hasAccounts;
                          return (
                            <button
                              key={curr.id}
                              type="button"
                              disabled={!isEnabled}
                              onClick={() => {
                                setSelectedCurrency(curr.id as 'ARS' | 'USD' | 'EUR');
                                form.setValue('accountId', '');
                              }}
                              className={cn(
                                "flex-1 py-3 px-4 rounded-xl border-2 font-bold transition-all",
                                selectedCurrency === curr.id
                                  ? "border-primary bg-primary text-white"
                                  : isEnabled
                                    ? "border-border hover:bg-secondary/50"
                                    : "border-border/50 bg-muted/30 text-muted-foreground cursor-not-allowed opacity-50"
                              )}
                            >
                              <span className="text-lg">{curr.symbol}</span>
                              <span className="block text-xs mt-0.5">{curr.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                {/* Account list - only show after currency is selected */}
                {selectedCurrency && (
                  <FormField
                    control={form.control}
                    name="accountId"
                    render={({ field }) => {
                      const filteredAccounts = accounts.filter((acc: any) => {
                        const accCurrency = acc.currency || 'ARS';
                        if (selectedCurrency === 'USD') return accCurrency === 'USD' || accCurrency === 'USD_CASH';
                        return accCurrency === selectedCurrency;
                      });
                      
                      return (
                        <FormItem>
                          <FormLabel>{isPending ? 'Cuenta donde se cobrará/pagará (opcional)' : 'Selecciona la cuenta'}</FormLabel>
                          <div className="grid gap-3">
                            {/* Option for no account - only for pending types */}
                            {isPending && (
                              <div 
                                onClick={() => field.onChange('')}
                                className={cn(
                                  "cursor-pointer p-4 rounded-lg border-2 flex items-center justify-between transition-all",
                                  !field.value 
                                    ? "border-primary bg-primary/5 ring-1 ring-primary" 
                                    : "border-border hover:bg-secondary/50"
                                )}
                              >
                                <div className="flex items-center gap-3">
                                  <div className="p-2 bg-gray-100 dark:bg-slate-800 rounded-md">
                                    <Clock className="h-4 w-4 text-muted-foreground" />
                                  </div>
                                  <div>
                                    <p className="font-bold text-sm">Sin cuenta por ahora</p>
                                    <p className="text-xs text-muted-foreground">
                                      Definir cuando se concrete el cobro/pago
                                    </p>
                                  </div>
                                </div>
                                {!field.value && <Check className="h-5 w-5 text-primary" />}
                              </div>
                            )}
                            {filteredAccounts.map((acc: any) => {
                              const currency = (acc.currency || 'ARS') as Currency;
                              const currencySymbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || 'AR$';
                              return (
                                <div 
                                  key={acc.id}
                                  onClick={() => field.onChange(acc.id)}
                                  className={cn(
                                    "cursor-pointer p-4 rounded-lg border-2 flex items-center justify-between transition-all",
                                    field.value === acc.id 
                                      ? "border-primary bg-primary/5 ring-1 ring-primary" 
                                      : "border-border hover:bg-secondary/50"
                                  )}
                                >
                                  <div className="flex items-center gap-3">
                                    <div className="p-2 bg-white dark:bg-card rounded-md shadow-sm">
                                      <Wallet className="h-4 w-4 text-primary" />
                                    </div>
                                    <div>
                                      <p className="font-bold text-sm">{acc.name}</p>
                                      <p className="text-xs text-muted-foreground capitalize">
                                        {getAccTypeLabel(acc.type)}
                                        {' • '}{currencySymbol} {parseFloat(acc.balance).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                                      </p>
                                    </div>
                                  </div>
                                  {field.value === acc.id && <Check className="h-5 w-5 text-primary" />}
                                </div>
                              );
                            })}
                          </div>
                          <FormMessage />
                        </FormItem>
                      );
                    }}
                  />
                )}

                {hasComplianceWarning() && (
                   <div className="p-4 bg-yellow-50 text-yellow-800 rounded-lg border border-yellow-200 flex items-start gap-3">
                     <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                     <div className="text-sm">
                       <p className="font-bold">¡Atención!</p>
                       <p>Estás imputando un movimiento <strong>CON FACTURA</strong> a una cuenta que parece ser informal ("{accounts.find((a: any) => a.id === values.accountId)?.name}").</p>
                       <p className="mt-1">¿Deseas continuar de todas formas?</p>
                     </div>
                   </div>
                )}
                  </>
                )}
              </div>
            )}

            {/* Transfer step - bank-style flow */}
            {step === 'transfer' && (() => {
              const originAccount = accounts.find((a: any) => a.id === values.accountId);
              const destAccount = accounts.find((a: any) => a.id === values.destinationAccountId);
              const originCurrency = originAccount?.currency || 'ARS';
              const destCurrency = destAccount?.currency || 'ARS';
              const isCrossCurrency = originAccount && destAccount && originCurrency !== destCurrency;
              
              // Determine if this is ARS to foreign conversion
              const isARStoForeign = originCurrency === 'ARS' && (destCurrency === 'USD' || destCurrency === 'USD_CASH' || destCurrency === 'EUR');
              const isForeignToARS = destCurrency === 'ARS' && (originCurrency === 'USD' || originCurrency === 'USD_CASH' || originCurrency === 'EUR');
              
              // Get exchange rate - ALWAYS stored as "1 foreign = X ARS"
              const getDefaultExchangeRate = () => {
                if (!isCrossCurrency) return '1';
                const usdRate = exchangeRates?.usdToLocal || 1050;
                const eurRate = exchangeRates?.eurToLocal || 1150;
                
                // USD involved
                if ((originCurrency === 'USD' || originCurrency === 'USD_CASH') || 
                    (destCurrency === 'USD' || destCurrency === 'USD_CASH')) {
                  return String(usdRate);
                }
                // EUR involved
                if (originCurrency === 'EUR' || destCurrency === 'EUR') {
                  return String(eurRate);
                }
                return '1';
              };
              
              // Rate is always "1 USD/EUR = X ARS"
              const displayedRate = customExchangeRate || getDefaultExchangeRate();
              const parsedAmount = parseFloat(values.amount?.replace(/\./g, '').replace(',', '.') || '0');
              
              // Calculate result based on conversion direction
              const resultAmount = (() => {
                if (!isCurrencyExchange || !isCrossCurrency) return parsedAmount;
                const rate = parseFloat(displayedRate);
                if (isForeignToARS) {
                  // USD/EUR -> ARS: multiply by rate (100 USD * 1470 = 147000 ARS)
                  return parsedAmount * rate;
                } else if (isARStoForeign) {
                  // ARS -> USD/EUR: divide by rate (147000 ARS / 1470 = 100 USD)
                  return parsedAmount / rate;
                }
                return parsedAmount;
              })();
              
              // Filter destination accounts
              const getDestinationAccounts = () => {
                const filtered = accounts.filter((a: any) => a.id !== values.accountId);
                if (!isCurrencyExchange && originAccount) {
                  // Only same currency
                  return filtered.filter((a: any) => a.currency === originAccount.currency);
                }
                return filtered;
              };
              
              const destinationAccounts = getDestinationAccounts();
              const hasDifferentCurrencyAccounts = originAccount && 
                accounts.some((a: any) => a.id !== values.accountId && a.currency !== originAccount.currency);
              
              return (
              <div className="space-y-6 animate-in slide-in-from-right-4 fade-in duration-300">
                <div className="text-center mb-4">
                  <div className="inline-flex p-3 rounded-full bg-purple-100 mb-2">
                    <ArrowLeftRight className="h-6 w-6 text-purple-600" />
                  </div>
                  <h3 className="text-lg font-bold text-purple-800">Transferencia entre cuentas</h3>
                </div>

                {/* Origin account - card style */}
                <div>
                  <Label className="flex items-center gap-2 mb-3">
                    <div className="w-6 h-6 rounded-full bg-red-100 flex items-center justify-center">
                      <ArrowUpRight className="h-3 w-3 text-red-600" />
                    </div>
                    Cuenta de Origen
                  </Label>
                  <div className="grid gap-2 max-h-48 overflow-y-auto pr-1">
                    {accounts.map((acc: any) => {
                      const currency = (acc.currency || 'ARS') as Currency;
                      const currencySymbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || 'AR$';
                      const isSelected = values.accountId === acc.id;
                      return (
                        <div 
                          key={acc.id}
                          onClick={() => {
                            form.setValue('accountId', acc.id);
                            // Reset destination if currencies don't match and not in exchange mode
                            if (!isCurrencyExchange && destAccount && destAccount.currency !== acc.currency) {
                              form.setValue('destinationAccountId', '');
                            }
                          }}
                          className={cn(
                            "cursor-pointer p-3 rounded-lg border-2 flex items-center justify-between transition-all",
                            isSelected 
                              ? "border-purple-500 bg-purple-50 ring-1 ring-purple-500" 
                              : "border-border hover:bg-secondary/50"
                          )}
                          data-testid={`transfer-origin-${acc.id}`}
                        >
                          <div className="flex items-center gap-3">
                            <div className={cn("p-2 rounded-md", isSelected ? "bg-purple-200" : "bg-white dark:bg-card shadow-sm")}>
                              <Wallet className={cn("h-4 w-4", isSelected ? "text-purple-600" : "text-primary")} />
                            </div>
                            <div>
                              <p className="font-bold text-sm">{acc.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {getAccTypeLabel(acc.type)}
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="font-bold text-sm">{currencySymbol} {parseFloat(acc.balance).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</p>
                            <Badge variant="outline" className="text-xs">{currency === 'USD_CASH' ? 'USD' : currency}</Badge>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Currency exchange toggle - only show if there are different currency accounts */}
                {originAccount && hasDifferentCurrencyAccounts && (
                  <div className="flex items-center justify-between p-3 bg-blue-50 rounded-lg border border-blue-200">
                    <div className="flex items-center gap-2">
                      <RefreshCw className="h-4 w-4 text-blue-600" />
                      <span className="text-sm font-medium text-blue-800">Cambio de moneda</span>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        className="sr-only peer"
                        checked={isCurrencyExchange}
                        onChange={(e) => {
                          setIsCurrencyExchange(e.target.checked);
                          if (!e.target.checked && destAccount && destAccount.currency !== originAccount.currency) {
                            form.setValue('destinationAccountId', '');
                          }
                          setCustomExchangeRate('');
                        }}
                      />
                      <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                  </div>
                )}

                {/* Destination account - card style */}
                {values.accountId && (
                  <div>
                    <Label className="flex items-center gap-2 mb-3">
                      <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center">
                        <ArrowDownLeft className="h-3 w-3 text-green-600" />
                      </div>
                      Cuenta de Destino
                      {!isCurrencyExchange && originAccount && (
                        <Badge variant="outline" className="text-xs ml-auto">Solo {originAccount.currency === 'USD_CASH' ? 'USD' : originAccount.currency}</Badge>
                      )}
                    </Label>
                    
                    {destinationAccounts.length === 0 ? (
                      <div className="p-4 bg-orange-50 border border-orange-200 rounded-lg text-center">
                        <AlertTriangle className="h-5 w-5 text-orange-500 mx-auto mb-2" />
                        <p className="text-sm text-orange-700">
                          No hay otras cuentas en {originAccount?.currency === 'USD_CASH' ? 'USD' : originAccount?.currency}.
                        </p>
                        <p className="text-xs text-orange-600 mt-1">
                          Activá "Cambio de moneda" para ver cuentas en otras monedas.
                        </p>
                      </div>
                    ) : (
                      <div className="grid gap-2 max-h-48 overflow-y-auto pr-1">
                        {destinationAccounts.map((acc: any) => {
                          const currency = (acc.currency || 'ARS') as Currency;
                          const currencySymbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || 'AR$';
                          const isSelected = values.destinationAccountId === acc.id;
                          const isDifferentCurrency = originAccount && acc.currency !== originAccount.currency;
                          return (
                            <div 
                              key={acc.id}
                              onClick={() => {
                                form.setValue('destinationAccountId', acc.id);
                                // Auto-enable currency exchange for cross-currency transfers
                                if (originAccount && acc.currency !== originAccount.currency) {
                                  setIsCurrencyExchange(true);
                                }
                              }}
                              className={cn(
                                "cursor-pointer p-3 rounded-lg border-2 flex items-center justify-between transition-all",
                                isSelected 
                                  ? "border-green-500 bg-green-50 ring-1 ring-green-500" 
                                  : "border-border hover:bg-secondary/50",
                                isDifferentCurrency && "border-dashed"
                              )}
                              data-testid={`transfer-dest-${acc.id}`}
                            >
                              <div className="flex items-center gap-3">
                                <div className={cn("p-2 rounded-md", isSelected ? "bg-green-200" : "bg-white dark:bg-card shadow-sm")}>
                                  <Wallet className={cn("h-4 w-4", isSelected ? "text-green-600" : "text-primary")} />
                                </div>
                                <div>
                                  <p className="font-bold text-sm">{acc.name}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {getAccTypeLabel(acc.type)}
                                  </p>
                                </div>
                              </div>
                              <div className="text-right">
                                <p className="font-bold text-sm">{currencySymbol} {parseFloat(acc.balance).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</p>
                                <Badge variant={isDifferentCurrency ? "secondary" : "outline"} className="text-xs">
                                  {currency === 'USD_CASH' ? 'USD' : currency}
                                </Badge>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Amount input */}
                {values.accountId && values.destinationAccountId && (
                  <>
                    <FormField
                      control={form.control}
                      name="amount"
                      render={({ field }) => {
                        const currencySymbol = CURRENCY_SYMBOLS[originCurrency as keyof typeof CURRENCY_SYMBOLS] || '$';
                        return (
                          <FormItem>
                            <FormLabel>Monto a transferir</FormLabel>
                            <FormControl>
                              <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">
                                  {currencySymbol}
                                </span>
                                <Input
                                  {...field}
                                  type="text"
                                  inputMode="decimal"
                                  placeholder="0,00"
                                  className="pl-12 text-xl font-bold"
                                  data-testid="input-transfer-amount"
                                  onChange={(e) => {
                                    // Accept both comma and dot as decimal separators
                                    // First convert dot to comma if used as decimal separator
                                    let raw = e.target.value;
                                    // Remove thousand separators (dots followed by 3+ digits)
                                    raw = raw.replace(/\.(?=\d{3})/g, '');
                                    // If dot is followed by 1-2 digits at end, it's a decimal separator - convert to comma
                                    raw = raw.replace(/\.(\d{1,2})$/, ',$1');
                                    // Remove all non-numeric except comma
                                    raw = raw.replace(/[^0-9,]/g, '');
                                    // Split by comma (decimal separator)
                                    const parts = raw.split(',');
                                    // Format integer part with dots as thousand separators
                                    if (parts[0]) {
                                      // Remove leading zeros except for "0"
                                      parts[0] = parts[0].replace(/^0+(\d)/, '$1');
                                      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
                                    }
                                    // Reconstruct with comma for decimals, limit to 2 decimal places
                                    const formatted = parts.length > 1 ? parts[0] + ',' + parts[1].slice(0, 2) : parts[0];
                                    field.onChange(formatted);
                                  }}
                                />
                              </div>
                            </FormControl>
                            <FormMessage />
                            {originAccount && (
                              <p className="text-xs text-muted-foreground">
                                Saldo disponible: {currencySymbol} {parseFloat(originAccount.balance || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                              </p>
                            )}
                          </FormItem>
                        );
                      }}
                    />

                    {/* Exchange rate section - only for cross-currency */}
                    {isCrossCurrency && isCurrencyExchange && (() => {
                      // Always show rate as "1 USD = X ARS" or "1 EUR = X ARS" for clarity
                      const isARStoForeign = originCurrency === 'ARS' && (destCurrency === 'USD' || destCurrency === 'USD_CASH' || destCurrency === 'EUR');
                      const foreignCurrency = isARStoForeign 
                        ? (destCurrency === 'USD_CASH' ? 'USD' : destCurrency)
                        : (originCurrency === 'USD_CASH' ? 'USD' : originCurrency);
                      
                      // Get the display rate (always as "1 foreign = X ARS")
                      const getDisplayRate = () => {
                        const usdRate = exchangeRates?.usdToLocal || 1050;
                        const eurRate = exchangeRates?.eurToLocal || 1150;
                        if (foreignCurrency === 'USD') return String(usdRate);
                        if (foreignCurrency === 'EUR') return String(eurRate);
                        return '1';
                      };
                      
                      // For display, we use the rate as shown (1 USD = X ARS)
                      // customExchangeRate stores the displayed value
                      const displayRate = customExchangeRate || getDisplayRate();
                      
                      return (
                      <div className="p-4 bg-gradient-to-r from-blue-50 to-purple-50 rounded-xl border border-blue-200">
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-sm font-medium text-blue-800">Tipo de cambio</span>
                          <Badge variant="outline" className="text-xs">
                            {exchangeRates?.source || 'Dólar Blue'}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-muted-foreground">1 {foreignCurrency} =</span>
                          <Input
                            type="text"
                            inputMode="decimal"
                            value={displayRate}
                            onChange={(e) => {
                              const value = e.target.value.replace(/[^0-9.,]/g, '');
                              setCustomExchangeRate(value);
                            }}
                            className="w-32 text-center font-bold"
                            data-testid="input-exchange-rate"
                          />
                          <span className="text-sm text-muted-foreground">ARS</span>
                        </div>
                        
                        {/* Result preview */}
                        {parsedAmount > 0 && (
                          <div className="mt-3 pt-3 border-t border-blue-200">
                            <p className="text-sm text-center">
                              <span className="text-muted-foreground">Recibirás aproximadamente:</span>
                              <br />
                              <span className="text-xl font-bold text-green-600">
                                {CURRENCY_SYMBOLS[destCurrency as keyof typeof CURRENCY_SYMBOLS] || '$'}{' '}
                                {resultAmount.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </span>
                            </p>
                          </div>
                        )}
                      </div>
                      );
                    })()}

                    {/* Reason/Description */}
                    <FormField
                      control={form.control}
                      name="description"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Motivo de la transferencia</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              placeholder="Ej: Paso de caja a banco, Compra de dólares..."
                              data-testid="input-transfer-reason"
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </>
                )}
              </div>
            );
            })()}

            {step === 'emit' && (
              <div className="space-y-5 animate-in slide-in-from-right-4 fade-in duration-300">
                <div className="rounded-lg border border-cyan-200 bg-cyan-50/60 p-3">
                  <div className="flex items-start gap-2">
                    <Receipt className="h-4 w-4 text-cyan-600 mt-0.5" />
                    <div className="text-xs text-cyan-900">
                      <p className="font-medium">Emisión de factura electrónica (ARCA)</p>
                      <p className="text-cyan-800/80 mt-0.5">
                        {invoicingAccount?.account?.environment === 'test'
                          ? 'Estás en modo Pruebas: la factura se simula sin impactar en ARCA.'
                          : 'La factura será emitida ante ARCA al confirmar la operación.'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <p className="text-sm font-medium text-foreground">Receptor</p>
                  {(() => {
                    // Pick the right counterparty list: clients for income/
                    // receivable, suppliers for expense/payable. The picker
                    // also offers "Receptor manual" so this still works on
                    // orgs without any counterparties loaded.
                    const isClientDirected = values.type === 'income' || values.type === 'receivable';
                    const counterparties: ReceiverPickerOption[] = isClientDirected
                      ? (clients as any[]).map((c) => ({
                          id: c.id,
                          name: c.name,
                          taxId: c.taxId,
                          cuit: c.cuit,
                          email: c.email,
                          ivaCondition: c.ivaCondition,
                          address: c.address,
                          phone: c.phone,
                        }))
                      : (suppliers as any[]).map((s) => ({
                          id: s.id,
                          name: s.name,
                          taxId: s.taxId,
                          cuit: s.cuit,
                          email: s.email,
                          ivaCondition: s.ivaCondition,
                          address: s.address,
                          phone: s.phone,
                        }));
                    const groupLabel = isClientDirected ? 'Mis clientes' : 'Mis proveedores';
                    const placeholder = isClientDirected
                      ? 'Elegí un cliente o tipeá un CUIT…'
                      : 'Elegí un proveedor o tipeá un CUIT…';
                    const emptyLabel = isClientDirected
                      ? 'No se encontraron clientes.'
                      : 'No se encontraron proveedores.';
                    return (
                      <ReceiverPicker
                        value={emitSelectedClientId}
                        options={counterparties}
                        groupLabel={groupLabel}
                        placeholder={placeholder}
                        emptyLabel={emptyLabel}
                        testIdPrefix="wizard-emit-client"
                        onSelectManual={() => {
                          setEmitSelectedClientId('manual');
                          setEmitReceiverName('');
                          setEmitReceiverTaxId('');
                          setEmitReceiverIva('consumidor_final');
                          setEmitReceiverEmail('');
                          setEmitReceiverAddress('');
                          setEmitReceiverPhone('');
                        }}
                        onSelect={(o) => {
                          setEmitSelectedClientId(o.id);
                          setEmitReceiverName(o.name || '');
                          const tx = (o.taxId || o.cuit || '').toString().replace(/\D/g, '');
                          setEmitReceiverTaxId(tx);
                          const allowed = ['responsable_inscripto', 'monotributo', 'exento', 'consumidor_final'] as const;
                          const fallback: typeof allowed[number] = tx && /^\d{11}$/.test(tx)
                            ? 'responsable_inscripto'
                            : 'consumidor_final';
                          const iva = (allowed as readonly string[]).includes(o.ivaCondition || '')
                            ? (o.ivaCondition as typeof allowed[number])
                            : fallback;
                          setEmitReceiverIva(iva);
                          setEmitReceiverEmail(o.email || '');
                          setEmitReceiverAddress(o.address || '');
                          setEmitReceiverPhone(o.phone || '');
                        }}
                      />
                    );
                  })()}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="text-xs text-muted-foreground">Razón social / Nombre</label>
                      <Input
                        value={emitReceiverName}
                        onChange={(e) => { markEmitReceiverManual(); setEmitReceiverName(e.target.value); }}
                        placeholder="Ej.: Acme S.A."
                        data-testid="input-emit-receiver-name"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">CUIT / DNI</label>
                      <Input
                        value={emitReceiverTaxId}
                        onChange={(e) => { markEmitReceiverManual(); setEmitReceiverTaxId(e.target.value.replace(/\D/g, '')); }}
                        placeholder="20123456789"
                        inputMode="numeric"
                        data-testid="input-emit-receiver-taxid"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Condición frente al IVA</label>
                    <Select value={emitReceiverIva} onValueChange={(v) => { markEmitReceiverManual(); setEmitReceiverIva(v as any); }}>
                      <SelectTrigger data-testid="select-emit-receiver-iva">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="responsable_inscripto">Responsable Inscripto</SelectItem>
                        <SelectItem value="monotributo">Monotributo</SelectItem>
                        <SelectItem value="exento">Exento</SelectItem>
                        <SelectItem value="consumidor_final">Consumidor Final</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="text-xs text-muted-foreground">Domicilio (opcional)</label>
                      <Input
                        value={emitReceiverAddress}
                        onChange={(e) => { markEmitReceiverManual(); setEmitReceiverAddress(e.target.value); }}
                        placeholder="Av. Corrientes 1234, CABA"
                        maxLength={300}
                        data-testid="input-emit-receiver-address"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">Teléfono (opcional)</label>
                      <Input
                        value={emitReceiverPhone}
                        onChange={(e) => { markEmitReceiverManual(); setEmitReceiverPhone(e.target.value); }}
                        placeholder="+54 11 5555 5555"
                        maxLength={30}
                        data-testid="input-emit-receiver-phone"
                      />
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Si elegiste un cliente, se completan con sus datos. Aparecerán en el comprobante.
                  </p>
                </div>

                {(values.type === 'expense' || values.type === 'payable') && (() => {
                  const isProduction = invoicingAccount?.account?.environment === 'production';
                  const debitDisabled = isProduction;
                  const effectiveKind = debitDisabled ? 'credit' : emitSupplierNoteKind;
                  const handleDebitClick = () => {
                    if (debitDisabled) {
                      toast({
                        title: 'Nota de Débito no disponible en producción',
                        description: 'Emitila desde ARCA y registrala como comprobante manual. Cuando el proveedor habilite el endpoint, se activa automáticamente.',
                      });
                      return;
                    }
                    setEmitSupplierNoteKind('debit');
                  };
                  return (
                    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                      <p className="text-sm font-medium text-amber-900">Tipo de comprobante a proveedor</p>
                      <p className="text-[11px] text-amber-900/80">
                        Para devoluciones de compra usá Nota de Crédito; para ajustes que aumentan el monto a pagar, Nota de Débito.
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setEmitSupplierNoteKind('credit')}
                          className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                            effectiveKind === 'credit'
                              ? 'border-amber-500 bg-white dark:bg-card text-amber-900 font-medium shadow-sm'
                              : 'border-amber-200 bg-amber-50 text-amber-900/80 hover:bg-white'
                          }`}
                          data-testid="button-supplier-note-credit"
                        >
                          Nota de Crédito
                        </button>
                        <button
                          type="button"
                          onClick={handleDebitClick}
                          disabled={debitDisabled}
                          aria-disabled={debitDisabled}
                          title={debitDisabled ? 'Nota de Débito a proveedor no está disponible automáticamente en producción. Emitila desde ARCA.' : undefined}
                          className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                            debitDisabled
                              ? 'border-amber-200 bg-amber-50/40 text-amber-900/40 cursor-not-allowed opacity-60'
                              : effectiveKind === 'debit'
                                ? 'border-amber-500 bg-white dark:bg-card text-amber-900 font-medium shadow-sm'
                                : 'border-amber-200 bg-amber-50 text-amber-900/80 hover:bg-white'
                          }`}
                          data-testid="button-supplier-note-debit"
                        >
                          Nota de Débito
                        </button>
                      </div>
                      {debitDisabled && (
                        <p className="text-[11px] text-amber-900/80" data-testid="text-supplier-note-debit-unavailable">
                          Nota de Débito a proveedor todavía no está disponible automáticamente en producción. Emitila desde ARCA y registrala como comprobante manual.
                        </p>
                      )}
                      <p className="text-[11px] text-amber-900/80" data-testid="text-supplier-note-doctype">
                        Se emitirá: {(() => {
                          const emitterIva: string | undefined = invoicingAccount?.account?.ivaCondition;
                          const ltr = emitterIva !== 'responsable_inscripto'
                            ? 'C'
                            : (emitReceiverIva === 'responsable_inscripto' ? 'A' : 'B');
                          const prefix = effectiveKind === 'debit' ? 'Nota de Débito' : 'Nota de Crédito';
                          return `${prefix} ${ltr}`;
                        })()}
                      </p>
                    </div>
                  );
                })()}

                <div className="space-y-3">
                  {(() => {
                    const emitterIvaCondHere: string | undefined = invoicingAccount?.account?.ivaCondition;
                    const emitterDiscriminatesHere = emitterIvaCondHere === 'responsable_inscripto';
                    const aliquotChoices = emitterDiscriminatesHere
                      ? [0, 2.5, 5, 10.5, 21, 27]
                      : [0];
                    return (
                      <>
                        {!(values.type === 'expense' || values.type === 'payable') && (
                        <div className="grid gap-2">
                          <label className="text-sm font-medium text-foreground">¿Qué estás facturando?</label>
                          <Select value={emitItemType} onValueChange={(v) => setEmitItemType(v as 'product' | 'service' | 'product_and_service')}>
                            <SelectTrigger data-testid="select-emit-item-type">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="product">Producto</SelectItem>
                              <SelectItem value="service">Servicio</SelectItem>
                              <SelectItem value="product_and_service">Productos y servicios</SelectItem>
                            </SelectContent>
                          </Select>
                          {emitIncludesService && (
                            <div className="grid gap-2 rounded-lg border border-dashed p-3">
                              <p className="text-xs text-muted-foreground">
                                Para facturar servicios, ARCA pide el período del servicio y el vencimiento de pago.
                              </p>
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                <div>
                                  <label className="text-xs text-muted-foreground">Servicio desde *</label>
                                  <Input
                                    type="date"
                                    value={emitServiceFrom}
                                    onChange={(e) => setEmitServiceFrom(e.target.value)}
                                    data-testid="input-emit-service-from"
                                  />
                                </div>
                                <div>
                                  <label className="text-xs text-muted-foreground">Servicio hasta *</label>
                                  <Input
                                    type="date"
                                    value={emitServiceTo}
                                    onChange={(e) => setEmitServiceTo(e.target.value)}
                                    data-testid="input-emit-service-to"
                                  />
                                </div>
                                <div>
                                  <label className="text-xs text-muted-foreground">Vencimiento de pago *</label>
                                  <Input
                                    type="date"
                                    value={emitPaymentDueDate}
                                    onChange={(e) => setEmitPaymentDueDate(e.target.value)}
                                    data-testid="input-emit-payment-due"
                                  />
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                        )}

                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-foreground">Detalle del comprobante</p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={addEmitItem}
                            data-testid="button-emit-add-item"
                          >
                            <Plus className="h-4 w-4 mr-1" /> Agregar ítem
                          </Button>
                        </div>

                        {emitItems.map((it, index) => {
                          const lineUnit = Number(it.unitNet) || 0;
                          const lineOverCap = emitCapApplies && lineUnit > MONOTRIBUTO_MAX_UNIT_PRICE;
                          return (
                            <div
                              key={it.id}
                              className="rounded-lg border p-3 grid gap-2"
                              data-testid={`row-emit-item-${index}`}
                            >
                              <div className="flex items-center gap-2">
                                <Input
                                  value={it.description}
                                  onChange={(e) => updateEmitItem(it.id, { description: e.target.value })}
                                  placeholder="Servicio profesional, producto, etc."
                                  data-testid={`input-emit-item-desc-${index}`}
                                />
                                {emitItems.length > 1 && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="shrink-0 text-muted-foreground hover:text-destructive"
                                    onClick={() => removeEmitItem(it.id)}
                                    aria-label="Quitar ítem"
                                    data-testid={`button-emit-remove-item-${index}`}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                )}
                              </div>
                              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                <div>
                                  <label className="text-xs text-muted-foreground">Cantidad</label>
                                  <Input
                                    type="number"
                                    inputMode="decimal"
                                    step="0.01"
                                    value={it.quantity}
                                    onChange={(e) => updateEmitItem(it.id, { quantity: e.target.value })}
                                    data-testid={`input-emit-item-qty-${index}`}
                                  />
                                </div>
                                <div>
                                  <label className="text-xs text-muted-foreground">Precio unitario</label>
                                  <Input
                                    type="number"
                                    inputMode="decimal"
                                    step="0.01"
                                    placeholder="0.00"
                                    value={it.unitNet}
                                    onChange={(e) => updateEmitItem(it.id, { unitNet: e.target.value })}
                                    className={cn(lineOverCap && "border-red-400 focus-visible:ring-red-400")}
                                    data-testid={`input-emit-item-unit-${index}`}
                                  />
                                </div>
                                <div className="col-span-2 sm:col-span-1">
                                  <label className="text-xs text-muted-foreground">Alícuota IVA</label>
                                  <Select
                                    value={String(it.aliquot)}
                                    onValueChange={(v) => updateEmitItem(it.id, { aliquot: Number(v) })}
                                    disabled={!emitterDiscriminatesHere}
                                  >
                                    <SelectTrigger data-testid={`select-emit-item-aliquot-${index}`}>
                                      <SelectValue placeholder="—" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {aliquotChoices.map((a) => (
                                        <SelectItem key={a} value={String(a)}>{a}%</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              </div>
                              {!emitterDiscriminatesHere && index === 0 && (
                                <p className="text-[11px] text-muted-foreground">
                                  Factura C no discrimina IVA.
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </>
                    );
                  })()}

                  <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted/40 p-3 text-xs sm:text-sm">
                    <div>
                      <span className="text-muted-foreground block text-xs">Neto</span>
                      <strong data-testid="text-emit-net">
                        ${emitTotals.net.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </strong>
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-xs">IVA</span>
                      <strong data-testid="text-emit-iva">
                        ${emitTotals.iva.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </strong>
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-xs">Total c/IVA</span>
                      <strong className="text-cyan-700" data-testid="text-emit-total">
                        ${emitTotals.total.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </strong>
                    </div>
                  </div>

                  {emitHasOverCap && (
                    <div
                      className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-500/10 dark:border-red-500/40 text-red-800 dark:text-red-200 p-3 text-xs sm:text-sm flex gap-2"
                      data-testid="alert-emit-monotributo-cap"
                    >
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                      <div className="space-y-1">
                        <p>
                          <strong>ARCA no va a aceptar esta factura.</strong> Para monotributo, el
                          precio unitario de cada ítem no puede superar{" "}
                          <strong>${MONOTRIBUTO_MAX_UNIT_PRICE.toLocaleString('es-AR')}</strong>.
                        </p>
                        <p>
                          {emitOverCapItems.length === 1
                            ? `El ítem ${emitOverCapItems[0].index + 1} lo supera. `
                            : `Hay ${emitOverCapItems.length} ítems que lo superan. `}
                          Dividilo en varios ítems o subí la cantidad para que cada precio unitario
                          quede por debajo del tope
                          {emitOverCapItems.length === 1
                            ? ` (necesitás al menos ${emitOverCapItems[0].minUnits} ${emitOverCapItems[0].minUnits === 1 ? 'unidad o ítem' : 'unidades o ítems'})`
                            : ''}
                          .
                        </p>
                      </div>
                    </div>
                  )}

                  <p className="text-[11px] text-muted-foreground">
                    Estos valores se usarán para emitir el comprobante ante ARCA.
                  </p>
                  <div>
                    <label className="text-xs text-muted-foreground">Observaciones (opcional)</label>
                    <Textarea
                      value={emitObservations}
                      onChange={(e) => setEmitObservations(e.target.value)}
                      placeholder="Notas que aparecerán en el comprobante y en el email"
                      rows={2}
                      data-testid="textarea-emit-observations"
                    />
                  </div>
                </div>

                <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-foreground">Enviar PDF por email</p>
                      <p className="text-[11px] text-muted-foreground">Adjuntamos el PDF al cliente apenas se emita la factura.</p>
                    </div>
                    <Switch
                      checked={emitSendEmail}
                      onCheckedChange={setEmitSendEmail}
                      data-testid="switch-emit-send-email"
                    />
                  </div>
                  {emitSendEmail && (
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-muted-foreground">Email del cliente</label>
                        <Input
                          type="email"
                          value={emitReceiverEmail}
                          onChange={(e) => { markEmitReceiverManual(); setEmitReceiverEmail(e.target.value); }}
                          placeholder="cliente@empresa.com"
                          data-testid="input-emit-receiver-email"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Copiar a (CC)</label>
                        <div className="flex gap-2">
                          <Input
                            type="email"
                            value={emitCcInput}
                            onChange={(e) => setEmitCcInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ',') {
                                e.preventDefault();
                                const v = emitCcInput.trim().replace(/,$/, '');
                                if (v && !emitCcList.includes(v)) {
                                  setEmitCcList([...emitCcList, v]);
                                  setEmitCcInput('');
                                }
                              }
                            }}
                            placeholder="otro@empresa.com (Enter para agregar)"
                            data-testid="input-emit-cc"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const v = emitCcInput.trim();
                              if (v && !emitCcList.includes(v)) {
                                setEmitCcList([...emitCcList, v]);
                                setEmitCcInput('');
                              }
                            }}
                          >
                            Agregar
                          </Button>
                        </div>
                        {emitCcList.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {emitCcList.map((cc) => (
                              <Badge
                                key={cc}
                                variant="secondary"
                                className="gap-1"
                                data-testid={`badge-cc-${cc}`}
                              >
                                {cc}
                                <button
                                  type="button"
                                  onClick={() => setEmitCcList(emitCcList.filter((x) => x !== cc))}
                                  className="ml-0.5 hover:text-destructive"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center justify-between">
                        <label htmlFor="self-copy" className="text-xs text-muted-foreground">
                          Enviarme una copia ({currentUser?.email || 'mi email'})
                        </label>
                        <Switch
                          id="self-copy"
                          checked={emitSendSelfCopy}
                          onCheckedChange={setEmitSendSelfCopy}
                          disabled={!currentUser?.email}
                          data-testid="switch-emit-self-copy"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {step === 'confirm' && (
               <div className="space-y-3 animate-in slide-in-from-right-4 fade-in duration-300 text-center">
                 {/* Compact header for transfers */}
                 {values.type === 'transfer' ? (
                   <div className="flex items-center justify-center gap-3 py-2">
                     <div className="p-2 bg-purple-100 rounded-lg">
                       <ArrowLeftRight className="h-6 w-6 text-purple-600" />
                     </div>
                     <div className="text-left">
                       <h3 className="text-lg font-bold font-display">
                         Transferencia de <FormattedAmount 
                           amount={values.amount} 
                           currency={accounts.find((a: any) => a.id === values.accountId)?.currency || selectedCurrency || 'ARS'} 
                         />
                       </h3>
                       <p className="text-sm text-muted-foreground">{values.description || 'Transferencia interna'}</p>
                     </div>
                   </div>
                 ) : (
                   <>
                     <div className="flex flex-col items-center justify-center p-4 bg-secondary/20 rounded-full w-20 h-20 mx-auto">
                        {values.type === 'income' ? <ArrowUpRight className="h-8 w-8 text-green-600" /> : 
                         values.type === 'expense' ? <ArrowDownLeft className="h-8 w-8 text-red-600" /> :
                         values.type === 'receivable' ? <CalendarClock className="h-8 w-8 text-blue-600" /> :
                         <Clock className="h-8 w-8 text-orange-600" />}
                     </div>
                     <div className="space-y-1">
                       <h3 className="text-xl font-bold font-display">
                         {values.type === 'income' ? 'Ingreso' : 
                          values.type === 'expense' ? 'Egreso' : 
                          values.type === 'receivable' ? 'Compromiso de Cobro' : 
                          'Compromiso de Pago'} de <FormattedAmount 
                            amount={values.amount} 
                            currency={accounts.find((a: any) => a.id === values.accountId)?.currency || selectedCurrency || 'ARS'} 
                          />
                       </h3>
                       <p className="text-muted-foreground">{values.description}</p>
                       {isPending && (
                         <p className="text-xs text-orange-600 font-medium">
                           Compromiso pendiente, no afecta el saldo actual
                         </p>
                       )}
                     </div>
                   </>
                 )}

                 {/* Details grid - different for transfers vs regular transactions */}
                 {values.type === 'transfer' ? (() => {
                   const originAcc = accounts.find((a: any) => a.id === values.accountId);
                   const destAcc = accounts.find((a: any) => a.id === values.destinationAccountId);
                   
                   // Guard against missing accounts
                   if (!originAcc || !destAcc) {
                     return (
                       <div className="text-center text-muted-foreground p-4">
                         Seleccioná las cuentas de origen y destino
                       </div>
                     );
                   }
                   
                   const originCurr = originAcc.currency || 'ARS';
                   const destCurr = destAcc.currency || 'ARS';
                   const isCrossCurrency = originCurr !== destCurr;
                   const parsedAmt = parseFloat(values.amount?.replace(/\./g, '').replace(',', '.') || '0');
                   const originBalance = parseFloat(originAcc.balance) || 0;
                   const destBalance = parseFloat(destAcc.balance) || 0;
                   
                   // For cross-currency, always show exchange info (will always be enabled)
                   const isARStoForeign = originCurr === 'ARS' && (destCurr === 'USD' || destCurr === 'USD_CASH' || destCurr === 'EUR');
                   const isForeignToARS = destCurr === 'ARS' && (originCurr === 'USD' || originCurr === 'USD_CASH' || originCurr === 'EUR');
                   const needsExchange = isCrossCurrency && (isARStoForeign || isForeignToARS);
                   
                   // Get rate directly from exchangeRates API
                   const usdApiRate = exchangeRates?.usdToLocal;
                   const eurApiRate = exchangeRates?.eurToLocal;
                   const foreignCurrencyForRate = isARStoForeign 
                     ? (destCurr === 'USD_CASH' ? 'USD' : destCurr)
                     : (originCurr === 'USD_CASH' ? 'USD' : originCurr);
                   const defaultApiRate = foreignCurrencyForRate === 'USD' ? (usdApiRate || 1050) : 
                                          foreignCurrencyForRate === 'EUR' ? (eurApiRate || 1150) : 1;
                   
                   // Use customExchangeRate if user modified it, otherwise use API rate
                   const customRateValue = customExchangeRate ? parseFloat(customExchangeRate.replace(/\./g, '').replace(',', '.')) : 0;
                   const rate = customRateValue > 1 ? customRateValue : defaultApiRate;
                   const isValidRate = !isNaN(rate) && rate > 1;
                   const showExchangeInfo = needsExchange && isValidRate;
                   
                   let destAmount = parsedAmt;
                   if (showExchangeInfo) {
                     if (isForeignToARS) {
                       destAmount = parsedAmt * rate;
                     } else if (isARStoForeign) {
                       destAmount = parsedAmt / rate;
                     }
                   }
                   
                   const originSymbol = CURRENCY_SYMBOLS[originCurr as keyof typeof CURRENCY_SYMBOLS] || '$';
                   const destSymbol = CURRENCY_SYMBOLS[destCurr as keyof typeof CURRENCY_SYMBOLS] || '$';
                   const foreignCurrency = foreignCurrencyForRate;
                   
                   return (
                   <div className="text-sm text-left max-w-md mx-auto space-y-2">
                      {/* Origin account section - compact */}
                      <div className="bg-red-50 px-3 py-2 rounded-lg border border-red-200">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <ArrowUpRight className="h-3 w-3 text-red-500" />
                            <span className="text-xs text-muted-foreground">Sale de</span>
                            <span className="font-medium text-red-700">{originAcc.name}</span>
                          </div>
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-white dark:bg-card">{originCurr === 'USD_CASH' ? 'USD' : originCurr}</Badge>
                        </div>
                        <div className="flex justify-between items-center mt-1 text-xs">
                          <span className="text-muted-foreground">Saldo: {originSymbol} {originBalance.toLocaleString('es-AR', { minimumFractionDigits: 2 })} → <span className="text-red-600">{originSymbol} {(originBalance - parsedAmt).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span></span>
                          <span className="text-red-700 font-bold">-{originSymbol} {parsedAmt.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                        </div>
                      </div>
                      
                      {/* Exchange rate badge - compact */}
                      {showExchangeInfo && foreignCurrency && (
                        <div className="flex justify-center py-1">
                          <div className="bg-gradient-to-r from-blue-50 to-purple-50 px-3 py-1 rounded-full border border-blue-200 flex items-center gap-1.5">
                            <ArrowLeftRight className="h-3 w-3 text-purple-600" />
                            <span className="text-xs font-medium text-purple-700">
                              1 {foreignCurrency === 'USD_CASH' ? 'USD' : foreignCurrency} = {rate.toLocaleString('es-AR', { minimumFractionDigits: 2 })} ARS
                            </span>
                          </div>
                        </div>
                      )}
                      
                      {/* Destination account section - compact */}
                      <div className="bg-green-50 px-3 py-2 rounded-lg border border-green-200">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <ArrowDownLeft className="h-3 w-3 text-green-500" />
                            <span className="text-xs text-muted-foreground">Llega a</span>
                            <span className="font-medium text-green-700">{destAcc.name}</span>
                          </div>
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-white dark:bg-card">{destCurr === 'USD_CASH' ? 'USD' : destCurr}</Badge>
                        </div>
                        <div className="flex justify-between items-center mt-1 text-xs">
                          <span className="text-muted-foreground">Saldo: {destSymbol} {destBalance.toLocaleString('es-AR', { minimumFractionDigits: 2 })} → <span className="text-green-600">{destSymbol} {(destBalance + destAmount).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span></span>
                          <span className="text-green-700 font-bold">+{destSymbol} {destAmount.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                        </div>
                      </div>
                      
                      {/* Note if present */}
                      {values.description && (
                        <div className="bg-gray-50 dark:bg-slate-900 p-3 rounded-lg border border-gray-200 dark:border-slate-800">
                          <span className="text-muted-foreground text-xs block mb-1">Nota</span>
                          <span className="font-medium">{values.description}</span>
                        </div>
                      )}
                   </div>
                   );
                 })() : (
                   <div className="grid grid-cols-2 gap-4 text-sm text-left max-w-sm mx-auto bg-secondary/20 p-4 rounded-xl">
                      <div className="col-span-2">
                        <span className="text-muted-foreground block mb-1">
                          {isPending ? 'Fecha de Vencimiento' : 'Fecha'}
                        </span>
                        <FormField
                          control={form.control}
                          name="imputationDate"
                          render={({ field }) => (
                            <FormItem>
                              <FormControl>
                                <Input 
                                  type="date" 
                                  {...field}
                                  value={field.value || getArgentinaToday()}
                                  min={isPending ? getArgentinaToday() : undefined}
                                  onChange={(e) => {
                                    const newDate = e.target.value;
                                    if (isPending && newDate) {
                                      const err = validateImputationDate(newDate, values.type);
                                      if (err) {
                                        toast({ title: "Fecha inválida", description: err, variant: "destructive" });
                                        return;
                                      }
                                    }
                                    field.onChange(newDate);
                                  }}
                                  className="w-full"
                                  data-testid="input-confirm-date"
                                />
                              </FormControl>
                            </FormItem>
                          )}
                        />
                      </div>
                      <div>
                        <span className="text-muted-foreground block">Concepto</span>
                        <span className="font-medium">{values.category}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground block">Cuenta</span>
                        <span className="font-medium">
                          {accounts.find((a: any) => a.id === values.accountId)?.name || 
                            (isPending ? 'Sin asignar' : '-')}
                        </span>
                      </div>
                      <div className="col-span-2">
                        <span className="text-muted-foreground block">Comprobante</span>
                        <span className="font-medium">{values.hasInvoice ? 'Factura ' + values.invoiceType : 'Sin Factura'}</span>
                      </div>
                      {emitWithArca && values.hasInvoice &&
                        ((values.type === 'income' || values.type === 'receivable') ||
                          ((values.type === 'expense' || values.type === 'payable') && !!values.supplierId)) && (() => {
                        const emitterIva = invoicingAccount?.account?.ivaCondition;
                        // Estimated voucher type based on emitter + receiver IVA condition
                        // (matches the FA/FB/FC mapping the backend will apply).
                        let estimatedDocType = 'Factura B';
                        if (emitterIva === 'responsable_inscripto') {
                          estimatedDocType = emitReceiverIva === 'responsable_inscripto' ? 'Factura A' : 'Factura B';
                        } else if (emitterIva === 'monotributo' || emitterIva === 'exento') {
                          estimatedDocType = 'Factura C';
                        }
                        return (
                        <div className="col-span-2 rounded-md border border-cyan-200 bg-cyan-50/50 p-2 text-left" data-testid="summary-arca">
                          <span className="text-muted-foreground block text-xs">Emisión electrónica (ARCA)</span>
                          <span className="font-medium block" data-testid="summary-arca-doctype">
                            {invoicingAccount?.account?.environment === 'test' ? 'Modo Pruebas · ' : ''}
                            Tipo estimado: <strong>{estimatedDocType}</strong>
                          </span>
                          <span className="text-[11px] text-muted-foreground block italic">
                            El número de comprobante lo asigna ARCA al confirmar.
                          </span>
                          <span className="text-xs text-muted-foreground block">
                            Receptor: {emitReceiverName || '—'}
                            {emitReceiverTaxId ? ` (CUIT ${emitReceiverTaxId})` : ''}
                          </span>
                          <span className="text-xs text-muted-foreground block">
                            Total estimado:{' '}
                            <FormattedAmount
                              amount={String(emitTotals.total || 0)}
                              currency={accounts.find((a: any) => a.id === values.accountId)?.currency || selectedCurrency || 'ARS'}
                            />
                          </span>
                          {(() => {
                            const movementTotal = normalizeAmountInput((values.amount || '').toString());
                            const willChange =
                              movementTotal > 0 &&
                              emitTotals.total > 0 &&
                              Math.abs(emitTotals.total - movementTotal) > 0.005;
                            if (!willChange) return null;
                            return (
                              <span className="text-[11px] text-amber-700 block mt-1" data-testid="summary-arca-amount-change">
                                El total de la factura difiere del monto del movimiento; al emitir, el movimiento se ajustará al total del comprobante.
                              </span>
                            );
                          })()}
                          {emitSendEmail && (
                            <span className="text-xs text-cyan-800 block mt-1" data-testid="summary-email-recipients">
                              ✉️ Se enviará el PDF a: <strong>{emitReceiverEmail || '—'}</strong>
                              {emitCcList.length > 0 && ` · CC: ${emitCcList.join(', ')}`}
                              {emitSendSelfCopy && currentUser?.email && ` · Copia para vos (${currentUser.email})`}
                            </span>
                          )}
                          {!emitSendEmail && (
                            <span className="text-xs text-muted-foreground block mt-1">
                              Sin envío automático por email.
                            </span>
                          )}
                        </div>
                        );
                      })()}
                      {values.clientId && (
                        <div className="col-span-2">
                          <span className="text-muted-foreground block">Cliente</span>
                          <span className="font-medium">{clients.find((c: any) => c.id === values.clientId)?.name || '-'}</span>
                        </div>
                      )}
                      {values.supplierId && (
                        <div className="col-span-2">
                          <span className="text-muted-foreground block">Proveedor</span>
                          <span className="font-medium">{suppliers.find((s: any) => s.id === values.supplierId)?.name || '-'}</span>
                        </div>
                      )}
                      {values.productId && (
                        <div className="col-span-2">
                          <span className="text-muted-foreground block">Producto</span>
                          <span className="font-medium">
                            {products.find((p: any) => p.id === values.productId)?.name || '-'}
                          </span>
                        </div>
                      )}
                      {values.isRecurring && (() => {
                        const freqLabels: Record<string, string> = {
                          weekly: 'Semanal',
                          biweekly: 'Quincenal',
                          monthly: 'Mensual',
                          quarterly: 'Trimestral',
                          yearly: 'Anual',
                        };
                        const freqLabel = freqLabels[values.recurrenceFrequency || 'monthly'] || 'Mensual';
                        const total = values.recurrenceTotalInstallments;
                        const cuotasText = total ? `1 de ${total}` : 'Sin límite';
                        return (
                          <div
                            className="col-span-2 rounded-md border border-violet-200 bg-violet-50/60 p-2 text-left"
                            data-testid="summary-recurrence"
                          >
                            <span className="text-muted-foreground block text-xs">Recurrencia</span>
                            <span className="font-medium block" data-testid="summary-recurrence-frequency">
                              Recurrente: Sí · Frecuencia: <strong>{freqLabel}</strong>
                            </span>
                            <span className="text-xs text-muted-foreground block" data-testid="summary-recurrence-installments">
                              Cuotas: {cuotasText}
                            </span>
                            <span className="text-[11px] text-muted-foreground block italic mt-1">
                              {(values.type === 'income' || values.type === 'expense')
                                ? 'Se generará automáticamente la próxima cuota como compromiso pendiente en ' + (values.type === 'income' ? 'Cobros' : 'Pagos') + ' Recurrentes.'
                                : 'Al confirmar esta cuota se generará la siguiente automáticamente.'}
                            </span>
                          </div>
                        );
                      })()}
                   </div>
                 )}

                 {/* AI Classification Section */}
                 {(values.type === 'expense' || values.type === 'payable') && (
                   <div className="max-w-sm mx-auto mt-4">
                     <div className="p-4 rounded-xl bg-gradient-to-r from-cyan-50 to-pink-50 border border-cyan-200">
                       <div className="flex items-center justify-between mb-3">
                         <div className="flex items-center gap-2">
                           <Sparkles className="h-4 w-4 text-cyan-600" />
                           <span className="text-sm font-medium text-cyan-800">Clasificación IA</span>
                         </div>
                         {!isClassifying && classification && (
                           <Button
                             type="button"
                             variant="ghost"
                             size="sm"
                             onClick={classifyTransactionWithAI}
                             className="h-6 px-2 text-xs"
                           >
                             <RefreshCw className="h-3 w-3 mr-1" />
                             Reclasificar
                           </Button>
                         )}
                       </div>
                       
                       {isClassifying ? (
                         <div className="flex items-center justify-center py-4">
                           <Loader2 className="h-5 w-5 animate-spin text-cyan-600" />
                           <span className="ml-2 text-sm text-muted-foreground">Analizando...</span>
                         </div>
                       ) : classification ? (
                         <div className="space-y-3">
                           <div className="flex items-center justify-between">
                             <div className="flex items-center gap-2">
                               {classification.assetType === 'asset_acquisition' ? (
                                 <Building2 className="h-5 w-5 text-blue-600" />
                               ) : classification.assetType === 'investment' ? (
                                 <TrendingUp className="h-5 w-5 text-purple-600" />
                               ) : (
                                 <ArrowDownLeft className="h-5 w-5 text-red-600" />
                               )}
                               <span className="font-medium">
                                 {classificationOverride 
                                   ? ASSET_TYPE_LABELS[classificationOverride]
                                   : classification.assetTypeLabel}
                               </span>
                             </div>
                             <Badge 
                               variant={classification.confidence > 0.8 ? 'default' : 'secondary'}
                               className={cn(
                                 "text-xs",
                                 classification.confidence > 0.8 ? "bg-green-100 text-green-800" : 
                                 classification.confidence > 0.5 ? "bg-yellow-100 text-yellow-800" : 
                                 "bg-red-100 text-red-800"
                               )}
                             >
                               {Math.round(classification.confidence * 100)}% confianza
                             </Badge>
                           </div>
                           
                           {classification.assetCategory && !classificationOverride && (
                             <div className="text-sm text-muted-foreground">
                               <span>Categoría: </span>
                               <span className="font-medium">{classification.assetCategoryLabel}</span>
                               {classification.suggestedUsefulLifeMonths && (
                                 <span className="ml-2">
                                   ({Math.round(classification.suggestedUsefulLifeMonths / 12)} años vida útil)
                                 </span>
                               )}
                             </div>
                           )}
                           
                           <p className="text-xs text-muted-foreground italic">
                             {classification.reasoning}
                           </p>
                           
                           {/* Override options */}
                           <div className="pt-2 border-t border-cyan-200">
                             <p className="text-xs text-muted-foreground mb-2">¿Clasificación incorrecta? Elegí:</p>
                             <div className="flex flex-wrap gap-2">
                               {(['expense', 'asset_acquisition', 'investment'] as AssetType[]).map((type) => (
                                 <Button
                                   key={type}
                                   type="button"
                                   variant={classificationOverride === type ? 'default' : 'outline'}
                                   size="sm"
                                   onClick={() => setClassificationOverride(
                                     classificationOverride === type ? null : type
                                   )}
                                   className={cn(
                                     "text-xs h-7",
                                     classificationOverride === type && "bg-cyan-600 hover:bg-cyan-700"
                                   )}
                                 >
                                   {ASSET_TYPE_LABELS[type]}
                                 </Button>
                               ))}
                             </div>
                           </div>
                         </div>
                       ) : (
                         <p className="text-sm text-muted-foreground text-center py-2">
                           No se pudo clasificar la transacción
                         </p>
                       )}
                     </div>
                     
                     {classification?.assetType === 'asset_acquisition' && !classificationOverride && (
                       <p className="mt-2 text-xs text-center text-cyan-700">
                         Esta transacción sumará al patrimonio de la empresa
                       </p>
                     )}
                   </div>
                 )}
               </div>
            )}

          </Form>
          )}
        </div>

        {canCreateTransactions && (
        <div className="p-6 bg-background border-t border-border flex justify-between items-center shrink-0">
          {step !== 'type' ? (
             <Button variant="ghost" onClick={handleBack}>
               Atrás
             </Button>
          ) : (
            <div />
          )}

          {step !== 'confirm' ? (
            step !== 'type' && (
              <Button onClick={handleNext} className="rounded-full px-8">
                Siguiente
              </Button>
            )
          ) : (
            <Button
              onClick={() => onSubmit()}
              disabled={createTransactionMutation.isPending || emitSubmitting}
              className="rounded-full px-8 bg-green-600 hover:bg-green-700 text-white"
              data-testid="button-confirm"
            >
              {createTransactionMutation.isPending
                ? 'Procesando...'
                : emitSubmitting
                  ? 'Emitiendo factura...'
                  : 'Confirmar Operación'}
            </Button>
          )}
        </div>
        )}
      </DialogContent>
    </Dialog>

    <AlertDialog open={showNegativeBalanceWarning} onOpenChange={setShowNegativeBalanceWarning}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-red-600">
            <AlertTriangle className="h-5 w-5" />
            {negativeBalanceInfo?.isPayable ? 'Saldo Insuficiente' : 'Saldo Negativo'}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-base" asChild>
            <div>
              {negativeBalanceInfo?.isPayable ? (
                <>
                  <p>
                    La cuenta <span className="font-semibold">{negativeBalanceInfo?.accountName}</span> no tiene saldo suficiente al día de hoy para cubrir este compromiso de pago.
                  </p>
                  <p className="mt-2">
                    Saldo resultante:{' '}
                    <span className="font-semibold text-red-600">
                      AR$ {negativeBalanceInfo?.newBalance?.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                    </span>
                  </p>
                  <p className="mt-3 text-amber-700 font-medium">
                    Si al vencimiento no hay fondos, el pago no podrá realizarse.
                  </p>
                  <p className="mt-2">
                    ¿Querés registrar el compromiso de todas formas y permitir saldo negativo?
                  </p>
                </>
              ) : (
                <>
                  <p>
                    La cuenta <span className="font-semibold">{negativeBalanceInfo?.accountName}</span> no tiene saldo suficiente.
                  </p>
                  <p className="mt-2">
                    Saldo actual:{' '}
                    <span className="font-semibold">
                      AR$ {negativeBalanceInfo?.currentBalance?.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                    </span>
                  </p>
                  <p className="mt-2">
                    Saldo resultante:{' '}
                    <span className="font-semibold text-red-600">
                      AR$ {negativeBalanceInfo?.newBalance?.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                    </span>
                  </p>
                  <p className="mt-3 text-amber-700">
                    ¿Querés registrar el gasto y dejar la cuenta en negativo?
                  </p>
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setShowNegativeBalanceWarning(false)}>
            Cancelar
          </AlertDialogCancel>
          <AlertDialogAction 
            onClick={handleConfirmNegativeBalance}
            className="bg-red-600 hover:bg-red-700"
            disabled={createTransactionMutation.isPending}
          >
            {createTransactionMutation.isPending ? 'Procesando...' : 'Sí, registrar igual'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>


    {/* Inline Supplier Creation Dialog */}
    <AlertDialog open={showNewSupplierDialog} onOpenChange={setShowNewSupplierDialog}>
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
                  placeholder="Ej: COTO, Mercado Libre"
                  className="mt-1"
                  autoFocus
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Podés completar más datos después en Base de Datos → Proveedores
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => {
            setShowNewSupplierDialog(false);
            setNewSupplierName('');
          }}>
            Cancelar
          </AlertDialogCancel>
          <AlertDialogAction 
            disabled={!newSupplierName.trim() || createSupplierMutation.isPending}
            onClick={async () => {
              if (!newSupplierName.trim()) return;
              try {
                const newSupplier = await createSupplierMutation.mutateAsync({ name: newSupplierName.trim() });
                form.setValue('supplierId', newSupplier.id);
                setNewSupplierName('');
                setShowNewSupplierDialog(false);
                toast({ title: 'Proveedor creado', description: `"${newSupplier.name}" agregado` });
              } catch (error) {
                toast({ title: 'Error', description: 'No se pudo crear el proveedor', variant: 'destructive' });
              }
            }}
          >
            {createSupplierMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Crear proveedor'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    {/* Task #230: Inline Payment Method Creation Dialog. Mounted as a sibling of
        the wizard Dialog (not nested), same as the client/supplier inline dialogs.
        On save, the new method is auto-selected on the form. */}
    <PaymentMethodEditorDialog
      open={showNewPaymentMethodDialog}
      onOpenChange={setShowNewPaymentMethodDialog}
      onSaved={(saved) => {
        form.setValue('paymentMethodId', saved.id, { shouldDirty: true, shouldValidate: true });
      }}
    />

    {/* Inline Client Creation Dialog */}
    <AlertDialog open={showNewClientDialog} onOpenChange={setShowNewClientDialog}>
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
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Podés completar más datos después en Base de Datos → Clientes
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => {
            setShowNewClientDialog(false);
            setNewClientName('');
          }}>
            Cancelar
          </AlertDialogCancel>
          <AlertDialogAction 
            disabled={!newClientName.trim() || createClientMutation.isPending}
            onClick={async () => {
              if (!newClientName.trim()) return;
              try {
                const newClient = await createClientMutation.mutateAsync({ name: newClientName.trim() });
                form.setValue('clientId', newClient.id);
                setNewClientName('');
                setShowNewClientDialog(false);
                toast({ title: 'Cliente creado', description: `"${newClient.name}" agregado` });
              } catch (error) {
                toast({ title: 'Error', description: 'No se pudo crear el cliente', variant: 'destructive' });
              }
            }}
          >
            {createClientMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Crear cliente'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    {/* Inline Product Creation Dialog - Full fields */}
    <AlertDialog open={showNewProductDialog} onOpenChange={(open) => {
      if (!open) {
        setNewProductName('');
        setNewProductCategory('');
        setNewProductSku('');
        setNewProductDescription('');
        setNewProductType('product');
        setNewProductBarcode('');
        setNewProductCostCurrency('ARS');
        setNewProductCostPrice('');
        setNewProductSalePrice('');
        setNewProductStock('');
        setNewProductMinStock('');
        setNewProductUnit('unidad');
        setNewProductPurchaseDate('');
        setNewProductUsefulLife('');
        setNewProductCurrentValue('');
      }
      setShowNewProductDialog(open);
    }}>
      <AlertDialogContent className="max-w-lg max-h-[85vh] flex flex-col" aria-describedby="quick-product-desc">
        <AlertDialogHeader>
          <AlertDialogTitle>Agregar Producto</AlertDialogTitle>
          <AlertDialogDescription id="quick-product-desc" className="sr-only">Completá los datos del nuevo producto</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="overflow-y-auto flex-1 pr-1 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-sm font-medium text-foreground">Nombre del producto *</label>
              <Input 
                value={newProductName}
                onChange={(e) => setNewProductName(e.target.value)}
                placeholder="Ej: Resma A4, Servicio de diseño"
                className="mt-1"
                autoFocus
                data-testid="input-quick-product-name"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground">Tipo</label>
              <Select value={newProductType} onValueChange={setNewProductType}>
                <SelectTrigger className="mt-1" data-testid="select-quick-product-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRODUCT_TYPES.map(t => (
                    <SelectItem key={t} value={t}>{PRODUCT_TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium text-foreground">Categoría</label>
              <Input 
                value={newProductCategory}
                onChange={(e) => setNewProductCategory(e.target.value)}
                placeholder="Ej: Insumos"
                className="mt-1"
                data-testid="input-quick-product-category"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-foreground">SKU / Código</label>
              <Input 
                value={newProductSku}
                onChange={(e) => setNewProductSku(e.target.value)}
                placeholder="Ej: PROD-001"
                className="mt-1"
                data-testid="input-quick-product-sku"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground">Código de barras</label>
              <Input 
                value={newProductBarcode}
                onChange={(e) => setNewProductBarcode(e.target.value)}
                placeholder="Ej: 7790001000"
                className="mt-1"
                data-testid="input-quick-product-barcode"
              />
            </div>
          </div>

          <div className="border-t pt-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Precios</p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-sm font-medium text-foreground">Moneda</label>
                <Select value={newProductCostCurrency} onValueChange={setNewProductCostCurrency}>
                  <SelectTrigger className="mt-1" data-testid="select-quick-product-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map(c => (
                      <SelectItem key={c} value={c}>{c.replace('_CASH', ' Billete')}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium text-foreground">Precio costo</label>
                <Input 
                  type="number"
                  step="0.01"
                  value={newProductCostPrice}
                  onChange={(e) => setNewProductCostPrice(e.target.value)}
                  placeholder="0.00"
                  className="mt-1"
                  data-testid="input-quick-product-cost"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground">Precio venta</label>
                <Input 
                  type="number"
                  step="0.01"
                  value={newProductSalePrice}
                  onChange={(e) => setNewProductSalePrice(e.target.value)}
                  placeholder="0.00"
                  className="mt-1"
                  data-testid="input-quick-product-sale-price"
                />
              </div>
            </div>
          </div>

          <div className="border-t pt-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Inventario</p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-sm font-medium text-foreground">Stock actual</label>
                <Input 
                  type="number"
                  step="0.01"
                  value={newProductStock}
                  onChange={(e) => setNewProductStock(e.target.value)}
                  placeholder="0"
                  className="mt-1"
                  data-testid="input-quick-product-stock"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground">Stock mínimo</label>
                <Input 
                  type="number"
                  step="0.01"
                  value={newProductMinStock}
                  onChange={(e) => setNewProductMinStock(e.target.value)}
                  placeholder="0"
                  className="mt-1"
                  data-testid="input-quick-product-min-stock"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground">Unidad</label>
                <Select value={newProductUnit} onValueChange={setNewProductUnit}>
                  <SelectTrigger className="mt-1" data-testid="select-quick-product-unit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[
                      { value: 'unidad', label: 'Unidad' },
                      { value: 'kg', label: 'Kilogramo' },
                      { value: 'gramo', label: 'Gramo' },
                      { value: 'litro', label: 'Litro' },
                      { value: 'ml', label: 'Mililitro' },
                      { value: 'metro', label: 'Metro' },
                      { value: 'caja', label: 'Caja' },
                      { value: 'paquete', label: 'Paquete' },
                      { value: 'par', label: 'Par' },
                      { value: 'docena', label: 'Docena' },
                      { value: 'tonelada', label: 'Tonelada' },
                    ].map(u => (
                      <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {newProductType === 'asset' && (
            <div className="border-t pt-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Datos del activo</p>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-sm font-medium text-foreground">Fecha compra</label>
                  <Input 
                    type="date"
                    value={newProductPurchaseDate}
                    onChange={(e) => setNewProductPurchaseDate(e.target.value)}
                    className="mt-1"
                    data-testid="input-quick-product-purchase-date"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground">Vida útil (meses)</label>
                  <Input 
                    type="number"
                    value={newProductUsefulLife}
                    onChange={(e) => setNewProductUsefulLife(e.target.value)}
                    placeholder="Ej: 60"
                    className="mt-1"
                    data-testid="input-quick-product-useful-life"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground">Valor actual</label>
                  <Input 
                    type="number"
                    step="0.01"
                    value={newProductCurrentValue}
                    onChange={(e) => setNewProductCurrentValue(e.target.value)}
                    placeholder="0.00"
                    className="mt-1"
                    data-testid="input-quick-product-current-value"
                  />
                </div>
              </div>
            </div>
          )}

          <div>
            <label className="text-sm font-medium text-foreground">Descripción</label>
            <Input 
              value={newProductDescription}
              onChange={(e) => setNewProductDescription(e.target.value)}
              placeholder="Detalles adicionales..."
              className="mt-1"
              data-testid="input-quick-product-description"
            />
          </div>
        </div>
        <AlertDialogFooter className="pt-3 border-t">
          <AlertDialogCancel>
            Cancelar
          </AlertDialogCancel>
          <AlertDialogAction 
            disabled={!newProductName.trim() || createProductMutation.isPending}
            onClick={async () => {
              if (!newProductName.trim()) return;
              try {
                const productData: any = { 
                  name: newProductName.trim(),
                  productType: newProductType,
                };
                if (newProductCategory) productData.category = newProductCategory;
                if (newProductSku) productData.sku = newProductSku;
                if (newProductDescription) productData.description = newProductDescription;
                if (newProductBarcode) productData.barcode = newProductBarcode;
                if (newProductCostCurrency) productData.costCurrency = newProductCostCurrency;
                if (newProductCostPrice) productData.costPrice = newProductCostPrice;
                if (newProductSalePrice) productData.salePrice = newProductSalePrice;
                if (newProductStock) productData.stock = newProductStock;
                if (newProductMinStock) productData.minStock = newProductMinStock;
                if (newProductUnit) productData.unit = newProductUnit;
                if (newProductType === 'asset') {
                  if (newProductPurchaseDate) productData.purchaseDate = newProductPurchaseDate;
                  if (newProductUsefulLife) productData.usefulLife = parseInt(newProductUsefulLife);
                  if (newProductCurrentValue) productData.currentValue = newProductCurrentValue;
                }
                
                const newProduct = await createProductMutation.mutateAsync(productData);
                form.setValue('productId', newProduct.id);
                form.setValue('description', newProduct.name);
                if (newProduct.category) form.setValue('category', newProduct.category);

                const currentType = form.getValues('type');
                const unitPrice = getProductUnitPrice(newProduct, currentType);
                setProductUnitPrice(unitPrice);
                form.setValue('productQuantity', '1');
                if (unitPrice > 0) {
                  const total = unitPrice.toFixed(2);
                  form.setValue('amount', total);
                  setAmountDisplay(formatAmountForDisplay(total));
                }

                setShowNewProductDialog(false);
                toast({ title: 'Producto creado', description: `"${newProduct.name}" agregado y seleccionado` });
              } catch (error) {
                toast({ title: 'Error', description: 'No se pudo crear el producto', variant: 'destructive' });
              }
            }}
          >
            {createProductMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Crear producto'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    {/* Close confirmation dialog */}
    <AlertDialog open={showCloseConfirmation} onOpenChange={setShowCloseConfirmation}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>¿Cerrar sin guardar?</AlertDialogTitle>
          <AlertDialogDescription>
            Los datos que cargaste en este movimiento se perderán. ¿Estás seguro de que querés cerrar?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setShowCloseConfirmation(false)}>
            Seguir editando
          </AlertDialogCancel>
          <AlertDialogAction 
            onClick={handleConfirmClose}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Cerrar y descartar
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
