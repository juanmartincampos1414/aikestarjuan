// =============================================================================
// AIKESTAR - Remitos (comprobante de entrega)
// =============================================================================
import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Loader2, Plus, FileText, Trash2, Printer, Ban } from 'lucide-react';

export default function RemitosPage() {
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const { data: remitos = [], isLoading } = useQuery<any[]>({ queryKey: ['/remitos'], queryFn: () => fetchWithAuth('/remitos') });

  if (isLoading) return <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FileText className="h-6 w-6 text-[#00C3DD]" /> Remitos</h1>
          <p className="text-sm text-muted-foreground">Comprobantes de entrega de mercadería y servicios.</p>
        </div>
        <Button onClick={() => setShowNew(true)} className="bg-gradient-to-r from-[#00D4FF] to-[#FF3366]"><Plus className="h-4 w-4 mr-1" /> Nuevo remito</Button>
      </div>

      {remitos.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          Todavía no hay remitos. Generalos desde un presupuesto, una orden de trabajo, o creá uno manual.
        </CardContent></Card>
      ) : (
        <div className="space-y-2">
          {remitos.map((r) => (
            <div key={r.id} onClick={() => setDetailId(r.id)} className="flex items-center gap-3 border rounded-lg p-3 bg-card cursor-pointer hover:shadow-sm transition-shadow">
              <div className="flex-1">
                <div className="font-medium">Remito {r.number}</div>
                <div className="text-xs text-muted-foreground">{r.clientName || 'Sin cliente'} · {new Date(r.date).toLocaleDateString('es-AR')}</div>
              </div>
              {r.stockApplied && <Badge variant="outline" className="text-xs">Stock descontado</Badge>}
              <Badge variant="outline" className={r.status === 'anulado' ? 'text-red-600 border-red-300' : 'text-emerald-600 border-emerald-300'}>{r.status === 'anulado' ? 'Anulado' : 'Emitido'}</Badge>
            </div>
          ))}
        </div>
      )}

      {detailId && <RemitoDetail id={detailId} onClose={() => setDetailId(null)} />}
      {showNew && <NewRemito onClose={() => setShowNew(false)} />}
    </div>
  );
}

