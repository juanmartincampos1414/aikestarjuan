// =============================================================================
// AIKESTAR - Servicio de cotizaciones de mercado (precios en vivo)
// =============================================================================
// Trae el precio actual de cada posición para calcular valor/ganancia en vivo.
// Funciona out-of-the-box, sin API key:
//   - Acciones / CEDEARs / bonos / ETFs / cripto  -> Yahoo Finance (v8 chart)
//   - Dólar argentino (blue, MEP, CCL, etc.)       -> dolarapi.com
// Si se define FINNHUB_API_KEY, las acciones/ETFs de EE.UU. se cotizan por Finnhub
// (tiempo real, mejores límites), con respaldo automático a Yahoo. Cache en memoria
// (60s) para respetar los rate limits.
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

// Cripto → id de CoinGecko (API gratis sin key, accesible desde la nube; Yahoo bloquea
// las IPs de datacenter como las de Render). Cubre las monedas más comunes.
const COINGECKO_IDS: Record<string, string> = {
  btc: 'bitcoin', xbt: 'bitcoin', eth: 'ethereum', usdt: 'tether', usdc: 'usd-coin',
  bnb: 'binancecoin', sol: 'solana', xrp: 'ripple', ada: 'cardano', doge: 'dogecoin',
  dot: 'polkadot', matic: 'matic-network', pol: 'polygon-ecosystem-token', ltc: 'litecoin',
  avax: 'avalanche-2', link: 'chainlink', trx: 'tron', shib: 'shiba-inu', dai: 'dai',
  uni: 'uniswap', atom: 'cosmos', xlm: 'stellar', bch: 'bitcoin-cash', near: 'near',
  apt: 'aptos', arb: 'arbitrum', op: 'optimism', fil: 'filecoin', etc: 'ethereum-classic',
  algo: 'algorand', vet: 'vechain', icp: 'internet-computer', sand: 'the-sandbox', mana: 'decentraland',
};
export function toCoinGeckoId(symbol: string): string | null {
  const raw = (symbol.includes(':') ? symbol.split(':')[1] : symbol).toLowerCase().trim();
  const base = raw.replace(/(usdt|usdc|busd|usd)$/i, '') || raw;
  return COINGECKO_IDS[base] || null;
}
async function fetchCryptoQuote(symbol: string): Promise<Quote | null> {
  const id = toCoinGeckoId(symbol);
  if (!id) return null;
  const data = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`);
  const row = data?.[id];
  if (!row || typeof row.usd !== 'number') return null;
  return {
    price: row.usd, currency: 'USD',
    changePct: typeof row.usd_24h_change === 'number' ? row.usd_24h_change : null,
    prevClose: null, asOf: Date.now(), source: 'coingecko',
  };
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

// Símbolo Finnhub para acciones/ETFs de EE.UU.: ticker plano ("NASDAQ:AAPL" -> "AAPL").
export function toFinnhubSymbol(symbol: string): string {
  const raw = (symbol || '').trim();
  return (raw.includes(':') ? raw.split(':')[1] : raw).toUpperCase();
}

// Finnhub /quote (acciones US en tiempo real). c=precio, pc=cierre previo, dp=variación %.
// Devuelve null si no hay key o el símbolo es desconocido (Finnhub responde c=0).
async function fetchFinnhubQuote(symbol: string): Promise<Quote | null> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;
  const fs = toFinnhubSymbol(symbol);
  if (!fs) return null;
  const data = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(fs)}&token=${key}`);
  const price = typeof data?.c === 'number' ? data.c : null;
  if (price == null || price === 0) return null; // c=0 => símbolo inexistente / sin datos
  const prevClose = typeof data.pc === 'number' && data.pc !== 0 ? data.pc : null;
  const changePct = typeof data.dp === 'number' ? data.dp : (prevClose ? ((price - prevClose) / prevClose) * 100 : null);
  return { price, currency: 'USD', changePct, prevClose, asOf: Date.now(), source: 'finnhub' };
}

