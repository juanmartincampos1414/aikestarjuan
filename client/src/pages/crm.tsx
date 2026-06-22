// =============================================================================
// AIKESTAR - CRM Comercial (pipeline Kanban)
// =============================================================================
import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/api';
import { formatCurrencyAR } from '@/lib/currency';
import { useToast } from '@/hooks/use-toast';
import { CRM_STAGES, CRM_STAGE_LABELS, type CrmStage } from '@shared/schema';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Loader2, Plus, Sparkles, AlertTriangle, Phone, Mail, Send } from 'lucide-react';

const ACTIVITY_LABELS: Record<string, string> = {
  call: '📞 Llamada', whatsapp: '💬 WhatsApp', email: '✉️ Email', meeting: '🤝 Reunión',
  visit: '🚗 Visita', note: '📝 Nota', stage_change: '🔀 Cambio de etapa', system: '⚙️ Sistema',
};

interface Opp {
  id: string; title: string; contactName?: string | null; phone?: string | null; email?: string | null;
  estimatedValue?: string | null; currency?: string; stage: CrmStage; nextFollowupAt?: string | null;
  quoteId?: string | null; description?: string | null;
}
interface Column { stage: CrmStage; count: number; total: number; items: Opp[]; }

function isOverdue(o: Opp) { return !!o.nextFollowupAt && new Date(o.nextFollowupAt) < new Date() && o.stage !== 'aprobado' && o.stage !== 'perdido'; }

export default function CrmPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const { data, isLoading } = useQuery<{ columns: Column[] }>({
    queryKey: ['/crm/board'], queryFn: () => fetchWithAuth('/crm/board'),
  });

  const move = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: CrmStage }) =>
      fetchWithAuth(`/crm/opportunities/${id}/move`, { method: 'POST', body: JSON.stringify({ stage }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/crm/board'] }),
    onError: (e: any) => toast({ title: 'Error', description: e?.message, variant: 'destructive' }),
  });

  function onDrop(stage: CrmStage, e: React.DragEvent) {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/opp');
    if (id) move.mutate({ id, stage });
  }

  if (isLoading) return <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>;
  const columns = data?.columns || [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">CRM Comercial</h1>
          <p className="text-sm text-muted-foreground">Tu pipeline de oportunidades, de la consulta a la aprobación.</p>
        </div>
        <Button onClick={() => setShowNew(true)} className="bg-gradient-to-r from-[#00D4FF] to-[#FF3366]"><Plus className="h-4 w-4 mr-1" /> Nueva oportunidad</Button>
      </div>

      <AiCommandBar onDone={() => queryClient.invalidateQueries({ queryKey: ['/crm/board'] })} />

      {/* Kanban */}
      <div className="flex gap-3 overflow-x-auto pb-4">
        {columns.map((col) => (
          <div
            key={col.stage}
            className="w-72 shrink-0"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => onDrop(col.stage, e)}
          >
            <div className="flex items-center justify-between mb-2 px-1">
              <div className="font-medium text-sm">{CRM_STAGE_LABELS[col.stage]}</div>
              <Badge variant="secondary">{col.count}</Badge>
            </div>
            {col.total > 0 && <div className="text-xs text-muted-foreground mb-2 px-1">{formatCurrencyAR(col.total, 'ARS')}</div>}
            <div className="space-y-2 min-h-[120px] rounded-lg bg-muted/40 p-2">
              {col.items.map((o) => (
                <div
                  key={o.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/opp', o.id)}
                  onClick={() => setDetailId(o.id)}
                  className={`rounded-lg border bg-card p-3 cursor-pointer hover:shadow-sm transition-shadow ${isOverdue(o) ? 'border-red-300' : ''}`}
                >
                  <div className="font-medium text-sm leading-snug">{o.title}</div>
                  {o.contactName && <div className="text-xs text-muted-foreground mt-0.5">{o.contactName}</div>}
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-xs font-medium">{formatCurrencyAR(o.estimatedValue ?? '0', 'ARS')}</span>
                    {isOverdue(o) && <Badge variant="outline" className="text-red-600 border-red-300 text-[10px]"><AlertTriangle className="h-3 w-3 mr-0.5" />Vencido</Badge>}
                    {o.quoteId && !isOverdue(o) && <Badge variant="outline" className="text-[10px]">Presup.</Badge>}
                  </div>
                </div>
              ))}
              {col.items.length === 0 && <div className="text-xs text-muted-foreground text-center py-4">—</div>}
            </div>
          </div>
        ))}
      </div>

      {detailId && <OpportunityDetail id={detailId} onClose={() => setDetailId(null)} />}
      {showNew && <NewOpportunity onClose={() => setShowNew(false)} />}
    </div>
  );
}

