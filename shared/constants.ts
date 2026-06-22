// =============================================================================
// AIKESTAR - CENTRALIZED CONSTANTS
// =============================================================================
// All hardcoded values should be defined here for easy maintenance

// -----------------------------------------------------------------------------
// AI MODELS
// -----------------------------------------------------------------------------
// Toda la IA de la app usa Claude (Anthropic). Ambos niveles apuntan a
// Claude Opus 4.8 — el modelo más capaz. Si en el futuro se quiere abaratar
// las tareas simples (clasificación), DEFAULT puede pasar a 'claude-haiku-4-5'.
export const AI_MODELS = {
  DEFAULT: 'claude-opus-4-8',
  ADVANCED: 'claude-opus-4-8',
} as const;

// -----------------------------------------------------------------------------
// TIME PERIODS (in milliseconds)
// -----------------------------------------------------------------------------
export const TIME_PERIODS = {
  ONE_MINUTE: 60 * 1000,
  FIVE_MINUTES: 5 * 60 * 1000,
  ONE_HOUR: 60 * 60 * 1000,
  ONE_DAY: 24 * 60 * 60 * 1000,
  SEVEN_DAYS: 7 * 24 * 60 * 60 * 1000,
  FIFTEEN_DAYS: 15 * 24 * 60 * 60 * 1000,
  THIRTY_DAYS: 30 * 24 * 60 * 60 * 1000,
} as const;

// Session duration (7 days)
export const SESSION_MAX_AGE = TIME_PERIODS.SEVEN_DAYS;

// Cache durations
export const CACHE_DURATIONS = {
  STALE_TIME: TIME_PERIODS.FIVE_MINUTES,
  EXCHANGE_RATES_REFRESH: TIME_PERIODS.ONE_HOUR,
} as const;

// -----------------------------------------------------------------------------
// SUBSCRIPTION & CANCELLATION
// -----------------------------------------------------------------------------
export const SUBSCRIPTION_CONFIG = {
  GRACE_PERIOD_DAYS: 7, // Days user can still access after payment fails
  DELETION_DAYS: 15, // Total days before account deletion after payment fails
  WARNING_DAYS_BEFORE_DELETION: 15,
} as const;

// -----------------------------------------------------------------------------
// LOCALE & FORMATTING
// -----------------------------------------------------------------------------
export const LOCALE = {
  DEFAULT: 'es-AR',
  TIMEZONE: 'America/Argentina/Buenos_Aires',
} as const;

// Devuelve el día de HOY en hora de Argentina como `YYYY-MM-DD`.
//
// No se puede usar `new Date().toISOString().split('T')[0]` para esto: eso
// devuelve el día en UTC, y como Argentina está en UTC-3, todo lo que se
// calcula entre las ~21:00 y la medianoche (hora argentina) ya cayó al día
// siguiente en UTC. Sirve tanto en el cliente como en el servidor (que corre
// en UTC). `Intl.DateTimeFormat('en-CA', { timeZone })` formatea siempre como
// `YYYY-MM-DD` calculando el día calendario en la zona horaria pedida.
export function getArgentinaToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: LOCALE.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// Devuelve el mes calendario (en hora de Argentina) de una fecha como
// `YYYY-MM`. Igual que getArgentinaToday pero a nivel mes: agrupa los
// movimientos por mes calendario argentino sin que un movimiento de las
// ~21:00–23:59 (que en UTC ya cayó al mes/día siguiente) se contabilice en el
// mes equivocado.
export function getArgentinaMonth(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: LOCALE.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
  }).format(date);
}

export const NUMBER_FORMAT = {
  MINIMUM_FRACTION_DIGITS: 2,
  MAXIMUM_FRACTION_DIGITS: 2,
} as const;

// -----------------------------------------------------------------------------
// PAGINATION & LIMITS
// -----------------------------------------------------------------------------
export const LIMITS = {
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 100,
  STRIPE_LIST_LIMIT: 100,
} as const;

// -----------------------------------------------------------------------------
// FACTURACIÓN ELECTRÓNICA (ARCA)
// -----------------------------------------------------------------------------
// Tope de precio unitario por ítem que ARCA aplica a monotributistas (Factura C).
// Si el precio unitario de un renglón supera este valor, ARCA rechaza la emisión
// con "unit_price ... supera el máximo permitido para productos en
// monotributistas (NNN)". El valor lo actualiza ARCA cada tanto; usamos esta
// constante para AVISAR de forma preventiva, pero cuando ARCA rechaza mostramos
// el número exacto que viene en su mensaje. Mantener sincronizado con ARCA.
export const MONOTRIBUTO_MAX_UNIT_PRICE = 613492;

// -----------------------------------------------------------------------------
// FILE UPLOAD
// -----------------------------------------------------------------------------
export const FILE_UPLOAD = {
  MAX_SIZE_MB: 10,
  MAX_SIZE_BYTES: 10 * 1024 * 1024,
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp'] as const,
  ALLOWED_DOCUMENT_TYPES: ['application/pdf'] as const,
} as const;

// -----------------------------------------------------------------------------
// API ENDPOINTS (for client-side use)
// -----------------------------------------------------------------------------
export const API_BASE = '/api';

// -----------------------------------------------------------------------------
// TRANSACTION NUMBER PREFIX
// -----------------------------------------------------------------------------
export const TRANSACTION_PREFIX = 'MOV';

// -----------------------------------------------------------------------------
// KPIs DE NEGOCIO (SaaS) — panel ADMIN
// -----------------------------------------------------------------------------
// Tipo de cambio ARS->USD usado SOLO para mostrar el equivalente en dólares de
// métricas que se cobran en pesos (MRR, ARR, ARPU). No hay feed en vivo: es un
// valor de referencia editable. El servidor lo puede sobrescribir con la
// variable de entorno USD_ARS_RATE; si no está definida o es inválida, se usa
// este valor por defecto.
export const USD_ARS_RATE_DEFAULT = 1200;

// Estimaciones fijas de la tabla de negocio (no se calculan desde la base de
// datos porque el sistema no registra gasto de marketing/ventas ni tiene
// historial de permanencia suficiente). Se muestran como tarjetas informativas
// claramente marcadas como "estimado".
export const SAAS_KPI_ESTIMATES = {
  // Costo de adquisición de cliente (CAC), en USD. Rango estimado.
  cacUsdMin: 10,
  cacUsdMax: 25,
  // Relación valor de vida / costo de adquisición (LTV:CAC) estimada.
  ltvCacRatio: 20,
} as const;
