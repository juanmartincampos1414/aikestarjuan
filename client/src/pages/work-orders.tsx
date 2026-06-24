// =============================================================================
// AIKESTAR - Órdenes de Trabajo
// =============================================================================
import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/api';
import { formatCurrencyAR } from '@/lib/currency';
import { useToast } from '@/hooks/use-toast';
import {
  WORK_ORDER_STATES, WORK_ORDER_STATE_LABELS, WORK_ORDER_PRIORITIES, WORK_ORDER_PRIORITY_LABELS,
  type WorkOrderState,
} from '@shared/schema';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Loader2, Plus, Wrench, Trash2, UserPlus, Image as ImageIcon } from 'lucide-react';

const STATE_COLOR: Record<string, string> = {
  pendiente: 'text-slate-600 border-slate-300', programado: 'text-blue-600 border-blue-300',
  en_ejecucion: 'text-amber-600 border-amber-300', esperando_materiales: 'text-orange-600 border-orange-300',
  finalizado: 'text-emerald-600 border-emerald-300', facturado: 'text-indigo-600 border-indigo-300', cobrado: 'text-green-700 border-green-300',
};
const PRIORITY_COLOR: Record<string, string> = { low: 'text-slate-500', medium: 'text-blue-600', high: 'text-orange-600', urgent: 'text-red-600' };

export default function WorkOrdersPage() {
  const [statusFilter, setStatusFilter] = useState('all');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const { data: orders = [], isLoading } = useQuery<any[]>({
    queryKey: ['/work-orders'], queryFn: () => fetchWithAuth('/work-orders'),
  });

  const filtered = statusFilter === 'all' ? orders : orders.filter((o) => o.status === statusFilter);

  if (isLoading) return <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Wrench className="h-6 w-6 text-[#00C3DD]" /> Órdenes de Trabajo</h1>
          <p className="text-sm text-muted-foreground">Ejecución operativa de los trabajos aprobados.</p>
        </div>
        <Button onClick={() => setShowNew(true)} className="bg-gradient-to-r from-[#00D4FF] to-[#FF3366]"><Plus className="h-4 w-4 mr-1" /> Nueva orden</Button>
      </div>

      {/* Filtro por estado */}
      <div className="flex gap-1.5 flex-wrap">
        <FilterChip label="Todas" active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} />
        {WORK_ORDER_STATES.map((s) => (
          <FilterChip key={s} label={WORK_ORDER_STATE_LABELS[s]} active={statusFilter === s} onClick={() => setStatusFilter(s)} />
        ))}
      </div>

      {filtered.length === 0 ? (
        <Card><CardContent className="p-8 text-center space-y-2">
          <Wrench className="h-9 w-9 mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No hay órdenes con este filtro. Las órdenes se generan solas al aprobar un presupuesto, o creá una manual.</p>
        </CardContent></Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((o) => (
            <div key={o.id} onClick={() => setDetailId(o.id)} className="flex items-center gap-3 border rounded-lg p-3 bg-card cursor-pointer hover:shadow-sm transition-shadow">
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{o.title}</div>
                <div className="text-xs text-muted-foreground">{o.scheduledDate ? `Programada: ${new Date(o.scheduledDate).toLocaleDateString('es-AR')}` : 'Sin fecha'}</div>
              </div>
              <Badge variant="outline" className={PRIORITY_COLOR[o.priority]}>{WORK_ORDER_PRIORITY_LABELS[o.priority as keyof typeof WORK_ORDER_PRIORITY_LABELS]}</Badge>
              <Badge variant="outline" className={STATE_COLOR[o.status]}>{WORK_ORDER_STATE_LABELS[o.status as WorkOrderState]}</Badge>
            </div>
          ))}
        </div>
      )}

      {detailId && <WorkOrderDetail id={detailId} onClose={() => setDetailId(null)} />}
      {showNew && <NewWorkOrder onClose={() => setShowNew(false)} />}
    </div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return <button onClick={onClick} className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${active ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'}`}>{label}</button>;
}

