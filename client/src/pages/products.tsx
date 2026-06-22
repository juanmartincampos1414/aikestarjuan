import React from 'react';
import { useForm, useWatch, type UseFormReturn } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { productAPI } from '@/lib/api';
import { useMembership, useExchangeRates } from '@/lib/hooks';
import { ROLE_PERMISSIONS, type Role, CURRENCIES, CURRENCY_SYMBOLS, PRODUCT_TYPES, PRODUCT_TYPE_LABELS, type ProductType } from '@shared/schema';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useUndoDelete } from '@/hooks/use-undo-delete';
import { Package, Plus, Trash2, Pencil, MoreVertical, Eye, ShieldAlert, Wrench, Building2, ArrowDownCircle, ArrowUpCircle, RefreshCw, AlertTriangle, BoxesIcon, Calculator, ChevronDown, ChevronUp, LayoutGrid, List, FileSpreadsheet, Search, X, Upload, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import * as XLSX from 'xlsx';
import { BackButton } from '@/components/BackButton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ToastAction } from '@/components/ui/toast';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import type { Product } from '@shared/schema';

const productSchema = z.object({
  name: z.string().min(2, 'El nombre es requerido'),
  description: z.string().optional(),
  productType: z.enum(PRODUCT_TYPES, { required_error: 'Seleccioná un tipo' }),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  category: z.string().optional(),
  defaultProfitabilityCodeId: z.string().optional(),
  costPrice: z.string().optional(),
  costCurrency: z.string().optional().default('ARS'),
  salePrice: z.string().optional(),
  stock: z.string().optional(),
  minStock: z.string().optional(),
  unit: z.string().optional(),
  ivaAliquot: z.string().optional(),
  purchaseDate: z.string().optional(),
  usefulLifeMonths: z.string().optional(),
  currentValue: z.string().optional(),
});

type ProductFormValues = z.infer<typeof productSchema>;

// Alícuotas de IVA disponibles para asignar a un producto. 21% y 10.5% son las
// más usadas; se incluye el resto del set estándar de ARCA para consistencia con
// el modal de emisión de factura.
const PRODUCT_IVA_OPTIONS = [21, 10.5, 0, 2.5, 5, 27];

const PRODUCT_TYPE_ICON: Record<ProductType, React.ReactNode> = {
  'product': <Package className="h-5 w-5 text-primary" />,
  'service': <Wrench className="h-5 w-5 text-blue-500" />,
  'asset': <Building2 className="h-5 w-5 text-amber-500" />,
};

const PRODUCT_TYPE_BADGE_CLASS: Record<ProductType, string> = {
  'product': 'bg-cyan-500/10 text-cyan-600 border-cyan-500/20',
  'service': 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  'asset': 'bg-amber-500/10 text-amber-600 border-amber-500/20',
};

const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  entry: 'Entrada',
  exit: 'Salida',
  adjustment: 'Ajuste',
};

const UNIT_OPTIONS = [
  { value: 'unidad', label: 'Unidad' },
  { value: 'kg', label: 'Kilogramo (kg)' },
  { value: 'gramo', label: 'Gramo (g)' },
  { value: 'litro', label: 'Litro (l)' },
  { value: 'ml', label: 'Mililitro (ml)' },
  { value: 'metro', label: 'Metro (m)' },
  { value: 'caja', label: 'Caja' },
  { value: 'paquete', label: 'Paquete' },
  { value: 'par', label: 'Par' },
  { value: 'docena', label: 'Docena' },
  { value: 'tonelada', label: 'Tonelada' },
];

const PLURAL_MAP: Record<string, string> = {
  unidad: 'unidades',
  litro: 'litros',
  metro: 'metros',
  caja: 'cajas',
  paquete: 'paquetes',
  par: 'pares',
  docena: 'docenas',
  tonelada: 'toneladas',
  gramo: 'gramos',
};

function pluralizeUnit(unit: string, quantity: number): string {
  if (quantity <= 1) return unit;
  return PLURAL_MAP[unit.toLowerCase()] || unit;
}