// ── Detalle + imprimir ────────────────────────────────────────────────────────
function RemitoDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery<any>({ queryKey: ['/remitos', id], queryFn: () => fetchWithAuth(`/remitos/${id}`) });
  const cancel = useMutation({
    mutationFn: () => fetchWithAuth(`/remitos/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['/remitos'] }); queryClient.invalidateQueries({ queryKey: ['/remitos', id] }); toast({ title: 'Remito anulado' }); },
  });
  const r = data?.remito; const items = data?.items || [];

  function print() {
    const rows = items.map((it: any) => `<tr><td>${it.quantity}</td><td>${it.description}</td>${it.unitPrice ? `<td style="text-align:right">$${Number(it.unitPrice).toLocaleString('es-AR')}</td>` : '<td></td>'}</tr>`).join('');
    const html = `<html><head><title>Remito ${r.number}</title><style>body{font-family:system-ui,sans-serif;padding:40px;color:#111}h1{font-size:20px}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;font-size:14px}</style></head><body><h1>REMITO ${r.number}</h1><p>Fecha: ${new Date(r.date).toLocaleDateString('es-AR')}<br/>Cliente: ${r.clientName || '—'}</p><table><thead><tr><th>Cant.</th><th>Descripción</th><th style="text-align:right">P. unit.</th></tr></thead><tbody>${rows}</tbody></table>${r.notes ? `<p style="margin-top:16px;font-size:13px;color:#555">${r.notes}</p>` : ''}<p style="margin-top:60px;font-size:13px">Firma y aclaración del receptor: ________________________</p></body></html>`;
    const w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); w.print(); }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Remito {r?.number}</DialogTitle></DialogHeader>
        {r && (
          <div className="space-y-3 text-sm">
            <div className="text-muted-foreground text-xs">{r.clientName || 'Sin cliente'} · {new Date(r.date).toLocaleDateString('es-AR')}</div>
            <div className="border rounded-lg divide-y">
              {items.map((it: any) => (
                <div key={it.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span>{it.quantity}× {it.description}</span>
                  {it.unitPrice && <span className="text-muted-foreground">${Number(it.unitPrice).toLocaleString('es-AR')}</span>}
                </div>
              ))}
            </div>
            {r.notes && <p className="text-muted-foreground text-xs">{r.notes}</p>}
            <div className="flex gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={print}><Printer className="h-4 w-4 mr-1" /> Imprimir</Button>
              {r.status !== 'anulado' && <Button size="sm" variant="ghost" className="text-red-600" onClick={() => cancel.mutate()}><Ban className="h-4 w-4 mr-1" /> Anular</Button>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Nuevo remito (manual / desde presupuesto / desde orden) ───────────────────
function NewRemito({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [mode, setMode] = useState<'manual' | 'quote' | 'wo'>('manual');
  const [applyStock, setApplyStock] = useState(false);
  const [clientName, setClientName] = useState('');
  const [items, setItems] = useState<Array<{ description: string; quantity: string; productId?: string | null; unitPrice?: string | null }>>([{ description: '', quantity: '1' }]);
  const [sourceId, setSourceId] = useState('');

  const { data: quotes = [] } = useQuery<any[]>({ queryKey: ['/api/quotes'], queryFn: () => fetchWithAuth('/quotes'), enabled: mode === 'quote' });
  const { data: orders = [] } = useQuery<any[]>({ queryKey: ['/work-orders'], queryFn: () => fetchWithAuth('/work-orders'), enabled: mode === 'wo' });
  // Catálogo de productos (incluye los de Tiendanube) para elegir en los ítems.
  const { data: products = [] } = useQuery<any[]>({ queryKey: ['/api/products'], queryFn: () => fetchWithAuth('/products'), enabled: mode === 'manual' });

  function pickProduct(i: number, productId: string) {
    const p = products.find((x) => x.id === productId);
    if (!p) return;
    setItems(arr => arr.map((it, idx) => idx === i ? { ...it, productId: p.id, description: p.name, unitPrice: p.salePrice ?? null } : it));
  }

  const done = () => { queryClient.invalidateQueries({ queryKey: ['/remitos'] }); toast({ title: 'Remito generado' }); onClose(); };
  const fail = (e: any) => toast({ title: 'Error', description: e?.message, variant: 'destructive' });

  const createManual = useMutation({ mutationFn: () => fetchWithAuth('/remitos', { method: 'POST', body: JSON.stringify({ clientName, applyStock, items: items.filter(i => i.description.trim()) }) }), onSuccess: done, onError: fail });
  const fromQuote = useMutation({ mutationFn: () => fetchWithAuth(`/remitos/from-quote/${sourceId}`, { method: 'POST', body: JSON.stringify({ applyStock }) }), onSuccess: done, onError: fail });
  const fromWo = useMutation({ mutationFn: () => fetchWithAuth(`/remitos/from-work-order/${sourceId}`, { method: 'POST', body: JSON.stringify({ applyStock }) }), onSuccess: done, onError: fail });

  const setItem = (i: number, k: string, v: string) => setItems(arr => arr.map((it, idx) => idx === i ? { ...it, [k]: v } : it));
  const canSubmit = mode === 'manual' ? items.some(i => i.description.trim()) : !!sourceId;
  const pending = createManual.isPending || fromQuote.isPending || fromWo.isPending;

  function submit() {
    if (mode === 'manual') createManual.mutate();
    else if (mode === 'quote') fromQuote.mutate();
    else fromWo.mutate();
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Nuevo remito</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-1.5">
            {([['manual', 'Manual'], ['quote', 'Desde presupuesto'], ['wo', 'Desde orden']] as const).map(([m, l]) => (
              <button key={m} onClick={() => { setMode(m); setSourceId(''); }} className={`text-xs px-3 py-1.5 rounded-full border ${mode === m ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'}`}>{l}</button>
            ))}
          </div>

          {mode === 'manual' && (
            <>
              <div><Label>Cliente</Label><Input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Nombre del cliente" /></div>
              <div className="space-y-2">
                <Label>Ítems</Label>
                {items.map((it, i) => (
                  <div key={i} className="space-y-1 border rounded-lg p-2">
                    <Select value={it.productId || ''} onValueChange={(v) => pickProduct(i, v)}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Elegir del catálogo (o escribir abajo)" /></SelectTrigger>
                      <SelectContent>
                        {products.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}{p.externalSource === 'tiendanube' ? ' · Tiendanube' : ''}{p.sku ? ` (${p.sku})` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex gap-1.5">
                      <Input className="w-16" value={it.quantity} onChange={(e) => setItem(i, 'quantity', e.target.value)} />
                      <Input className="flex-1" placeholder="Descripción" value={it.description} onChange={(e) => setItem(i, 'description', e.target.value)} />
                      {items.length > 1 && <Button size="icon" variant="ghost" onClick={() => setItems(arr => arr.filter((_, idx) => idx !== i))}><Trash2 className="h-4 w-4" /></Button>}
                    </div>
                  </div>
                ))}
                <Button size="sm" variant="outline" onClick={() => setItems(arr => [...arr, { description: '', quantity: '1' }])}><Plus className="h-3 w-3 mr-1" /> Ítem</Button>
              </div>
            </>
          )}

          {mode === 'quote' && (
            <div><Label>Presupuesto</Label>
              <Select value={sourceId} onValueChange={setSourceId}>
                <SelectTrigger><SelectValue placeholder="Elegir presupuesto" /></SelectTrigger>
                <SelectContent>{quotes.map((q) => <SelectItem key={q.id} value={q.id}>{q.title} — {q.clientName || 'Sin cliente'}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          {mode === 'wo' && (
            <div><Label>Orden de trabajo</Label>
              <Select value={sourceId} onValueChange={setSourceId}>
                <SelectTrigger><SelectValue placeholder="Elegir orden" /></SelectTrigger>
                <SelectContent>{orders.map((o) => <SelectItem key={o.id} value={o.id}>{o.title}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox checked={applyStock} onCheckedChange={(v) => setApplyStock(!!v)} />
            Descontar del stock al emitir (los productos del catálogo salen del inventario)
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button disabled={!canSubmit || pending} onClick={submit}>{pending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Generar remito'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
