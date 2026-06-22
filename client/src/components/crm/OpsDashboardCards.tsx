// Tarjetas de Operaciones (órdenes de trabajo) en el Dashboard.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { fetchWithAuth } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Wrench, CalendarClock, PlayCircle, CheckCircle2, FileText } from 'lucide-react';

export function OpsDashboardCards() {
  const { data } = useQuery<any>({ queryKey: ['/work-orders/metrics'], queryFn: () => fetchWithAuth('/work-orders/metrics'), retry: false });
  if (!data) return null;
  const totalActivity = data.pending + data.inProgress + data.finished;
  if (totalActivity === 0 && data.todayScheduled === 0) return null;

  const cards = [
    { label: 'Órdenes pendientes', value: data.pending, icon: Wrench, color: 'text-slate-600' },
    { label: 'Programadas hoy', value: data.todayScheduled, icon: CalendarClock, color: 'text-blue-600' },
    { label: 'En ejecución', value: data.inProgress, icon: PlayCircle, color: 'text-amber-600' },
    { label: 'A facturar', value: data.pendingInvoicing, icon: FileText, color: data.pendingInvoicing > 0 ? 'text-indigo-600' : 'text-muted-foreground' },
  ];

  return (
    <Link href="/ordenes">
      <div className="mb-6 cursor-pointer">
        <div className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-2"><Wrench className="h-4 w-4" /> Operaciones</div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {cards.map((c) => (
            <Card key={c.label} className="hover:shadow-sm transition-shadow">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-muted-foreground">{c.label}</div>
                  <c.icon className={`h-4 w-4 ${c.color}`} />
                </div>
                <div className="text-xl font-bold mt-1">{c.value}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </Link>
  );
}
