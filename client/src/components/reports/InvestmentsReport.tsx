// =============================================================================
// AIKESTAR - Reporte de Inversiones (vista + export PDF visual)
// =============================================================================
import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip as RechartsTooltip } from 'recharts';
import { Loader2, FileDown, TrendingUp, TrendingDown, Wallet, PiggyBank, Percent } from 'lucide-react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

const PALETTE = ['#00C3DD', '#FF3366', '#7C5CFC', '#22C55E', '#F59E0B', '#EC4899', '#14B8A6', '#64748B'];

const PERIODS: { key: string; label: string; days: number | 'ytd' }[] = [
  { key: '1m', label: 'Último mes', days: 30 },
  { key: '3m', label: 'Últimos 3 meses', days: 90 },
  { key: '6m', label: 'Últimos 6 meses', days: 182 },
  { key: '1y', label: 'Último año', days: 365 },
  { key: 'ytd', label: 'Este año (YTD)', days: 'ytd' },
];

function fromDateFor(days: number | 'ytd'): string {
  if (days === 'ytd') return new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}
function fmtMoney(v: number | null | undefined, currency = 'ARS', max = 0) {
  if (v == null) return '—';
  try { return new Intl.NumberFormat('es-AR', { style: 'currency', currency, maximumFractionDigits: max }).format(v); }
  catch { return `${currency} ${Math.round(v)}`; }
}
function fmtPct(v: number | null | undefined) {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}
const pctColor = (v: number | null | undefined) => (v == null ? 'text-muted-foreground' : v >= 0 ? 'text-emerald-600' : 'text-red-600');

// Conversión oklch() → rgb por matemática de color (OKLCH→OKLab→sRGB lineal→sRGB).
// El canvas de Chrome NO normaliza oklch, así que lo hacemos a mano. Reemplaza cada
// ocurrencia de oklch(...) dentro de un valor (sirve también para gradientes).
function oklchToRgb(l: number, c: number, h: number, alpha: number): string {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr), b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;
  const L3 = l_ ** 3, M3 = m_ ** 3, S3 = s_ ** 3;
  let r = 4.0767416621 * L3 - 3.3077115913 * M3 + 0.2309699292 * S3;
  let g = -1.2684380046 * L3 + 2.6097574011 * M3 - 0.3413193965 * S3;
  let bl = -0.0041960863 * L3 - 0.7034186147 * M3 + 1.7076147010 * S3;
  const toSrgb = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  const ch = (x: number) => Math.max(0, Math.min(255, Math.round(toSrgb(x) * 255)));
  const rr = ch(r), gg = ch(g), bb = ch(bl);
  return alpha < 1 ? `rgba(${rr}, ${gg}, ${bb}, ${alpha})` : `rgb(${rr}, ${gg}, ${bb})`;
}
function convertOklchInValue(value: string): string {
  return value.replace(/oklch\(([^)]+)\)/gi, (_m, inner) => {
    const [main, alphaStr] = String(inner).split('/');
    const parts = main.trim().split(/\s+/);
    const L = parts[0]?.endsWith('%') ? parseFloat(parts[0]) / 100 : parseFloat(parts[0]);
    const C = parseFloat(parts[1] ?? '0');
    const H = parseFloat(parts[2] ?? '0') || 0;
    const alpha = alphaStr != null ? (alphaStr.trim().endsWith('%') ? parseFloat(alphaStr) / 100 : parseFloat(alphaStr)) : 1;
    if (![L, C, H].every((n) => Number.isFinite(n))) return _m;
    return oklchToRgb(L, C, H, Number.isFinite(alpha) ? alpha : 1);
  });
}

// Neutraliza oklch en el documento clonado para que html2canvas (que no lo soporta)
// renderice el reporte. Tailwind v4 expone toda la paleta como custom props oklch en
// :root, heredadas por cada elemento → las redefinimos a rgb una sola vez en :root,
// y además convertimos las propiedades estándar ya resueltas a oklch.
function sanitizeOklch(doc: Document) {
  const view = doc.defaultView || window;

  // 1) Redefinir las custom props del tema (--color-*) a rgb en :root del clon.
  const rootCS = view.getComputedStyle(doc.documentElement);
  let rootCss = '';
  for (let i = 0; i < rootCS.length; i++) {
    const p = rootCS[i];
    if (!p.startsWith('--')) continue;
    const v = rootCS.getPropertyValue(p);
    if (v && v.indexOf('oklch') !== -1) rootCss += `${p}:${convertOklchInValue(v)};`;
  }
  if (rootCss) {
    const st = doc.createElement('style');
    st.textContent = `:root{${rootCss}}`;
    (doc.head || doc.documentElement).appendChild(st);
  }

  // 2) Convertir propiedades estándar que aún resuelvan a oklch (set directo, no var).
  doc.querySelectorAll<HTMLElement>('*').forEach((el) => {
    const cs = view.getComputedStyle(el);
    for (let i = 0; i < cs.length; i++) {
      const p = cs[i];
      if (p.startsWith('--')) continue;
      const v = cs.getPropertyValue(p);
      if (v && v.indexOf('oklch') !== -1) el.style.setProperty(p, convertOklchInValue(v));
    }
  });
}

