// Tests de inversiones (lógica pura: P&L, totales por moneda, mapeo de símbolos).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';

test('computePosition: valor, costo y P&L con cotización', async () => {
  const { computePosition } = await import('./services/investmentService');
  const p = computePosition({ quantity: '10', buyPrice: '100', currency: 'ARS' }, { price: 150, currency: 'ARS', changePct: 5, prevClose: 142.85, asOf: Date.now(), source: 'yahoo' });
  assert.equal(p.cost, 1000);
  assert.equal(p.currentValue, 1500);
  assert.equal(p.pnl, 500);
  assert.equal(p.pnlPct, 50);
  assert.equal(p.dayChangePct, 5);
});

test('computePosition: sin cotización deja valores en null', async () => {
  const { computePosition } = await import('./services/investmentService');
  const p = computePosition({ quantity: '5', buyPrice: '20', currency: 'USD' }, null);
  assert.equal(p.cost, 100);
  assert.equal(p.currentValue, null);
  assert.equal(p.pnl, null);
  assert.equal(p.currency, 'USD');
});

test('computePosition: sin precio de compra no calcula P&L', async () => {
  const { computePosition } = await import('./services/investmentService');
  const p = computePosition({ quantity: '3', buyPrice: null, currency: 'ARS' }, { price: 10, currency: 'ARS', changePct: null, prevClose: null, asOf: Date.now(), source: 'yahoo' });
  assert.equal(p.cost, null);
  assert.equal(p.currentValue, 30);
  assert.equal(p.pnl, null);
  assert.equal(p.pnlPct, null);
});

test('computeTotals: agrupa por moneda y suma costo/valor/PNL', async () => {
  const { computeTotals } = await import('./services/investmentService');
  const totals = computeTotals([
    { investment: {} as any, position: { cost: 1000, currentValue: 1500, currency: 'ARS' } as any },
    { investment: {} as any, position: { cost: 500, currentValue: 400, currency: 'ARS' } as any },
    { investment: {} as any, position: { cost: 100, currentValue: 120, currency: 'USD' } as any },
  ]);
  const ars = totals.find((t) => t.currency === 'ARS')!;
  const usd = totals.find((t) => t.currency === 'USD')!;
  assert.equal(ars.cost, 1500);
  assert.equal(ars.currentValue, 1900);
  assert.equal(ars.pnl, 400);
  assert.equal(usd.pnl, 20);
});

test('toYahooSymbol: mapea cada tipo de activo', async () => {
  const { toYahooSymbol } = await import('./services/marketData');
  assert.equal(toYahooSymbol('BCBA:GGAL', 'accion_arg'), 'GGAL.BA');
  assert.equal(toYahooSymbol('AAPL', 'cedear'), 'AAPL.BA');
  assert.equal(toYahooSymbol('NASDAQ:AAPL', 'accion_us'), 'AAPL');
  assert.equal(toYahooSymbol('BINANCE:BTCUSDT', 'cripto'), 'BTC-USD');
  assert.equal(toYahooSymbol('ETH', 'cripto'), 'ETH-USD');
  assert.equal(toYahooSymbol('AL30', 'bono'), 'AL30.BA');
  assert.equal(toYahooSymbol('blue', 'dolar'), null);
});

test('toFinnhubSymbol: ticker plano sin prefijo de exchange', async () => {
  const { toFinnhubSymbol } = await import('./services/marketData');
  assert.equal(toFinnhubSymbol('NASDAQ:AAPL'), 'AAPL');
  assert.equal(toFinnhubSymbol('NYSE:SPY'), 'SPY');
  assert.equal(toFinnhubSymbol('tsla'), 'TSLA');
});

test('computePeriodReturn: variación del período', async () => {
  const { computePeriodReturn } = await import('./services/investmentReport');
  assert.equal(computePeriodReturn(100, 125), 25);
  assert.equal(computePeriodReturn(200, 150), -25);
  assert.equal(computePeriodReturn(null, 125), null);
  assert.equal(computePeriodReturn(0, 50), null);
});

test('buildAllocation: porciones con % sobre el total, ordenadas', async () => {
  const { buildAllocation } = await import('./services/investmentReport');
  const a = buildAllocation([
    { key: 'cripto', label: 'Cripto', valueARS: 300 },
    { key: 'accion_us', label: 'Acción EE.UU.', valueARS: 700 },
    { key: 'bono', label: 'Bono', valueARS: 0 },
  ]);
  assert.equal(a.length, 2); // descarta los de valor 0
  assert.equal(a[0].key, 'accion_us'); // ordenado por valor desc
  assert.equal(a[0].pct, 70);
  assert.equal(a[1].pct, 30);
});
