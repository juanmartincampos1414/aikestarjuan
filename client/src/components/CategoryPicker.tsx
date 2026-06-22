import { useState } from 'react';
import { Check, ChevronsUpDown, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';

export type CategoryPickerCategory = {
  id: string;
  name: string;
  type: string;
  expenseSubtype?: string | null;
};

type TxType = 'income' | 'expense' | 'receivable' | 'payable';

interface CategoryPickerProps {
  /** Single-select value. Required in single mode. Ignored when `selectedValues` provided. */
  value?: string;
  /** Single-select change handler. */
  onChange?: (value: string) => void;
  /** When provided, switches the picker to multi-select mode. */
  selectedValues?: string[];
  /** Multi-select change handler. Required when `selectedValues` is provided. */
  onValuesChange?: (values: string[]) => void;
  /** When omitted, the picker shows all categories regardless of type. */
  type?: TxType;
  categories: CategoryPickerCategory[];
  placeholder?: string;
  testId?: string;
  disabled?: boolean;
  triggerClassName?: string;
  /**
   * When false, the "Usar [texto]" inline-create action is hidden, so the
   * picker behaves as a select-only combobox limited to existing categories.
   * Defaults to true to match the wizard's historical behavior.
   */
  allowInlineCreate?: boolean;
  /**
   * Label shown in multi-select mode when more than one item is selected,
   * before the count. Defaults to "categorías".
   */
  multiLabel?: string;
}

export function CategoryPicker({
  value,
  onChange,
  selectedValues,
  onValuesChange,
  type,
  categories,
  placeholder = 'Seleccioná un concepto...',
  testId = 'select-category',
  disabled = false,
  triggerClassName,
  allowInlineCreate = true,
  multiLabel = 'categorías',
}: CategoryPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const isMulti = Array.isArray(selectedValues);
  const selectedSet = isMulti ? new Set(selectedValues) : null;

  // Type filter: when `type` is omitted (e.g. the filter UI in Movimientos
  // and Reportes shows a single list across income/expense), we skip the
  // type-based subset so all available categories show up.
  const filtered = (() => {
    if (!type) return categories;
    const isIncomeType = type === 'income' || type === 'receivable';
    const matchingType = isIncomeType ? 'income' : 'expense';
    return categories.filter(c => c.type === matchingType);
  })();

  const isExpenseType = type === 'expense' || type === 'payable';
  const trimmedSearch = search.trim();
  const hasExactMatch = trimmedSearch.length > 0 && filtered.some(
    c => c.name.toLocaleLowerCase('es-AR') === trimmedSearch.toLocaleLowerCase('es-AR')
  );
  // Inline-create is only meaningful in single-select mode; multi-select
  // filter UIs never create categories from the filter trigger.
  const showCreateCTA = !isMulti && allowInlineCreate && trimmedSearch.length > 0 && !hasExactMatch;
  const handleCreate = () => {
    if (!onChange) return;
    onChange(trimmedSearch);
    setOpen(false);
    setSearch('');
  };

  const matchedCurrent = !isMulti && value && isExpenseType
    ? categories.find(c => c.name === value && c.type === 'expense')
    : null;

  const triggerLabel = (() => {
    if (isMulti) {
      const size = selectedSet!.size;
      if (size === 0) return placeholder;
      if (size === 1) return Array.from(selectedSet!)[0];
      return `${size} ${multiLabel}`;
    }
    return value || placeholder;
  })();

  const clearMulti = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    onValuesChange?.([]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={isMulti && selectedSet!.size > 0 ? 'default' : 'outline'}
          role="combobox"
          disabled={disabled}
          className={cn(
            'w-full justify-between font-normal',
            !isMulti && !value && 'text-muted-foreground',
            isMulti && selectedSet!.size === 0 && 'text-muted-foreground',
            triggerClassName,
          )}
          data-testid={testId}
        >
          <span className="flex items-center gap-2 truncate">
            {triggerLabel}
            {matchedCurrent && (
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${
                  matchedCurrent.expenseSubtype === 'cost'
                    ? 'bg-orange-500/20 text-orange-600 dark:text-orange-400'
                    : 'bg-purple-500/20 text-purple-600 dark:text-purple-400'
                }`}
              >
                {matchedCurrent.expenseSubtype === 'cost' ? 'Costo' : 'Gasto'}
              </span>
            )}
          </span>
          <span className="ml-2 flex items-center gap-1 shrink-0">
            {isMulti && selectedSet!.size > 0 && (
              <span
                role="button"
                tabIndex={0}
                onClick={clearMulti}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    clearMulti(e);
                  }
                }}
                className="opacity-70 hover:opacity-100"
                data-testid={`${testId}-clear`}
                aria-label="Limpiar categorías"
              >
                <X className="h-3.5 w-3.5" />
              </span>
            )}
            <ChevronsUpDown className="h-4 w-4 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput
            placeholder={isMulti ? 'Buscar categoría...' : 'Buscar o escribir concepto...'}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-[240px]">
            <CommandEmpty className="py-2 px-1">
              <span className="block px-2 py-1.5 text-sm text-muted-foreground text-center">
                No hay coincidencias
              </span>
            </CommandEmpty>
            {showCreateCTA && (
              <CommandGroup>
                <CommandItem
                  value={`__create__${trimmedSearch}`}
                  onSelect={handleCreate}
                  data-testid="button-create-inline-category"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Usar "{trimmedSearch}"
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup>
              {filtered.map(cat => {
                const isOn = isMulti
                  ? selectedSet!.has(cat.name)
                  : value === cat.name;
                return (
                  <CommandItem
                    key={cat.id}
                    value={cat.name}
                    onSelect={() => {
                      if (isMulti) {
                        const next = new Set(selectedSet!);
                        if (next.has(cat.name)) next.delete(cat.name);
                        else next.add(cat.name);
                        onValuesChange?.(Array.from(next));
                      } else {
                        onChange?.(cat.name);
                        setOpen(false);
                        setSearch('');
                      }
                    }}
                    data-testid={isMulti ? `${testId}-item-${cat.name}` : undefined}
                  >
                    {isMulti ? (
                      // Cuadradito tipo checkbox para que se vea de un toque
                      // que el listado es multi-select.
                      <span
                        className={cn(
                          'mr-2 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border',
                          isOn
                            ? 'bg-primary border-primary text-primary-foreground'
                            : 'border-input bg-background',
                        )}
                        aria-hidden="true"
                      >
                        {isOn && <Check className="h-3 w-3" strokeWidth={3} />}
                      </span>
                    ) : (
                      <Check
                        className={cn(
                          'mr-2 h-4 w-4',
                          isOn ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                    )}
                    {cat.name}
                    {type && cat.type === 'expense' && (
                      <span
                        className={`ml-auto text-[10px] px-1.5 py-0.5 rounded-full ${
                          cat.expenseSubtype === 'cost'
                            ? 'bg-orange-500/20 text-orange-600 dark:text-orange-400'
                            : 'bg-purple-500/20 text-purple-600 dark:text-purple-400'
                        }`}
                      >
                        {cat.expenseSubtype === 'cost' ? 'Costo' : 'Gasto'}
                      </span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