async function fetchQuote(symbol: string, assetType: InvestmentAssetType): Promise<Quote | null> {
  if (assetType === 'dolar') return fetchDolarQuote(symbol);
  // Cripto: CoinGecko (gratis, sin key, accesible desde la nube), con respaldo a Yahoo.
  if (assetType === 'cripto') {
    const cg = await fetchCryptoQuote(symbol);
    if (cg) return cg;
  }
  // Acciones/ETFs de EE.UU.: si hay key de Finnhub, se prioriza (tiempo real),
  // con respaldo automático a Yahoo. BYMA/bonos van por Yahoo (ojo: Yahoo bloquea
  // IPs de datacenter, así que en la nube conviene la key de Finnhub para US).
  if (assetType === 'accion_us' || assetType === 'etf') {
    const fh = await fetchFinnhubQuote(symbol);
    if (fh) return fh;
  }
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

// ── Histórico (para reportes por período) ────────────────────────────────────
// El histórico siempre sale de Yahoo (Finnhub free no tiene candles y dolarapi no
// guarda historia). Para el dólar como activo se usa el oficial USD/ARS de Yahoo
// como aproximación; si no hay dato, queda null.
export interface HistRange { startClose: number | null; endClose: number | null; }

const histCache = new Map<string, { value: HistRange; at: number }>();
const HIST_TTL_MS = 30 * 60_000; // 30 min: el histórico cambia poco

function toYahooHistSymbol(symbol: string, assetType: InvestmentAssetType): string | null {
  if (assetType === 'dolar') return 'ARS=X'; // USD/ARS oficial en Yahoo
  return toYahooSymbol(symbol, assetType);
}

// Histórico de cripto vía CoinGecko (rango), para que el reporte funcione también
// en la nube (Yahoo bloquea datacenters).
async function fetchCryptoHist(symbol: string, fromSec: number, toSec: number): Promise<HistRange> {
  const id = toCoinGeckoId(symbol);
  if (!id) return { startClose: null, endClose: null };
  const data = await fetchJson(`https://api.coingecko.com/api/v3/coins/${id}/market_chart/range?vs_currency=usd&from=${fromSec}&to=${toSec}`);
  const prices: [number, number][] | undefined = data?.prices;
  if (!Array.isArray(prices) || prices.length === 0) return { startClose: null, endClose: null };
  return { startClose: prices[0]?.[1] ?? null, endClose: prices[prices.length - 1]?.[1] ?? null };
}

// Devuelve el cierre más cercano a `fromSec` (primer dato del rango) y el más
// reciente (`endClose`), usando velas diarias entre from y to.
async function fetchYahooHist(yahooSymbol: string, fromSec: number, toSec: number): Promise<HistRange> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?period1=${fromSec}&period2=${toSec}&interval=1d`;
  const data = await fetchJson(url);
  const res = data?.chart?.result?.[0];
  const closes: (number | null)[] | undefined = res?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(closes) || closes.length === 0) return { startClose: null, endClose: null };
  const startClose = closes.find((c) => typeof c === 'number') ?? null;
  let endClose: number | null = null;
  for (let i = closes.length - 1; i >= 0; i--) { if (typeof closes[i] === 'number') { endClose = closes[i]!; break; } }
  return { startClose, endClose };
}

export async function getHistoricalCloses(
  items: { symbol: string; assetType: InvestmentAssetType }[],
  fromSec: number,
  toSec: number,
): Promise<Map<string, HistRange>> {
  const out = new Map<string, HistRange>();
  const unique = new Map<string, { symbol: string; assetType: InvestmentAssetType }>();
  for (const it of items) { if (it.symbol) unique.set(cacheKey(it.symbol, it.assetType), it); }
  const now = Date.now();
  const fromDay = Math.floor(fromSec / 86400);
  await Promise.all(Array.from(unique.entries()).map(async ([key, it]) => {
    const ck = `${key}::${fromDay}`;
    const cached = histCache.get(ck);
    if (cached && now - cached.at < HIST_TTL_MS) { out.set(key, cached.value); return; }
    let value: HistRange;
    if (it.assetType === 'cripto') {
      value = await fetchCryptoHist(it.symbol, fromSec, toSec);
    } else {
      const ys = toYahooHistSymbol(it.symbol, it.assetType);
      value = ys ? await fetchYahooHist(ys, fromSec, toSec) : { startClose: null, endClose: null };
    }
    histCache.set(ck, { value, at: now });
    out.set(key, value);
  }));
  return out;
}
