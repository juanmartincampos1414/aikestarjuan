export const COUNTRIES = ['AR', 'CO', 'MX', 'CL', 'PE', 'UY', 'BR', 'US', 'ES'] as const;
export type Country = typeof COUNTRIES[number];

export const COUNTRY_LABELS: Record<Country, string> = {
  'AR': 'Argentina',
  'CO': 'Colombia',
  'MX': 'México',
  'CL': 'Chile',
  'PE': 'Perú',
  'UY': 'Uruguay',
  'BR': 'Brasil',
  'US': 'Estados Unidos',
  'ES': 'España',
};

export const CURRENCIES = ['ARS', 'COP', 'MXN', 'CLP', 'PEN', 'UYU', 'BRL', 'USD', 'USD_CASH', 'EUR'] as const;
export type Currency = typeof CURRENCIES[number];

export const CURRENCY_LABELS: Record<Currency, string> = {
  'ARS': 'Pesos Argentinos',
  'COP': 'Pesos Colombianos',
  'MXN': 'Pesos Mexicanos',
  'CLP': 'Pesos Chilenos',
  'PEN': 'Soles Peruanos',
  'UYU': 'Pesos Uruguayos',
  'BRL': 'Reales Brasileños',
  'USD': 'Dólares (Banco)',
  'USD_CASH': 'Dólares (Efectivo)',
  'EUR': 'Euros',
};

export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  'ARS': 'AR$',
  'COP': 'COP$',
  'MXN': 'MX$',
  'CLP': 'CLP$',
  'PEN': 'S/',
  'UYU': 'UY$',
  'BRL': 'R$',
  'USD': 'US$',
  'USD_CASH': 'US$',
  'EUR': '€',
};

export const COUNTRY_CURRENCY_MAP: Record<Country, Currency> = {
  'AR': 'ARS',
  'CO': 'COP',
  'MX': 'MXN',
  'CL': 'CLP',
  'PE': 'PEN',
  'UY': 'UYU',
  'BR': 'BRL',
  'US': 'USD',
  'ES': 'EUR',
};

// Transaction status types
export const TRANSACTION_STATUSES = ['scheduled', 'completed', 'cancelled'] as const;
export type TransactionStatus = typeof TRANSACTION_STATUSES[number];

// Feature flags (client-side).
// Toggle UI surfaces without removing code. Backend stays untouched.
//
// INVOICING_ENABLED:
//   Hides every entry point to electronic invoicing (ARCA / Facturita) until the
//   final API is wired and validated. Default OFF. To re-enable: set
//   `VITE_INVOICING_ENABLED=true` in the deploy environment and redeploy.
export const FEATURE_FLAGS = {
  INVOICING_ENABLED: import.meta.env.VITE_INVOICING_ENABLED === 'true',
} as const;
