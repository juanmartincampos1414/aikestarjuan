// Tarjetas de métricas del CRM en el Dashboard.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { fetchWithAuth } from '@/lib/api';
import { formatCurrencyAR } from '@/lib/currency';
import { Card, CardContent } from '@/components/ui/card';
import { Briefcase, TrendingUp, Percent, AlertTriangle } from 'lucide-react';

export function CrmDashboardCards() {
  const { data } = useQuery<any>({
    queryKey: ['/crm/metrics'], queryFn: () => fetchWithAuth('/crm/metrics'), retry: false,
  });
  if (!data) return null;
  // Si no hay nada de CRM todavía, no ocupamos espacio.
  if (data.activeOpportunities === 0 && data.won === 0 && data.lost === 0) return null;

  const cards = [
    { label: 'Oportunidades activas', value: data.activeOpportunities, icon: Briefcase, color: 'text-cyan-600' },
    { label: 'Valor del pipeline', value: formatCurrencyAR(data.pipelineValue || 0, 'ARS'), icon: TrendingUp, color: 'text-emerald-600' },
    { label: 'Tasa de cierre', value: `${data.closeRate}%`, icon: Percent, color: 'text-indigo-600' },
    { label: 'Seguimientos vencidos', value: data.overdueFollowups, icon: AlertTriangle, color: data.overdueFollowups > 0 ? 'text-red-600' : 'text-muted-foreground' },
  ];

  return (
    <Link href="/crm">
      <div className="mb-6 cursor-pointer">
        <div className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-2"><Briefcase className="h-4 w-4" /> CRM Comercial</div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {cards.map((c) => (
            <Card key={c.label} className="hover:shadow-sm transition-shadow">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-muted-foreground">{c.label}</div>
                  <c.icon className={`h-4 w-4 ${c.color}`} />
                </div>
                <div className={`text-xl font-bold mt-1 ${c.label === 'Seguimientos vencidos' && data.overdueFollowups > 0 ? 'text-red-600' : ''}`}>{c.value}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </Link>
  );
}
