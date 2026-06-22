import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FileText, ExternalLink, Filter, AlertTriangle, Loader2, Download, FileSpreadsheet, FileArchive, FileBarChart, MailWarning, Mail, Send, FileX2, Plus } from 'lucide-react';
import { CreditNoteModal } from '@/components/CreditNoteModal';
import { TransactionWizard } from '@/components/transaction-wizard';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fetchWithAuth, getAuthToken } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { formatCurrencyAR } from '@/lib/currency';
import { getArgentinaToday } from '@/lib/utils';
import { BackButton } from '@/components/BackButton';
import { useAccounts, useIsPersonalBasic, useOrganization } from '@/lib/hooks';
import { Info, Building2 } from 'lucide-react';

interface InvoiceItem {
  id: string;
  date: string;
  amount: string;
  currency: string;
  description: string;
  type: string;
  status: string;
  createdVia?: string | null;
  invoiceUuid: string | null;
  invoiceVoucherId: string | null;
  invoiceCae: string | null;
  invoiceCaeExpirationDate: string | null;
  invoicePdfUrl: string | null;
  invoiceEnvironment: 'sandbox' | 'production' | null;
  invoiceEmissionStatus: string | null;
  invoiceEmissionErrorMessage?: string | null;
  invoiceEmissionErrorCode?: string | null;
  invoiceEmissionErrorAt?: string | null;
  invoiceEmittedAt: string | null;
  invoiceDocType: string | null;
  invoiceEmitterCuit: string | null;
  invoiceCreditNoteUuid: string | null;
  invoiceCreditNotePdfUrl?: string | null;
  invoiceNetAmount: string | null;
  invoiceIvaAmount: string | null;
  invoiceSimulated?: boolean | null;
  invoiceEmailStatus?: 'sent' | 'failed' | null;
  invoiceEmailLastAttemptAt?: string | null;
  invoiceEmailLastError?: string | null;
  invoiceEmailLastRecipients?: string | null;
  clientId: string | null;
  clientName?: string | null;
}
interface InvoicesResponse {
  items: InvoiceItem[];
  summary: { count: number; total: number; net: number; iva: number };
  emitterCuits: string[];
}

const DOC_TYPE_LABEL: Record<string, string> = {
  FA: 'Factura A', FB: 'Factura B', FC: 'Factura C',
  NCA: 'Nota Crédito A', NCB: 'Nota Crédito B', NCC: 'Nota Crédito C',
};

function startOfMonth() {
  return getArgentinaToday().slice(0, 8) + '01';
}
function today() { return getArgentinaToday(); }

