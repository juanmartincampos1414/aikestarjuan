import {
  ARCA_INVOICE_NUMBER_REGEX,
  isValidArcaInvoiceNumber,
  normalizeArcaInvoiceNumber,
} from '@shared/schema';

export const INVOICE_NUMBER_FORMAT_HINT = 'Formato: 0001-00001234 (4 dígitos · 8 dígitos)';
export const INVOICE_NUMBER_FORMAT_ERROR = 'Formato inválido. Usá PPPP-NNNNNNNN (ej: 0001-00001234).';

export const normalizeInvoiceNumber = (input: string | null | undefined): string =>
  normalizeArcaInvoiceNumber(input);

export const validateInvoiceNumber = (input: string | null | undefined): boolean =>
  isValidArcaInvoiceNumber(input);

export { ARCA_INVOICE_NUMBER_REGEX };

export const formatAmountAR = (amount: string | number): { integer: string; cents: string | null } => {
  let num: number;
  
  if (typeof amount === 'number') {
    num = amount;
  } else if (typeof amount === 'string') {
    const hasComma = amount.includes(',');
    const dotCount = (amount.match(/\./g) || []).length;
    
    if (hasComma) {
      // Argentine format with comma as decimal: 239.258,21 → remove dots, replace comma
      num = parseFloat(amount.replace(/\./g, '').replace(',', '.'));
    } else if (dotCount > 1) {
      // Multiple dots = AR thousands separators only (no cents): 1.200.000 → 1200000
      num = parseFloat(amount.replace(/\./g, ''));
    } else if (dotCount === 1) {
      // Single dot - check if it's decimal or thousands separator
      const afterDot = amount.split('.')[1];
      if (afterDot && afterDot.length <= 2) {
        // Likely decimal: 239258.21 → internal format, parse directly
        num = parseFloat(amount);
      } else {
        // More than 2 digits after dot = thousands separator: 1.200 → 1200
        num = parseFloat(amount.replace(/\./g, ''));
      }
    } else {
      // No separators: just a number
      num = parseFloat(amount);
    }
  } else {
    num = 0;
  }
  
  if (isNaN(num)) return { integer: '0', cents: null };
  
  const fixed = num.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  
  const formattedInt = parseInt(intPart).toLocaleString('es-AR');
  const cents = decPart === '00' ? null : decPart;
  
  return { integer: formattedInt, cents };
};

export const formatAmountForDisplay = (value: string): string => {
  if (!value) return '';
  const numValue = parseFloat(value);
  if (isNaN(numValue)) return '';
  const parts = value.split('.');
  const integerPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const decimalPart = parts[1] || '';
  return decimalPart ? `${integerPart},${decimalPart}` : integerPart;
};

export const validateImputationDate = (dateValue: string, transactionType: string): string | null => {
  const isPendingType = transactionType === 'payable' || transactionType === 'receivable';
  if (!dateValue) {
    if (isPendingType) {
      return "Debes seleccionar una fecha de vencimiento";
    }
    return null;
  }
  const now = new Date();
  
  const dateParts = dateValue.split('-').map(Number);
  const selectedDate = isPendingType 
    ? new Date(dateParts[0], dateParts[1] - 1, dateParts[2]) 
    : new Date(dateParts[0], dateParts[1] - 1, 1);
  
  const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const twoYearsAgo = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());
  const oneYearAhead = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
  
  if (transactionType === 'income' || transactionType === 'expense') {
    if (selectedDate < twoYearsAgo) {
      return "La fecha es muy antigua (más de 2 años atrás)";
    }
    if (selectedDate > currentMonth) {
      return "Para ingresos/egresos ya realizados, usá el mes actual o anterior";
    }
  }
  if (isPendingType) {
    if (selectedDate < today) {
      return "Los compromisos pendientes deben tener fecha de hoy o futura";
    }
    if (selectedDate > oneYearAhead) {
      return "La fecha es muy lejana (más de 1 año adelante)";
    }
  }
  return null;
};
