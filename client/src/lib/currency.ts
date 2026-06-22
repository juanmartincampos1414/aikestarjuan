/**
 * Currency utilities for handling Argentine format (dot=thousands, comma=decimals)
 * and internal format (dot=decimal)
 */

/**
 * Normalize any amount input to internal format (dot as decimal separator)
 * Handles:
 * - Argentine format: 1.234.567,89 → 1234567.89
 * - Argentine without cents: 1.234.567 → 1234567
 * - Internal format: 1234567.89 → 1234567.89
 * - Plain numbers: 1234567 → 1234567
 * 
 * @param input - The amount string in any supported format
 * @returns The normalized number, or 0 if parsing fails
 */
export function normalizeAmountInput(input: string | number): number {
  if (typeof input === 'number') {
    return isNaN(input) ? 0 : input;
  }
  
  if (!input || typeof input !== 'string') {
    return 0;
  }
  
  const trimmed = input.trim();
  if (!trimmed) return 0;
  
  const hasComma = trimmed.includes(',');
  const dotCount = (trimmed.match(/\./g) || []).length;
  
  let normalized: string;
  
  if (hasComma) {
    // Argentine format with comma as decimal: 239.258,21 → 239258.21
    normalized = trimmed.replace(/\./g, '').replace(',', '.');
  } else if (dotCount > 1) {
    // Multiple dots = AR thousands separators only (no cents): 1.200.000 → 1200000
    normalized = trimmed.replace(/\./g, '');
  } else if (dotCount === 1) {
    // Single dot - check if it's decimal or thousands separator
    const afterDot = trimmed.split('.')[1];
    if (afterDot && afterDot.length <= 2) {
      // Likely decimal: 239258.21 → internal format, keep as is
      normalized = trimmed;
    } else {
      // More than 2 digits after dot = thousands separator: 1.200 (meaning 1200)
      normalized = trimmed.replace(/\./g, '');
    }
  } else {
    // No separators: just a number
    normalized = trimmed;
  }
  
  const result = parseFloat(normalized);
  return isNaN(result) ? 0 : result;
}

/**
 * Format a number for display in Argentine locale
 * @param amount - The amount as number or internal format string
 * @param decimals - Number of decimal places (default 2)
 * @returns Formatted string like "1.234.567,89"
 */
