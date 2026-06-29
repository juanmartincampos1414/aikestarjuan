// =============================================================================
// AIKESTAR - Servicio de cotizaciones de mercado (precios en vivo)
// =============================================================================
// Trae el precio actual de cada posición para calcular valor/ganancia en vivo.
// Funciona out-of-the-box, sin API key:
//   - Acciones / CEDEARs / bonos / ETFs / cripto  -> Yahoo Finance (v8 chart)
//   - Dólar argentino (blue, MEP, CCL, etc.)       -> dolarapi.com
// Opcionalmente, si se define FINNHUB_API_KEY, se usa Finnhub para acciones US
// (mejores límites). Cache en memoria (60s) para respetar los rate limits.
// =============================================================================
import type { InvestmentAssetType } from '@shared/schema';

export interface Quote {
  price: number;
  currency: string;
  changePct: number | null; // variación del día en %
  prevClose: number | null;
  asOf: number; // epoch ms
  source: string;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { quote: Quote | null; at: number }>();

function cacheKey(symbol: string, assetType: string) {
  return `${assetType}::${symbol}`;
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AikestarBot/1.0)' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Mapea un símbolo en formato TradingView al símbolo de Yahoo Finance.
// Devuelve null si el activo no se cotiza por Yahoo (ej. dólar argentino).
export function toYahooSymbol(symbol: string, assetType: InvestmentAssetType): string | null {
  const raw = (symbol || '').trim();
  if (!raw) return null;
  // Quitar prefijo de exchange "BCBA:GGAL" -> "GGAL"
  const ticker = (raw.includes(':') ? raw.split(':')[1] : raw).toUpperCase();
  switch (assetType) {
    case 'accion_arg':
    case 'cedear':
    case 'bono':
      return `${ticker}.BA`;
    case 'accion_us':
    case 'etf':
      return ticker;
    case 'cripto': {
      // "BTCUSDT" / "BTCUSD" / "BTC" -> "BTC-USD"
      const base = ticker.replace(/(USDT|USDC|USD|BUSD)$/i, '') || ticker;
      return `${base}-USD`;
    }
    case 'dolar':
      return null; // se resuelve por dolarapi
    default:
      return ticker.includes('.') || ticker.length <= 6 ? ticker : null;
  }
}

// Mapea el símbolo de dólar ("DOLAR:blue", "blue", "mep"...) a la "casa" de dolarapi.
function toDolarCasa(symbol: string): string {
  const v = (symbol.includes(':') ? symbol.split(':')[1] : symbol).toLowerCase().trim();
  const map: Record<string, string> = {
    oficial: 'oficial', blue: 'blue', bolsa: 'bolsa', mep: 'bolsa',
    ccl: 'contadoconliqui', contadoconliqui: 'contadoconliqui', cl: 'contadoconliqui',
    tarjeta: 'tarjeta', mayorista: 'mayorista', cripto: 'cripto',
  };
  return map[v] || 'blue';
}

async function fetchYahooQuote(yahooSymbol: string): Promise<Quote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=2d`;
  const data = await fetchJson(url);
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
  const price = meta.regularMarketPrice;
  const prevClose = typeof meta.chartPreviousClose === 'number'
    ? meta.chartPreviousClose
    : (typeof meta.previousClose === 'number' ? meta.previousClose : null);
  const changePct = prevClose && prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : null;
  return {
    price,
    currency: meta.currency || 'USD',
    changePct,
    prevClose,
    asOf: Date.now(),
    source: 'yahoo',
  };
}

async function fetchDolarQuote(symbol: string): Promise<Quote | null> {
  const casa = toDolarCasa(symbol);
  const data = await fetchJson(`https://dolarapi.com/v1/dolares/${casa}`);
  const price = typeof data?.venta === 'number' ? data.venta : (typeof data?.compra === 'number' ? data.compra : null);
  if (price == null) return null;
  return { price, currency: 'ARS', changePct: null, prevClose: null, asOf: Date.now(), source: 'dolarapi' };
}

async function fetchQuote(symbol: string, assetType: InvestmentAssetType): Promise<Quote | null> {
  if (assetType === 'dolar') return fetchDolarQuote(symbol);
  const ys = toYahooSymbol(symbol, assetType);
  if (!ys) return null;
  return fetchYahooQuote(ys);
}

// Devuelve un mapa keyed por `${assetType}::${symbol}` con la cotización (o null).
export async function getQuotes(
  items: { symbol: string; assetType: InvestmentAssetType }[],
): Promise<Map<string, Quote | null>> {
  const out = new Map<string, Quote | null>();
  // Deduplicar por (symbol, assetType)
  const unique = new Map<string, { symbol: string; assetType: InvestmentAssetType }>();
  for (const it of items) {
    if (!it.symbol) continue;
    unique.set(cacheKey(it.symbol, it.assetType), it);
  }
  const now = Date.now();
  await Promise.all(Array.from(unique.entries()).map(async ([key, it]) => {
    const cached = cache.get(key);
    if (cached && now - cached.at < CACHE_TTL_MS) {
      out.set(key, cached.quote);
      return;
    }
    const quote = await fetchQuote(it.symbol, it.assetType);
    // Si falla y hay cache viejo, devolver el viejo en vez de null (mejor que nada).
    const value = quote ?? cached?.quote ?? null;
    cache.set(key, { quote: value, at: now });
    out.set(key, value);
  }));
  return out;
}

export function quoteKey(symbol: string, assetType: string) {
  return cacheKey(symbol, assetType);
}
