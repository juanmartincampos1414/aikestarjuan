import React, { useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CURRENCY_SYMBOLS } from '@/lib/constants';

interface CurrencyWithTooltipProps {
  value: number;
  currency?: string;
  className?: string;
  label?: string;
}

function formatFullAmount(value: number, currency: string = 'ARS'): string {
  const currencyCode = currency === 'USD_CASH' ? 'USD' : currency;
  return new Intl.NumberFormat('es-AR', { 
    style: 'currency', 
    currency: currencyCode === 'ARS' || currencyCode === 'COP' || currencyCode === 'MXN' || currencyCode === 'CLP' || currencyCode === 'PEN' || currencyCode === 'UYU' || currencyCode === 'BRL' || currencyCode === 'USD' || currencyCode === 'EUR' 
      ? currencyCode 
      : 'ARS'
  }).format(value);
}

function formatAbbreviated(value: number, currency: string = 'ARS'): { abbreviated: string; isAbbreviated: boolean } {
  const absValue = Math.abs(value);
  const symbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || '$';
  
  if (absValue >= 1000000000) {
    const formatted = `${symbol}${(value / 1000000000).toFixed(1)}MM`;
    return { abbreviated: formatted, isAbbreviated: true };
  } else if (absValue >= 1000000) {
    const formatted = `${symbol}${(value / 1000000).toFixed(1)}M`;
    return { abbreviated: formatted, isAbbreviated: true };
  } else {
    return { abbreviated: formatFullAmount(value, currency), isAbbreviated: false };
  }
}

export function CurrencyWithTooltip({ value, currency = 'ARS', className, label }: CurrencyWithTooltipProps) {
  const [showDialog, setShowDialog] = useState(false);
  const { abbreviated, isAbbreviated } = formatAbbreviated(value, currency);
  const fullAmount = formatFullAmount(value, currency);
  
  if (!isAbbreviated) {
    return (
      <span 
        className={`tabular-nums ${className || ''}`}
        style={{ fontSize: 'clamp(0.875rem, 2.5vw, 1.5rem)' }}
      >
        {abbreviated}
      </span>
    );
  }
  
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span 
            className={`cursor-pointer tabular-nums underline decoration-dotted underline-offset-2 ${className || ''}`}
            style={{ fontSize: 'clamp(0.875rem, 2.5vw, 1.5rem)' }}
            onClick={(e) => { e.stopPropagation(); setShowDialog(true); }}
          >
            {abbreviated}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xl font-bold px-4 py-2 hidden md:block">
          {fullAmount}
        </TooltipContent>
      </Tooltip>
      
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-center">{label || 'Monto'}</DialogTitle>
          </DialogHeader>
          <div className="text-center py-4">
            <p className="text-3xl font-bold tabular-nums text-primary">
              {fullAmount}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
