// Tarjeta de Inversiones en el Dashboard: valor de la cartera y P&L por moneda.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { fetchWithAuth } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { TrendingUp, TrendingDown, Layers } from 'lucide-react';

function fmtMoney(v: number | null | undefined, currency = 'ARS') {
  if (v == null) return '—';
  try { return new Intl.NumberFormat('es-AR', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v); }
  catch { return `${currency} ${Math.round(v)}`; }
}

export function InvestmentsDashboardCard() {
  const { data } = useQuery<any>({
    queryKey: ['/market-investments'], queryFn: () => fetchWithAuth('/market-investments'),
    retry: false, refetchInterval: 60_000,
  });
  const rows: any[] = data?.rows ?? [];
  const totals: any[] = data?.totals ?? [];
  if (rows.length === 0) return null; // sin cartera, no ocupamos espacio

  return (
    <Link href="/inversiones">
      <div className="mb-6 cursor-pointer">
        <div className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-2"><TrendingUp className="h-4 w-4" /> Inversiones</div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card className="hover:shadow-sm transition-shadow">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">Posiciones</div>
                <Layers className="h-4 w-4 text-cyan-600" />
              </div>
              <div className="text-xl font-bold mt-1">{rows.length}</div>
            </CardContent>
          </Card>
          {totals.map((t) => {
            const up = (t.pnl ?? 0) >= 0;
            return (
              <Card key={t.currency} className="hover:shadow-sm transition-shadow">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-muted-foreground">Cartera {t.currency}</div>
                    {up ? <TrendingUp className="h-4 w-4 text-emerald-600" /> : <TrendingDown className="h-4 w-4 text-red-600" />}
                  </div>
                  <div className="text-xl font-bold mt-1">{fmtMoney(t.currentValue, t.currency)}</div>
                  <div className={`text-xs font-medium ${up ? 'text-emerald-600' : 'text-red-600'}`}>
                    {up ? '+' : ''}{fmtMoney(t.pnl, t.currency)}{t.pnlPct != null ? ` (${up ? '+' : ''}${t.pnlPct.toFixed(1)}%)` : ''}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </Link>
  );
}
