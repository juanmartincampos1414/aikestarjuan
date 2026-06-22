// Alerta accionable en el Dashboard cuando la integración Tiendanube tiene algo
// que requiere atención: error de sincronización o clientes pendientes de resolver.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { fetchWithAuth } from '@/lib/api';
import { AlertTriangle, Users, ArrowRight } from 'lucide-react';

export function TiendanubeDashboardAlert() {
  const { data } = useQuery<any>({
    queryKey: ['/tiendanube/status'],
    queryFn: () => fetchWithAuth('/tiendanube/status'),
    refetchInterval: 60000,
    retry: false,
  });

  if (!data?.connection) return null;
  const hasError = !!data.connection.lastError;
  const pending = data.pendingClients || 0;
  if (!hasError && pending === 0) return null;

  return (
    <div className="mb-4 space-y-2">
      {hasError && (
        <Link href="/settings?tab=integrations">
          <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300 cursor-pointer hover:bg-amber-100 transition-colors">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="flex-1">Tiendanube: hubo un problema de sincronización. Revisá la conexión.</span>
            <ArrowRight className="h-4 w-4" />
          </div>
        </Link>
      )}
      {pending > 0 && (
        <Link href="/settings?tab=integrations">
          <div className="flex items-center gap-2 rounded-lg border border-cyan-300 bg-cyan-50 dark:bg-cyan-950/30 px-4 py-2.5 text-sm text-cyan-800 dark:text-cyan-300 cursor-pointer hover:bg-cyan-100 transition-colors">
            <Users className="h-4 w-4 shrink-0" />
            <span className="flex-1">Tiendanube: {pending} cliente{pending > 1 ? 's' : ''} pendiente{pending > 1 ? 's' : ''} de revisión.</span>
            <ArrowRight className="h-4 w-4" />
          </div>
        </Link>
      )}
    </div>
  );
}
