"use client"

import * as React from "react"
import { Check, ChevronsUpDown, Plus } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Input } from "@/components/ui/input"

export interface CreatableComboboxOption {
  value: string
  label: string
}

interface CreatableComboboxProps {
  options: CreatableComboboxOption[]
  value: string
  onValueChange: (value: string) => void
  onCreateOption?: (value: string) => Promise<void> | void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  createText?: string
  className?: string
  disabled?: boolean
  "data-testid"?: string
}

export function CreatableCombobox({
  options,
  value,
  onValueChange,
  onCreateOption,
  placeholder = "Seleccionar...",
  searchPlaceholder = "Buscar...",
  emptyText = "No se encontraron resultados.",
  createText = "Crear",
  className,
  disabled,
  "data-testid": testId,
}: CreatableComboboxProps) {
  const [open, setOpen] = React.useState(false)
  const [inputValue, setInputValue] = React.useState("")
  const [isCreating, setIsCreating] = React.useState(false)
  const [highlightedIndex, setHighlightedIndex] = React.useState(-1)
  const listRef = React.useRef<HTMLDivElement>(null)

  const selectedOption = options.find((option) => option.value === value)
  
  const normalizedInput = inputValue.trim().toLowerCase()
  
  const filteredOptions = options.filter((option) =>
    option.label.toLowerCase().includes(normalizedInput)
  )
  
  const showCreateOption = inputValue.trim() && 
    !options.some((option) => 
      option.label.toLowerCase() === normalizedInput ||
      option.value.toLowerCase() === normalizedInput
    )

  const totalItems = filteredOptions.length + (showCreateOption ? 1 : 0)

  const handleSelect = (selectedValue: string) => {
    onValueChange(selectedValue)
    setOpen(false)
    setInputValue("")
    setHighlightedIndex(-1)
  }

  const handleCreate = async () => {
    const newValue = inputValue.trim()
    if (newValue && !isCreating) {
      setIsCreating(true)
      try {
        if (onCreateOption) {
          await onCreateOption(newValue)
        }
        onValueChange(newValue)
        setOpen(false)
        setInputValue("")
        setHighlightedIndex(-1)
      } catch (error) {
        // Error is handled by the parent via onCreateOption's promise rejection
        // Keep popover open so user can try again
      } finally {
        setIsCreating(false)
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setHighlightedIndex((prev) => Math.min(prev + 1, totalItems - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setHighlightedIndex((prev) => Math.max(prev - 1, 0))
    } else if (e.key === "Enter" && highlightedIndex >= 0) {
      e.preventDefault()
      if (highlightedIndex < filteredOptions.length) {
        handleSelect(filteredOptions[highlightedIndex].value)
      } else if (showCreateOption) {
        handleCreate()
      }
    } else if (e.key === "Escape") {
      setOpen(false)
      setHighlightedIndex(-1)
    }
  }

  React.useEffect(() => {
    if (!open) {
      setHighlightedIndex(-1)
      setInputValue("")
    }
  }, [open])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={disabled}
          className={cn(
            "w-full justify-between font-normal",
            !value && "text-muted-foreground",
            className
          )}
          data-testid={testId}
        >
          {selectedOption?.label || value || placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-full min-w-[200px] p-0" align="start">
        <div className="flex flex-col">
          <div className="flex items-center border-b px-3 py-2">
            <Input
              placeholder={searchPlaceholder}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              className="h-8 border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
              data-testid="combobox-search-input"
              autoFocus
            />
          </div>
          <div 
            ref={listRef}
            role="listbox"
            aria-label="Opciones"
            className="max-h-[200px] overflow-y-auto"
            style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', touchAction: 'pan-y' }}
            onWheel={(e) => {
              const el = listRef.current
              if (!el) return
              el.scrollTop += e.deltaY
              e.stopPropagation()
            }}
            onTouchMove={(e) => {
              e.stopPropagation()
            }}
          >
            {filteredOptions.length === 0 && !showCreateOption && (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {emptyText}
              </div>
            )}
            <div className="p-1">
              {filteredOptions.map((option, index) => (
                <div
                  key={option.value}
                  role="option"
                  aria-selected={value === option.value}
                  onClick={() => handleSelect(option.value)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  className={cn(
                    "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none",
                    (highlightedIndex === index || value === option.value) && "bg-accent text-accent-foreground"
                  )}
                  data-testid={`combobox-option-${option.value}`}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === option.value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {option.label}
                </div>
              ))}
              {showCreateOption && (
                <div
                  role="option"
                  aria-selected={false}
                  onClick={handleCreate}
                  onMouseEnter={() => setHighlightedIndex(filteredOptions.length)}
                  className={cn(
                    "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none text-primary",
                    highlightedIndex === filteredOptions.length && "bg-accent",
                    isCreating && "pointer-events-none opacity-50"
                  )}
                  data-testid="combobox-create-option"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  {isCreating ? "Creando..." : `${createText} "${inputValue.trim()}"`}
                </div>
              )}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