export default function InvoicesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isPersonalContext = useIsPersonalBasic();
  const { data: currentOrg } = useOrganization();
  const [resending, setResending] = useState<string | null>(null);
  const [creditNoteTarget, setCreditNoteTarget] = useState<InvoiceItem | null>(null);
  const [newInvoiceWizardOpen, setNewInvoiceWizardOpen] = useState(false);
  const [pendingReceivable, setPendingReceivable] = useState<{ id: string; description?: string; amount?: string; currency?: string } | null>(null);
  const [confirmAccountId, setConfirmAccountId] = useState<string>('');
  const [confirmingIncome, setConfirmingIncome] = useState(false);
  const { data: accountsList = [] } = useAccounts();
  const [filters, setFilters] = useState({
    startDate: startOfMonth(),
    endDate: today(),
    environment: 'all',
    status: 'all',
    docType: 'all',
    emitterCuit: 'all',
  });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState<string | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.startDate) p.set('startDate', filters.startDate);
    if (filters.endDate) p.set('endDate', filters.endDate);
    if (filters.environment !== 'all') p.set('environment', filters.environment);
    if (filters.status !== 'all') p.set('status', filters.status);
    if (filters.docType !== 'all') p.set('docType', filters.docType);
    if (filters.emitterCuit !== 'all') p.set('emitterCuit', filters.emitterCuit);
    return p.toString();
  }, [filters]);

  const { data, isLoading, error } = useQuery<InvoicesResponse>({
    queryKey: ['/api/invoicing/invoices', qs],
    queryFn: async () => fetchWithAuth(`/invoicing/invoices${qs ? `?${qs}` : ''}`),
  });

  const allItems = data?.items || [];
  const items = useMemo(() => {
    if (!search.trim()) return allItems;
    const q = search.trim().toLowerCase();
    return allItems.filter((it) =>
      (it.invoiceVoucherId || '').toLowerCase().includes(q) ||
      (it.invoiceCae || '').toLowerCase().includes(q) ||
      (it.clientName || '').toLowerCase().includes(q) ||
      (it.description || '').toLowerCase().includes(q),
    );
  }, [allItems, search]);
  const summary = data?.summary || { count: 0, total: 0, net: 0, iva: 0 };
  const emitterCuits = data?.emitterCuits || [];
  const showEmitterFilter = emitterCuits.length > 1;

  const visibleIds = useMemo(() => items.map(i => i.id), [items]);
  const allChecked = visibleIds.length > 0 && visibleIds.every(id => selected.has(id));
  const someChecked = visibleIds.some(id => selected.has(id)) && !allChecked;
  function toggleAll() {
    setSelected(prev => {
      const next = new Set(prev);
      if (allChecked) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }
  function toggleOne(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function resendEmail(item: InvoiceItem) {
    let recipients: { to?: string[]; cc?: string[]; bcc?: string[]; message?: string | null } = {};
    if (item.invoiceEmailLastRecipients) {
      try { recipients = JSON.parse(item.invoiceEmailLastRecipients); } catch { /* noop */ }
    }
    let to = (recipients.to || []).filter(Boolean);
    if (to.length === 0) {
      const entered = window.prompt('Ingresá el email del destinatario para reenviar la factura:');
      if (!entered || !entered.trim()) return;
      to = [entered.trim()];
    }
    try {
      setResending(item.id);
      const resp = await fetchWithAuth(
        `/invoicing/transactions/${item.id}/send-pdf`,
        {
          method: 'POST',
          body: JSON.stringify({
            to: to.length === 1 ? to[0] : to,
            cc: recipients.cc || [],
            bcc: recipients.bcc || [],
            message: recipients.message ?? null,
          }),
        },
      ) as { sent?: string[]; failed?: string[] };
      const sent: string[] = resp?.sent || [];
      const failed: string[] = resp?.failed || [];
      if (failed.length === 0) {
        toast({ title: 'Email enviado', description: `Se reenvió a ${sent.join(', ')}` });
      } else {
        toast({
          title: 'Reenvío parcial',
          description: `Falló para: ${failed.join(', ')}`,
          variant: 'destructive',
        });
      }
      queryClient.invalidateQueries({ queryKey: ['/api/invoicing/invoices'] });
    } catch (e: any) {
      toast({
        title: 'No se pudo reenviar',
        description: e?.message || 'Error al reenviar el email',
        variant: 'destructive',
      });
    } finally {
      setResending(null);
    }
  }

  async function downloadExport(format: 'xlsx' | 'pdf' | 'zip') {
    try {
      setExporting(format);
      const params = new URLSearchParams(qs);
      const ids = Array.from(selected);
      if (ids.length > 0) params.set('ids', ids.join(','));
      const url = `/api/invoicing/invoices.${format}${params.toString() ? `?${params.toString()}` : ''}`;
      const headers: Record<string, string> = {};
      const token = getAuthToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const resp = await fetch(url, { credentials: 'include', headers });
      if (!resp.ok) {
        const msg = await resp.json().catch(() => ({ message: `HTTP ${resp.status}` }));
        throw new Error(msg.message || `Error ${resp.status}`);
      }
      const blob = await resp.blob();
      const cd = resp.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename="?([^";]+)"?/i);
      const filename = m ? m[1] : `facturas.${format}`;
      const a = document.createElement('a');
      const objUrl = URL.createObjectURL(blob);
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objUrl);
      toast({ title: 'Exportación lista', description: filename });
    } catch (e: any) {
      toast({ title: 'No se pudo exportar', description: e?.message || 'Error', variant: 'destructive' });
    } finally {
      setExporting(null);
    }
  }

  if (isPersonalContext) {
    return (
      <div className="w-full p-4 md:p-6" data-testid="page-invoices-personal-blocked">
        <BackButton />
        <Alert className="mt-4">
          <Info className="w-4 h-4" />
          <AlertDescription>
            <strong className="block mb-1">Esta sección no está disponible en cuentas personales</strong>
            La facturación electrónica sólo aplica a organizaciones tipo Empresa, donde se gestionan clientes y comprobantes. Si necesitás emitir facturas, creá o cambiá a una organización Empresa desde el selector de organización.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6 flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <div>
          <BackButton />
          <h1 className="text-3xl font-bold font-display mt-2 flex items-center gap-3">
            <FileText className="h-7 w-7 text-pink-500" />
            Facturas emitidas
          </h1>
          <p className="text-muted-foreground">
            Listado de facturas y notas de crédito generadas mediante el conector con ARCA. Configurá el emisor en{' '}
            <Link href="/settings?tab=invoicing"><a className="underline">Configuración → Facturador</a></Link>.
          </p>
          {currentOrg?.name && (
            <div
              className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted/60 border text-sm"
              data-testid="badge-current-org"
            >
              <Building2 className="h-4 w-4 text-cyan-500" />
              <span className="text-muted-foreground">Mostrando facturas de:</span>
              <strong className="font-semibold" data-testid="text-current-org-name">{currentOrg.name}</strong>
            </div>
          )}
        </div>
        <Button
          onClick={() => setNewInvoiceWizardOpen(true)}
          className="aikestar-gradient hover:opacity-90 text-white shadow-lg teal-glow rounded-full font-semibold"
          data-testid="button-new-invoice"
        >
          <Plus className="h-4 w-4 mr-2" />
          Nueva Factura
        </Button>
      </div>

      <Card className="mb-4">
        <CardContent className="pt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div>
            <Label className="text-xs">Desde</Label>
            <Input type="date" data-testid="filter-start" value={filters.startDate} onChange={(e) => setFilters({ ...filters, startDate: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs">Hasta</Label>
            <Input type="date" data-testid="filter-end" value={filters.endDate} onChange={(e) => setFilters({ ...filters, endDate: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs">Ambiente</Label>
            <Select value={filters.environment} onValueChange={(v) => setFilters({ ...filters, environment: v })}>
              <SelectTrigger data-testid="filter-env"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="sandbox">Pruebas</SelectItem>
                <SelectItem value="production">Producción</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Estado</Label>
            <Select value={filters.status} onValueChange={(v) => setFilters({ ...filters, status: v })}>
              <SelectTrigger data-testid="filter-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="emitted">Emitida</SelectItem>
                <SelectItem value="cancelled">Anulada (NC)</SelectItem>
                <SelectItem value="error">Error</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Buscar</Label>
            <Input
              data-testid="filter-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Nº comprob., CAE, cliente…"
            />
          </div>
          {showEmitterFilter && (
            <div>
              <Label className="text-xs">CUIT Emisor</Label>
              <Select value={filters.emitterCuit} onValueChange={(v) => setFilters({ ...filters, emitterCuit: v })}>
                <SelectTrigger data-testid="filter-emitter-cuit"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {emitterCuits.map((c) => (
                    <SelectItem key={c} value={c} data-testid={`filter-emitter-cuit-${c}`}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label className="text-xs">Tipo</Label>
            <Select value={filters.docType} onValueChange={(v) => setFilters({ ...filters, docType: v })}>
              <SelectTrigger data-testid="filter-doctype"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="FA">Factura A</SelectItem>
                <SelectItem value="FB">Factura B</SelectItem>
                <SelectItem value="FC">Factura C</SelectItem>
                <SelectItem value="NCA">NC A</SelectItem>
                <SelectItem value="NCB">NC B</SelectItem>
                <SelectItem value="NCC">NC C</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Card><CardContent className="pt-4 sm:pt-6">
          <p className="text-xs text-muted-foreground">Cantidad</p>
          <p className="text-lg sm:text-2xl font-bold break-words" data-testid="text-count">{summary.count}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 sm:pt-6">
          <p className="text-xs text-muted-foreground">Total emitido</p>
          <p className="text-lg sm:text-2xl font-bold break-words" data-testid="text-total">{formatCurrencyAR(summary.total)}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 sm:pt-6">
          <p className="text-xs text-muted-foreground">Neto</p>
          <p className="text-lg sm:text-2xl font-bold break-words" data-testid="text-net">{formatCurrencyAR(summary.net)}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 sm:pt-6">
          <p className="text-xs text-muted-foreground">IVA</p>
          <p className="text-lg sm:text-2xl font-bold break-words" data-testid="text-iva">{formatCurrencyAR(summary.iva)}</p>
        </CardContent></Card>
      </div>

      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="text-sm text-muted-foreground" data-testid="text-selection">
          {selected.size > 0
            ? `${selected.size} seleccionada${selected.size === 1 ? '' : 's'} de ${items.length}`
            : `Sin selección · se exportarán las ${items.length} del filtro`}
        </div>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} data-testid="button-clear-selection">
              Limpiar selección
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button data-testid="button-export" disabled={items.length === 0 || !!exporting}>
                {exporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
                Exportar
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => downloadExport('xlsx')} data-testid="menu-export-xlsx">
                <FileSpreadsheet className="h-4 w-4 mr-2" /> Excel (.xlsx)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => downloadExport('pdf')} data-testid="menu-export-pdf">
                <FileBarChart className="h-4 w-4 mr-2" /> PDF Libro de IVA Ventas
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => downloadExport('zip')} data-testid="menu-export-zip">
                <FileArchive className="h-4 w-4 mr-2" /> ZIP de PDFs
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          {isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>
          ) : error ? (
            <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertDescription>{(error as Error).message}</AlertDescription></Alert>
          ) : items.length === 0 ? (
            <div className="text-center py-12" data-testid="empty-invoices">
              <Filter className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                Sin facturas emitidas en el período seleccionado
                {currentOrg?.name ? <> en <strong>{currentOrg.name}</strong></> : null}.
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Emití una factura desde un ingreso o cuenta a cobrar para verla aquí.
              </p>
              <p className="text-xs text-muted-foreground mt-3">
                ¿Esperabas ver facturas? Verificá que estés en la organización correcta usando el selector arriba a la izquierda.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        data-testid="checkbox-select-all"
                        checked={allChecked ? true : (someChecked ? 'indeterminate' : false)}
                        onCheckedChange={() => toggleAll()}
                      />
                    </TableHead>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Comprobante</TableHead>
                    <TableHead>CUIT Emisor</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead className="text-right">Neto</TableHead>
                    <TableHead className="text-right">IVA</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>CAE</TableHead>
                    <TableHead>Ambiente</TableHead>
                    <TableHead>Origen</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => (
                    <TableRow key={it.id} data-testid={`row-invoice-${it.id}`}>
                      <TableCell>
                        <Checkbox
                          data-testid={`checkbox-invoice-${it.id}`}
                          checked={selected.has(it.id)}
                          onCheckedChange={() => toggleOne(it.id)}
                        />
                      </TableCell>
                      <TableCell className="text-xs">{new Date(it.date).toLocaleDateString('es-AR')}</TableCell>
                      <TableCell>{DOC_TYPE_LABEL[it.invoiceDocType || ''] || it.invoiceDocType || '—'}</TableCell>
                      <TableCell className="font-mono text-xs">{it.invoiceVoucherId || '—'}</TableCell>
                      <TableCell className="font-mono text-xs" data-testid={`text-emitter-cuit-${it.id}`}>{it.invoiceEmitterCuit || '—'}</TableCell>
                      <TableCell className="text-xs">{it.clientName || '—'}</TableCell>
                      <TableCell className="text-right">{formatCurrencyAR(it.invoiceNetAmount || '0', it.currency)}</TableCell>
                      <TableCell className="text-right">{formatCurrencyAR(it.invoiceIvaAmount || '0', it.currency)}</TableCell>
                      <TableCell className="text-right font-semibold">{formatCurrencyAR(it.amount, it.currency)}</TableCell>
                      <TableCell className="font-mono text-xs">{it.invoiceCae || '—'}</TableCell>
                      <TableCell>
                        <Badge variant={it.invoiceEnvironment === 'production' ? 'destructive' : 'secondary'}>
                          {it.invoiceEnvironment === 'production' ? 'Prod' : 'Pruebas'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">{it.createdVia || 'web'}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1 items-start">
                          {it.invoiceCreditNoteUuid ? (
                            <Badge variant="outline">Anulada</Badge>
                          ) : it.invoiceEmissionStatus === 'failed' ? (
                            <Badge
                              variant="destructive"
                              title={it.invoiceEmissionErrorMessage || 'No se pudo emitir. Abrí el detalle de la transacción para ver el motivo.'}
                              data-testid={`badge-emit-failed-${it.id}`}
                            >
                              Error
                            </Badge>
                          ) : (
                            <Badge>Emitida</Badge>
                          )}
                          {it.invoiceSimulated && (
                            <Badge
                              variant="outline"
                              className="border-pink-500/50 text-pink-600 dark:text-pink-400 text-[10px]"
                              data-testid={`badge-simulated-${it.id}`}
                              title="Comprobante generado en modo de pruebas — sin validez fiscal"
                            >
                              Simulada
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {it.invoiceEmailStatus === 'failed' ? (
                          <Badge
                            variant="destructive"
                            className="text-[10px] gap-1"
                            data-testid={`badge-email-failed-${it.id}`}
                            title={it.invoiceEmailLastError || 'No se pudo enviar el email'}
                          >
                            <MailWarning className="h-3 w-3" /> Email pendiente
                          </Badge>
                        ) : it.invoiceEmailStatus === 'sent' ? (
                          <Badge
                            variant="outline"
                            className="text-[10px] gap-1 border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
                            data-testid={`badge-email-sent-${it.id}`}
                            title={it.invoiceEmailLastAttemptAt ? `Enviado el ${new Date(it.invoiceEmailLastAttemptAt).toLocaleString('es-AR')}` : 'Enviado'}
                          >
                            <Mail className="h-3 w-3" /> Enviado
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {(it.invoiceUuid || it.invoicePdfUrl) && (
                            <a href={`/api/invoicing/transactions/${it.id}/pdf`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs underline" data-testid={`link-pdf-${it.id}`}>
                              PDF <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                          {(it.invoiceCreditNoteUuid || it.invoiceCreditNotePdfUrl) && (
                            <a
                              href={`/api/invoicing/transactions/${it.id}/pdf?type=creditNote`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-xs underline text-red-700"
                              data-testid={`link-pdf-nc-${it.id}`}
                              title="PDF de la Nota de Crédito que anuló esta factura"
                            >
                              PDF NC <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                          {it.invoiceEmailStatus === 'failed' && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs gap-1"
                              onClick={() => resendEmail(it)}
                              disabled={resending === it.id}
                              data-testid={`button-resend-email-${it.id}`}
                            >
                              {resending === it.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Send className="h-3 w-3" />
                              )}
                              Reenviar
                            </Button>
                          )}
                          {!it.invoiceCreditNoteUuid &&
                            it.invoiceEmissionStatus === 'emitted' &&
                            !(it.invoiceDocType || '').startsWith('NC') &&
                            !(it.invoiceDocType || '').startsWith('ND') && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs gap-1 border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800"
                                onClick={() => setCreditNoteTarget(it)}
                                data-testid={`button-cancel-invoice-${it.id}`}
                              >
                                <FileX2 className="h-3 w-3" /> Anular
                              </Button>
                            )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <CreditNoteModal
            open={!!creditNoteTarget}
            onOpenChange={(o) => { if (!o) setCreditNoteTarget(null); }}
            transaction={creditNoteTarget}
          />
        </CardContent>
      </Card>

      <TransactionWizard
        open={newInvoiceWizardOpen}
        onOpenChange={setNewInvoiceWizardOpen}
        preset={{ type: 'receivable', hasInvoice: true, emitInvoice: true, startStep: 'account' }}
        onCreated={(tx) => {
          if (tx?.type === 'receivable' && tx?.id) {
            setPendingReceivable({
              id: tx.id,
              description: tx.description,
              amount: tx.amount,
              currency: tx.currency,
            });
            setConfirmAccountId('');
          }
        }}
      />

      <Dialog
        open={!!pendingReceivable}
        onOpenChange={(o) => { if (!o && !confirmingIncome) setPendingReceivable(null); }}
      >
        <DialogContent
          data-testid="dialog-confirm-income"
          onPointerDownOutside={(e) => { if (confirmingIncome) e.preventDefault(); }}
          onInteractOutside={(e) => { if (confirmingIncome) e.preventDefault(); }}
        >
          <DialogHeader>
            <DialogTitle>¿Ya cobraste esta factura?</DialogTitle>
            <DialogDescription>
              Si querés, lo convertimos en un ingreso ahora mismo. Elegí la cuenta donde entró el dinero
              {pendingReceivable?.amount
                ? ` (${pendingReceivable.currency || 'ARS'} ${formatCurrencyAR(parseFloat(pendingReceivable.amount))})`
                : ''}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-sm">Cuenta de destino</Label>
            <Select value={confirmAccountId} onValueChange={setConfirmAccountId}>
              <SelectTrigger data-testid="select-confirm-account">
                <SelectValue placeholder="Seleccioná una cuenta" />
              </SelectTrigger>
              <SelectContent>
                {accountsList
                  .filter((a: any) => {
                    if (!pendingReceivable?.currency) return true;
                    const norm = (c: string) => (c === 'USD_CASH' ? 'USD' : c);
                    const tx = norm(pendingReceivable.currency);
                    const ac = norm(a.currency || 'ARS');
                    return tx === ac;
                  })
                  .map((a: any) => (
                    <SelectItem key={a.id} value={a.id} data-testid={`option-confirm-account-${a.id}`}>
                      {a.name} · {a.currency}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={confirmingIncome}
              onClick={() => setPendingReceivable(null)}
              data-testid="button-skip-income"
            >
              Más tarde
            </Button>
            <Button
              disabled={!confirmAccountId || confirmingIncome}
              onClick={async (e) => {
                e.preventDefault();
                if (!pendingReceivable || !confirmAccountId) return;
                setConfirmingIncome(true);
                try {
                  await fetchWithAuth(`/transactions/${pendingReceivable.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status: 'completed', accountId: confirmAccountId }),
                  });
                  toast({
                    title: 'Confirmado como ingreso',
                    description: 'La factura quedó registrada como cobrada.',
                  });
                  queryClient.invalidateQueries({ queryKey: ['/api/invoicing/invoices'] });
                  queryClient.invalidateQueries({ queryKey: ['transactions'] });
                  queryClient.invalidateQueries({ queryKey: ['accounts'] });
                  setPendingReceivable(null);
                } catch (err: any) {
                  toast({
                    title: 'No se pudo confirmar el cobro',
                    description: err?.body?.message || err?.message || 'Probá desde la página de Transacciones.',
                    variant: 'destructive',
                  });
                } finally {
                  setConfirmingIncome(false);
                }
              }}
              data-testid="button-confirm-income"
            >
              {confirmingIncome ? 'Confirmando…' : 'Sí, confirmar ingreso'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