function PricingCalculator({ formInstance }: { formInstance: UseFormReturn<ProductFormValues> }) {
  const costPriceRaw = useWatch({ control: formInstance.control, name: 'costPrice' });
  const costCurrency = useWatch({ control: formInstance.control, name: 'costCurrency' }) || 'ARS';
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<'markup' | 'margin'>('markup');
  const [markupStr, setMarkupStr] = React.useState('30');
  const [marginStr, setMarginStr] = React.useState('25');

  const cost = parseFloat(costPriceRaw || '');
  const hasCost = !isNaN(cost) && cost > 0;
  const sym = CURRENCY_SYMBOLS[costCurrency as keyof typeof CURRENCY_SYMBOLS] || '$';
  const fmt = (n: number) => `${sym} ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const markupPct = parseFloat(markupStr);
  const marginPct = parseFloat(marginStr);

  let suggested: number | null = null;
  let marginError: string | null = null;

  if (hasCost) {
    if (mode === 'markup') {
      if (!isNaN(markupPct)) {
        suggested = cost * (1 + markupPct / 100);
      }
    } else {
      if (!isNaN(marginPct)) {
        if (marginPct >= 100) {
          marginError = 'El margen debe ser menor a 100%';
        } else {
          suggested = cost / (1 - marginPct / 100);
        }
      }
    }
  }

  const unitProfit = suggested != null ? suggested - cost : null;
  const realMargin = suggested != null && suggested > 0 ? ((suggested - cost) / suggested) * 100 : null;
  const realMarkup = suggested != null && cost > 0 ? ((suggested - cost) / cost) * 100 : null;

  const applyToSalePrice = () => {
    if (suggested == null || suggested <= 0) return;
    formInstance.setValue('salePrice', suggested.toFixed(2), { shouldDirty: true, shouldValidate: true });
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border border-purple-500/20 rounded-lg bg-purple-500/5">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full flex items-center justify-between px-4 py-3 text-left"
            data-testid="toggle-pricing-calculator"
          >
            <span className="flex items-center gap-2 text-sm font-medium text-purple-700">
              <Calculator className="h-4 w-4" />
              Calculadora de precio sugerido
            </span>
            {open ? <ChevronUp className="h-4 w-4 text-purple-700" /> : <ChevronDown className="h-4 w-4 text-purple-700" />}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-4 pb-4 space-y-3">
            {!hasCost && (
              <p className="text-xs text-muted-foreground" data-testid="text-pricing-no-cost">
                Ingresá primero el precio de costo para calcular el precio sugerido.
              </p>
            )}

            <RadioGroup
              value={mode}
              onValueChange={(v) => setMode(v as 'markup' | 'margin')}
              className="flex flex-col sm:flex-row gap-3"
              disabled={!hasCost}
            >
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <RadioGroupItem value="markup" id="pricing-mode-markup" data-testid="radio-pricing-mode-markup" />
                <span>Markup sobre el costo</span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <RadioGroupItem value="margin" id="pricing-mode-margin" data-testid="radio-pricing-mode-margin" />
                <span>Margen sobre la venta</span>
              </label>
            </RadioGroup>

            {mode === 'markup' ? (
              <div className="space-y-1">
                <Label htmlFor="input-markup" className="text-xs">Markup (% sobre el costo)</Label>
                <div className="relative">
                  <Input
                    id="input-markup"
                    type="number"
                    min={0}
                    max={1000}
                    step={1}
                    value={markupStr}
                    onChange={(e) => setMarkupStr(e.target.value)}
                    disabled={!hasCost}
                    className="pr-8"
                    data-testid="input-pricing-markup"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                <Label htmlFor="input-margin" className="text-xs">Margen (% sobre la venta)</Label>
                <div className="relative">
                  <Input
                    id="input-margin"
                    type="number"
                    min={0}
                    max={99}
                    step={1}
                    value={marginStr}
                    onChange={(e) => setMarginStr(e.target.value)}
                    disabled={!hasCost}
                    className="pr-8"
                    data-testid="input-pricing-margin"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
                </div>
                {marginError && (
                  <p className="text-xs text-red-600" data-testid="text-pricing-margin-error">{marginError}</p>
                )}
              </div>
            )}

            {hasCost && suggested != null && suggested > 0 && (
              <div className="rounded-md bg-background/60 border border-purple-500/10 px-3 py-2 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Precio sugerido:</span>
                  <span className="font-semibold text-green-600" data-testid="text-pricing-suggested-price">{fmt(suggested)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Ganancia por unidad:</span>
                  <span className="font-medium" data-testid="text-pricing-unit-profit">{unitProfit != null ? fmt(unitProfit) : '-'}</span>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Margen real:</span>
                  <span>
                    {realMargin != null ? `${realMargin.toFixed(1).replace('.', ',')}%` : '-'}
                    {' · '}
                    Markup real: {realMarkup != null ? `${realMarkup.toFixed(1).replace('.', ',')}%` : '-'}
                  </span>
                </div>
              </div>
            )}

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full border-purple-500/30 text-purple-700 hover:bg-purple-500/10"
              onClick={applyToSalePrice}
              disabled={!hasCost || suggested == null || suggested <= 0}
              data-testid="button-apply-suggested-price"
            >
              Aplicar al precio de venta
            </Button>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function ProductFormFields({ formInstance }: { formInstance: any }) {
  const currentType = useWatch({ control: formInstance.control, name: 'productType' });
  const isProduct = currentType === 'product';
  const isAsset = currentType === 'asset';
  const { data: profitabilityCodes = [] } = useQuery<Array<{id: string; code: string; name: string; color: string | null; isActive: boolean}>>({
    queryKey: ['/api/profitability-codes'],
    queryFn: async () => {
      const res = await fetch('/api/profitability-codes', { credentials: 'include' });
      if (!res.ok) return [];
      return res.json();
    },
  });
  return (
    <>
      <FormField
        control={formInstance.control}
        name="name"
        render={({ field }: any) => (
          <FormItem>
            <FormLabel>Nombre *</FormLabel>
            <FormControl>
              <Input placeholder="Nombre del producto" {...field} data-testid="input-product-name" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={formInstance.control}
        name="productType"
        render={({ field }: any) => (
          <FormItem>
            <FormLabel>Tipo *</FormLabel>
            <Select onValueChange={field.onChange} value={field.value || undefined}>
              <FormControl>
                <SelectTrigger data-testid="select-product-type">
                  <SelectValue placeholder="Seleccionar tipo" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {PRODUCT_TYPES.map(t => (
                  <SelectItem key={t} value={t}>{PRODUCT_TYPE_LABELS[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={formInstance.control}
        name="description"
        render={({ field }: any) => (
          <FormItem>
            <FormLabel>Descripcion</FormLabel>
            <FormControl>
              <Textarea placeholder="Descripcion del producto..." {...field} data-testid="input-product-description" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={formInstance.control}
          name="sku"
          render={({ field }: any) => (
            <FormItem>
              <FormLabel>SKU</FormLabel>
              <FormControl>
                <Input placeholder="SKU-001" {...field} data-testid="input-product-sku" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={formInstance.control}
          name="barcode"
          render={({ field }: any) => (
            <FormItem>
              <FormLabel>Codigo de barras</FormLabel>
              <FormControl>
                <Input placeholder="1234567890123" {...field} data-testid="input-product-barcode" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <FormField
        control={formInstance.control}
        name="category"
        render={({ field }: any) => (
          <FormItem>
            <FormLabel>Categoria</FormLabel>
            <FormControl>
              <Input placeholder="Insumos, Electrónica..." {...field} data-testid="input-product-category" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={formInstance.control}
        name="defaultProfitabilityCodeId"
        render={({ field }: any) => (
          <FormItem>
            <FormLabel>Código de rentabilidad por defecto (opcional)</FormLabel>
            <Select
              onValueChange={(val) => field.onChange(val === '__none__' ? '' : val)}
              value={field.value || '__none__'}
            >
              <FormControl>
                <SelectTrigger data-testid="select-product-profitability-code">
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
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-1">
          <FormField
            control={formInstance.control}
            name="costCurrency"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>Moneda costo</FormLabel>
                <Select onValueChange={field.onChange} value={field.value || 'ARS'}>
                  <FormControl>
                    <SelectTrigger data-testid="select-cost-currency">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {CURRENCIES.map(c => (
                      <SelectItem key={c} value={c}>{CURRENCY_SYMBOLS[c]} {c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={formInstance.control}
          name="costPrice"
          render={({ field }: any) => (
            <FormItem>
              <FormLabel>Precio de costo</FormLabel>
              <FormControl>
                <Input type="number" step="0.01" placeholder="0.00" {...field} data-testid="input-product-cost" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={formInstance.control}
          name="salePrice"
          render={({ field }: any) => (
            <FormItem>
              <FormLabel>Precio de venta</FormLabel>
              <FormControl>
                <Input type="number" step="0.01" placeholder="0.00" {...field} data-testid="input-product-price" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <FormField
        control={formInstance.control}
        name="ivaAliquot"
        render={({ field }: any) => (
          <FormItem>
            <FormLabel>IVA</FormLabel>
            <Select onValueChange={field.onChange} value={field.value || '21'}>
              <FormControl>
                <SelectTrigger data-testid="select-product-iva">
                  <SelectValue placeholder="Seleccionar IVA" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {PRODUCT_IVA_OPTIONS.map((a) => (
                  <SelectItem key={a} value={String(a)} data-testid={`option-product-iva-${a}`}>
                    {String(a).replace('.', ',')}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">Se usa como IVA por defecto al emitir la factura de este producto</p>
            <FormMessage />
          </FormItem>
        )}
      />

      {!isAsset && (
        <PricingCalculator formInstance={formInstance} />
      )}

      {!isAsset && (
        <div className="border border-cyan-500/20 rounded-lg p-4 space-y-4 bg-cyan-500/5">
          <p className="text-sm font-medium text-cyan-700">Inventario</p>
            <div className="grid grid-cols-3 gap-3">
              <FormField
                control={formInstance.control}
                name="stock"
                render={({ field }: any) => (
                  <FormItem>
                    <FormLabel>Stock actual</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" placeholder="0" {...field} data-testid="input-product-stock" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={formInstance.control}
                name="minStock"
                render={({ field }: any) => (
                  <FormItem>
                    <FormLabel>Stock minimo</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" placeholder="0" {...field} data-testid="input-product-min-stock" />
                    </FormControl>
                    <p className="text-xs text-muted-foreground mt-1">Te avisamos cuando el stock baje de este nivel</p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={formInstance.control}
                name="unit"
                render={({ field }: any) => (
                  <FormItem>
                    <FormLabel>Unidad</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || 'unidad'}>
                      <FormControl>
                        <SelectTrigger data-testid="select-product-unit">
                          <SelectValue placeholder="Seleccionar" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {UNIT_OPTIONS.map(u => (
                          <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
        </div>
      )}

      {isAsset && (
        <div className="border border-amber-500/20 rounded-lg p-4 space-y-4 bg-amber-500/5">
          <p className="text-sm font-medium text-amber-600">Campos de activo</p>
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={formInstance.control}
              name="purchaseDate"
              render={({ field }: any) => (
                <FormItem>
                  <FormLabel>Fecha de compra</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} data-testid="input-product-purchase-date" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={formInstance.control}
              name="usefulLifeMonths"
              render={({ field }: any) => (
                <FormItem>
                  <FormLabel>Vida util (meses)</FormLabel>
                  <FormControl>
                    <Input type="number" placeholder="60" {...field} data-testid="input-product-useful-life" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <FormField
            control={formInstance.control}
            name="currentValue"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>Valor actual</FormLabel>
                <FormControl>
                  <Input type="number" step="0.01" placeholder="0.00" {...field} data-testid="input-product-current-value" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      )}
    </>
  );
}

function StockMovementDialog({ product, open, onOpenChange }: { product: Product; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [movementType, setMovementType] = React.useState<string>('entry');
  const [quantity, setQuantity] = React.useState('');
  const [reason, setReason] = React.useState('');

  const currentStock = parseFloat(product.stock || '0');
  const unit = product.unit || 'unidades';

  const { data: movements = [] } = useQuery({
    queryKey: ['/api/products', product.id, 'movements'],
    queryFn: () => productAPI.getStockMovements(product.id),
    enabled: open,
  });

  const mutation = useMutation({
    mutationFn: (data: { type: string; quantity: string; reason?: string }) =>
      productAPI.createStockMovement(product.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      queryClient.invalidateQueries({ queryKey: ['/api/products', product.id, 'movements'] });
      toast({ title: "Stock actualizado" });
      setQuantity('');
      setReason('');
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const parsedQty = parseFloat(quantity) || 0;
  let previewStock = currentStock;
  if (movementType === 'entry') previewStock = currentStock + parsedQty;
  else if (movementType === 'exit') previewStock = currentStock - parsedQty;
  else if (movementType === 'adjustment') previewStock = parsedQty;

  const handleSubmit = () => {
    if (!quantity || parsedQty <= 0) {
      toast({ title: "Error", description: "Ingresá una cantidad válida", variant: "destructive" });
      return;
    }
    if (movementType === 'exit' && parsedQty > currentStock) {
      toast({ title: "Error", description: "No podés sacar más de lo que hay en stock", variant: "destructive" });
      return;
    }
    mutation.mutate({ type: movementType, quantity, reason: reason || undefined });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BoxesIcon className="h-5 w-5 text-primary" />
            Stock de {product.name}
          </DialogTitle>
          <DialogDescription>
            Stock actual: <span className="font-semibold">{currentStock} {pluralizeUnit(unit, currentStock)}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            <Button
              type="button"
              variant={movementType === 'entry' ? 'default' : 'outline'}
              className={movementType === 'entry' ? 'bg-green-600 hover:bg-green-700' : ''}
              onClick={() => setMovementType('entry')}
              data-testid="button-stock-entry"
            >
              <ArrowDownCircle className="h-4 w-4 mr-1" /> Entrada
            </Button>
            <Button
              type="button"
              variant={movementType === 'exit' ? 'default' : 'outline'}
              className={movementType === 'exit' ? 'bg-red-600 hover:bg-red-700' : ''}
              onClick={() => setMovementType('exit')}
              data-testid="button-stock-exit"
            >
              <ArrowUpCircle className="h-4 w-4 mr-1" /> Salida
            </Button>
            <Button
              type="button"
              variant={movementType === 'adjustment' ? 'default' : 'outline'}
              className={movementType === 'adjustment' ? 'bg-blue-600 hover:bg-blue-700' : ''}
              onClick={() => setMovementType('adjustment')}
              data-testid="button-stock-adjustment"
            >
              <RefreshCw className="h-4 w-4 mr-1" /> Ajuste
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">
                {movementType === 'adjustment' ? 'Nuevo stock' : 'Cantidad'} *
              </label>
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                data-testid="input-stock-quantity"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Motivo</label>
              <Input
                placeholder="Compra, venta, inventario..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                data-testid="input-stock-reason"
              />
            </div>
          </div>

          {parsedQty > 0 && (
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50 text-sm">
              <span className="text-muted-foreground">Stock actual: <span className="font-medium text-foreground">{currentStock} {pluralizeUnit(unit, currentStock)}</span></span>
              <span className="text-muted-foreground">→</span>
              <span className="text-muted-foreground">Nuevo stock: <span className={`font-semibold ${previewStock < 0 ? 'text-red-600' : 'text-foreground'}`}>{previewStock} {pluralizeUnit(unit, previewStock)}</span></span>
            </div>
          )}

          <Button
            onClick={handleSubmit}
            disabled={mutation.isPending || !quantity || parsedQty <= 0}
            className="w-full"
            data-testid="button-save-stock"
          >
            {mutation.isPending ? 'Guardando...' : 'Registrar movimiento'}
          </Button>

          {movements.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-2 text-muted-foreground">Historial de movimientos</h4>
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Fecha</TableHead>
                      <TableHead className="text-xs">Tipo</TableHead>
                      <TableHead className="text-xs text-right">Cantidad</TableHead>
                      <TableHead className="text-xs text-right">Stock</TableHead>
                      <TableHead className="text-xs">Motivo</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {movements.slice(0, 20).map((m: any) => (
                      <TableRow key={m.id}>
                        <TableCell className="text-xs">{new Date(m.createdAt).toLocaleDateString('es-AR')}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-xs ${
                            m.type === 'entry' ? 'text-green-600 border-green-300' :
                            m.type === 'exit' ? 'text-red-600 border-red-300' :
                            'text-blue-600 border-blue-300'
                          }`}>
                            {MOVEMENT_TYPE_LABELS[m.type] || m.type}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-right font-medium">
                          {m.type === 'entry' ? '+' : m.type === 'exit' ? '-' : ''}{parseFloat(m.quantity)}
                        </TableCell>
                        <TableCell className="text-xs text-right">{parseFloat(m.newStock)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-[120px] truncate">{m.reason || '-'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type ImportRowResult = {
  rowNumber: number;
  status: 'new' | 'update' | 'error';
  name: string;
  sku: string;
  matchBy?: 'sku' | 'name' | null;
  existingId?: string | null;
  errors: string[];
};
type ImportSummary = { total: number; new: number; update: number; errors: number; applied: number };
type ImportPreview = { summary: ImportSummary; rows: ImportRowResult[] };

