// =============================================================================
// AIKESTAR - UI de la integración con Tiendanube (Settings → Integraciones)
// Sub-tabs: Conexión, Mapeo, Pendientes, Configuración.
// =============================================================================
import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { Loader2, Store, Link2, AlertTriangle, CheckCircle2, RefreshCw, Unplug, ExternalLink, PackageSearch } from 'lucide-react';
import { useEffect, useRef } from 'react';

interface TnStatus {
  enabled: boolean;
  hasAccess: boolean;
  isOwner: boolean;
  connection: null | {
    id: string; storeId: string; storeName?: string | null; storeUrl?: string | null;
    status: string; connectedAt?: string | null; lastSyncAt?: string | null; lastError?: string | null;
  };
  pendingClients: number;
}

export function TiendanubeIntegration() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState(false);

  const { data: status, isLoading } = useQuery<TnStatus>({
    queryKey: ['/tiendanube/status'],
    queryFn: () => fetchWithAuth('/tiendanube/status'),
  });

  const connected = !!status?.connection;

  async function startConnect() {
    try {
      setConnecting(true);
      const r = await fetchWithAuth('/tiendanube/connect');
      if (r?.authorizeUrl) window.location.href = r.authorizeUrl;
      else throw new Error('No se recibió URL de autorización');
    } catch (e: any) {
      toast({ title: 'No se pudo conectar', description: e?.message || 'Error', variant: 'destructive' });
      setConnecting(false);
    }
  }

  const disconnect = useMutation({
    mutationFn: () => fetchWithAuth('/tiendanube/disconnect', { method: 'POST' }),
    onSuccess: () => {
      toast({ title: 'Tiendanube desconectada' });
      queryClient.invalidateQueries({ queryKey: ['/tiendanube/status'] });
    },
    onError: (e: any) => toast({ title: 'Error', description: e?.message, variant: 'destructive' }),
  });

  if (isLoading) {
    return <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  if (!status?.enabled) {
    return <p className="text-sm text-muted-foreground py-4">La integración con Tiendanube no está disponible en este momento.</p>;
  }
  if (!status?.hasAccess) {
    return (
      <div className="py-4 space-y-2">
        <Badge variant="outline">No incluido en tu plan</Badge>
        <p className="text-sm text-muted-foreground">La integración con Tiendanube está disponible en los planes Team, Business y Enterprise.</p>
      </div>
    );
  }

  return (
    <Tabs defaultValue="conexion" className="w-full">
      <TabsList className="grid grid-cols-4 w-full max-w-2xl">
        <TabsTrigger value="conexion">Conexión</TabsTrigger>
        <TabsTrigger value="mapeo" disabled={!connected}>Mapeo</TabsTrigger>
        <TabsTrigger value="pendientes" disabled={!connected}>
          Pendientes{status.pendingClients > 0 ? ` (${status.pendingClients})` : ''}
        </TabsTrigger>
        <TabsTrigger value="config" disabled={!connected}>Configuración</TabsTrigger>
      </TabsList>

      {/* ── Conexión ── */}
      <TabsContent value="conexion" className="pt-4 space-y-4">
        {connected ? (
          <Card>
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                <span className="font-medium">Tienda conectada</span>
                <Badge variant="secondary">{status.connection!.status}</Badge>
              </div>
              <div className="text-sm text-muted-foreground space-y-1">
                <div className="flex items-center gap-2"><Store className="h-4 w-4" /> {status.connection!.storeName || `Tienda ${status.connection!.storeId}`}</div>
                {status.connection!.storeUrl && (
                  <a href={status.connection!.storeUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-cyan-600 hover:underline">
                    <ExternalLink className="h-4 w-4" /> {status.connection!.storeUrl}
                  </a>
                )}
                {status.connection!.lastSyncAt && <div>Última sincronización: {new Date(status.connection!.lastSyncAt).toLocaleString('es-AR')}</div>}
              </div>
              {status.connection!.lastError && (
                <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 dark:bg-amber-950/30 rounded p-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> <span>{status.connection!.lastError}</span>
                </div>
              )}
              {status.isOwner ? (
                <div className="flex gap-2 pt-1">
                  <Button variant="outline" size="sm" onClick={startConnect} disabled={connecting}>
                    <RefreshCw className="h-4 w-4 mr-1" /> Reconectar
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
                    <Unplug className="h-4 w-4 mr-1" /> Desconectar
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Solo el propietario puede reconectar o desconectar.</p>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Link2 className="h-5 w-5" /> <span>No hay ninguna tienda conectada.</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Conectá tu tienda Tiendanube para que los pedidos se registren automáticamente como movimientos, con clientes y trazabilidad.
              </p>
              {status.isOwner ? (
                <Button onClick={startConnect} disabled={connecting} className="bg-gradient-to-r from-[#00D4FF] to-[#FF3366]">
                  {connecting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Store className="h-4 w-4 mr-1" />} Conectar Tiendanube
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">Solo el propietario de la organización puede conectar Tiendanube.</p>
              )}
            </CardContent>
          </Card>
        )}
      </TabsContent>

      <TabsContent value="mapeo" className="pt-4"><PaymentMappings /></TabsContent>
      <TabsContent value="pendientes" className="pt-4"><PendingClients /></TabsContent>
      <TabsContent value="config" className="pt-4 space-y-6">
        <CatalogSync />
        <WebhookLogs />
      </TabsContent>
    </Tabs>
  );
}

// ── Sincronización de catálogo con barra de progreso ──────────────────────────
function CatalogSync() {
  const { toast } = useToast();
  const [progress, setProgress] = useState<{ status: string; total: number; done: number } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function poll() {
    try {
      const p = await fetchWithAuth('/tiendanube/sync/progress');
      setProgress(p);
      if (p.status !== 'running' && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    } catch { /* ignore */ }
  }

  useEffect(() => { poll(); return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, []);

  async function start() {
    try {
      await fetchWithAuth('/tiendanube/sync/catalog', { method: 'POST' });
      setProgress({ status: 'running', total: 0, done: 0 });
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(poll, 1500);
      toast({ title: 'Sincronización iniciada' });
    } catch (e: any) {
      toast({ title: 'Error', description: e?.message, variant: 'destructive' });
    }
  }

  const running = progress?.status === 'running';
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="space-y-3 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium text-sm flex items-center gap-2"><PackageSearch className="h-4 w-4" /> Catálogo de productos</div>
          <p className="text-xs text-muted-foreground">Importá todos los productos de tu tienda. Se actualizan solos con cada cambio.</p>
        </div>
        <Button size="sm" variant="outline" onClick={start} disabled={running}>
          {running ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
          {running ? 'Sincronizando…' : 'Sincronizar catálogo'}
        </Button>
      </div>
      {progress && progress.status !== 'idle' && (
        <div className="space-y-1">
          <Progress value={running ? pct : (progress.status === 'done' ? 100 : pct)} />
          <p className="text-xs text-muted-foreground">
            {progress.status === 'done' ? `✓ ${progress.done} productos sincronizados.`
              : progress.status === 'error' ? 'Hubo un error en la sincronización.'
              : `${progress.done} / ${progress.total} productos…`}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Mapeo de medios de pago → cuenta ──────────────────────────────────────────
function PaymentMappings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data } = useQuery<{ mappings: any[] }>({ queryKey: ['/tiendanube/payment-mappings'], queryFn: () => fetchWithAuth('/tiendanube/payment-mappings') });
  const { data: accountsData } = useQuery<any[]>({ queryKey: ['/accounts'], queryFn: () => fetchWithAuth('/accounts') });
  const accounts = accountsData || [];

  const save = useMutation({
    mutationFn: (body: { gatewayName: string; accountId: string }) =>
      fetchWithAuth('/tiendanube/payment-mappings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { toast({ title: 'Mapeo guardado' }); queryClient.invalidateQueries({ queryKey: ['/tiendanube/payment-mappings'] }); },
    onError: (e: any) => toast({ title: 'Error', description: e?.message, variant: 'destructive' }),
  });

  const mappings = data?.mappings || [];
  if (mappings.length === 0) {
    return <p className="text-sm text-muted-foreground">Todavía no hay medios de pago detectados. Aparecerán acá automáticamente con la primera venta para que asignes la cuenta destino.</p>;
  }
  return (
    <div className="space-y-3 max-w-2xl">
      <p className="text-sm text-muted-foreground">Asociá cada medio de pago de Tiendanube con la cuenta de Aikestar donde debe impactar el dinero.</p>
      {mappings.map((m) => (
        <div key={m.id} className="flex items-center gap-3 border rounded-lg p-3">
          <div className="flex-1">
            <div className="font-medium text-sm">{m.gatewayName}</div>
            {m.autoDetected && !m.accountId && <Badge variant="outline" className="text-amber-600 border-amber-300 mt-1">Sin asignar</Badge>}
          </div>
          <Select defaultValue={m.accountId || ''} onValueChange={(v) => save.mutate({ gatewayName: m.gatewayName, accountId: v })}>
            <SelectTrigger className="w-56"><SelectValue placeholder="Elegir cuenta destino" /></SelectTrigger>
            <SelectContent>
              {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name} ({a.currency})</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      ))}
    </div>
  );
}

// ── Clientes pendientes de revisión ───────────────────────────────────────────
function PendingClients() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data } = useQuery<{ pending: any[] }>({ queryKey: ['/tiendanube/pending-clients'], queryFn: () => fetchWithAuth('/tiendanube/pending-clients') });
  const resolve = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) =>
      fetchWithAuth(`/tiendanube/pending-clients/${id}/resolve`, { method: 'POST', body: JSON.stringify({ action }) }),
    onSuccess: () => {
      toast({ title: 'Resuelto' });
      queryClient.invalidateQueries({ queryKey: ['/tiendanube/pending-clients'] });
      queryClient.invalidateQueries({ queryKey: ['/tiendanube/status'] });
    },
    onError: (e: any) => toast({ title: 'Error', description: e?.message, variant: 'destructive' }),
  });

  const pending = data?.pending || [];
  if (pending.length === 0) return <p className="text-sm text-muted-foreground">No hay clientes pendientes de revisión. 🎉</p>;
  return (
    <div className="space-y-3 max-w-2xl">
      <p className="text-sm text-muted-foreground">Clientes de Tiendanube que coinciden con más de un cliente existente. Decidí cómo resolverlos.</p>
      {pending.map((p) => {
        const d = p.externalData || {};
        return (
          <div key={p.id} className="border rounded-lg p-3 space-y-2">
            <div className="text-sm">
              <span className="font-medium">{d.name || 'Cliente'}</span>
              {d.email && <span className="text-muted-foreground"> · {d.email}</span>}
              {d.taxId && <span className="text-muted-foreground"> · {d.taxId}</span>}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => resolve.mutate({ id: p.id, action: 'create_new' })}>Crear nuevo</Button>
              <Button size="sm" variant="ghost" onClick={() => resolve.mutate({ id: p.id, action: 'reject' })}>Ignorar</Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Logs de webhooks + configuración ──────────────────────────────────────────
function WebhookLogs() {
  const { data } = useQuery<{ logs: any[] }>({ queryKey: ['/tiendanube/logs'], queryFn: () => fetchWithAuth('/tiendanube/logs') });
  const logs = data?.logs || [];
  return (
    <div className="space-y-3 max-w-2xl">
      <div className="text-sm text-muted-foreground">
        <p>La sincronización es automática vía webhooks (en tiempo real), con una reconciliación de respaldo cada 30 minutos.</p>
      </div>
      <div className="font-medium text-sm">Últimos eventos</div>
      {logs.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin eventos todavía.</p>
      ) : (
        <div className="border rounded-lg divide-y max-h-80 overflow-auto">
          {logs.map((l) => (
            <div key={l.id} className="flex items-center justify-between px-3 py-2 text-xs">
              <span className="font-mono">{l.event} · {l.externalResourceId}</span>
              <Badge variant={l.status === 'processed' ? 'secondary' : l.status === 'failed' ? 'destructive' : 'outline'}>{l.status}</Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