export function InvestmentsReport() {
  const { toast } = useToast();
  const [period, setPeriod] = useState('3m');
  const [exporting, setExporting] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  const def = PERIODS.find((p) => p.key === period) || PERIODS[1];
  const fromDate = fromDateFor(def.days);

  const { data, isLoading } = useQuery<any>({
    queryKey: ['/market-investments/report', fromDate],
    queryFn: () => fetchWithAuth(`/market-investments/report?from=${fromDate}`),
  });

  const positions: any[] = data?.positions ?? [];
  const typeData = useMemo(() => (data?.allocationByType ?? []).map((a: any) => ({ name: a.label, value: Math.round(a.valueARS) })), [data]);
  const curData = useMemo(() => (data?.allocationByCurrency ?? []).map((a: any) => ({ name: a.key, value: Math.round(a.valueARS) })), [data]);

  const handleExport = async () => {
    if (!reportRef.current) return;
    setExporting(true);
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);
      const canvas = await html2canvas(reportRef.current, {
        backgroundColor: '#ffffff', scale: 2, useCORS: true, logging: false,
        // Tailwind v4 emite colores en oklch(), que html2canvas no sabe parsear.
        // En el clon convertimos cualquier color oklch a rgb con la Canvas API.
        onclone: (doc) => sanitizeOklch(doc),
      });
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const imgW = pageW;
      const imgH = (canvas.height * imgW) / canvas.width;
      let heightLeft = imgH;
      let position = 0;
      const imgData = canvas.toDataURL('image/png');
      pdf.addImage(imgData, 'PNG', 0, position, imgW, imgH);
      heightLeft -= pageH;
      while (heightLeft > 0) {
        position -= pageH;
        pdf.addPage();
        pdf.addImage(imgData, 'PNG', 0, position, imgW, imgH);
        heightLeft -= pageH;
      }
      pdf.save(`Reporte-Inversiones-${fromDate}.pdf`);
      toast({ title: 'PDF generado' });
    } catch (e: any) {
      console.error('[InvestmentsReport] export PDF failed:', e);
      toast({ title: 'No se pudo generar el PDF', description: String(e?.message || e), variant: 'destructive' });
    } finally {
      setExporting(false);
    }
  };

  if (isLoading) return <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>;

  if (positions.length === 0) {
    return (
      <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
        No hay inversiones cargadas. Agregá posiciones en <span className="font-medium">Oficina → Inversiones</span> para generar el reporte.
      </CardContent></Card>
    );
  }

  const u = data.unified;
  const up = (u?.pnlARS ?? 0) >= 0;

  return (
    <div className="space-y-4">
      {/* Controles (no entran al PDF) */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Período</span>
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="h-9 w-[190px]"><SelectValue /></SelectTrigger>
            <SelectContent>{PERIODS.map((p) => <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <Button onClick={handleExport} disabled={exporting} className="bg-gradient-to-r from-[#00D4FF] to-[#FF3366]">
          {exporting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <FileDown className="h-4 w-4 mr-1" />} Exportar PDF
        </Button>
      </div>

      {/* Documento del reporte (esto se captura al PDF) */}
      <div ref={reportRef} className="bg-white text-slate-900 rounded-xl p-6 space-y-6">
        {/* Encabezado */}
        <div className="border-b border-slate-200 pb-4 flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">Reporte de Inversiones</h2>
            <p className="text-sm text-slate-500">
              Período: {format(new Date(fromDate + 'T00:00:00'), "d 'de' MMM yyyy", { locale: es })} – {format(new Date(), "d 'de' MMM yyyy", { locale: es })}
            </p>
          </div>
          <div className="text-right text-xs text-slate-500">
            <div>Generado {format(new Date(), "d/MM/yyyy HH:mm", { locale: es })}</div>
            {data.mepRate && <div>Valores en ARS-eq. · 1 USD = {fmtMoney(data.mepRate, 'ARS', 0)} (MEP)</div>}
          </div>
        </div>

        {/* Resumen */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <SummaryBox icon={Wallet} label="Valor actual (ARS-eq.)" value={fmtMoney(u.valueARS, 'ARS')} />
          <SummaryBox icon={PiggyBank} label="Invertido (ARS-eq.)" value={fmtMoney(u.investedARS, 'ARS')} />
          <SummaryBox icon={up ? TrendingUp : TrendingDown} label="Resultado total" value={fmtMoney(u.pnlARS, 'ARS')} valueClass={up ? 'text-emerald-600' : 'text-red-600'} />
          <SummaryBox icon={Percent} label="Rentabilidad" value={fmtPct(u.pnlPct)} valueClass={up ? 'text-emerald-600' : 'text-red-600'} />
        </div>

        {/* Resumen por moneda */}
        {data.totalsByCurrency?.length > 1 && (
          <div className="flex flex-wrap gap-2 text-xs">
            {data.totalsByCurrency.map((t: any) => (
              <span key={t.currency} className="px-2 py-1 rounded-md bg-slate-100 text-slate-700">
                {t.currency}: {fmtMoney(t.currentValue, t.currency)} <span className={t.pnl >= 0 ? 'text-emerald-600' : 'text-red-600'}>({fmtPct(t.pnlPct)})</span>
              </span>
            ))}
          </div>
        )}

        {/* Distribución (pies) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <AllocationPie title="Distribución por tipo de activo" rows={typeData} />
          <AllocationPie title="Distribución por moneda" rows={curData} />
        </div>

        {/* Detalle por posición */}
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Detalle de posiciones</h3>
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left font-medium p-2">Activo</th>
                  <th className="text-right font-medium p-2">Cant.</th>
                  <th className="text-right font-medium p-2">P. compra</th>
                  <th className="text-right font-medium p-2">P. actual</th>
                  <th className="text-right font-medium p-2">Valor</th>
                  <th className="text-right font-medium p-2">Peso</th>
                  <th className="text-right font-medium p-2">Resultado</th>
                  <th className="text-right font-medium p-2">Período</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p: any, i: number) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="p-2">
                      <div className="font-medium text-slate-800">{p.name}</div>
                      <div className="text-[10px] text-slate-400">{p.assetTypeLabel} · {p.symbol}</div>
                    </td>
                    <td className="p-2 text-right text-slate-600">{p.quantity}</td>
                    <td className="p-2 text-right text-slate-600">{p.buyPrice != null ? fmtMoney(p.buyPrice, p.currency, 2) : '—'}</td>
                    <td className="p-2 text-right text-slate-600">{p.currentPrice != null ? fmtMoney(p.currentPrice, p.currency, 2) : '—'}</td>
                    <td className="p-2 text-right font-medium text-slate-800">{fmtMoney(p.currentValue, p.currency)}</td>
                    <td className="p-2 text-right text-slate-600">{p.weightPct != null ? p.weightPct.toFixed(1) + '%' : '—'}</td>
                    <td className={`p-2 text-right font-medium ${pctColor(p.pnlPct)}`}>{fmtPct(p.pnlPct)}</td>
                    <td className={`p-2 text-right font-medium ${pctColor(p.periodReturnPct)}`}>{fmtPct(p.periodReturnPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Mejores / peores del período */}
        {(data.bestPerformers?.length > 0 || data.worstPerformers?.length > 0) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <PerformersBox title="Mejores del período" rows={data.bestPerformers} positive />
            <PerformersBox title="Peores del período" rows={data.worstPerformers} />
          </div>
        )}

        <p className="text-[10px] text-slate-400 border-t border-slate-200 pt-3">
          Aikestar · Cotizaciones de mercado en tiempo real (TradingView/Finnhub/Yahoo). El rendimiento del período se calcula con precios históricos de cierre. Reporte informativo, no constituye asesoramiento financiero.
        </p>
      </div>
    </div>
  );
}

function SummaryBox({ icon: Icon, label, value, valueClass }: { icon: any; label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-slate-500">{label}</div>
        <Icon className="h-4 w-4 text-slate-400" />
      </div>
      <div className={`text-lg font-bold mt-1 ${valueClass || 'text-slate-900'}`}>{value}</div>
    </div>
  );
}

function AllocationPie({ title, rows }: { title: string; rows: { name: string; value: number }[] }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="text-sm font-semibold text-slate-700 mb-1">{title}</div>
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie data={rows} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={(e: any) => `${(e.percent * 100).toFixed(0)}%`}>
            {rows.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
          </Pie>
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <RechartsTooltip formatter={(v: any) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(v)} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

function PerformersBox({ title, rows, positive }: { title: string; rows: any[]; positive?: boolean }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-1">
        {positive ? <TrendingUp className="h-4 w-4 text-emerald-600" /> : <TrendingDown className="h-4 w-4 text-red-600" />} {title}
      </div>
      <div className="space-y-1">
        {rows.map((p: any, i: number) => (
          <div key={i} className="flex items-center justify-between text-xs">
            <span className="text-slate-700">{p.name} <span className="text-slate-400">· {p.symbol}</span></span>
            <span className={`font-semibold ${pctColor(p.periodReturnPct)}`}>{fmtPct(p.periodReturnPct)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
