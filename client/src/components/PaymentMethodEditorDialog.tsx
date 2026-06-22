import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useFieldArray, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { paymentMethodAPI, fetchWithAuth } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Plus, X, Check, ChevronsUpDown } from 'lucide-react';
import type { PaymentMethodWithConcepts } from '@shared/schema';
import { MAX_PAYMENT_METHOD_CONCEPTS } from '@shared/schema';

const conceptSchema = z.object({
  name: z.string().trim().min(1, 'Nombre requerido').max(80, 'Máximo 80'),
  kind: z.enum(['percentage', 'fixed']),
  value: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,4})?$/, 'Valor inválido')
    .refine((v) => parseFloat(v) > 0, 'Debe ser mayor a 0'),
  expenseCategoryId: z.string().nullable().optional(),
});

const formSchema = z.object({
  name: z.string().trim().min(2, 'El nombre es requerido').max(80, 'Máximo 80 caracteres'),
  description: z.string().trim().max(500, 'Máximo 500 caracteres').optional().or(z.literal('')),
  concepts: z
    .array(conceptSchema)
    .min(0)
    .max(MAX_PAYMENT_METHOD_CONCEPTS, `Máximo ${MAX_PAYMENT_METHOD_CONCEPTS} conceptos`)
    .superRefine((concepts, ctx) => {
      concepts.forEach((c, i) => {
        if (c.kind === 'percentage') {
          const v = parseFloat(c.value);
          if (v > 100) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i, 'value'],
              message: 'El porcentaje no puede superar 100',
            });
          }
        }
      });
    }),
});

type FormValues = z.infer<typeof formSchema>;

const PREVIEW_AMOUNT = 10000;

function formatARS(n: number): string {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 2,
  }).format(n);
}

interface PaymentMethodEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMethod?: PaymentMethodWithConcepts | null;
  onSaved?: (method: PaymentMethodWithConcepts) => void;
}