const EXPECTED_HEADERS = ['Tipo', 'Nombre', 'SKU', 'Código de barras', 'Categoría', 'Moneda', 'Costo', 'Precio de venta', 'Stock', 'Stock mínimo', 'Unidad', 'IVA', 'Descripción'];

const TEMPLATE_HEADERS = [
  'Tipo', 'Nombre', 'SKU', 'Código de barras', 'Categoría', 'Moneda',
  'Costo', 'Precio de venta', 'Stock', 'Stock mínimo', 'Unidad', 'IVA', 'Descripción', 'Activo',
] as const;

function buildProductTemplateWorkbook(): XLSX.WorkBook {
  const exampleRows = [
    {
      'Tipo': 'Producto',
      'Nombre': 'Remera blanca talle M',
      'SKU': 'REM-001',
      'Código de barras': '7790001234567',
      'Categoría': 'Indumentaria',
      'Moneda': 'ARS',
      'Costo': 4500,
      'Precio de venta': 8900,
      'Stock': 20,
      'Stock mínimo': 5,
      'Unidad': 'unidad',
      'IVA': 21,
      'Descripción': 'Remera de algodón, color blanco, talle M',
      'Activo': 'Sí',
    },
    {
      'Tipo': 'Activo',
      'Nombre': 'Notebook Lenovo ThinkPad',
      'SKU': 'ACT-001',
      'Código de barras': '',
      'Categoría': 'Equipamiento',
      'Moneda': 'ARS',
      'Costo': 850000,
      'Precio de venta': '',
      'Stock': '',
      'Stock mínimo': '',
      'Unidad': '',
      'IVA': 10.5,
      'Descripción': 'Notebook de uso administrativo',
      'Activo': 'Sí',
    },
  ];

  const ws = XLSX.utils.json_to_sheet(exampleRows, { header: TEMPLATE_HEADERS as unknown as string[] });
  ws['!cols'] = [
    { wch: 12 }, { wch: 32 }, { wch: 14 }, { wch: 16 }, { wch: 18 },
    { wch: 8 },  { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 12 },
    { wch: 12 }, { wch: 40 }, { wch: 8 },
  ];

  const instructions = [
    ['Columna', 'Obligatoria', 'Valores válidos / Formato'],
    ['Tipo', 'Sí', 'Producto, Servicio o Activo (si está vacío se asume Producto)'],
    ['Nombre', 'Sí', 'Texto libre. Es la única columna que no puede quedar vacía.'],
    ['SKU', 'No', 'Código interno. Si coincide con un producto existente, se actualiza.'],
    ['Código de barras', 'No', 'Texto / número EAN/UPC.'],
    ['Categoría', 'No', 'Texto libre.'],
    ['Moneda', 'No', 'ARS, USD o EUR. Si está vacío se asume ARS.'],
    ['Costo', 'No', 'Número sin símbolo de moneda. Coma o punto como decimal.'],
    ['Precio de venta', 'No', 'Número sin símbolo de moneda. Coma o punto como decimal.'],
    ['Stock', 'No', 'Número. Sólo aplica a Producto. Dejar vacío para Servicio o Activo.'],
    ['Stock mínimo', 'No', 'Número. Aviso cuando el stock baje de este nivel.'],
    ['Unidad', 'No', 'unidad, kg, litro, caja, paquete, etc.'],
    ['IVA', 'No', 'Alícuota de IVA: 0, 2.5, 5, 10.5, 21 o 27. Si está vacío se asume 21.'],
    ['Descripción', 'No', 'Texto libre.'],
    ['Activo', 'No', 'Sí o No. Por defecto Sí.'],
    [],
    ['Regla de match', '', 'Primero se busca por SKU. Si no hay SKU, por Nombre exacto. Si no coincide, se crea uno nuevo.'],
    ['Mayúsculas y tildes', '', "El sistema reconoce 'nombre', 'Nombre', 'NOMBRE' o 'Categoria' sin tilde — pero usar exactamente estos encabezados evita errores."],
    ['Máximo de filas', '', '2000 por archivo.'],
  ];
  const wsInst = XLSX.utils.aoa_to_sheet(instructions);
  wsInst['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 80 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Productos');
  XLSX.utils.book_append_sheet(wb, wsInst, 'Instrucciones');
  return wb;
}

function downloadProductTemplate() {
  const wb = buildProductTemplateWorkbook();
  XLSX.writeFile(wb, 'productos-plantilla.xlsx');
}

function ImportProductsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = React.useState<string>('');
  const [rawRows, setRawRows] = React.useState<any[] | null>(null);
  const [preview, setPreview] = React.useState<ImportPreview | null>(null);
  const [isParsing, setIsParsing] = React.useState(false);
  const [isPreviewing, setIsPreviewing] = React.useState(false);
  const [isApplying, setIsApplying] = React.useState(false);

  const reset = () => {
    setFileName('');
    setRawRows(null);
    setPreview(null);
    setIsParsing(false);
    setIsPreviewing(false);
    setIsApplying(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  React.useEffect(() => { if (!open) reset(); }, [open]);

  const handleFile = async (file: File) => {
    setIsParsing(true);
    setPreview(null);
    setRawRows(null);
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) throw new Error('El archivo no tiene hojas');
      const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: '', raw: false });
      if (!Array.isArray(rows) || rows.length === 0) {
        toast({ title: 'Archivo vacío', description: 'No se encontraron filas para importar', variant: 'destructive' });
        setIsParsing(false);
        return;
      }
      setRawRows(rows);
      setIsParsing(false);
      setIsPreviewing(true);
      try {
        const res = await productAPI.bulkImport(rows, true) as ImportPreview;
        setPreview(res);
      } catch (e: any) {
        if (e?.code === 'MISSING_NAME_COLUMN') {
          const detected: string[] = Array.isArray(e?.detectedHeaders)
            ? e.detectedHeaders.filter((h: any) => typeof h === 'string' && h.trim().length > 0)
            : [];
          const MAX_SHOWN = 10;
          const shown = detected.slice(0, MAX_SHOWN);
          const extra = detected.length - shown.length;
          toast({
            title: "Falta la columna 'Nombre'",
            description: (
              <div className="space-y-2">
                <p>No detectamos la columna 'Nombre' en el archivo. Descargá la plantilla y volvé a intentarlo.</p>
                <button
                  type="button"
                  onClick={() => downloadProductTemplate()}
                  className="underline font-medium"
                  data-testid="button-toast-download-template"
                >
                  Descargar plantilla
                </button>
                {detected.length > 0 && (
                  <div className="pt-1" data-testid="text-detected-headers">
                    <p className="text-xs font-medium">Columnas detectadas en tu archivo:</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {shown.map((h, i) => (
                        <span
                          key={`${h}-${i}`}
                          className="inline-flex items-center rounded border border-current/30 bg-background/10 px-1.5 py-0.5 text-[11px]"
                          data-testid={`chip-detected-header-${i}`}
                        >
                          {h}
                        </span>
                      ))}
                      {extra > 0 && (
                        <span
                          className="inline-flex items-center text-[11px] opacity-80"
                          data-testid="text-detected-headers-more"
                        >
                          y {extra} más
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) as any,
            variant: 'destructive',
          });
          setRawRows(null);
          setFileName('');
          if (fileInputRef.current) fileInputRef.current.value = '';
        } else {
          toast({ title: 'Error al analizar', description: e?.message || 'No se pudo procesar el archivo', variant: 'destructive' });
        }
      } finally {
        setIsPreviewing(false);
      }
    } catch (e: any) {
      toast({ title: 'No se pudo leer el archivo', description: e?.message || String(e), variant: 'destructive' });
      setIsParsing(false);
    }
  };

  const applyImport = async () => {
    if (!rawRows) return;
    setIsApplying(true);
    try {
      const res = await productAPI.bulkImport(rawRows, false) as ImportPreview & { applyErrors?: any[] };
      const s = res.summary;
      const successCount = s.applied;
      const errorCount = s.errors;
      const fullSuccess = errorCount === 0 && successCount > 0;
      // Si la importación fue 100% exitosa, cerramos primero (y reseteamos
      // el dialog vía el useEffect de open=false) para que un eventual
      // fallo en invalidateQueries no deje al usuario con el modal abierto
      // sin saber qué pasó.
      if (fullSuccess) {
        setIsApplying(false);
        onOpenChange(false);
      } else {
        setPreview(res);
      }
      try {
        queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      } catch {
        // ignorar errores de invalidación: la próxima navegación recarga.
      }
      toast({
        title: errorCount > 0 ? 'Importación completada con errores' : 'Importación completada',
        description: `${successCount} producto(s) procesado(s) correctamente${errorCount > 0 ? `, ${errorCount} con errores` : ''}.`,
        variant: errorCount > 0 ? 'destructive' : 'default',
      });
    } catch (e: any) {
      toast({ title: 'Error al importar', description: e?.message || String(e), variant: 'destructive' });
    } finally {
      setIsApplying(false);
    }
  };

  const canApply = !!preview && preview.summary.total > 0 && (preview.summary.new + preview.summary.update) > 0 && !isApplying;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[900px] max-h-[85vh] overflow-y-auto" data-testid="dialog-import-products">
        <DialogHeader>
          <DialogTitle>Importar productos desde Excel</DialogTitle>
          <DialogDescription>
            Subí un archivo .xlsx con las mismas columnas que exporta el sistema. El match con productos existentes se hace por SKU; si no hay SKU, por nombre exacto.
          </DialogDescription>
        </DialogHeader>

        {!preview && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-4 py-3">
              <div className="text-sm">
                <p className="font-medium">¿No sabés cómo armar el archivo?</p>
                <p className="text-muted-foreground text-xs">Descargá la plantilla con los encabezados correctos y dos filas de ejemplo.</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={downloadProductTemplate}
                data-testid="button-download-products-template"
              >
                <FileSpreadsheet className="mr-2 h-4 w-4" />
                Descargar plantilla
              </Button>
            </div>
            <div className="rounded-md border border-dashed p-6 text-center bg-muted/30">
              <FileSpreadsheet className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground mb-3">
                Columnas esperadas: {EXPECTED_HEADERS.join(', ')}
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
                data-testid="input-products-import-file"
              />
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={isParsing || isPreviewing}
                data-testid="button-select-import-file"
              >
                {(isParsing || isPreviewing) ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Analizando archivo…</>
                ) : (
                  <><Upload className="mr-2 h-4 w-4" /> Elegir archivo .xlsx</>
                )}
              </Button>
              {fileName && (
                <p className="text-xs text-muted-foreground mt-2" data-testid="text-import-filename">{fileName}</p>
              )}
            </div>
          </div>
        )}

        {preview && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div className="rounded-md border p-3 text-center">
                <div className="text-xs text-muted-foreground">Filas</div>
                <div className="text-xl font-semibold" data-testid="text-import-total">{preview.summary.total}</div>
              </div>
              <div className="rounded-md border p-3 text-center bg-emerald-500/5 border-emerald-500/20">
                <div className="text-xs text-emerald-700">Nuevos</div>
                <div className="text-xl font-semibold text-emerald-700" data-testid="text-import-new">{preview.summary.new}</div>
              </div>
              <div className="rounded-md border p-3 text-center bg-cyan-500/5 border-cyan-500/20">
                <div className="text-xs text-cyan-700">A actualizar</div>
                <div className="text-xl font-semibold text-cyan-700" data-testid="text-import-update">{preview.summary.update}</div>
              </div>
              <div className="rounded-md border p-3 text-center bg-red-500/5 border-red-500/20">
                <div className="text-xs text-red-700">Con errores</div>
                <div className="text-xl font-semibold text-red-700" data-testid="text-import-errors">{preview.summary.errors}</div>
              </div>
            </div>

            <div className="border rounded-md overflow-hidden max-h-[40vh] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Fila</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Nombre</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Detalle</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((r) => (
                    <TableRow key={r.rowNumber} data-testid={`row-import-${r.rowNumber}`}>
                      <TableCell className="font-mono text-xs">{r.rowNumber}</TableCell>
                      <TableCell>
                        {r.status === 'new' && (
                          <Badge className="bg-emerald-500/10 text-emerald-700 border-emerald-500/20" variant="outline">Nuevo</Badge>
                        )}
                        {r.status === 'update' && (
                          <Badge className="bg-cyan-500/10 text-cyan-700 border-cyan-500/20" variant="outline">
                            Actualiza{r.matchBy ? ` (${r.matchBy === 'sku' ? 'SKU' : 'nombre'})` : ''}
                          </Badge>
                        )}
                        {r.status === 'error' && (
                          <Badge className="bg-red-500/10 text-red-700 border-red-500/20" variant="outline">Error</Badge>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate">{r.name || <span className="text-muted-foreground italic">(sin nombre)</span>}</TableCell>
                      <TableCell className="font-mono text-xs">{r.sku || '—'}</TableCell>
                      <TableCell className="text-xs">
                        {r.errors.length > 0 ? (
                          <span className="text-red-700">{r.errors.join(' · ')}</span>
                        ) : r.status === 'update' ? (
                          <span className="text-muted-foreground">Se actualizará el producto existente</span>
                        ) : (
                          <span className="text-muted-foreground">Se creará</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        <DialogFooter>
          {preview && (
            <Button variant="outline" onClick={reset} disabled={isApplying} data-testid="button-import-restart">
              Elegir otro archivo
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isApplying} data-testid="button-import-cancel">
            Cancelar
          </Button>
          {preview && (
            <Button onClick={applyImport} disabled={!canApply} data-testid="button-import-confirm">
              {isApplying ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Importando…</>
              ) : (
                <><CheckCircle2 className="mr-2 h-4 w-4" /> Confirmar importación</>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ProductsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { showUndoToast } = useUndoDelete();
  const { data: membership } = useMembership();
  const [isOpen, setIsOpen] = React.useState(false);
  const [editProduct, setEditProduct] = React.useState<Product | null>(null);
  const [deleteProductId, setDeleteProductId] = React.useState<string | null>(null);
  const [viewProduct, setViewProduct] = React.useState<Product | null>(null);
  const [stockProduct, setStockProduct] = React.useState<Product | null>(null);
  const [showInactive, setShowInactive] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [typeFilter, setTypeFilter] = React.useState<'all' | ProductType>('all');
  const [categoryFilter, setCategoryFilter] = React.useState<string>('all');
  const [isImportOpen, setIsImportOpen] = React.useState(false);
  const [selectedProductIds, setSelectedProductIds] = React.useState<Set<string>>(new Set());
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = React.useState(false);
  const [bulkDeleting, setBulkDeleting] = React.useState(false);
  const [bulkDeleteForce, setBulkDeleteForce] = React.useState(false);
  const toggleProductSelection = (id: string) => {
    setSelectedProductIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const clearProductSelection = () => setSelectedProductIds(new Set());

  const organizationId = (membership as any)?.organizationId as string | undefined;
  const viewModeStorageKey = organizationId ? `productos:viewMode:${organizationId}` : 'productos:viewMode';
  const [viewMode, setViewMode] = React.useState<'cards' | 'table'>(() => {
    if (typeof window === 'undefined') return 'cards';
    try {
      const saved = window.localStorage.getItem(viewModeStorageKey);
      return saved === 'table' ? 'table' : 'cards';
    } catch {
      return 'cards';
    }
  });
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = window.localStorage.getItem(viewModeStorageKey);
      setViewMode(saved === 'table' ? 'table' : 'cards');
    } catch {}
  }, [viewModeStorageKey]);
  const handleViewModeChange = (value: string) => {
    if (value !== 'cards' && value !== 'table') return;
    setViewMode(value);
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(viewModeStorageKey, value);
    } catch {}
  };

  const userRole = (membership?.role as Role) || 'viewer';
  const userPermissions = ROLE_PERMISSIONS[userRole] || [];
  const canCreate = userPermissions.includes('transactions:create');
  const canBulkDelete = userRole === 'owner' || userRole === 'admin';

  const runBulkDeleteProducts = React.useCallback(async (ids: string[], force: boolean, closeDialog: boolean) => {
    if (ids.length === 0) return;
    setBulkDeleting(true);
    try {
      const CHUNK = 200;
      const aggregated: { deleted: string[]; skipped: { id: string; reason: string }[] } = { deleted: [], skipped: [] };
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const r = await productAPI.bulkDelete(chunk, { force });
        if (Array.isArray(r?.deleted)) aggregated.deleted.push(...r.deleted);
        if (Array.isArray(r?.skipped)) aggregated.skipped.push(...r.skipped);
      }
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      const deletedCount = aggregated.deleted.length;
      const skipped = aggregated.skipped;
      if (skipped.length === 0) {
        toast({ title: 'Productos eliminados', description: `Se eliminaron ${deletedCount} productos.` });
      } else {
        const reasons = skipped.reduce((acc: Record<string, number>, s: any) => {
          acc[s.reason] = (acc[s.reason] || 0) + 1; return acc;
        }, {});
        const reasonLabels: Record<string, string> = {
          not_found: 'no encontrados',
          delete_failed: 'no se pudieron eliminar',
          in_use: 'tienen movimientos asociados',
          has_transactions: 'tienen movimientos asociados',
          has_stock: 'tienen stock registrado',
          error: 'con error',
        };
        const detail = Object.entries(reasons)
          .map(([r, n]) => `${n} ${reasonLabels[r] || r}`)
          .join(', ');
        const hasStockSkipped = (reasons['has_stock'] || 0) > 0;
        const canRetryWithForce = !force && hasStockSkipped && canBulkDelete;
        const stockIds = canRetryWithForce
          ? skipped.filter((s: any) => s.reason === 'has_stock').map((s: any) => s.id)
          : [];
        toast({
          title: deletedCount > 0 ? 'Eliminación parcial' : 'No se pudo eliminar',
          description: `${deletedCount} eliminados. ${skipped.length} omitidos: ${detail}.`,
          variant: deletedCount > 0 ? 'default' : 'destructive',
          action: canRetryWithForce ? (
            <ToastAction
              altText="Reintentar incluyendo productos con stock"
              data-testid="button-toast-retry-bulk-delete-force"
              onClick={() => { void runBulkDeleteProducts(stockIds, true, false); }}
            >
              Reintentar con stock
            </ToastAction>
          ) : undefined,
        });
      }
      clearProductSelection();
      if (closeDialog) {
        setShowBulkDeleteDialog(false);
        setBulkDeleteForce(false);
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err?.message || 'No se pudieron eliminar los productos', variant: 'destructive' });
    } finally {
      setBulkDeleting(false);
    }
  }, [canBulkDelete, queryClient, toast]);
  
  const roleNameMap: Record<string, string> = {
    owner: 'Propietario',
    admin: 'Administrador',
    specialist: 'Especialista',
    operator: 'Operador',
    viewer: 'Veedor'
  };
  const userRoleDisplay = roleNameMap[userRole] || userRole;

  const { data: products = [], isLoading } = useQuery({
    queryKey: ['/api/products', showInactive],
    queryFn: () => productAPI.getAll(!showInactive),
  });

  const createMutation = useMutation({
    mutationFn: productAPI.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      toast({ title: "Producto creado", description: "El producto ha sido registrado exitosamente." });
      setIsOpen(false);
      form.reset();
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) =>
      productAPI.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      toast({ title: "Producto actualizado" });
      setEditProduct(null);
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: productAPI.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleDeleteProduct = async () => {
    if (!deleteProductId) return;
    const productName = products.find((p: Product) => p.id === deleteProductId)?.name;
    try {
      const result = await deleteMutation.mutateAsync(deleteProductId);
      setDeleteProductId(null);
      if (result?.undoKey) {
        showUndoToast(result.undoKey, 'product', productName);
      }
    } catch {}
  };

  const defaultFormValues: ProductFormValues = {
    name: '', description: '', productType: 'product',
    sku: '', barcode: '', category: '', defaultProfitabilityCodeId: '',
    costPrice: '', costCurrency: 'ARS', salePrice: '',
    stock: '', minStock: '', unit: '', ivaAliquot: '21',
    purchaseDate: '', usefulLifeMonths: '', currentValue: '',
  };

  const form = useForm<ProductFormValues>({
    resolver: zodResolver(productSchema),
    defaultValues: defaultFormValues,
  });

  const editForm = useForm<ProductFormValues>({
    resolver: zodResolver(productSchema),
    defaultValues: defaultFormValues,
  });

  const buildPayload = (data: ProductFormValues) => {
    const payload: any = {
      name: data.name,
      description: data.description || undefined,
      productType: data.productType || 'product',
      sku: data.sku || undefined,
      barcode: data.barcode || undefined,
      category: data.category || undefined,
      defaultProfitabilityCodeId: data.defaultProfitabilityCodeId || null,
      costPrice: data.costPrice || undefined,
      costCurrency: data.costCurrency || 'ARS',
      salePrice: data.salePrice || undefined,
      ivaAliquot: data.ivaAliquot || '21',
    };
    if (data.productType === 'asset') {
      payload.stock = '0';
      payload.minStock = '0';
      payload.unit = 'unidad';
      payload.purchaseDate = data.purchaseDate || null;
      payload.usefulLifeMonths = data.usefulLifeMonths ? parseInt(data.usefulLifeMonths) : null;
      payload.currentValue = data.currentValue || null;
    } else {
      payload.stock = data.stock || '0';
      payload.minStock = data.minStock || '0';
      payload.unit = data.unit || 'unidad';
    }
    return payload;
  };

  const onSubmit = (data: ProductFormValues) => {
    createMutation.mutate(buildPayload(data));
  };

  const handleEditOpen = (product: Product) => {
    editForm.reset({
      name: product.name,
      description: product.description || '',
      productType: (product.productType as ProductType) || 'product',
      sku: product.sku || '',
      barcode: product.barcode || '',
      category: product.category || '',
      defaultProfitabilityCodeId: (product as any).defaultProfitabilityCodeId || '',
      costPrice: product.costPrice && parseFloat(product.costPrice) > 0 ? product.costPrice : '',
      costCurrency: product.costCurrency || 'ARS',
      salePrice: product.salePrice && parseFloat(product.salePrice) > 0 ? product.salePrice : '',
      stock: product.stock && parseFloat(product.stock) > 0 ? product.stock : '',
      minStock: product.minStock && parseFloat(product.minStock) > 0 ? product.minStock : '',
      unit: product.unit || '',
      ivaAliquot: (product as any).ivaAliquot != null ? String(parseFloat((product as any).ivaAliquot)) : '21',
      purchaseDate: product.purchaseDate ? new Date(product.purchaseDate).toISOString().split('T')[0] : '',
      usefulLifeMonths: product.usefulLifeMonths ? String(product.usefulLifeMonths) : '',
      currentValue: product.currentValue && parseFloat(product.currentValue) > 0 ? product.currentValue : '',
    });
    setEditProduct(product);
  };

  const onEditSubmit = (data: ProductFormValues) => {
    if (!editProduct) return;
    updateMutation.mutate({ id: editProduct.id, data: buildPayload(data) });
  };

  const toggleActive = (product: Product) => {
    updateMutation.mutate({ id: product.id, data: { isActive: !product.isActive } });
  };

  const formatPrice = (amount: string | null, currency?: string | null) => {
    if (!amount || parseFloat(amount) === 0) return null;
    const sym = CURRENCY_SYMBOLS[(currency || 'ARS') as keyof typeof CURRENCY_SYMBOLS] || '$';
    return `${sym} ${parseFloat(amount).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
  };

  const getStockInfo = (product: Product) => {
    const stock = parseFloat(product.stock || '0');
    const minStock = parseFloat(product.minStock || '0');
    const unit = product.unit || 'unidades';
    const isLow = minStock > 0 && stock <= minStock;
    return { stock, minStock, unit, isLow };
  };

  const categories = React.useMemo(() => {
    const set = new Set<string>();
    (products as Product[]).forEach((p) => {
      const c = (p.category || '').trim();
      if (c) set.add(c);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'));
  }, [products]);

  React.useEffect(() => {
    if (categoryFilter !== 'all' && !categories.includes(categoryFilter)) {
      setCategoryFilter('all');
    }
  }, [categories, categoryFilter]);

  const filteredProducts = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return (products as Product[]).filter((p) => {
      const pType = (p.productType as ProductType) || 'product';
      if (typeFilter !== 'all' && pType !== typeFilter) return false;
      if (categoryFilter !== 'all' && (p.category || '') !== categoryFilter) return false;
      if (q) {
        const hay = [p.name, p.sku, p.barcode].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [products, searchQuery, typeFilter, categoryFilter]);

  const hasActiveFilters = searchQuery.trim() !== '' || typeFilter !== 'all' || categoryFilter !== 'all';

  // ── Tarjetas de totales + ordenamiento de la vista Tabla ───────────────
  const { data: exchangeRates } = useExchangeRates();
  const usdRate = exchangeRates?.usdToLocal || 0;
  const eurRate = exchangeRates?.eurToLocal || 0;
  const toARS = React.useCallback((amount: number, currency?: string | null): number => {
    const cur = (currency || 'ARS').toUpperCase();
    if (!Number.isFinite(amount) || amount === 0) return 0;
    if (cur === 'USD' || cur === 'USD_CASH') return usdRate > 0 ? amount * usdRate : amount;
    if (cur === 'EUR') return eurRate > 0 ? amount * eurRate : amount;
    return amount;
  }, [usdRate, eurRate]);

  const stockTotals = React.useMemo(() => {
    let units = 0;
    let costArs = 0;
    let saleArs = 0;
    let count = 0;
    let anyForeignCurrency = false;
    filteredProducts.forEach((p) => {
      const pType = (p.productType as ProductType) || 'product';
      if (pType !== 'product') return;
      if (p.isActive === false) return;
      const cur = (p.costCurrency || 'ARS').toUpperCase();
      if (cur !== 'ARS') anyForeignCurrency = true;
      const stock = parseFloat(p.stock || '0') || 0;
      const cost = parseFloat(p.costPrice || '0') || 0;
      const sale = parseFloat(p.salePrice || '0') || 0;
      count += 1;
      units += stock;
      costArs += toARS(stock * cost, cur);
      saleArs += toARS(stock * sale, cur);
    });
    return { units, costArs, saleArs, count, anyForeignCurrency };
  }, [filteredProducts, toARS]);

  // Prune selección al cambiar filtros para que el contador y los totales
  // de la barra fija siempre coincidan con la lista visible.
  React.useEffect(() => {
    if (selectedProductIds.size === 0) return;
    const visible = new Set(filteredProducts.map((p: Product) => p.id));
    let changed = false;
    const next = new Set<string>();
    selectedProductIds.forEach(id => {
      if (visible.has(id)) next.add(id);
      else changed = true;
    });
    if (changed) setSelectedProductIds(next);
  }, [filteredProducts]);

  const fmtArs = React.useCallback((v: number) => `AR$ ${v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, []);
  const fmtUnits = React.useCallback((v: number) => v.toLocaleString('es-AR', { maximumFractionDigits: Number.isInteger(v) ? 0 : 2 }), []);

  type SortKey = 'name' | 'sku' | 'category' | 'costPrice' | 'salePrice' | 'profitability' | 'stock';
  type SortDir = 'asc' | 'desc';
  const sortStorageKey = organizationId ? `productos:sort:${organizationId}` : 'productos:sort';
  const [sortConfig, setSortConfig] = React.useState<{ key: SortKey; dir: SortDir } | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const saved = window.localStorage.getItem(sortStorageKey);
      if (!saved) return null;
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed.key === 'string' && (parsed.dir === 'asc' || parsed.dir === 'desc')) {
        return parsed as { key: SortKey; dir: SortDir };
      }
      return null;
    } catch {
      return null;
    }
  });
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = window.localStorage.getItem(sortStorageKey);
      setSortConfig(saved ? (JSON.parse(saved) as { key: SortKey; dir: SortDir }) : null);
    } catch {
      setSortConfig(null);
    }
  }, [sortStorageKey]);
  const persistSort = (cfg: { key: SortKey; dir: SortDir } | null) => {
    if (typeof window === 'undefined') return;
    try {
      if (cfg === null) window.localStorage.removeItem(sortStorageKey);
      else window.localStorage.setItem(sortStorageKey, JSON.stringify(cfg));
    } catch {}
  };
  const handleSort = (key: SortKey) => {
    setSortConfig((prev) => {
      let next: { key: SortKey; dir: SortDir } | null;
      if (!prev || prev.key !== key) next = { key, dir: 'asc' };
      else if (prev.dir === 'asc') next = { key, dir: 'desc' };
      else next = null;
      persistSort(next);
      return next;
    });
  };

  const getProfitabilityPct = (p: Product): number | null => {
    const pType = (p.productType as ProductType) || 'product';
    if (pType === 'asset') return null;
    const cost = parseFloat(p.costPrice || '0') || 0;
    const sale = parseFloat(p.salePrice || '0') || 0;
    if (cost <= 0 || sale <= 0) return null;
    // Margen comercial sobre venta — consistente con la vista Tarjetas
    // (`marginPct = diff / sale * 100`) y con la convención que usa la
    // app para "rentabilidad".
    return ((sale - cost) / sale) * 100;
  };

  const displayProducts = React.useMemo(() => {
    if (!sortConfig) return filteredProducts;
    const arr = [...filteredProducts];
    const dir = sortConfig.dir === 'asc' ? 1 : -1;
    const cmpStr = (a: string, b: string) => a.localeCompare(b, 'es', { sensitivity: 'base' });
    const cmpNum = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);
    arr.sort((a, b) => {
      switch (sortConfig.key) {
        case 'name':
          return cmpStr(a.name || '', b.name || '') * dir;
        case 'sku':
          return cmpStr(a.sku || '', b.sku || '') * dir;
        case 'category':
          return cmpStr(a.category || '', b.category || '') * dir;
        case 'costPrice': {
          const ac = toARS(parseFloat(a.costPrice || '0') || 0, a.costCurrency);
          const bc = toARS(parseFloat(b.costPrice || '0') || 0, b.costCurrency);
          return cmpNum(ac, bc) * dir;
        }
        case 'salePrice': {
          const ac = toARS(parseFloat(a.salePrice || '0') || 0, a.costCurrency);
          const bc = toARS(parseFloat(b.salePrice || '0') || 0, b.costCurrency);
          return cmpNum(ac, bc) * dir;
        }
        case 'profitability': {
          const ap = getProfitabilityPct(a);
          const bp = getProfitabilityPct(b);
          if (ap === null && bp === null) return 0;
          if (ap === null) return 1; // nulos al final, sin importar dir
          if (bp === null) return -1;
          return cmpNum(ap, bp) * dir;
        }
        case 'stock': {
          const aType = (a.productType as ProductType) || 'product';
          const bType = (b.productType as ProductType) || 'product';
          const as = aType === 'asset' ? -Infinity : (parseFloat(a.stock || '0') || 0);
          const bs = bType === 'asset' ? -Infinity : (parseFloat(b.stock || '0') || 0);
          return cmpNum(as, bs) * dir;
        }
      }
    });
    return arr;
  }, [filteredProducts, sortConfig, toARS]);

  const SortableHead: React.FC<{
    sortKey: SortKey;
    className?: string;
    children: React.ReactNode;
  }> = ({ sortKey, className, children }) => {
    const isActive = sortConfig?.key === sortKey;
    const dir = isActive ? sortConfig?.dir : undefined;
    const isRight = className?.includes('text-right');
    return (
      <TableHead className={className}>
        <button
          type="button"
          onClick={() => handleSort(sortKey)}
          className={`inline-flex items-center gap-1 hover:text-foreground transition-colors ${isRight ? 'justify-end w-full' : ''} ${isActive ? 'text-foreground font-medium' : ''}`}
          data-testid={`header-sort-${sortKey}`}
        >
          <span>{children}</span>
          {isActive && dir === 'asc' && <ChevronUp className="h-3.5 w-3.5" />}
          {isActive && dir === 'desc' && <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </TableHead>
    );
  };

  const exportToExcel = () => {
    const list = filteredProducts;
    if (!list.length) {
      toast({ title: 'No hay productos para exportar', variant: 'destructive' });
      return;
    }
    const toNumOrEmpty = (v: string | null | undefined) => {
      if (v == null || v === '') return '';
      const n = parseFloat(v);
      return isNaN(n) ? '' : n;
    };
    const rows = list.map((p) => {
      const pType = (p.productType as ProductType) || 'product';
      const isAssetItem = pType === 'asset';
      return {
        'Tipo': PRODUCT_TYPE_LABELS[pType],
        'Nombre': p.name,
        'SKU': p.sku || '',
        'Código de barras': p.barcode || '',
        'Categoría': p.category || '',
        'Moneda': p.costCurrency || 'ARS',
        'Costo': toNumOrEmpty(p.costPrice),
        'Precio de venta': toNumOrEmpty(p.salePrice),
        'Stock': isAssetItem ? '' : toNumOrEmpty(p.stock),
        'Stock mínimo': isAssetItem ? '' : toNumOrEmpty(p.minStock),
        'Unidad': isAssetItem ? '' : (p.unit || ''),
        'IVA': (p as any).ivaAliquot != null ? parseFloat((p as any).ivaAliquot) : '',
        'Descripción': p.description || '',
        'Activo': p.isActive ? 'Sí' : 'No',
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
      { wch: 12 }, { wch: 32 }, { wch: 14 }, { wch: 16 }, { wch: 18 },
      { wch: 8 },  { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 12 },
      { wch: 12 }, { wch: 8 }, { wch: 40 }, { wch: 8 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Productos');
    const today = new Date().toISOString().slice(0, 10);
    const filename = `productos-${today}.xlsx`;
    XLSX.writeFile(wb, filename);
    toast({ title: 'Exportación lista', description: filename });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-lg text-muted-foreground">Cargando productos...</div>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <BackButton />
          <h1 className="text-3xl font-bold font-display mt-2">Productos/Activos</h1>
          <p className="text-muted-foreground">Catalogo de productos, servicios y activos.</p>
        </div>

        <div className="flex flex-wrap items-center gap-3 md:gap-4">
          <ToggleGroup
            type="single"
            value={viewMode}
            onValueChange={(v) => { if (v) handleViewModeChange(v); }}
            variant="outline"
            size="sm"
            className="bg-background"
            data-testid="toggle-products-view-mode"
          >
            <ToggleGroupItem value="cards" aria-label="Vista de tarjetas" data-testid="toggle-view-cards">
              <LayoutGrid className="h-4 w-4 mr-1" />
              <span className="hidden sm:inline">Tarjetas</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="table" aria-label="Vista de tabla" data-testid="toggle-view-table">
              <List className="h-4 w-4 mr-1" />
              <span className="hidden sm:inline">Tabla</span>
            </ToggleGroupItem>
          </ToggleGroup>

          <Button
            variant="outline"
            size="sm"
            onClick={exportToExcel}
            disabled={!filteredProducts.length}
            data-testid="button-export-products-xlsx"
          >
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            Exportar a Excel
          </Button>

          {canCreate && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsImportOpen(true)}
              data-testid="button-import-products-xlsx"
            >
              <Upload className="mr-2 h-4 w-4" />
              Importar desde Excel
            </Button>
          )}

          <div className="flex items-center gap-2">
            <Switch
              id="show-inactive"
              checked={showInactive}
              onCheckedChange={setShowInactive}
              data-testid="switch-show-inactive"
            />
            <label htmlFor="show-inactive" className="text-sm text-muted-foreground">
              Mostrar inactivos
            </label>
          </div>

          <Dialog open={isOpen} onOpenChange={(open) => { setIsOpen(open); if (!open) form.reset(defaultFormValues); }}>
            <DialogTrigger asChild>
              <Button className="bg-primary text-primary-foreground shadow-lg shadow-primary/20" data-testid="button-new-product">
                <Plus className="mr-2 h-4 w-4" /> Nuevo Producto
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[700px] max-h-[85vh] overflow-y-auto">
              {!canCreate ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="w-20 h-20 rounded-full bg-gradient-to-br from-amber-100 to-orange-100 flex items-center justify-center mb-6">
                    <ShieldAlert className="h-10 w-10 text-amber-600" />
                  </div>
                  <h3 className="text-xl font-bold text-gray-800 dark:text-slate-100 mb-3">Acceso restringido</h3>
                  <p className="text-muted-foreground max-w-sm mb-6">
                    Tu rol actual (<span className="font-medium text-amber-600">{userRoleDisplay}</span>) no tiene permiso para crear productos.
                  </p>
                  <div className="bg-amber-50 border border-amber-200 rounded-xl px-6 py-4 max-w-sm">
                    <p className="text-sm text-amber-800">
                      <strong>Necesitas crear productos?</strong><br />
                      Contacta al administrador de la cuenta para que te asigne un rol con mas permisos.
                    </p>
                  </div>
                  <Button variant="outline" className="mt-6" onClick={() => setIsOpen(false)}>
                    Entendido
                  </Button>
                </div>
              ) : (
              <>
              <DialogHeader>
                <DialogTitle>Nuevo Producto</DialogTitle>
              </DialogHeader>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <ProductFormFields formInstance={form} />
                  <DialogFooter>
                    <Button type="submit" disabled={createMutation.isPending} data-testid="button-save-product">
                      {createMutation.isPending ? 'Guardando...' : 'Guardar'}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
              </>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {products.length > 0 && (
        <div className="mb-4 flex flex-col md:flex-row md:items-center gap-3">
          <div className="relative flex-1 min-w-0 md:max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              type="search"
              placeholder="Buscar por nombre, SKU o código de barras"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 pr-9"
              data-testid="input-search-products"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                aria-label="Limpiar búsqueda"
                data-testid="button-clear-search-products"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as 'all' | ProductType)}>
              <SelectTrigger className="w-[160px]" data-testid="select-filter-product-type">
                <SelectValue placeholder="Tipo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los tipos</SelectItem>
                {PRODUCT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{PRODUCT_TYPE_LABELS[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={categoryFilter}
              onValueChange={setCategoryFilter}
              disabled={categories.length === 0}
            >
              <SelectTrigger className="w-[200px]" data-testid="select-filter-product-category">
                <SelectValue placeholder="Categoría" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas las categorías</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {hasActiveFilters && (
              <>
                <span
                  className="text-sm text-muted-foreground"
                  data-testid="text-products-filter-count"
                >
                  Mostrando {filteredProducts.length} de {products.length} productos
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setSearchQuery(''); setTypeFilter('all'); setCategoryFilter('all'); }}
                  data-testid="button-clear-all-product-filters"
                >
                  Limpiar filtros
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {viewMode === 'table' && filteredProducts.some((p) => ((p.productType as ProductType) || 'product') === 'product') && (
        <div className="mb-4 grid grid-cols-1 sm:grid-cols-3 gap-3" data-testid="cards-products-totals">
          <Card data-testid="card-products-total-units">
            <CardContent className="py-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Unidades en stock</div>
              <div className="text-2xl font-bold mt-1" data-testid="text-products-total-units">{fmtUnits(stockTotals.units)}</div>
              <div className="mt-2 pt-2 border-t border-border/60 flex items-baseline justify-between gap-2">
                <span className="text-xs text-muted-foreground">Cantidad de productos</span>
                <span className="text-sm font-semibold tabular-nums" data-testid="text-products-total-count">{fmtUnits(stockTotals.count)}</span>
              </div>
              {hasActiveFilters && (
                <div className="text-[10px] text-muted-foreground mt-1">Sobre los productos filtrados</div>
              )}
            </CardContent>
          </Card>
          <Card data-testid="card-products-total-cost">
            <CardContent className="py-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Costo total del stock</div>
              <div className="text-2xl font-bold mt-1" data-testid="text-products-total-cost">{fmtArs(stockTotals.costArs)}</div>
              {stockTotals.anyForeignCurrency && (
                <div className="text-[10px] text-muted-foreground mt-1">Convertido a AR$ con TC actual</div>
              )}
            </CardContent>
          </Card>
          <Card data-testid="card-products-total-sale-value">
            <CardContent className="py-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Valor de venta del stock</div>
              <div className="text-2xl font-bold mt-1 text-green-600" data-testid="text-products-total-sale-value">{fmtArs(stockTotals.saleArs)}</div>
              <div className="text-[10px] text-muted-foreground mt-1">Stock × precio de venta</div>
            </CardContent>
          </Card>
        </div>
      )}

      {products.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Package className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No hay productos registrados</h3>
            <p className="text-muted-foreground mb-4">Agrega tu primer producto para autocompletar movimientos mas rapido.</p>
          </CardContent>
        </Card>
      ) : filteredProducts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Search className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No se encontraron productos</h3>
            <p className="text-muted-foreground mb-4">Probá cambiar la búsqueda o los filtros activos.</p>
            <Button
              variant="outline"
              onClick={() => { setSearchQuery(''); setTypeFilter('all'); setCategoryFilter('all'); }}
              data-testid="button-clear-product-filters"
            >
              Limpiar filtros
            </Button>
          </CardContent>
        </Card>
      ) : viewMode === 'cards' ? (
        <>
        {canBulkDelete && (
          <div className="flex items-center gap-2 mb-3">
            <Checkbox
              checked={filteredProducts.length > 0 && filteredProducts.every((p: Product) => selectedProductIds.has(p.id))}
              onCheckedChange={() => {
                const allSelected = filteredProducts.every((p: Product) => selectedProductIds.has(p.id));
                if (allSelected) {
                  clearProductSelection();
                } else {
                  setSelectedProductIds(new Set(filteredProducts.map((p: Product) => p.id)));
                }
              }}
              data-testid="checkbox-select-all-products"
            />
            <span className="text-xs text-muted-foreground">Seleccionar todos</span>
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredProducts.map((product: Product) => {
            const pType = (product.productType as ProductType) || 'product';
            const isAssetItem = pType === 'asset';
            const stockInfo = isAssetItem ? null : getStockInfo(product);
            return (
            <Card key={product.id} className={`${!product.isActive ? 'opacity-60' : ''}`} data-testid={`card-product-${product.id}`}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <CardTitle className="text-lg flex items-center gap-2">
                      {PRODUCT_TYPE_ICON[pType]}
                      {product.name}
                    </CardTitle>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <Badge variant="outline" className={PRODUCT_TYPE_BADGE_CLASS[pType]}>
                        {PRODUCT_TYPE_LABELS[pType]}
                      </Badge>
                      {product.sku && (
                        <CardDescription>SKU: {product.sku}</CardDescription>
                      )}
                      {stockInfo?.isLow && (
                        <Badge variant="outline" className="text-orange-600 border-orange-300 bg-orange-50 text-xs">
                          <AlertTriangle className="h-3 w-3 mr-1" /> Stock bajo
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {canBulkDelete && (
                      <Checkbox
                        checked={selectedProductIds.has(product.id)}
                        onCheckedChange={() => toggleProductSelection(product.id)}
                        onClick={(e) => e.stopPropagation()}
                        data-testid={`checkbox-select-product-${product.id}`}
                      />
                    )}
                    {!product.isActive && (
                      <Badge variant="secondary">Inactivo</Badge>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" data-testid={`button-menu-product-${product.id}`}>
                          <MoreVertical className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setViewProduct(product)}>
                          <Eye className="mr-2 h-4 w-4" /> Ver detalle
                        </DropdownMenuItem>
                        {canCreate && !isAssetItem && (
                          <DropdownMenuItem onClick={() => setStockProduct(product)}>
                            <BoxesIcon className="mr-2 h-4 w-4" /> Stock
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => handleEditOpen(product)}>
                          <Pencil className="mr-2 h-4 w-4" /> Editar
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toggleActive(product)}>
                          {product.isActive ? 'Desactivar' : 'Activar'}
                        </DropdownMenuItem>
                        <DropdownMenuItem 
                          className="text-destructive" 
                          onClick={() => setDeleteProductId(product.id)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" /> Eliminar
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-2 overflow-hidden">
                <div className="text-sm space-y-1 min-w-0">
                  {formatPrice(product.salePrice, product.costCurrency) && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Venta:</span>
                      <span className="font-semibold text-green-600">{formatPrice(product.salePrice, product.costCurrency)}</span>
                    </div>
                  )}
                  {formatPrice(product.costPrice, product.costCurrency) && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Costo:</span>
                      <span className="font-medium">{formatPrice(product.costPrice, product.costCurrency)}</span>
                    </div>
                  )}
                  {!isAssetItem && product.salePrice && product.costPrice && parseFloat(product.salePrice) > 0 && parseFloat(product.costPrice) > 0 && (() => {
                    const sale = parseFloat(product.salePrice);
                    const cost = parseFloat(product.costPrice);
                    const diff = sale - cost;
                    const marginPct = (diff / sale) * 100;
                    const sym = CURRENCY_SYMBOLS[(product.costCurrency || 'ARS') as keyof typeof CURRENCY_SYMBOLS] || '$';
                    const absText = `${sym} ${Math.abs(diff).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                    const signed = diff > 0 ? absText : diff < 0 ? `-${absText}` : absText;
                    const color = diff > 0 ? 'text-green-600' : diff < 0 ? 'text-red-600' : 'text-muted-foreground';
                    return (
                      <div className="flex justify-between" data-testid={`text-product-margin-${product.id}`}>
                        <span className="text-muted-foreground">Margen:</span>
                        <span className={`font-medium ${color}`}>
                          {marginPct.toFixed(1).replace('.', ',')}% · {signed}
                        </span>
                      </div>
                    );
                  })()}
                  {stockInfo && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Stock:</span>
                        <span className={`font-medium ${stockInfo.isLow ? 'text-orange-600' : ''}`}>
                          {stockInfo.stock} {pluralizeUnit(stockInfo.unit, stockInfo.stock)}
                        </span>
                      </div>
                      {stockInfo.stock > 0 && product.costPrice && parseFloat(product.costPrice) > 0 && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Valor total:</span>
                          <span className="font-medium text-primary">
                            {formatPrice(String(stockInfo.stock * parseFloat(product.costPrice)), product.costCurrency)}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                  {product.category && (
                    <div className="flex justify-between items-center min-w-0">
                      <span className="text-muted-foreground shrink-0">Categoria:</span>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="outline" className="max-w-[140px] truncate ml-2 cursor-default">{product.category}</Badge>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{product.category}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  )}
                  {(product as any).ivaAliquot != null && (
                    <div className="flex justify-between" data-testid={`text-product-iva-${product.id}`}>
                      <span className="text-muted-foreground">IVA:</span>
                      <span className="font-medium">{String(parseFloat((product as any).ivaAliquot)).replace('.', ',')}%</span>
                    </div>
                  )}
                  {product.description && (
                    <p className="text-muted-foreground text-xs mt-2 line-clamp-2 break-all">{product.description}</p>
                  )}
                </div>
              </CardContent>
            </Card>
            );
          })}
        </div>
        </>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <Table data-testid="table-products">
              <TableHeader>
                <TableRow>
                  {canBulkDelete && (
                    <TableHead className="w-[40px]">
                      <Checkbox
                        checked={displayProducts.length > 0 && displayProducts.every((p: Product) => selectedProductIds.has(p.id))}
                        onCheckedChange={() => {
                          const allSelected = displayProducts.every((p: Product) => selectedProductIds.has(p.id));
                          if (allSelected) {
                            clearProductSelection();
                          } else {
                            setSelectedProductIds(new Set(displayProducts.map((p: Product) => p.id)));
                          }
                        }}
                        data-testid="checkbox-select-all-products-table"
                      />
                    </TableHead>
                  )}
                  <TableHead className="w-[120px]">Tipo</TableHead>
                  <SortableHead sortKey="name">Nombre</SortableHead>
                  <SortableHead sortKey="sku">SKU</SortableHead>
                  <SortableHead sortKey="category">Categoría</SortableHead>
                  <SortableHead sortKey="costPrice" className="text-right">Costo</SortableHead>
                  <SortableHead sortKey="salePrice" className="text-right">Precio venta</SortableHead>
                  <SortableHead sortKey="profitability" className="text-right">Rentabilidad</SortableHead>
                  <SortableHead sortKey="stock" className="text-right">Stock</SortableHead>
                  <TableHead className="text-right">Stock mín.</TableHead>
                  <TableHead>Unidad</TableHead>
                  <TableHead className="text-right">IVA</TableHead>
                  <TableHead className="w-[60px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayProducts.map((product: Product) => {
                  const pType = (product.productType as ProductType) || 'product';
                  const isAssetItem = pType === 'asset';
                  const stockInfo = isAssetItem ? null : getStockInfo(product);
                  return (
                    <TableRow
                      key={product.id}
                      onClick={() => setViewProduct(product)}
                      className={`cursor-pointer ${!product.isActive ? 'opacity-60' : ''} ${stockInfo?.isLow ? 'bg-orange-50/40 hover:bg-orange-50' : ''}`}
                      data-testid={`row-product-${product.id}`}
                    >
                      {canBulkDelete && (
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={selectedProductIds.has(product.id)}
                            onCheckedChange={() => toggleProductSelection(product.id)}
                            data-testid={`checkbox-select-product-row-${product.id}`}
                          />
                        </TableCell>
                      )}
                      <TableCell>
                        <Badge variant="outline" className={`${PRODUCT_TYPE_BADGE_CLASS[pType]} gap-1`}>
                          {PRODUCT_TYPE_ICON[pType]}
                          <span className="text-xs">{PRODUCT_TYPE_LABELS[pType]}</span>
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium flex items-center gap-2">
                          <span className="truncate max-w-[260px]">{product.name}</span>
                          {!product.isActive && (
                            <Badge variant="secondary" className="text-xs">Inactivo</Badge>
                          )}
                          {stockInfo?.isLow && (
                            <Badge variant="outline" className="text-orange-600 border-orange-300 bg-orange-50 text-xs">
                              <AlertTriangle className="h-3 w-3 mr-1" /> Stock bajo
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{product.sku || '-'}</TableCell>
                      <TableCell className="text-sm">
                        {product.category ? (
                          <Badge variant="outline" className="max-w-[160px] truncate">{product.category}</Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-sm font-medium">
                        {formatPrice(product.costPrice, product.costCurrency) || <span className="text-muted-foreground">-</span>}
                      </TableCell>
                      <TableCell className="text-right text-sm font-semibold text-green-600">
                        {formatPrice(product.salePrice, product.costCurrency) || <span className="text-muted-foreground font-normal">-</span>}
                      </TableCell>
                      <TableCell className="text-right text-sm" data-testid={`text-profitability-${product.id}`}>
                        {(() => {
                          const pct = getProfitabilityPct(product);
                          if (pct === null) return <span className="text-muted-foreground">-</span>;
                          const cls = pct < 0
                            ? 'text-red-600 font-medium'
                            : pct >= 30
                              ? 'text-green-600 font-medium'
                              : 'text-foreground';
                          return <span className={cls}>{pct.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%</span>;
                        })()}
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        {isAssetItem ? (
                          <span className="text-muted-foreground">-</span>
                        ) : (
                          <span className={stockInfo?.isLow ? 'text-orange-600 font-medium' : ''}>
                            {stockInfo?.stock ?? 0}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {isAssetItem ? '-' : (stockInfo && stockInfo.minStock > 0 ? stockInfo.minStock : '-')}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {isAssetItem ? '-' : (product.unit || '-')}
                      </TableCell>
                      <TableCell className="text-right text-sm" data-testid={`text-product-iva-row-${product.id}`}>
                        {(product as any).ivaAliquot != null ? `${String(parseFloat((product as any).ivaAliquot)).replace('.', ',')}%` : '-'}
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" data-testid={`button-menu-product-row-${product.id}`}>
                              <MoreVertical className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setViewProduct(product)}>
                              <Eye className="mr-2 h-4 w-4" /> Ver detalle
                            </DropdownMenuItem>
                            {canCreate && !isAssetItem && (
                              <DropdownMenuItem onClick={() => setStockProduct(product)}>
                                <BoxesIcon className="mr-2 h-4 w-4" /> Stock
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => handleEditOpen(product)}>
                              <Pencil className="mr-2 h-4 w-4" /> Editar
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => toggleActive(product)}>
                              {product.isActive ? 'Desactivar' : 'Activar'}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => setDeleteProductId(product.id)}
                            >
                              <Trash2 className="mr-2 h-4 w-4" /> Eliminar
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      {/* Edit Dialog */}
      <Dialog open={!!editProduct} onOpenChange={() => setEditProduct(null)}>
        <DialogContent className="sm:max-w-[700px] max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Producto</DialogTitle>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4">
              <ProductFormFields formInstance={editForm} />
              <DialogFooter>
                <Button type="submit" disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? 'Guardando...' : 'Guardar cambios'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteProductId} onOpenChange={() => setDeleteProductId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar producto?</AlertDialogTitle>
            <AlertDialogDescription>
              El producto sera eliminado. Podras deshacer esta accion por unos segundos.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteProduct}
            >
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* View Product Dialog */}
      <Dialog open={!!viewProduct} onOpenChange={() => setViewProduct(null)}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {viewProduct && PRODUCT_TYPE_ICON[(viewProduct.productType as ProductType) || 'product']}
              {viewProduct?.name}
            </DialogTitle>
          </DialogHeader>
          {viewProduct && (
            <div className="space-y-4">
              <Badge variant="outline" className={PRODUCT_TYPE_BADGE_CLASS[(viewProduct.productType as ProductType) || 'product']}>
                {PRODUCT_TYPE_LABELS[(viewProduct.productType as ProductType) || 'product']}
              </Badge>
              <div className="grid grid-cols-2 gap-4 text-sm">
                {viewProduct.sku && (
                  <div>
                    <span className="text-muted-foreground block">SKU</span>
                    <p className="font-medium">{viewProduct.sku}</p>
                  </div>
                )}
                {viewProduct.barcode && (
                  <div>
                    <span className="text-muted-foreground block">Codigo de barras</span>
                    <p className="font-medium">{viewProduct.barcode}</p>
                  </div>
                )}
                {viewProduct.category && (
                  <div>
                    <span className="text-muted-foreground block">Categoria</span>
                    <Badge variant="outline" className="mt-1">{viewProduct.category}</Badge>
                  </div>
                )}
                {formatPrice(viewProduct.costPrice, viewProduct.costCurrency) && (
                  <div>
                    <span className="text-muted-foreground block">Precio de costo</span>
                    <p className="font-medium">{formatPrice(viewProduct.costPrice, viewProduct.costCurrency)}</p>
                  </div>
                )}
                {formatPrice(viewProduct.salePrice) && (
                  <div>
                    <span className="text-muted-foreground block">Precio de venta</span>
                    <p className="font-medium text-green-600">{formatPrice(viewProduct.salePrice)}</p>
                  </div>
                )}
                {(viewProduct as any).ivaAliquot != null && (
                  <div data-testid="text-product-iva-detail">
                    <span className="text-muted-foreground block">IVA</span>
                    <p className="font-medium">{String(parseFloat((viewProduct as any).ivaAliquot)).replace('.', ',')}%</p>
                  </div>
                )}
              </div>

              {viewProduct.productType !== 'asset' && (
                <div className="border border-cyan-500/20 rounded-lg p-3 bg-cyan-500/5 space-y-2">
                  <p className="text-sm font-medium text-cyan-700">Inventario</p>
                  <div className="grid grid-cols-3 gap-3 text-sm">
                    <div>
                      <span className="text-muted-foreground block">Stock</span>
                      <p className="font-medium">{parseFloat(viewProduct.stock || '0')} {pluralizeUnit(viewProduct.unit || 'unidad', parseFloat(viewProduct.stock || '0'))}</p>
                    </div>
                    {viewProduct.minStock && parseFloat(viewProduct.minStock) > 0 && (
                      <div>
                        <span className="text-muted-foreground block">Stock minimo</span>
                        <p className="font-medium">{parseFloat(viewProduct.minStock)}</p>
                      </div>
                    )}
                    {viewProduct.unit && (
                      <div>
                        <span className="text-muted-foreground block">Unidad</span>
                        <p className="font-medium">{viewProduct.unit}</p>
                      </div>
                    )}
                  </div>
                  {canCreate && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() => { setViewProduct(null); setStockProduct(viewProduct); }}
                      data-testid="button-manage-stock"
                    >
                      <BoxesIcon className="h-4 w-4 mr-1" /> Gestionar stock
                    </Button>
                  )}
                </div>
              )}

              {viewProduct.productType === 'asset' && (
                <div className="border border-amber-500/20 rounded-lg p-3 bg-amber-500/5 space-y-2">
                  <p className="text-sm font-medium text-amber-600">Datos del activo</p>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    {viewProduct.purchaseDate && (
                      <div>
                        <span className="text-muted-foreground block">Fecha de compra</span>
                        <p className="font-medium">{new Date(viewProduct.purchaseDate).toLocaleDateString('es-AR')}</p>
                      </div>
                    )}
                    {viewProduct.usefulLifeMonths && (
                      <div>
                        <span className="text-muted-foreground block">Vida util</span>
                        <p className="font-medium">{viewProduct.usefulLifeMonths} meses</p>
                      </div>
                    )}
                    {formatPrice(viewProduct.currentValue, viewProduct.costCurrency) && (
                      <div>
                        <span className="text-muted-foreground block">Valor actual</span>
                        <p className="font-medium text-amber-600">{formatPrice(viewProduct.currentValue, viewProduct.costCurrency)}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {viewProduct.description && (
                <div>
                  <span className="text-muted-foreground block text-sm">Descripcion</span>
                  <p className="text-sm mt-1">{viewProduct.description}</p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Stock Movement Dialog */}
      {stockProduct && (
        <StockMovementDialog
          product={stockProduct}
          open={!!stockProduct}
          onOpenChange={(open) => { if (!open) setStockProduct(null); }}
        />
      )}

      {/* Import Products Dialog */}
      {canCreate && (
        <ImportProductsDialog open={isImportOpen} onOpenChange={setIsImportOpen} />
      )}

      {/* Bulk Delete Floating Bar */}
      {canBulkDelete && selectedProductIds.size > 0 && (
        <div className="fixed bottom-28 md:bottom-4 left-1/2 -translate-x-1/2 z-[60] bg-slate-900 text-white rounded-xl shadow-2xl px-3 py-2.5 flex items-center gap-2 animate-in slide-in-from-bottom-4 w-[calc(100vw-2rem)] max-w-md md:w-auto">
          <CheckCircle2 className="h-4 w-4 text-cyan-400" />
          <span className="font-medium text-sm" data-testid="text-bulk-products-count">
            {selectedProductIds.size} seleccionados
          </span>
          <div className="flex items-center gap-1.5 ml-auto">
            <Button
              size="sm"
              variant="default"
              className="bg-red-600 hover:bg-red-700 text-white text-xs h-7 px-3"
              onClick={() => setShowBulkDeleteDialog(true)}
              disabled={bulkDeleting}
              data-testid="button-bulk-delete-products"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              Eliminar
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-slate-300 hover:text-white hover:bg-slate-700 h-7 w-7 p-0"
              onClick={clearProductSelection}
              data-testid="button-clear-product-selection"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Bulk Delete Confirmation */}
      <AlertDialog open={showBulkDeleteDialog} onOpenChange={(o) => !o && !bulkDeleting && setShowBulkDeleteDialog(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar {selectedProductIds.size} productos?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>Los productos seleccionados serán eliminados. Esta acción no se puede deshacer en bloque.</p>
                <p className="text-amber-600 text-sm">
                  Los productos que tengan movimientos contables asociados no podrán eliminarse y se informarán al final. Por defecto, los productos con stock registrado tampoco se eliminan.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-md border border-red-200 bg-red-50 p-3 flex items-start gap-2">
            <Checkbox
              id="bulk-delete-force"
              checked={bulkDeleteForce}
              onCheckedChange={(v) => setBulkDeleteForce(v === true)}
              disabled={bulkDeleting}
              data-testid="checkbox-bulk-delete-force"
              className="mt-0.5"
            />
            <label htmlFor="bulk-delete-force" className="text-sm text-red-800 cursor-pointer select-none">
              <span className="font-medium">Eliminar también productos con stock registrado.</span>{' '}
              <span className="text-xs text-red-700">Borra los movimientos de stock asociados. Esta acción es irreversible y se usa para limpiar catálogos importados mal.</span>
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting} data-testid="button-cancel-bulk-delete-products">Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={async (e) => {
                e.preventDefault();
                if (selectedProductIds.size === 0) return;
                const ids = Array.from(selectedProductIds);
                await runBulkDeleteProducts(ids, bulkDeleteForce, true);
              }}
              disabled={bulkDeleting}
              className="bg-red-600 hover:bg-red-700"
              data-testid="button-confirm-bulk-delete-products"
            >
              {bulkDeleting ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Eliminando...</> : 'Eliminar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