// ── Detalle de orden ──────────────────────────────────────────────────────────
function WorkOrderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const invalidate = () => { queryClient.invalidateQueries({ queryKey: ['/work-orders', id] }); queryClient.invalidateQueries({ queryKey: ['/work-orders'] }); };

  const { data } = useQuery<any>({ queryKey: ['/work-orders', id], queryFn: () => fetchWithAuth(`/work-orders/${id}`) });
  const { data: employees = [] } = useQuery<any[]>({ queryKey: ['/employees'], queryFn: () => fetchWithAuth('/employees') });

  const transition = useMutation({
    mutationFn: (status: string) => fetchWithAuth(`/work-orders/${id}/transition`, { method: 'POST', body: JSON.stringify({ status }) }),
    onSuccess: invalidate, onError: (e: any) => toast({ title: 'Error', description: e?.message, variant: 'destructive' }),
  });
  const assign = useMutation({ mutationFn: (employeeId: string) => fetchWithAuth(`/work-orders/${id}/assignments`, { method: 'POST', body: JSON.stringify({ employeeId }) }), onSuccess: invalidate });
  const unassign = useMutation({ mutationFn: (assignId: string) => fetchWithAuth(`/work-orders/assignments/${assignId}`, { method: 'DELETE' }), onSuccess: invalidate });
  const [matDesc, setMatDesc] = useState(''); const [matQty, setMatQty] = useState('1');
  const addMat = useMutation({ mutationFn: () => fetchWithAuth(`/work-orders/${id}/materials`, { method: 'POST', body: JSON.stringify({ description: matDesc, quantity: matQty }) }), onSuccess: () => { setMatDesc(''); setMatQty('1'); invalidate(); } });
  const delMat = useMutation({ mutationFn: (mid: string) => fetchWithAuth(`/work-orders/materials/${mid}`, { method: 'DELETE' }), onSuccess: invalidate });
  const [photoUrl, setPhotoUrl] = useState('');
  const addPhoto = useMutation({ mutationFn: () => fetchWithAuth(`/work-orders/${id}/photos`, { method: 'POST', body: JSON.stringify({ url: photoUrl }) }), onSuccess: () => { setPhotoUrl(''); invalidate(); }, onError: (e: any) => toast({ title: 'Error', description: e?.message, variant: 'destructive' }) });
  const delPhoto = useMutation({ mutationFn: (pid: string) => fetchWithAuth(`/work-orders/photos/${pid}`, { method: 'DELETE' }), onSuccess: invalidate });
  const genRemito = useMutation({
    mutationFn: (applyStock: boolean) => fetchWithAuth(`/remitos/from-work-order/${id}`, { method: 'POST', body: JSON.stringify({ applyStock }) }),
    onSuccess: (r: any) => toast({ title: 'Remito generado', description: `Remito ${r.number} con los materiales de la orden.` }),
    onError: (e: any) => toast({ title: 'Error', description: e?.message, variant: 'destructive' }),
  });

  const o = data?.workOrder;
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{o?.title || 'Orden'}</DialogTitle></DialogHeader>
        {o && (
          <div className="space-y-4 text-sm">
            {/* Estado */}
            <div className="flex items-center gap-2">
              <Label className="text-xs">Estado</Label>
              <Select value={o.status} onValueChange={(v) => transition.mutate(v)}>
                <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
                <SelectContent>{WORK_ORDER_STATES.map(s => <SelectItem key={s} value={s}>{WORK_ORDER_STATE_LABELS[s]}</SelectItem>)}</SelectContent>
              </Select>
              <Badge variant="outline" className={PRIORITY_COLOR[o.priority]}>{WORK_ORDER_PRIORITY_LABELS[o.priority as keyof typeof WORK_ORDER_PRIORITY_LABELS]}</Badge>
            </div>

            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={genRemito.isPending} onClick={() => genRemito.mutate(false)}>Generar remito</Button>
              <Button size="sm" variant="ghost" disabled={genRemito.isPending} onClick={() => genRemito.mutate(true)}>Remito + descontar stock</Button>
            </div>

            {/* Técnicos */}
            <Section title="Técnicos asignados">
              <div className="flex flex-wrap gap-1.5 mb-2">
                {(data.assignments || []).map((a: any) => (
                  <Badge key={a.id} variant="secondary" className="gap-1">{a.fullName || 'Empleado'}<button onClick={() => unassign.mutate(a.id)}><Trash2 className="h-3 w-3" /></button></Badge>
                ))}
                {(data.assignments || []).length === 0 && <span className="text-xs text-muted-foreground">Sin técnicos</span>}
              </div>
              <Select onValueChange={(v) => assign.mutate(v)}>
                <SelectTrigger className="w-full"><SelectValue placeholder="+ Asignar técnico" /></SelectTrigger>
                <SelectContent>{employees.map((e) => <SelectItem key={e.id} value={e.id}>{e.fullName}</SelectItem>)}</SelectContent>
              </Select>
            </Section>

            {/* Materiales */}
            <Section title="Materiales">
              {(data.materials || []).map((m: any) => (
                <div key={m.id} className="flex items-center justify-between text-xs py-1">
                  <span>{m.quantity}× {m.description}</span>
                  <button onClick={() => delMat.mutate(m.id)}><Trash2 className="h-3 w-3 text-muted-foreground" /></button>
                </div>
              ))}
              <div className="flex gap-1.5 mt-1">
                <Input className="w-16" value={matQty} onChange={(e) => setMatQty(e.target.value)} />
                <Input className="flex-1" placeholder="Material…" value={matDesc} onChange={(e) => setMatDesc(e.target.value)} />
                <Button size="sm" variant="outline" disabled={!matDesc.trim()} onClick={() => addMat.mutate()}>+</Button>
              </div>
            </Section>

            {/* Fotos (URL) */}
            <Section title="Fotos">
              <div className="flex flex-wrap gap-2 mb-2">
                {(data.photos || []).map((p: any) => (
                  <div key={p.id} className="relative group">
                    <img src={p.url} className="h-16 w-16 object-cover rounded border" />
                    <button onClick={() => delPhoto.mutate(p.id)} className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5"><Trash2 className="h-2.5 w-2.5" /></button>
                  </div>
                ))}
              </div>
              <div className="flex gap-1.5">
                <Input placeholder="https://…/foto.jpg" value={photoUrl} onChange={(e) => setPhotoUrl(e.target.value)} />
                <Button size="sm" variant="outline" disabled={!photoUrl.trim()} onClick={() => addPhoto.mutate()}><ImageIcon className="h-4 w-4" /></Button>
              </div>
            </Section>

            {/* Timeline */}
            <Section title="Historial">
              {(data.timeline || []).map((t: any) => (
                <div key={t.id} className="text-xs border-l-2 border-primary/20 pl-3 py-0.5 flex justify-between">
                  <span>{timelineLabel(t)}</span>
                  <span className="text-muted-foreground">{new Date(t.createdAt).toLocaleString('es-AR')}</span>
                </div>
              ))}
            </Section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function timelineLabel(t: any): string {
  const d = t.detail || {};
  switch (t.event) {
    case 'created': return '🆕 Orden creada';
    case 'status_change': return `🔀 ${d.from} → ${d.to}`;
    case 'assignment_added': return '👷 Técnico asignado';
    case 'material_added': return `🧱 Material: ${d.description || ''}`;
    case 'photo_added': return '📷 Foto agregada';
    default: return t.event;
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="rounded-lg border p-3"><div className="font-medium text-sm mb-2">{title}</div>{children}</div>;
}

// ── Nueva orden ───────────────────────────────────────────────────────────────
function NewWorkOrder({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState({ title: '', priority: 'medium', scheduledDate: '' });
  const create = useMutation({
    mutationFn: () => fetchWithAuth('/work-orders', { method: 'POST', body: JSON.stringify({ ...form, scheduledDate: form.scheduledDate || null }) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['/work-orders'] }); toast({ title: 'Orden creada' }); onClose(); },
    onError: (e: any) => toast({ title: 'Error', description: e?.message, variant: 'destructive' }),
  });
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Nueva orden de trabajo</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Título *</Label><Input value={form.title} onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Instalación / reparación…" /></div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>Prioridad</Label>
              <Select value={form.priority} onValueChange={(v) => setForm(f => ({ ...f, priority: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{WORK_ORDER_PRIORITIES.map(p => <SelectItem key={p} value={p}>{WORK_ORDER_PRIORITY_LABELS[p]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label>Fecha programada</Label><Input type="date" value={form.scheduledDate} onChange={(e) => setForm(f => ({ ...f, scheduledDate: e.target.value }))} /></div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button disabled={!form.title.trim() || create.isPending} onClick={() => create.mutate()}>Crear</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