export default function PaymentMethodEditorDialog({
  open,
  onOpenChange,
  initialMethod,
  onSaved,
}: PaymentMethodEditorDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: categories = [] } = useQuery<
    Array<{ id: string; name: string; type: string; expenseSubtype: string | null }>
  >({
    queryKey: ['/organization/categories'],
    queryFn: () => fetchWithAuth('/organization/categories'),
  });

  const expenseCategories = categories.filter((c) => c.type === 'expense');

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: '', description: '', concepts: [] },
  });

  const conceptsArray = useFieldArray({ control: form.control, name: 'concepts' });
  const watchedConcepts = useWatch({ control: form.control, name: 'concepts' });

  // Reset form whenever the dialog opens, with the initial method's data
  // (or blank for "new"). Without this, opening "edit" right after "new"
  // would keep the previous form state.
  React.useEffect(() => {
    if (!open) return;
    if (initialMethod) {
      form.reset({
        name: initialMethod.name,
        description: initialMethod.description || '',
        concepts: initialMethod.concepts
          .slice()
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
          .map((c) => ({
            name: c.name,
            kind: c.kind as 'percentage' | 'fixed',
            value: String(parseFloat(c.value)),
            expenseCategoryId: c.expenseCategoryId || null,
          })),
      });
    } else {
      form.reset({ name: '', description: '', concepts: [] });
    }
  }, [open, initialMethod, form]);

  const preview = React.useMemo(() => {
    let totalCost = 0;
    const lines: Array<{ name: string; cost: number; pct: number }> = [];
    for (const c of watchedConcepts || []) {
      if (!c?.value) continue;
      const v = parseFloat(c.value);
      if (!Number.isFinite(v) || v <= 0) continue;
      const cost = c.kind === 'percentage' ? (PREVIEW_AMOUNT * v) / 100 : v;
      lines.push({
        name: c.name || 'Concepto',
        cost,
        pct: (cost / PREVIEW_AMOUNT) * 100,
      });
      totalCost += cost;
    }
    return { lines, totalCost, net: PREVIEW_AMOUNT - totalCost };
  }, [watchedConcepts]);

  const saveMutation = useMutation<PaymentMethodWithConcepts, Error, FormValues>({
    mutationFn: async (values: FormValues) => {
      const concepts = values.concepts.map((c, i) => ({
        name: c.name,
        kind: c.kind,
        value: c.value,
        expenseCategoryId: c.expenseCategoryId || null,
        position: i,
      }));
      const payload = {
        name: values.name,
        description: values.description || null,
        concepts,
      };
      return initialMethod
        ? paymentMethodAPI.update(initialMethod.id, payload)
        : paymentMethodAPI.create(payload);
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['/api/payment-methods'] });
      toast({ title: initialMethod ? 'Medio actualizado' : 'Medio creado' });
      onOpenChange(false);
      onSaved?.(saved);
    },
    onError: (err: any) => {
      toast({
        title: 'Error',
        description: err?.message || 'No se pudo guardar el medio',
        variant: 'destructive',
      });
    },
  });

  const onSubmit = (values: FormValues) => saveMutation.mutate(values);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {initialMethod ? `Editar "${initialMethod.name}"` : 'Nuevo medio de cobro'}
          </DialogTitle>
          <DialogDescription>
            Hasta {MAX_PAYMENT_METHOD_CONCEPTS} conceptos. Los porcentajes se calculan sobre el monto
            bruto (sin cascada).
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nombre *</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="MercadoPago 6 cuotas"
                      {...field}
                      data-testid="input-method-name"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Descripción</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Notas internas (opcional)"
                      rows={2}
                      {...field}
                      data-testid="input-method-description"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-sm">Conceptos asociados</div>
                  <div className="text-xs text-muted-foreground">
                    {conceptsArray.fields.length} de {MAX_PAYMENT_METHOD_CONCEPTS}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    conceptsArray.append({
                      name: '',
                      kind: 'percentage',
                      value: '',
                      expenseCategoryId: null,
                    })
                  }
                  disabled={conceptsArray.fields.length >= MAX_PAYMENT_METHOD_CONCEPTS}
                  data-testid="button-add-concept"
                >
                  <Plus className="h-4 w-4 mr-1" /> Agregar concepto
                </Button>
              </div>

              {conceptsArray.fields.length === 0 ? (
                <div className="border border-dashed rounded-lg p-4 text-center text-sm text-muted-foreground">
                  Agregá conceptos como "Comisión MP", "IIBB", "Costo financiero", etc.
                </div>
              ) : (
                <div className="space-y-2">
                  {conceptsArray.fields.map((field, idx) => (
                    <div
                      key={field.id}
                      className="border rounded-lg p-3 space-y-2 bg-muted/30"
                      data-testid={`row-concept-${idx}`}
                    >
                      <div className="grid grid-cols-12 gap-2 items-start">
                        <div className="col-span-12 sm:col-span-4">
                          <FormField
                            control={form.control}
                            name={`concepts.${idx}.name`}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs">Nombre</FormLabel>
                                <FormControl>
                                  <Input
                                    placeholder="Comisión MP"
                                    {...field}
                                    data-testid={`input-concept-name-${idx}`}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>
                        <div className="col-span-5 sm:col-span-3">
                          <FormField
                            control={form.control}
                            name={`concepts.${idx}.kind`}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs">Tipo</FormLabel>
                                <Select value={field.value} onValueChange={field.onChange}>
                                  <FormControl>
                                    <SelectTrigger data-testid={`select-concept-kind-${idx}`}>
                                      <SelectValue />
                                    </SelectTrigger>
                                  </FormControl>
                                  <SelectContent>
                                    <SelectItem value="percentage">Porcentaje (%)</SelectItem>
                                    <SelectItem value="fixed">Monto fijo ($)</SelectItem>
                                  </SelectContent>
                                </Select>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>
                        <div className="col-span-7 sm:col-span-3">
                          <FormField
                            control={form.control}
                            name={`concepts.${idx}.value`}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs">
                                  Valor{' '}
                                  {watchedConcepts?.[idx]?.kind === 'percentage' ? '(%)' : '($)'}
                                </FormLabel>
                                <FormControl>
                                  <Input
                                    placeholder={
                                      watchedConcepts?.[idx]?.kind === 'percentage' ? '2.5' : '100'
                                    }
                                    inputMode="decimal"
                                    {...field}
                                    data-testid={`input-concept-value-${idx}`}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>
                        <div className="col-span-12 sm:col-span-2 flex items-end justify-end h-full">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => conceptsArray.remove(idx)}
                            data-testid={`button-remove-concept-${idx}`}
                            title="Quitar concepto"
                          >
                            <X className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>

                      <FormField
                        control={form.control}
                        name={`concepts.${idx}.expenseCategoryId`}
                        render={({ field }) => {
                          const selectedCat = expenseCategories.find((c) => c.id === field.value);
                          return (
                            <FormItem className="flex flex-col">
                              <FormLabel className="text-xs">
                                Categoría de egreso (opcional)
                              </FormLabel>
                              <CategoryCombobox
                                idx={idx}
                                value={field.value || null}
                                onChange={(v) => field.onChange(v)}
                                categories={expenseCategories}
                                displayLabel={
                                  selectedCat ? selectedCat.name : 'Costos de cobro (por defecto)'
                                }
                              />
                              <FormMessage />
                            </FormItem>
                          );
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {watchedConcepts && watchedConcepts.length > 0 && (
              <div
                className="border rounded-lg p-4 bg-cyan-500/5 border-cyan-500/20"
                data-testid="payment-method-preview"
              >
                <div className="text-xs font-semibold text-cyan-700 mb-2 uppercase tracking-wide">
                  Si vendés {formatARS(PREVIEW_AMOUNT)}…
                </div>
                <div className="space-y-1 text-sm">
                  {preview.lines.map((l, i) => (
                    <div key={i} className="flex justify-between text-muted-foreground">
                      <span>{l.name}</span>
                      <span>
                        − {formatARS(l.cost)} ({l.pct.toFixed(2)}%)
                      </span>
                    </div>
                  ))}
                  <div className="flex justify-between pt-2 mt-2 border-t font-semibold">
                    <span>Recibís neto</span>
                    <span data-testid="text-preview-net">{formatARS(preview.net)}</span>
                  </div>
                </div>
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                data-testid="button-cancel-method"
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                disabled={saveMutation.isPending}
                data-testid="button-save-method"
              >
                {saveMutation.isPending
                  ? 'Guardando…'
                  : initialMethod
                    ? 'Guardar cambios'
                    : 'Crear medio'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

interface CategoryComboboxProps {
  idx: number;
  value: string | null;
  onChange: (v: string | null) => void;
  categories: Array<{ id: string; name: string }>;
  displayLabel: string;
}

function CategoryCombobox({
  idx,
  value,
  onChange,
  categories,
  displayLabel,
}: CategoryComboboxProps) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'w-full justify-between font-normal',
            !value && 'text-muted-foreground',
          )}
          data-testid={`select-concept-category-${idx}`}
        >
          <span className="truncate">{displayLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
        sideOffset={4}
      >
        <Command>
          <CommandInput placeholder="Buscar categoría…" />
          <CommandList className="max-h-[260px] overflow-y-auto">
            <CommandEmpty>Sin resultados.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__none__ Costos de cobro por defecto"
                onSelect={() => {
                  onChange(null);
                  setOpen(false);
                }}
                data-testid={`option-category-default-${idx}`}
              >
                <Check
                  className={cn(
                    'mr-2 h-4 w-4',
                    !value ? 'opacity-100' : 'opacity-0',
                  )}
                />
                Costos de cobro (por defecto)
              </CommandItem>
              {categories.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.name}
                  onSelect={() => {
                    onChange(c.id);
                    setOpen(false);
                  }}
                  data-testid={`option-category-${c.id}`}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      value === c.id ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  {c.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
