import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Check, ChevronsUpDown, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";

export type ReceiverPickerOption = {
  id: string;
  name?: string | null;
  taxId?: string | null;
  cuit?: string | null;
  email?: string | null;
  ivaCondition?: string | null;
  address?: string | null;
  phone?: string | null;
};

export interface ReceiverPickerProps {
  value: string | "manual" | null;
  options: ReceiverPickerOption[];
  onSelect: (option: ReceiverPickerOption) => void;
  onSelectManual: () => void;
  groupLabel?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  manualLabel?: string;
  emptyLabel?: string;
  testIdPrefix?: string;
  disabled?: boolean;
}

export function ReceiverPicker({
  value,
  options,
  onSelect,
  onSelectManual,
  groupLabel = "Mis clientes",
  placeholder = "Elegí un cliente o tipeá un CUIT…",
  searchPlaceholder = "Buscar por nombre, razón social o CUIT…",
  manualLabel = "Receptor manual (tipear datos)",
  emptyLabel = "No se encontraron clientes.",
  testIdPrefix = "emit-client",
  disabled = false,
}: ReceiverPickerProps) {
  const [open, setOpen] = useState(false);
  const selected = value && value !== "manual"
    ? options.find((o) => o.id === value)
    : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          disabled={disabled}
          className={cn(
            "w-full justify-between font-normal",
            !value && "text-muted-foreground",
          )}
          data-testid={`combobox-${testIdPrefix}`}
        >
          <span className="flex items-center gap-2 truncate">
            <User className="h-4 w-4 shrink-0 opacity-60" />
            {value === "manual" ? (
              "Receptor manual"
            ) : selected ? (
              <span className="truncate">
                {selected.name}
                {(selected.taxId || selected.cuit) ? (
                  <span className="text-muted-foreground">
                    {" · "}
                    {selected.taxId || selected.cuit}
                  </span>
                ) : null}
              </span>
            ) : (
              placeholder
            )}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        <Command
          filter={(v, search) => {
            if (!search) return 1;
            return v.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
          }}
        >
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList className="max-h-[240px]">
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__manual__ receptor manual"
                onSelect={() => {
                  onSelectManual();
                  setOpen(false);
                }}
                data-testid={`option-${testIdPrefix}-manual`}
              >
                <Check
                  className={cn(
                    "mr-2 h-4 w-4",
                    value === "manual" ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="text-primary">{manualLabel}</span>
              </CommandItem>
            </CommandGroup>
            {options.length > 0 && (
              <CommandGroup heading={groupLabel}>
                {options.map((o) => {
                  const taxId = o.taxId || o.cuit || "";
                  const searchValue = `${o.name || ""} ${taxId} ${o.email || ""}`.trim();
                  return (
                    <CommandItem
                      key={o.id}
                      value={searchValue}
                      onSelect={() => {
                        onSelect(o);
                        setOpen(false);
                      }}
                      data-testid={`option-${testIdPrefix}-${o.id}`}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          value === o.id ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <div className="flex flex-col min-w-0">
                        <span className="truncate">{o.name || "—"}</span>
                        {(taxId || o.email) && (
                          <span className="text-xs text-muted-foreground truncate">
                            {taxId}
                            {taxId && o.email ? " · " : ""}
                            {o.email || ""}
                          </span>
                        )}
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
