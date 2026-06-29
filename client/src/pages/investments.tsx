// =============================================================================
// AIKESTAR - Inversiones (cartera monitoreada en vivo con TradingView)
// =============================================================================
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Loader2, Plus, TrendingUp, TrendingDown, Trash2, Pencil, LineChart } from 'lucide-react';
import { INVESTMENT_ASSET_TYPES, INVESTMENT_ASSET_TYPE_LABELS, type InvestmentAssetType } from '@shared/schema';
import { TradingViewWidget } from '@/components/TradingViewWidget';

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtMoney(v: number | null | undefined, currency = 'ARS') {
  if (v == null) return '—';
  try { return new Intl.NumberFormat('es-AR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(v); }
  catch { return `${currency} ${v.toFixed(2)}`; }
}
function fmtPct(v: number | null | undefined) {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}
function fmtNum(v: number | null | undefined) {
  if (v == null) return '—';
  return new Intl.NumberFormat('es-AR', { maximumFractionDigits: 8 }).format(v);
}

// Símbolo válido de TradingView para el widget/gráfico de un holding.
function tvSymbol(inv: { symbol: string; assetType: string }): string {
  const raw = (inv.symbol || '').trim();
  if (inv.assetType === 'dolar') return 'FX_IDC:USDARS';
  if (raw.includes(':')) return raw.toUpperCase();
  const t = raw.toUpperCase();
  switch (inv.assetType) {
    case 'accion_arg':
    case 'cedear':
    case 'bono': return `BCBA:${t}`;
    case 'cripto': return `BINANCE:${t.replace(/(USDT|USD|USDC)$/i, '')}USDT`;
    default: return t;
  }
}

const DEFAULT_TICKERS = [
  { proName: 'BCBA:GGAL', title: 'Galicia' },
  { proName: 'NASDAQ:AAPL', title: 'Apple' },
  { proName: 'BINANCE:BTCUSDT', title: 'Bitcoin' },
  { proName: 'FX_IDC:USDARS', title: 'Dólar' },
  { proName: 'NASDAQ:TSLA', title: 'Tesla' },
];

type SortKey = 'name' | 'value' | 'pnl' | 'day';

export default function InvestmentsPage() {
  const [showNew, setShowNew] = useState(false);
  const [editRow, setEditRow] = useState<any | null>(null);
  const [detailRow, setDetailRow] = useState<any | null>(null);
  const [sort, setSort] = useState<SortKey>('value');

  const { data, isLoading } = useQuery<any>({
    queryKey: ['/market-investments'],
    queryFn: () => fetchWithAuth('/market-investments'),
    refetchInterval: 60_000, // refresca cotizaciones en vivo
  });

  const rows: any[] = data?.rows ?? [];
  const totals: any[] = data?.totals ?? [];

  const tickerSymbols = useMemo(() => {
    const fromHoldings = rows.map((r) => ({ proName: tvSymbol(r.investment), title: r.investment.name })).slice(0, 12);
    return fromHoldings.length > 0 ? fromHoldings : DEFAULT_TICKERS;
  }, [rows]);

  const sortedRows = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      if (sort === 'name') return a.investment.name.localeCompare(b.investment.name);
      if (sort === 'day') return (b.position.dayChangePct ?? -Infinity) - (a.position.dayChangePct ?? -Infinity);
      if (sort === 'pnl') return (b.position.pnl ?? -Infinity) - (a.position.pnl ?? -Infinity);
      return (b.position.currentValue ?? -Infinity) - (a.position.currentValue ?? -Infinity);
    });
    return arr;
  }, [rows, sort]);

  if (isLoading) return <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><TrendingUp className="h-6 w-6 text-[#00C3DD]" /> Inversiones</h1>
          <p className="text-sm text-muted-foreground">Monitoreá tu cartera en tiempo real con cotizaciones de TradingView.</p>
        </div>
        <Button onClick={() => setShowNew(true)} className="bg-gradient-to-r from-[#00D4FF] to-[#FF3366]"><Plus className="h-4 w-4 mr-1" /> Nueva inversión</Button>
      </div>

      {/* Cinta de cotizaciones en vivo */}
      <Card className="overflow-hidden"><CardContent className="p-0">
        <TradingViewWidget type="ticker-tape" config={{
          symbols: tickerSymbols, showSymbolLogo: true, colorTheme: 'dark', isTransparent: true, displayMode: 'adaptive', locale: 'es',
        }} />
      </CardContent></Card>

      {/* Totales por moneda */}
      {totals.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {totals.map((t) => {
            const up = t.pnl >= 0;
            return (
              <Card key={t.currency}><CardContent className="p-4">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Cartera en {t.currency}</div>
                <div className="text-2xl font-bold mt-1">{fmtMoney(t.currentValue, t.currency)}</div>
                <div className="text-xs text-muted-foreground">Invertido: {fmtMoney(t.cost, t.currency)}</div>
                <div className={`mt-1 text-sm font-semibold flex items-center gap-1 ${up ? 'text-emerald-500' : 'text-red-500'}`}>
                  {up ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                  {fmtMoney(t.pnl, t.currency)} ({fmtPct(t.pnlPct)})
                </div>
              </CardContent></Card>
            );
          })}
        </div>
      )}

      {rows.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          Todavía no cargaste inversiones. Agregá tu primera posición (acción, CEDEAR, cripto o dólar) para monitorearla en vivo.
        </CardContent></Card>
      ) : (
        <Card><CardContent className="p-0">
          {/* Encabezado con orden */}
          <div className="flex items-center justify-end gap-2 px-4 py-2 border-b text-xs text-muted-foreground">
            <span>Ordenar por</span>
            <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
              <SelectTrigger className="h-7 w-[150px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="value">Valor actual</SelectItem>
                <SelectItem value="pnl">Resultado $</SelectItem>
                <SelectItem value="day">Variación del día</SelectItem>
                <SelectItem value="name">Nombre</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="divide-y">
            {sortedRows.map((r) => {
              const p = r.position;
              const up = (p.pnl ?? 0) >= 0;
              const dayUp = (p.dayChangePct ?? 0) >= 0;
              return (
                <div key={r.investment.id} onClick={() => setDetailRow(r)} className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/40 transition-colors">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{r.investment.name}</div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className="text-[10px] px-1 py-0">{INVESTMENT_ASSET_TYPE_LABELS[r.investment.assetType as InvestmentAssetType] || r.investment.assetType}</Badge>
                      <span className="truncate">{r.investment.symbol}</span>
                    </div>
                  </div>
                  <div className="hidden sm:block text-right text-xs text-muted-foreground w-24">
                    <div>{fmtNum(p.quantity)}</div>
                    <div>compra {p.buyPrice != null ? fmtMoney(p.buyPrice, p.currency) : '—'}</div>
                  </div>
                  <div className="text-right w-28">
                    <div className="font-medium">{p.currentPrice != null ? fmtMoney(p.currentPrice, p.currency) : '—'}</div>
                    <div className={`text-xs ${dayUp ? 'text-emerald-500' : 'text-red-500'}`}>{fmtPct(p.dayChangePct)}</div>
                  </div>
                  <div className="text-right w-32">
                    <div className="font-semibold">{fmtMoney(p.currentValue, p.currency)}</div>
                    <div className={`text-xs ${up ? 'text-emerald-500' : 'text-red-500'}`}>
                      {p.pnl != null ? `${up ? '+' : ''}${fmtMoney(p.pnl, p.currency)}` : '—'} {p.pnlPct != null ? `(${fmtPct(p.pnlPct)})` : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent></Card>
      )}

      {showNew && <InvestmentForm onClose={() => setShowNew(false)} />}
      {editRow && <InvestmentForm existing={editRow.investment} onClose={() => setEditRow(null)} />}
      {detailRow && <InvestmentDetail row={detailRow} onClose={() => setDetailRow(null)} onEdit={() => { setEditRow(detailRow); setDetailRow(null); }} />}
    </div>
  );
}

// ── Detalle con gráfico en vivo ───────────────────────────────────────────────
function InvestmentDetail({ row, onClose, onEdit }: { row: any; onClose: () => void; onEdit: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const inv = row.investment;
  const p = row.position;
  const del = useMutation({
    mutationFn: () => fetchWithAuth(`/market-investments/${inv.id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/market-investments'] }); toast({ title: 'Inversión eliminada' }); onClose(); },
    onError: () => toast({ title: 'No se pudo eliminar', variant: 'destructive' }),
  });
  const up = (p.pnl ?? 0) >= 0;
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><LineChart className="h-5 w-5 text-[#00C3DD]" /> {inv.name}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div><div className="text-xs text-muted-foreground">Precio actual</div><div className="font-semibold">{p.currentPrice != null ? fmtMoney(p.currentPrice, p.currency) : '—'}</div></div>
          <div><div className="text-xs text-muted-foreground">Valor</div><div className="font-semibold">{fmtMoney(p.currentValue, p.currency)}</div></div>
          <div><div className="text-xs text-muted-foreground">Resultado</div><div className={`font-semibold ${up ? 'text-emerald-500' : 'text-red-500'}`}>{p.pnl != null ? fmtMoney(p.pnl, p.currency) : '—'} ({fmtPct(p.pnlPct)})</div></div>
          <div><div className="text-xs text-muted-foreground">Día</div><div className={`font-semibold ${(p.dayChangePct ?? 0) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>{fmtPct(p.dayChangePct)}</div></div>
        </div>
        <div className="rounded-lg overflow-hidden border" style={{ height: 380 }}>
          <TradingViewWidget type="advanced-chart" height={380} config={{
            symbol: tvSymbol(inv), autosize: true, theme: 'dark', locale: 'es', timezone: 'America/Argentina/Buenos_Aires',
            style: '1', hide_side_toolbar: true, allow_symbol_change: false, interval: 'D',
          }} />
        </div>
        {inv.notes && <p className="text-sm text-muted-foreground">{inv.notes}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onEdit}><Pencil className="h-4 w-4 mr-1" /> Editar</Button>
          <Button variant="outline" className="text-red-600 hover:text-red-700" disabled={del.isPending} onClick={() => del.mutate()}>
            {del.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4 mr-1" />} Eliminar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Alta / edición ────────────────────────────────────────────────────────────
function defaultCurrencyFor(assetType: InvestmentAssetType): string {
  return assetType === 'accion_us' || assetType === 'etf' || assetType === 'cripto' ? 'USD' : 'ARS';
}

function InvestmentForm({ existing, onClose }: { existing?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const [assetType, setAssetType] = useState<InvestmentAssetType>(existing?.assetType ?? 'accion_arg');
  const [symbol, setSymbol] = useState(existing?.symbol ?? '');
  const [quantity, setQuantity] = useState(String(existing?.quantity ?? ''));
  const [buyPrice, setBuyPrice] = useState(existing?.buyPrice != null ? String(existing.buyPrice) : '');
  const [currency, setCurrency] = useState(existing?.currency ?? 'ARS');
  const [broker, setBroker] = useState(existing?.broker ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [touchedCurrency, setTouchedCurrency] = useState(false);

  const onTypeChange = (v: InvestmentAssetType) => {
    setAssetType(v);
    if (!touchedCurrency) setCurrency(defaultCurrencyFor(v));
  };

  const body = () => ({ name, assetType, symbol, quantity: quantity || '0', buyPrice: buyPrice || null, currency, broker, notes });
  const save = useMutation({
    mutationFn: () => existing
      ? fetchWithAuth(`/market-investments/${existing.id}`, { method: 'PATCH', body: JSON.stringify(body()) })
      : fetchWithAuth('/market-investments', { method: 'POST', body: JSON.stringify(body()) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/market-investments'] }); toast({ title: existing ? 'Inversión actualizada' : 'Inversión agregada' }); onClose(); },
    onError: () => toast({ title: 'No se pudo guardar', variant: 'destructive' }),
  });

  const symbolHint = assetType === 'dolar'
    ? 'Tipo de dólar: blue, oficial, mep, ccl o cripto'
    : assetType === 'cripto'
      ? 'Ticker o par, ej. BTC, ETH (BINANCE:BTCUSDT)'
      : (assetType === 'accion_arg' || assetType === 'cedear' || assetType === 'bono')
        ? 'Ticker BYMA, ej. GGAL, AAPL (CEDEAR), AL30'
        : 'Ticker EE.UU., ej. AAPL, TSLA, SPY';

  const canSave = name.trim() && symbol.trim() && !save.isPending;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{existing ? 'Editar inversión' : 'Nueva inversión'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Nombre</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Galicia, Bitcoin, Dólar MEP" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Tipo de activo</Label>
              <Select value={assetType} onValueChange={(v) => onTypeChange(v as InvestmentAssetType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {INVESTMENT_ASSET_TYPES.map((t) => <SelectItem key={t} value={t}>{INVESTMENT_ASSET_TYPE_LABELS[t]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Moneda</Label>
              <Select value={currency} onValueChange={(v) => { setCurrency(v); setTouchedCurrency(true); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ARS">ARS</SelectItem>
                  <SelectItem value="USD">USD</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Símbolo / ticker</Label>
            <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder={assetType === 'dolar' ? 'blue' : 'GGAL'} />
            <p className="text-[11px] text-muted-foreground mt-1">{symbolHint}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Cantidad</Label>
              <Input type="number" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="0" />
            </div>
            <div>
              <Label>Precio de compra</Label>
              <Input type="number" step="any" value={buyPrice} onChange={(e) => setBuyPrice(e.target.value)} placeholder="Opcional" />
            </div>
          </div>
          <div>
            <Label>Broker / cuenta <span className="text-muted-foreground text-xs">(opcional)</span></Label>
            <Input value={broker} onChange={(e) => setBroker(e.target.value)} placeholder="Ej. IOL, Balanz, Binance" />
          </div>
          <div>
            <Label>Notas <span className="text-muted-foreground text-xs">(opcional)</span></Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={!canSave} onClick={() => save.mutate()} className="bg-gradient-to-r from-[#00D4FF] to-[#FF3366]">
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : (existing ? 'Guardar' : 'Agregar')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