export function formatAmountForDisplayAR(amount: number | string, decimals: number = 2): string {
  const num = typeof amount === 'string' ? normalizeAmountInput(amount) : amount;
  if (isNaN(num)) return '0';
  
  return num.toLocaleString('es-AR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format amount with currency symbol for Argentine display
 * @param amount - The amount
 * @param currency - Currency code (ARS, USD, EUR)
 * @returns Formatted string like "AR$ 1.234.567,89"
 */
export function formatCurrencyAR(amount: number | string, currency: string = 'ARS'): string {
  const num = typeof amount === 'string' ? normalizeAmountInput(amount) : amount;
  
  const symbols: Record<string, string> = {
    'ARS': 'AR$',
    'USD': 'U$D',
    'EUR': '€',
  };
  
  const symbol = symbols[currency] || currency;
  const formatted = formatAmountForDisplayAR(num);
  
  return `${symbol} ${formatted}`;
}

/**
 * Parse amount input and return internal format string (for form state)
 * @param input - User input in any format
 * @returns String in internal format like "1234567.89"
 */
export function parseAmountToInternalFormat(input: string): string {
  const num = normalizeAmountInput(input);
  return num.toString();
}

/**
 * Validate and prepare a raw quote amount for saving.
 *
 * Mirrors exactly what QuotesSection.handleSave needs: the form stores the raw
 * (internal) amount string produced by formatAmountLive, and the save path must
 * (1) reject empty/zero/non-numeric amounts and (2) send that same raw string in
 * the payload while parsing to the correct number. Extracted as a pure helper so
 * it can be unit-tested without rendering the whole page component.
 *
 * @param rawAmount - The raw internal amount string (form.amount)
 * @returns ok=false when invalid; otherwise the numeric value and the exact
 *          string to send in the payload.
 */
export function prepareQuoteAmount(
  rawAmount: string
): { ok: false } | { ok: true; amountNum: number; amountValue: string } {
  const amountNum = parseFloat(rawAmount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return { ok: false };
  }
  return { ok: true, amountNum, amountValue: rawAmount };
}

/**
 * Format amount input LIVE as user types - adds thousand separators while typing
 * Returns both the display value (with separators) and internal value (for form state).
 * 
 * Argentine format: dot = thousands separator, comma = decimal separator
 * 
 * @param input - Raw user input (may contain formatted dots from display)
 * @param previousInternalValue - Optional previous internal value to help detect backspace
 * @returns Object with displayValue and internalValue
 */
export function formatAmountLive(
  input: string, 
  previousInternalValue?: string
): { displayValue: string; internalValue: string } {
  // Remove any non-numeric chars except comma and dot
  let cleaned = input.replace(/[^0-9.,]/g, '');
  
  // Handle empty input
  if (!cleaned) {
    return { displayValue: '', internalValue: '' };
  }
  
  const hasComma = cleaned.includes(',');
  const dotCount = (cleaned.match(/\./g) || []).length;
  
  // Count raw digits in current input vs previous
  const currentDigits = (cleaned.match(/\d/g) || []).length;
  const prevDigits = previousInternalValue 
    ? (previousInternalValue.match(/\d/g) || []).length 
    : 0;
  const isDeleting = previousInternalValue && currentDigits < prevDigits;
  
  // Check if previous value had a decimal
  const prevHadDecimal = previousInternalValue?.includes('.') || false;
  
  let integerPart: string;
  let decimalPart: string | null = null;
  
  if (hasComma) {
    // Comma present = AR format, dots are thousands
    const parts = cleaned.split(',');
    integerPart = (parts[0] || '').replace(/\./g, '');
    decimalPart = parts.length > 1 ? parts[1].replace(/[^0-9]/g, '').slice(0, 2) : null;
  } else if (dotCount > 0) {
    // No comma, but has dots
    
    // Trailing dot → user wants decimal, convert to comma
    if (cleaned.endsWith('.')) {
      integerPart = cleaned.slice(0, -1).replace(/\./g, '');
      decimalPart = ''; // Empty decimal part shows comma
    } else if (isDeleting && !prevHadDecimal) {
      // User is backspacing/deleting AND previous value had no decimal
      // So all dots are thousands separators (from our formatting)
      integerPart = cleaned.replace(/\./g, '');
    } else if (dotCount === 1) {
      // Single dot - check context
      const dotParts = cleaned.split('.');
      const afterDot = dotParts[1] || '';
      
      // If 3 digits after dot, definitely thousands (1.234)
      // If ≤2 digits AND (not deleting OR prev had decimal), treat as decimal
      if (afterDot.length === 3) {
        integerPart = cleaned.replace(/\./g, '');
      } else if (afterDot.length <= 2 && (prevHadDecimal || !isDeleting)) {
        integerPart = dotParts[0];
        decimalPart = afterDot;
      } else {
        integerPart = cleaned.replace(/\./g, '');
      }
    } else {
      // Multiple dots = thousands separators
      integerPart = cleaned.replace(/\./g, '');
    }
  } else {
    // No separators at all
    integerPart = cleaned;
  }
  
  // Add thousand separators to integer part
  const formattedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  
  // Limit decimal to 2 digits
  if (decimalPart !== null) {
    decimalPart = decimalPart.slice(0, 2);
  }
  
  // Build display value with Argentine format (comma for decimal)
  const displayValue = decimalPart !== null 
    ? `${formattedInteger},${decimalPart}`
    : formattedInteger;
  
  // Build internal value (dot as decimal)
  const internalValue = decimalPart !== null && decimalPart.length > 0
    ? `${integerPart}.${decimalPart}`
    : integerPart;
  
  return { displayValue, internalValue };
}