// ── Caja de comando IA ────────────────────────────────────────────────────────
function AiCommandBar({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: (t: string) => fetchWithAuth('/ai/command', { method: 'POST', body: JSON.stringify({ text: t }) }),
    onSuccess: (r: any) => { toast({ title: 'Aike', description: r.reply }); setText(''); onDone(); },
    onError: (e: any) => toast({ title: 'Error', description: e?.message, variant: 'destructive' }),
  });
  return (
    <div className="flex gap-2 items-center rounded-lg border bg-card p-2">
      <Sparkles className="h-4 w-4 text-[#FF3366] ml-1 shrink-0" />
      <Input
        placeholder='Pedile a Aike… ej: "Crear oportunidad para Ana por pintura $80000" o "Mover X a presupuesto enviado"'
        value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) send.mutate(text.trim()); }}
        className="border-0 focus-visible:ring-0 shadow-none"
      />
      <Button size="sm" disabled={!text.trim() || send.isPending} onClick={() => send.mutate(text.trim())}>
        {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
      </Button>
    </div>
  );
}

// ── Detalle de oportunidad + timeline ─────────────────────────────────────────
function OpportunityDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [actType, setActType] = useState('note');
  const [actContent, setActContent] = useState('');
  const [actDate, setActDate] = useState('');

  const { data } = useQuery<{ opportunity: Opp; activities: any[] }>({
    queryKey: ['/crm/opp', id], queryFn: () => fetchWithAuth(`/crm/opportunities/${id}`),
  });

  const addAct = useMutation({
    mutationFn: () => fetchWithAuth(`/crm/opportunities/${id}/activities`, {
      method: 'POST', body: JSON.stringify({ type: actType, content: actContent, scheduledAt: actDate || null }),
    }),
    onSuccess: () => {
      setActContent(''); setActDate('');
      queryClient.invalidateQueries({ queryKey: ['/crm/opp', id] });
      queryClient.invalidateQueries({ queryKey: ['/crm/board'] });
      toast({ title: 'Actividad registrada' });
    },
  });

  const o = data?.opportunity;
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{o?.title || 'Oportunidad'}</DialogTitle></DialogHeader>
        {o && (
          <div className="space-y-4">
            <div className="text-sm space-y-1">
              {o.contactName && <div className="font-medium">{o.contactName}</div>}
              <div className="flex flex-wrap gap-3 text-muted-foreground text-xs">
                {o.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{o.phone}</span>}
                {o.email && <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{o.email}</span>}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <Badge variant="secondary">{CRM_STAGE_LABELS[o.stage]}</Badge>
                <span className="font-medium">{formatCurrencyAR(o.estimatedValue ?? '0', 'ARS')}</span>
              </div>
              {o.description && <p className="text-muted-foreground pt-1">{o.description}</p>}
            </div>

            {/* Registrar actividad */}
            <div className="rounded-lg border p-3 space-y-2">
              <div className="font-medium text-sm">Registrar actividad</div>
              <div className="flex gap-2">
                <Select value={actType} onValueChange={setActType}>
                  <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['call', 'whatsapp', 'email', 'meeting', 'visit', 'note'].map(t => <SelectItem key={t} value={t}>{ACTIVITY_LABELS[t]}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input type="datetime-local" value={actDate} onChange={(e) => setActDate(e.target.value)} className="flex-1" placeholder="Programar (opcional)" />
              </div>
              <Textarea placeholder="Detalle…" value={actContent} onChange={(e) => setActContent(e.target.value)} rows={2} />
              <Button size="sm" disabled={addAct.isPending} onClick={() => addAct.mutate()}>Agregar</Button>
            </div>

            {/* Timeline */}
            <div>
              <div className="font-medium text-sm mb-2">Historial</div>
              <div className="space-y-2">
                {(data?.activities || []).map((a) => (
                  <div key={a.id} className="text-xs border-l-2 border-primary/20 pl-3 py-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{ACTIVITY_LABELS[a.type] || a.type}</span>
                      <span className="text-muted-foreground">{new Date(a.createdAt).toLocaleString('es-AR')}</span>
                    </div>
                    {a.content && <div className="text-muted-foreground">{a.content}</div>}
                    {a.scheduledAt && <div className="text-cyan-600">📅 {new Date(a.scheduledAt).toLocaleString('es-AR')}</div>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Nueva oportunidad ─────────────────────────────────────────────────────────
function NewOpportunity({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState({ title: '', contactName: '', phone: '', email: '', estimatedValue: '', stage: 'consulta' as CrmStage });
  const create = useMutation({
    mutationFn: () => fetchWithAuth('/crm/opportunities', { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['/crm/board'] }); toast({ title: 'Oportunidad creada' }); onClose(); },
    onError: (e: any) => toast({ title: 'Error', description: e?.message, variant: 'destructive' }),
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Nueva oportunidad</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Título *</Label><Input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Instalación eléctrica" /></div>
          <div><Label>Contacto</Label><Input value={form.contactName} onChange={(e) => set('contactName', e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>Teléfono</Label><Input value={form.phone} onChange={(e) => set('phone', e.target.value)} /></div>
            <div><Label>Email</Label><Input value={form.email} onChange={(e) => set('email', e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>Valor estimado</Label><Input type="number" value={form.estimatedValue} onChange={(e) => set('estimatedValue', e.target.value)} /></div>
            <div><Label>Etapa</Label>
              <Select value={form.stage} onValueChange={(v) => set('stage', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{CRM_STAGES.map(s => <SelectItem key={s} value={s}>{CRM_STAGE_LABELS[s]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
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
