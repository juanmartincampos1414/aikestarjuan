import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { fetchWithAuth } from '@/lib/api';
import { FEATURE_FLAGS } from '@/lib/constants';
import { useToast } from '@/hooks/use-toast';
import { useOrganization, useIsPersonalBasic } from '@/lib/hooks';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { es } from 'date-fns/locale';
import { Download, FileSpreadsheet, FileText, Receipt, TrendingUp, TrendingDown, AlertCircle, Edit, Info, Settings } from 'lucide-react';
import { Link } from 'wouter';

const formatMoney = (n: number, currency = 'ARS') => {
  const symbol = currency === 'USD' || currency === 'USD_CASH' ? 'U$D' : '$';
  return `${symbol} ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

function escapeHtml(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface TaxRow {
  id: string;
  date: string;
  description: string;
  category: string;
  invoiceNumber: string;
  invoiceType?: string;
  counterpartyName: string;
  counterpartyCuit: string;
  currency: string;
  net: number;
  iva: number;
  ivaAliquot: number;
  otherTaxes: number;
  total: number;
  hasFiscalData: boolean;
  hasInvoice: boolean;
  invoiceFileUrl?: string | null;
  origin?: string | null;
  status?: string;
  simulated?: boolean;
  emissionAttempted?: boolean;
  emissionStatus?: string | null;
  cae?: string | null;
  emissionFailed?: boolean;
}

interface TaxResponse {
  rows: TaxRow[];
  totals: { net: number; iva: number; otherTaxes: number; total: number; count: number };
}

interface IvaAliquotRow { aliquot: number; salesNet: number; salesIva: number; purchasesNet: number; purchasesIva: number }
interface MonthlyRow { month: string; salesNet: number; salesTotal: number; salesIva: number; purchasesNet: number; purchasesTotal: number; purchasesIva: number }

interface TaxSummary {
  sales: TaxResponse['totals'];
  purchases: TaxResponse['totals'];
  ivaBalance: number;
  utility: number;
  topClients: Array<{ name: string; total: number; net: number; iva: number; count: number }>;
  topSuppliers: Array<{ name: string; total: number; net: number; iva: number; count: number }>;
  ivaByAliquot: IvaAliquotRow[];
  monthly: MonthlyRow[];
  coverage: { salesWithFiscal: number; salesTotal: number; purchasesWithFiscal: number; purchasesTotal: number };
  unemitted?: { salesCount: number; salesIva: number; purchasesCount: number; purchasesIva: number };
  profile: TaxProfileShape | null;
}

type GroupByMode = 'none' | 'month' | 'counterparty' | 'aliquot';

interface TaxProfileShape {
  ivaCondition?: string | null;
  monotributoCategory?: string | null;
  iibbInscribed?: boolean;
  iibbJurisdictions?: string | null;
  iibbAliquot?: string | null;
  gananciasInscribed?: boolean;
  gananciasNumber?: string | null;
}

export default function ImpuestosPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: organization } = useOrganization() as { data: { id?: string; type?: string } | undefined };
  const orgId = organization?.id;
  const isPersonalContext = useIsPersonalBasic();

  const today = new Date();
  const [startDate, setStartDate] = useState(format(startOfMonth(today), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(format(endOfMonth(today), 'yyyy-MM-dd'));
  const [currency, setCurrency] = useState<string>('ARS');
  const [invoiceType, setInvoiceType] = useState<string>('all');
  const [aliquot, setAliquot] = useState<string>('all');
  const [status, setStatus] = useState<string>('completed');
  const [hasAttachment, setHasAttachment] = useState<string>('all');
  const [counterpartyId, setCounterpartyId] = useState<string>('all');
  const [origin, setOrigin] = useState<string>('all');
  const [includeSimulated, setIncludeSimulated] = useState<boolean>(false);
  // Cuando está activado, las facturas con emisión electrónica fallida
  // (sin CAE y no anuladas) NO suman al IVA. Por defecto OFF para no
  // cambiar lo que el usuario ya ve, pero el aviso siempre aparece.
  const [excludeUnemitted, setExcludeUnemitted] = useState<boolean>(false);
  const [groupBy, setGroupBy] = useState<GroupByMode>('none');

  const clientsQuery = useQuery<any[]>({
    queryKey: ['/api/clients', orgId],
    queryFn: async () => await fetchWithAuth('/clients'),
    enabled: !!orgId,
  });
  const suppliersQuery = useQuery<any[]>({
    queryKey: ['/api/suppliers', orgId],
    queryFn: async () => await fetchWithAuth('/suppliers'),
    enabled: !!orgId,
  });
  const [activeTab, setActiveTab] = useState('resumen');
  const [editTx, setEditTx] = useState<TaxRow | null>(null);

  const filterParams = useMemo(() => {
    const p = new URLSearchParams();
    if (startDate) p.set('startDate', startDate);
    if (endDate) p.set('endDate', endDate);
    if (currency) p.set('currency', currency);
    if (invoiceType && invoiceType !== 'all') p.set('invoiceType', invoiceType);
    if (aliquot && aliquot !== 'all') p.set('aliquot', aliquot);
    if (status && status !== 'all') p.set('status', status);
    if (hasAttachment && hasAttachment !== 'all') p.set('hasAttachment', hasAttachment);
    if (counterpartyId && counterpartyId !== 'all') p.set('counterpartyId', counterpartyId);
    if (origin && origin !== 'all') p.set('origin', origin);
    if (includeSimulated) p.set('includeSimulated', 'true');
    if (excludeUnemitted) p.set('excludeUnemitted', 'true');
    return p.toString();
  }, [startDate, endDate, currency, invoiceType, aliquot, status, hasAttachment, counterpartyId, origin, includeSimulated, excludeUnemitted]);

  const salesQuery = useQuery<TaxResponse>({
    queryKey: ['/api/taxes/sales', filterParams, orgId],
    queryFn: async () => await fetchWithAuth(`/taxes/sales?${filterParams}`),
    enabled: !!orgId,
  });
  const purchasesQuery = useQuery<TaxResponse>({
    queryKey: ['/api/taxes/purchases', filterParams, orgId],
    queryFn: async () => await fetchWithAuth(`/taxes/purchases?${filterParams}`),
    enabled: !!orgId,
  });
  const summaryQuery = useQuery<TaxSummary>({
    queryKey: ['/api/taxes/summary', filterParams, orgId],
    queryFn: async () => await fetchWithAuth(`/taxes/summary?${filterParams}`),
    enabled: !!orgId,
  });

  const updateFiscal = useMutation({
    mutationFn: async (payload: { id: string; data: Record<string, unknown> }) => {
      return await fetchWithAuth(`/taxes/transactions/${payload.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload.data),
      });
    },
    onSuccess: () => {
      toast({ title: 'Datos fiscales actualizados' });
      queryClient.invalidateQueries({ queryKey: ['/api/taxes/sales'] });
      queryClient.invalidateQueries({ queryKey: ['/api/taxes/purchases'] });
      queryClient.invalidateQueries({ queryKey: ['/api/taxes/summary'] });
      setEditTx(null);
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const downloadFile = (kind: 'sales' | 'purchases' | 'summary', ext: 'csv' | 'xlsx') => {
    const url = `/api/taxes/${kind}.${ext}?${filterParams}`;
    const a = document.createElement('a');
    a.href = url;
    a.click();
  };
  const downloadCsv = (kind: 'sales' | 'purchases' | 'summary') => downloadFile(kind, 'csv');
  const downloadXlsx = (kind: 'sales' | 'purchases' | 'summary') => downloadFile(kind, 'xlsx');

  const printPdf = (title: string, rows: TaxRow[], showFiscal = true) => {
    const w = window.open('', '_blank');
    if (!w) return;
    const headers = showFiscal
      ? ['Fecha', 'N° Comprobante', 'Razón Social / CUIT', 'Descripción', 'Neto', 'Alícuota IVA', 'IVA', 'Otros', 'Total']
      : ['Fecha', 'N° Comprobante', 'Razón Social / CUIT', 'Descripción', 'Total'];
    const body = rows.map(r => {
      const cpName = escapeHtml(r.counterpartyName || '-');
      const cpCuit = r.counterpartyCuit ? `<br/><small>${escapeHtml(r.counterpartyCuit)}</small>` : '';
      const simBadge = r.simulated ? ' <span style="background:#fef3c7;color:#92400e;padding:1px 4px;border-radius:3px;font-size:9px;">SIMULADA</span>' : '';
      const cells = showFiscal
        ? [
            escapeHtml(format(new Date(r.date), 'dd/MM/yyyy')),
            escapeHtml(r.invoiceNumber || '-') + simBadge,
            cpName + cpCuit,
            escapeHtml(r.description),
            escapeHtml(formatMoney(r.net, r.currency)),
            escapeHtml(r.ivaAliquot ? `${r.ivaAliquot}%` : '-'),
            escapeHtml(formatMoney(r.iva, r.currency)),
            escapeHtml(formatMoney(r.otherTaxes, r.currency)),
            escapeHtml(formatMoney(r.total, r.currency)),
          ]
        : [
            escapeHtml(format(new Date(r.date), 'dd/MM/yyyy')),
            escapeHtml(r.invoiceNumber || '-'),
            cpName + cpCuit,
            escapeHtml(r.description),
            escapeHtml(formatMoney(r.total, r.currency)),
          ];
      const rowStyle = r.simulated ? ' style="background:#fffbeb;"' : '';
      return `<tr${rowStyle}>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
    }).join('');
    w.document.write(`
      <!DOCTYPE html><html><head><title>${escapeHtml(title)}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 30px; color: #111; }
        h1 { color: #00b8d4; font-size: 22px; margin: 0 0 4px; }
        .meta { color: #555; font-size: 12px; margin-bottom: 18px; }
        table { width: 100%; border-collapse: collapse; font-size: 11px; }
        th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; vertical-align: top; }
        th { background: #f0f9ff; }
        tr:nth-child(even) td { background: #fafafa; }
        .footer { margin-top: 24px; font-size: 10px; color: #888; }
      </style></head><body>
      <h1>${title}</h1>
      <div class="meta">Período: ${startDate} a ${endDate} · Moneda: ${currency} · ${rows.length} comprobantes</div>
      <table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>
      <div class="footer">Aikestar — Información tributaria. Documento informativo, no apto para presentación oficial.</div>
      </body></html>
    `);
    w.document.close();
    setTimeout(() => w.print(), 200);
  };

  const taxProfile = summaryQuery.data?.profile;

  if (isPersonalContext) {
    return (
      <div className="w-full p-4 md:p-6" data-testid="page-impuestos-personal-blocked">
        <Alert>
          <Info className="w-4 h-4" />
          <AlertTitle>Esta sección no está disponible en cuentas personales</AlertTitle>
          <AlertDescription>
            La sección de Impuestos sólo aplica a organizaciones tipo Empresa, donde se gestionan clientes, proveedores y facturación electrónica. Si necesitás esta funcionalidad, creá o cambiá a una organización Empresa desde el selector de organización.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="w-full p-4 md:p-6 space-y-6" data-testid="page-impuestos">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight bg-gradient-to-r from-cyan-400 to-pink-500 bg-clip-text text-transparent">
            Impuestos
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Vista informativa de IVA, Ingresos Brutos y otros tributos según tus comprobantes.
          </p>
        </div>
        <div className="flex gap-2">
          {FEATURE_FLAGS.INVOICING_ENABLED && (
            <Link href="/settings?tab=taxes">
              <Button variant="outline" size="sm" data-testid="button-go-tax-settings">
                <Settings className="w-4 h-4 mr-1" /> Condiciones impositivas
              </Button>
            </Link>
          )}
        </div>
      </div>

      {includeSimulated && (
        <Alert variant="destructive" data-testid="alert-simulated-included">
          <AlertCircle className="w-4 h-4" />
          <AlertTitle>Incluyendo comprobantes simulados</AlertTitle>
          <AlertDescription>
            Los totales y exportaciones incluyen facturas simuladas (modo prueba interno). Estos comprobantes no tienen validez fiscal y no deben presentarse ante AFIP/ARCA.
          </AlertDescription>
        </Alert>
      )}

      {FEATURE_FLAGS.INVOICING_ENABLED && !taxProfile && (
        <Alert data-testid="alert-no-tax-profile">
          <Info className="w-4 h-4" />
          <AlertTitle>Configurá tus condiciones impositivas</AlertTitle>
          <AlertDescription>
            Definí tu condición de IVA, Ingresos Brutos y Ganancias para enriquecer este reporte.{' '}
            <Link href="/settings?tab=taxes" className="underline text-cyan-500">Ir a configuración →</Link>
          </AlertDescription>
        </Alert>
      )}

      {/* Filtros */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <Label htmlFor="start-date">Desde</Label>
              <Input id="start-date" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} data-testid="input-start-date" />
            </div>
            <div>
              <Label htmlFor="end-date">Hasta</Label>
              <Input id="end-date" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} data-testid="input-end-date" />
            </div>
            <div>
              <Label htmlFor="currency">Moneda</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger id="currency" data-testid="select-currency"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ARS">Pesos (ARS)</SelectItem>
                  <SelectItem value="USD">Dólares (USD)</SelectItem>
                  <SelectItem value="USD_CASH">USD Efectivo</SelectItem>
                  <SelectItem value="EUR">Euros (EUR)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="invoice-type">Tipo comprobante</Label>
              <Select value={invoiceType} onValueChange={setInvoiceType}>
                <SelectTrigger id="invoice-type" data-testid="select-invoice-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="A">Factura A</SelectItem>
                  <SelectItem value="B">Factura B</SelectItem>
                  <SelectItem value="C">Factura C</SelectItem>
                  <SelectItem value="E">Factura E</SelectItem>
                  <SelectItem value="M">Factura M</SelectItem>
                  <SelectItem value="ND">Nota Débito</SelectItem>
                  <SelectItem value="NC">Nota Crédito</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="aliquot-filter">Alícuota IVA</Label>
              <Select value={aliquot} onValueChange={setAliquot}>
                <SelectTrigger id="aliquot-filter" data-testid="select-aliquot-filter"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas</SelectItem>
                  <SelectItem value="0">0% (Exento)</SelectItem>
                  <SelectItem value="2.5">2.5%</SelectItem>
                  <SelectItem value="5">5%</SelectItem>
                  <SelectItem value="10.5">10.5%</SelectItem>
                  <SelectItem value="21">21%</SelectItem>
                  <SelectItem value="27">27%</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="status-filter">Estado</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="status-filter" data-testid="select-status-filter"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="completed">Completados</SelectItem>
                  <SelectItem value="scheduled">Programados</SelectItem>
                  <SelectItem value="cancelled">Cancelados</SelectItem>
                  <SelectItem value="all">Todos</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="attachment-filter">Adjunto</Label>
              <Select value={hasAttachment} onValueChange={setHasAttachment}>
                <SelectTrigger id="attachment-filter" data-testid="select-attachment-filter"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="with">Con adjunto</SelectItem>
                  <SelectItem value="without">Sin adjunto</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="counterparty-filter">{activeTab === 'compras' ? 'Proveedor' : 'Cliente'}</Label>
              <Select value={counterpartyId} onValueChange={setCounterpartyId}>
                <SelectTrigger id="counterparty-filter" data-testid="select-counterparty-filter"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {(activeTab === 'compras' ? (suppliersQuery.data || []) : (clientsQuery.data || [])).map((c: { id: string; name?: string; businessName?: string }) => (
                    <SelectItem key={c.id} value={c.id}>{c.name || c.businessName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="include-simulated">Comprobantes simulados</Label>
              <div className="flex items-center gap-2 min-h-10 py-2 px-3 border rounded-md" data-testid="container-include-simulated">
                <input
                  id="include-simulated"
                  type="checkbox"
                  className="flex-shrink-0"
                  checked={includeSimulated}
                  onChange={e => setIncludeSimulated(e.target.checked)}
                  data-testid="checkbox-include-simulated"
                />
                <Label htmlFor="include-simulated" className="text-xs cursor-pointer m-0 leading-tight break-words min-w-0 flex-1">
                  Incluir simulados
                </Label>
              </div>
            </div>
            <div>
              <Label htmlFor="exclude-unemitted">Emisión electrónica</Label>
              <div className="flex items-center gap-2 min-h-10 py-2 px-3 border rounded-md" data-testid="container-exclude-unemitted">
                <input
                  id="exclude-unemitted"
                  type="checkbox"
                  className="flex-shrink-0"
                  checked={excludeUnemitted}
                  onChange={e => setExcludeUnemitted(e.target.checked)}
                  data-testid="checkbox-exclude-unemitted"
                />
                <Label htmlFor="exclude-unemitted" className="text-xs cursor-pointer m-0 leading-tight break-words min-w-0 flex-1">
                  Excluir sin CAE
                </Label>
              </div>
            </div>
            <div>
              <Label htmlFor="origin-filter">Origen</Label>
              <Select value={origin} onValueChange={setOrigin}>
                <SelectTrigger id="origin-filter" data-testid="select-origin-filter"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="web">Web</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                  <SelectItem value="api">API</SelectItem>
                  <SelectItem value="recurring">Recurrente</SelectItem>
                  <SelectItem value="auto_apply">Auto aplicado</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-2 flex-wrap">
              <Button variant="outline" size="sm" onClick={() => { setStartDate(format(startOfMonth(today), 'yyyy-MM-dd')); setEndDate(format(endOfMonth(today), 'yyyy-MM-dd')); }} data-testid="button-period-month">
                Este mes
              </Button>
              <Button variant="outline" size="sm" onClick={() => { setStartDate(format(new Date(today.getFullYear(), 0, 1), 'yyyy-MM-dd')); setEndDate(format(new Date(today.getFullYear(), 11, 31), 'yyyy-MM-dd')); }} data-testid="button-period-year">
                Este año
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="resumen" data-testid="tab-resumen">Resumen</TabsTrigger>
          <TabsTrigger value="ventas" data-testid="tab-ventas">Ventas</TabsTrigger>
          <TabsTrigger value="compras" data-testid="tab-compras">Compras</TabsTrigger>
        </TabsList>

        {/* RESUMEN */}
        <TabsContent value="resumen" className="space-y-4 mt-4">
          {summaryQuery.isLoading ? (
            <div className="text-center py-8 text-muted-foreground">Cargando…</div>
          ) : summaryQuery.isError ? (
            <Alert variant="destructive" data-testid="alert-summary-error">
              <AlertCircle className="w-4 h-4" />
              <AlertTitle>No pudimos cargar el resumen</AlertTitle>
              <AlertDescription>{(summaryQuery.error as Error | null)?.message || 'Reintentá en unos segundos.'}</AlertDescription>
            </Alert>
          ) : summaryQuery.data ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <Card data-testid="card-utility-summary">
                  <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Receipt className="w-4 h-4 text-cyan-500" /> Utilidad estimada</CardTitle></CardHeader>
                  <CardContent>
                    <div className={`text-2xl font-bold ${summaryQuery.data.utility >= 0 ? 'text-cyan-500' : 'text-pink-500'}`} data-testid="text-utility">
                      {formatMoney(summaryQuery.data.utility, currency)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">Total Ventas − Total Compras</div>
                    {taxProfile?.gananciasInscribed && summaryQuery.data.utility > 0 && (
                      <div className="text-xs text-muted-foreground mt-2">
                        Ganancias estimada (35%): <b className="text-pink-500" data-testid="text-ganancias-estimate">{formatMoney(summaryQuery.data.utility * 0.35, currency)}</b>
                      </div>
                    )}
                  </CardContent>
                </Card>
                <Card data-testid="card-sales-summary">
                  <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><TrendingUp className="w-4 h-4 text-cyan-500" /> Ventas (Débito Fiscal)</CardTitle></CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold" data-testid="text-sales-iva">{formatMoney(summaryQuery.data.sales.iva, currency)}</div>
                    <div className="text-xs text-muted-foreground mt-1">IVA cobrado en ventas</div>
                    <div className="text-xs text-muted-foreground mt-2">
                      Neto: {formatMoney(summaryQuery.data.sales.net, currency)} · Total: {formatMoney(summaryQuery.data.sales.total, currency)}
                    </div>
                    <div className="text-xs text-muted-foreground">{summaryQuery.data.sales.count} comprobantes</div>
                  </CardContent>
                </Card>
                <Card data-testid="card-purchases-summary">
                  <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><TrendingDown className="w-4 h-4 text-pink-500" /> Compras (Crédito Fiscal)</CardTitle></CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold" data-testid="text-purchases-iva">{formatMoney(summaryQuery.data.purchases.iva, currency)}</div>
                    <div className="text-xs text-muted-foreground mt-1">IVA pagado en compras</div>
                    <div className="text-xs text-muted-foreground mt-2">
                      Neto: {formatMoney(summaryQuery.data.purchases.net, currency)} · Total: {formatMoney(summaryQuery.data.purchases.total, currency)}
                    </div>
                    <div className="text-xs text-muted-foreground">{summaryQuery.data.purchases.count} comprobantes</div>
                  </CardContent>
                </Card>
                <Card data-testid="card-iva-balance">
                  <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Receipt className="w-4 h-4" /> Saldo IVA</CardTitle></CardHeader>
                  <CardContent>
                    <div className={`text-2xl font-bold ${summaryQuery.data.ivaBalance >= 0 ? 'text-pink-500' : 'text-cyan-500'}`} data-testid="text-iva-balance">
                      {formatMoney(Math.abs(summaryQuery.data.ivaBalance), currency)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {summaryQuery.data.ivaBalance >= 0 ? 'A pagar a AFIP/ARCA' : 'Saldo a favor'}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Aviso de facturas con IVA cargado pero emisión electrónica
                  fallida (intento de emitir por Facturita/ARCA y no quedó CAE
                  ni fue anulada). El IVA de esas facturas no debería computar
                  hasta reemitirlas o anularlas con NC. */}
              {summaryQuery.data.unemitted &&
                (summaryQuery.data.unemitted.salesCount + summaryQuery.data.unemitted.purchasesCount) > 0 && (
                <Alert variant="destructive" data-testid="alert-unemitted-invoices">
                  <AlertCircle className="w-4 h-4" />
                  <AlertTitle>Facturas con IVA pero sin emisión válida</AlertTitle>
                  <AlertDescription>
                    Detectamos movimientos con IVA cargado cuya factura electrónica no se emitió
                    correctamente (sin CAE de AFIP/ARCA y sin nota de crédito).
                    {' '}
                    {summaryQuery.data.unemitted.salesCount > 0 && (
                      <>
                        <b data-testid="text-unemitted-sales-count">{summaryQuery.data.unemitted.salesCount}</b>
                        {' venta(s) '}
                        (IVA Débito {formatMoney(summaryQuery.data.unemitted.salesIva, currency)})
                        {summaryQuery.data.unemitted.purchasesCount > 0 ? '. ' : '. '}
                      </>
                    )}
                    {summaryQuery.data.unemitted.purchasesCount > 0 && (
                      <>
                        <b data-testid="text-unemitted-purchases-count">{summaryQuery.data.unemitted.purchasesCount}</b>
                        {' compra(s) '}
                        (IVA Crédito {formatMoney(summaryQuery.data.unemitted.purchasesIva, currency)}).{' '}
                      </>
                    )}
                    Reemití la factura desde el movimiento o anulala con una nota de crédito.
                    Activá <b>"Excluir facturas sin CAE"</b> en los filtros para sacarlas del cálculo del saldo IVA.
                  </AlertDescription>
                </Alert>
              )}

              {/* Coverage warning */}
              {(summaryQuery.data.coverage.salesTotal > 0 || summaryQuery.data.coverage.purchasesTotal > 0) && (
                <Alert data-testid="alert-coverage">
                  <AlertCircle className="w-4 h-4" />
                  <AlertTitle>Cobertura de datos fiscales</AlertTitle>
                  <AlertDescription>
                    Ventas con datos fiscales: <b>{summaryQuery.data.coverage.salesWithFiscal}/{summaryQuery.data.coverage.salesTotal}</b> ·{' '}
                    Compras con datos fiscales: <b>{summaryQuery.data.coverage.purchasesWithFiscal}/{summaryQuery.data.coverage.purchasesTotal}</b>.
                    Los movimientos sin neto/IVA no aportan al cálculo de IVA. Editalos desde las pestañas Ventas o Compras, o cargá los datos al registrar el movimiento.
                  </AlertDescription>
                </Alert>
              )}

              {/* IVA por alícuota */}
              {summaryQuery.data.ivaByAliquot.length > 0 && (
                <Card data-testid="card-iva-by-aliquot">
                  <CardHeader><CardTitle className="text-base">IVA discriminado por alícuota</CardTitle></CardHeader>
                  <CardContent className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Alícuota</TableHead>
                          <TableHead className="text-right">Ventas Neto</TableHead>
                          <TableHead className="text-right">IVA Débito</TableHead>
                          <TableHead className="text-right">Compras Neto</TableHead>
                          <TableHead className="text-right">IVA Crédito</TableHead>
                          <TableHead className="text-right">Saldo IVA</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {summaryQuery.data.ivaByAliquot.map((r, i) => (
                          <TableRow key={i} data-testid={`row-aliquot-${r.aliquot}`}>
                            <TableCell><Badge variant="outline">{r.aliquot}%</Badge></TableCell>
                            <TableCell className="text-right">{formatMoney(r.salesNet, currency)}</TableCell>
                            <TableCell className="text-right text-cyan-500">{formatMoney(r.salesIva, currency)}</TableCell>
                            <TableCell className="text-right">{formatMoney(r.purchasesNet, currency)}</TableCell>
                            <TableCell className="text-right text-pink-500">{formatMoney(r.purchasesIva, currency)}</TableCell>
                            <TableCell className="text-right font-medium">{formatMoney(r.salesIva - r.purchasesIva, currency)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}

              {/* Comparativa mensual */}
              {summaryQuery.data.monthly.length > 0 && (
                <Card data-testid="card-monthly-comparison">
                  <CardHeader><CardTitle className="text-base">Comparativa mensual</CardTitle><CardDescription>Ventas vs Compras (neto)</CardDescription></CardHeader>
                  <CardContent>
                    <MonthlyBars data={summaryQuery.data.monthly} currency={currency} />
                  </CardContent>
                </Card>
              )}

              {/* Tax profile resumen */}
              {taxProfile && (
                <Card>
                  <CardHeader><CardTitle className="text-base">Tu condición fiscal</CardTitle></CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                      <div><span className="text-muted-foreground">IVA:</span> <b>{taxProfile.ivaCondition || 'No definido'}</b>{taxProfile.monotributoCategory ? ` (Cat. ${taxProfile.monotributoCategory})` : ''}</div>
                      <div><span className="text-muted-foreground">Ingresos Brutos:</span> <b>{taxProfile.iibbInscribed ? `Inscripto${taxProfile.iibbAliquot ? ` (${taxProfile.iibbAliquot}%)` : ''}` : 'No inscripto'}</b></div>
                      <div><span className="text-muted-foreground">Ganancias:</span> <b>{taxProfile.gananciasInscribed ? 'Inscripto' : 'No inscripto'}</b></div>
                    </div>
                    {taxProfile.iibbInscribed && taxProfile.iibbAliquot && (
                      <div className="mt-3 pt-3 border-t text-sm">
                        <span className="text-muted-foreground">IIBB estimado sobre ventas netas: </span>
                        <b className="text-pink-500" data-testid="text-iibb-estimate">{formatMoney((summaryQuery.data.sales.net * Number(taxProfile.iibbAliquot)) / 100, currency)}</b>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card>
                  <CardHeader><CardTitle className="text-base">Top 5 clientes</CardTitle></CardHeader>
                  <CardContent>
                    {summaryQuery.data.topClients.length === 0 ? <div className="text-sm text-muted-foreground">Sin datos</div> : (
                      <div className="space-y-2">
                        {summaryQuery.data.topClients.map((c, i) => (
                          <div key={i} className="flex justify-between text-sm" data-testid={`row-top-client-${i}`}>
                            <span className="truncate">{c.name}</span>
                            <span className="font-medium">{formatMoney(c.total, currency)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle className="text-base">Top 5 proveedores</CardTitle></CardHeader>
                  <CardContent>
                    {summaryQuery.data.topSuppliers.length === 0 ? <div className="text-sm text-muted-foreground">Sin datos</div> : (
                      <div className="space-y-2">
                        {summaryQuery.data.topSuppliers.map((c, i) => (
                          <div key={i} className="flex justify-between text-sm" data-testid={`row-top-supplier-${i}`}>
                            <span className="truncate">{c.name}</span>
                            <span className="font-medium">{formatMoney(c.total, currency)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button onClick={() => downloadXlsx('summary')} variant="outline" size="sm" data-testid="button-export-summary-xlsx">
                  <FileSpreadsheet className="w-4 h-4 mr-1" /> Excel completo (xlsx)
                </Button>
                <Button onClick={() => downloadCsv('summary')} variant="outline" size="sm" data-testid="button-export-summary-csv">
                  <FileSpreadsheet className="w-4 h-4 mr-1" /> CSV
                </Button>
                <Button
                  onClick={() => printResumenPdf(summaryQuery.data!, currency, startDate, endDate, taxProfile, organization)}
                  variant="outline" size="sm" data-testid="button-print-summary"
                >
                  <FileText className="w-4 h-4 mr-1" /> Imprimir / PDF
                </Button>
              </div>
            </>
          ) : null}
        </TabsContent>

        {/* VENTAS */}
        <TabsContent value="ventas" className="space-y-4 mt-4">
          <div className="flex flex-wrap gap-2 justify-between items-center">
            <div className="text-sm text-muted-foreground">
              {salesQuery.data ? `${salesQuery.data.totals.count} comprobantes · Neto ${formatMoney(salesQuery.data.totals.net, currency)} · IVA ${formatMoney(salesQuery.data.totals.iva, currency)} · Total ${formatMoney(salesQuery.data.totals.total, currency)}` : ''}
            </div>
            <div className="flex gap-2 items-center">
              <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupByMode)}>
                <SelectTrigger className="w-[170px] h-9" data-testid="select-group-by-sales"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sin agrupar</SelectItem>
                  <SelectItem value="month">Por mes</SelectItem>
                  <SelectItem value="counterparty">Por cliente</SelectItem>
                  <SelectItem value="aliquot">Por alícuota</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={() => downloadXlsx('sales')} data-testid="button-export-sales-xlsx">
                <FileSpreadsheet className="w-4 h-4 mr-1" /> Excel
              </Button>
              <Button variant="outline" size="sm" onClick={() => downloadCsv('sales')} data-testid="button-export-sales-csv">
                <Download className="w-4 h-4 mr-1" /> CSV
              </Button>
              <Button variant="outline" size="sm" onClick={() => salesQuery.data && printPdf('Libro IVA Ventas', salesQuery.data.rows)} data-testid="button-print-sales">
                <FileText className="w-4 h-4 mr-1" /> PDF
              </Button>
            </div>
          </div>
          {groupBy === 'none' ? (
            <TaxRowsTable rows={salesQuery.data?.rows || []} loading={salesQuery.isLoading} kind="ventas" onEdit={setEditTx} currency={currency} />
          ) : (
            <GroupedTable rows={salesQuery.data?.rows || []} groupBy={groupBy} kind="ventas" currency={currency} />
          )}
        </TabsContent>

        {/* COMPRAS */}
        <TabsContent value="compras" className="space-y-4 mt-4">
          <div className="flex flex-wrap gap-2 justify-between items-center">
            <div className="text-sm text-muted-foreground">
              {purchasesQuery.data ? `${purchasesQuery.data.totals.count} comprobantes · Neto ${formatMoney(purchasesQuery.data.totals.net, currency)} · IVA ${formatMoney(purchasesQuery.data.totals.iva, currency)} · Total ${formatMoney(purchasesQuery.data.totals.total, currency)}` : ''}
            </div>
            <div className="flex gap-2 items-center">
              <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupByMode)}>
                <SelectTrigger className="w-[170px] h-9" data-testid="select-group-by-purchases"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sin agrupar</SelectItem>
                  <SelectItem value="month">Por mes</SelectItem>
                  <SelectItem value="counterparty">Por proveedor</SelectItem>
                  <SelectItem value="aliquot">Por alícuota</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={() => downloadXlsx('purchases')} data-testid="button-export-purchases-xlsx">
                <FileSpreadsheet className="w-4 h-4 mr-1" /> Excel
              </Button>
              <Button variant="outline" size="sm" onClick={() => downloadCsv('purchases')} data-testid="button-export-purchases-csv">
                <Download className="w-4 h-4 mr-1" /> CSV
              </Button>
              <Button variant="outline" size="sm" onClick={() => purchasesQuery.data && printPdf('Libro IVA Compras', purchasesQuery.data.rows)} data-testid="button-print-purchases">
                <FileText className="w-4 h-4 mr-1" /> PDF
              </Button>
            </div>
          </div>
          {groupBy === 'none' ? (
            <TaxRowsTable rows={purchasesQuery.data?.rows || []} loading={purchasesQuery.isLoading} kind="compras" onEdit={setEditTx} currency={currency} />
          ) : (
            <GroupedTable rows={purchasesQuery.data?.rows || []} groupBy={groupBy} kind="compras" currency={currency} />
          )}
        </TabsContent>
      </Tabs>

      {/* Modal edición fiscal */}
      <Dialog open={!!editTx} onOpenChange={(o) => !o && setEditTx(null)}>
        <DialogContent data-testid="dialog-edit-fiscal">
          <DialogHeader>
            <DialogTitle>Editar datos fiscales</DialogTitle>
            <DialogDescription>{editTx?.description}</DialogDescription>
          </DialogHeader>
          {editTx && <FiscalForm tx={editTx} onSave={(data) => updateFiscal.mutate({ id: editTx.id, data })} saving={updateFiscal.isPending} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TaxRowsTable({ rows, loading, kind, onEdit, currency }: { rows: TaxRow[]; loading: boolean; kind: 'ventas' | 'compras'; onEdit: (r: TaxRow) => void; currency: string }) {
  if (loading) return <div className="text-center py-8 text-muted-foreground">Cargando…</div>;
  if (rows.length === 0) return <div className="text-center py-8 text-muted-foreground">No hay {kind} con factura en el período seleccionado.</div>;
  return (
    <Card>
      <CardContent className="p-0 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fecha</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Comprobante</TableHead>
              <TableHead>{kind === 'ventas' ? 'Cliente' : 'Proveedor'}</TableHead>
              <TableHead className="text-right">Neto</TableHead>
              <TableHead className="text-right">IVA</TableHead>
              <TableHead className="text-right">Otros</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-center">Estado</TableHead>
              <TableHead className="text-center">Datos fisc.</TableHead>
              <TableHead className="text-center">Origen</TableHead>
              <TableHead className="text-center">Adj.</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(r => (
              <TableRow key={r.id} data-testid={`row-${kind}-${r.id}`}>
                <TableCell className="whitespace-nowrap text-xs">{format(new Date(r.date), 'dd/MM/yy')}</TableCell>
                <TableCell className="text-xs">{r.invoiceType ? <Badge variant="outline" className="text-xs">{r.invoiceType}</Badge> : <span className="text-muted-foreground">-</span>}</TableCell>
                <TableCell className="text-xs">
                  <div className="flex items-center gap-1 flex-wrap">
                    <span>{r.invoiceNumber || <span className="text-muted-foreground">-</span>}</span>
                    {r.simulated && (
                      <Badge
                        variant="outline"
                        className="text-[10px] bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-950 dark:text-amber-300"
                        title="Comprobante simulado, no tiene validez fiscal"
                        data-testid={`badge-simulated-${r.id}`}
                      >
                        Simulada
                      </Badge>
                    )}
                    {r.emissionFailed && (
                      <Badge
                        variant="outline"
                        className="text-[10px] bg-rose-50 text-rose-700 border-rose-300 dark:bg-rose-950 dark:text-rose-300"
                        title="La factura electrónica no se emitió correctamente (sin CAE). El IVA no debería computar hasta reemitirla o anularla."
                        data-testid={`badge-unemitted-${r.id}`}
                      >
                        Sin CAE
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-xs">
                  <div>{r.counterpartyName || <span className="text-muted-foreground">-</span>}</div>
                  {r.counterpartyCuit && <div className="text-muted-foreground">{r.counterpartyCuit}</div>}
                  <div className="text-muted-foreground truncate max-w-[200px]">{r.description}</div>
                </TableCell>
                <TableCell className="text-right text-xs">{r.net > 0 ? formatMoney(r.net, r.currency) : '-'}</TableCell>
                <TableCell className="text-right text-xs">
                  {r.iva > 0 ? <>{formatMoney(r.iva, r.currency)}{r.ivaAliquot ? ` (${r.ivaAliquot}%)` : ''}</> : '-'}
                </TableCell>
                <TableCell className="text-right text-xs">{r.otherTaxes > 0 ? formatMoney(r.otherTaxes, r.currency) : '-'}</TableCell>
                <TableCell className="text-right text-xs font-medium">{formatMoney(r.total, r.currency)}</TableCell>
                <TableCell className="text-center">
                  <Badge variant={r.status === 'completed' ? 'default' : r.status === 'cancelled' ? 'destructive' : 'secondary'} className="text-xs">
                    {r.status === 'completed' ? 'Completado' : r.status === 'cancelled' ? 'Cancelado' : r.status === 'scheduled' ? 'Programado' : r.status || '-'}
                  </Badge>
                </TableCell>
                <TableCell className="text-center">
                  {r.hasFiscalData ? <Badge variant="outline" className="text-xs">OK</Badge> : <Badge variant="secondary" className="text-xs">Sin datos</Badge>}
                </TableCell>
                <TableCell className="text-center text-xs">
                  {r.origin ? <Badge variant="outline" className="text-xs capitalize">{r.origin}</Badge> : <span className="text-muted-foreground">-</span>}
                </TableCell>
                <TableCell className="text-center">
                  {r.invoiceFileUrl ? (
                    <a href={r.invoiceFileUrl} target="_blank" rel="noreferrer" data-testid={`link-attachment-${r.id}`}>
                      <Badge variant="outline" className="text-xs">Ver</Badge>
                    </a>
                  ) : <span className="text-muted-foreground text-xs">-</span>}
                </TableCell>
                <TableCell className="flex gap-1">
                  <Button size="icon" variant="ghost" onClick={() => onEdit(r)} data-testid={`button-edit-fiscal-${r.id}`} title="Editar fiscal">
                    <Edit className="w-3.5 h-3.5" />
                  </Button>
                  <Link href={`/transactions?id=${r.id}`}>
                    <Button size="icon" variant="ghost" data-testid={`button-open-tx-${r.id}`} title="Ver movimiento">
                      <Receipt className="w-3.5 h-3.5" />
                    </Button>
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function FiscalForm({ tx, onSave, saving }: { tx: TaxRow; onSave: (data: Record<string, unknown>) => void; saving: boolean }) {
  const [invoiceNumber, setInvoiceNumber] = useState(tx.invoiceNumber || '');
  const [net, setNet] = useState<string>(tx.net ? String(tx.net) : '');
  const [aliquot, setAliquot] = useState<string>(tx.ivaAliquot ? String(tx.ivaAliquot) : '21');
  const [iva, setIva] = useState<string>(tx.iva ? String(tx.iva) : '');
  const [other, setOther] = useState<string>(tx.otherTaxes ? String(tx.otherTaxes) : '');
  const [autoIva, setAutoIva] = useState(true);

  const computedIva = useMemo(() => {
    const n = parseFloat(net);
    const a = parseFloat(aliquot);
    if (!isFinite(n) || !isFinite(a)) return '';
    return (n * a / 100).toFixed(2);
  }, [net, aliquot]);

  const finalIva = autoIva && computedIva ? computedIva : iva;
  const totalCheck = (parseFloat(net) || 0) + (parseFloat(finalIva) || 0) + (parseFloat(other) || 0);

  return (
    <div className="space-y-3">
      <div>
        <Label>N° Comprobante</Label>
        <Input value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} placeholder="Ej: 0001-00000123" data-testid="input-fiscal-invoice" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Neto gravado</Label>
          <Input type="number" step="0.01" value={net} onChange={e => setNet(e.target.value)} data-testid="input-fiscal-net" />
        </div>
        <div>
          <Label>Alícuota IVA (%)</Label>
          <Select value={aliquot} onValueChange={setAliquot}>
            <SelectTrigger data-testid="select-fiscal-aliquot"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="0">0% (Exento)</SelectItem>
              <SelectItem value="2.5">2.5%</SelectItem>
              <SelectItem value="5">5%</SelectItem>
              <SelectItem value="10.5">10.5%</SelectItem>
              <SelectItem value="21">21%</SelectItem>
              <SelectItem value="27">27%</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="flex items-center gap-2">
            IVA
            <input type="checkbox" checked={autoIva} onChange={e => setAutoIva(e.target.checked)} className="ml-auto" />
            <span className="text-xs text-muted-foreground">Auto</span>
          </Label>
          <Input type="number" step="0.01" value={autoIva ? computedIva : iva} onChange={e => setIva(e.target.value)} disabled={autoIva} data-testid="input-fiscal-iva" />
        </div>
        <div>
          <Label>Otros impuestos</Label>
          <Input type="number" step="0.01" value={other} onChange={e => setOther(e.target.value)} data-testid="input-fiscal-other" />
        </div>
      </div>
      <div className="text-xs p-3 rounded bg-muted">
        <div>Total calculado: <b>{totalCheck.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</b></div>
        <div>Total del movimiento: <b>{tx.total.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</b></div>
        {Math.abs(totalCheck - tx.total) > 0.5 && (
          <div className="text-yellow-600 mt-1">⚠ El total calculado no coincide con el total del movimiento.</div>
        )}
      </div>
      <DialogFooter>
        <Button onClick={() => onSave({
          invoiceNumber: invoiceNumber || null,
          invoiceNetAmount: net || null,
          invoiceIvaAmount: (autoIva ? computedIva : iva) || null,
          invoiceIvaAliquot: aliquot || null,
          invoiceOtherTaxes: other || null,
        })} disabled={saving} data-testid="button-save-fiscal">
          {saving ? 'Guardando…' : 'Guardar'}
        </Button>
      </DialogFooter>
    </div>
  );
}

function GroupedTable({ rows, groupBy, kind, currency }: { rows: TaxRow[]; groupBy: 'month' | 'counterparty' | 'aliquot'; kind: 'ventas' | 'compras'; currency: string }) {
  if (rows.length === 0) return <div className="text-center py-8 text-muted-foreground">No hay {kind} con factura en el período.</div>;
  const map = new Map<string, { key: string; count: number; net: number; iva: number; otherTaxes: number; total: number }>();
  for (const r of rows) {
    let k: string;
    if (groupBy === 'month') {
      const d = new Date(r.date);
      k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    } else if (groupBy === 'counterparty') {
      k = r.counterpartyName || 'Sin identificar';
    } else {
      k = `${r.ivaAliquot || 0}%`;
    }
    const cur = map.get(k) || { key: k, count: 0, net: 0, iva: 0, otherTaxes: 0, total: 0 };
    cur.count += 1;
    cur.net += r.net;
    cur.iva += r.iva;
    cur.otherTaxes += r.otherTaxes;
    cur.total += r.total;
    map.set(k, cur);
  }
  const groups = Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
  const label = groupBy === 'month' ? 'Mes' : groupBy === 'counterparty' ? (kind === 'ventas' ? 'Cliente' : 'Proveedor') : 'Alícuota';
  return (
    <Card>
      <CardContent className="p-0 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{label}</TableHead>
              <TableHead className="text-right">Comprob.</TableHead>
              <TableHead className="text-right">Neto</TableHead>
              <TableHead className="text-right">IVA</TableHead>
              <TableHead className="text-right">Otros</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map(g => (
              <TableRow key={g.key} data-testid={`row-group-${kind}-${g.key}`}>
                <TableCell className="font-medium">{g.key}</TableCell>
                <TableCell className="text-right">{g.count}</TableCell>
                <TableCell className="text-right">{formatMoney(g.net, currency)}</TableCell>
                <TableCell className="text-right">{formatMoney(g.iva, currency)}</TableCell>
                <TableCell className="text-right">{formatMoney(g.otherTaxes, currency)}</TableCell>
                <TableCell className="text-right font-medium">{formatMoney(g.total, currency)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function MonthlyBars({ data, currency }: { data: MonthlyRow[]; currency: string }) {
  const max = Math.max(1, ...data.flatMap(d => [d.salesNet, d.purchasesNet]));
  return (
    <div className="space-y-3" data-testid="chart-monthly">
      {data.map(d => {
        const sPct = (d.salesNet / max) * 100;
        const pPct = (d.purchasesNet / max) * 100;
        return (
          <div key={d.month} className="space-y-1" data-testid={`bar-month-${d.month}`}>
            <div className="flex justify-between text-xs">
              <span className="font-medium">{d.month}</span>
              <span className="text-muted-foreground">V {formatMoney(d.salesNet, currency)} · C {formatMoney(d.purchasesNet, currency)}</span>
            </div>
            <div className="flex gap-1 h-3">
              <div className="bg-cyan-500 rounded-sm" style={{ width: `${sPct}%` }} title={`Ventas: ${formatMoney(d.salesNet, currency)}`} />
            </div>
            <div className="flex gap-1 h-3">
              <div className="bg-pink-500 rounded-sm" style={{ width: `${pPct}%` }} title={`Compras: ${formatMoney(d.purchasesNet, currency)}`} />
            </div>
          </div>
        );
      })}
      <div className="flex gap-4 text-xs text-muted-foreground pt-2 border-t">
        <span><span className="inline-block w-3 h-3 bg-cyan-500 rounded-sm align-middle mr-1" />Ventas</span>
        <span><span className="inline-block w-3 h-3 bg-pink-500 rounded-sm align-middle mr-1" />Compras</span>
      </div>
    </div>
  );
}

function printResumenPdf(s: TaxSummary, currency: string, startDate: string, endDate: string, profile: TaxProfileShape | null | undefined, organization?: { id?: string; name?: string; cuit?: string | null; taxId?: string | null } | null) {
  const w = window.open('', '_blank');
  if (!w) return;
  const fmt = (n: number) => escapeHtml(`${currency === 'USD' || currency === 'USD_CASH' ? 'U$D' : '$'} ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const aliquotRows = s.ivaByAliquot.map(r => `<tr><td>${escapeHtml(r.aliquot)}%</td><td>${fmt(r.salesNet)}</td><td>${fmt(r.salesIva)}</td><td>${fmt(r.purchasesNet)}</td><td>${fmt(r.purchasesIva)}</td><td>${fmt(r.salesIva - r.purchasesIva)}</td></tr>`).join('');
  const monthlyRows = s.monthly.map(m => `<tr><td>${escapeHtml(m.month)}</td><td>${fmt(m.salesNet)}</td><td>${fmt(m.salesIva)}</td><td>${fmt(m.purchasesNet)}</td><td>${fmt(m.purchasesIva)}</td></tr>`).join('');
  const ganancias = profile?.gananciasInscribed && s.utility > 0 ? `<tr><td>Ganancias estimada (35% s/utilidad)</td><td><b>${fmt(s.utility * 0.35)}</b></td></tr>` : '';
  const iibb = profile?.iibbInscribed && profile?.iibbAliquot ? `<tr><td>IIBB estimado (${escapeHtml(profile.iibbAliquot)}% s/ventas neto)</td><td><b>${fmt((s.sales.net * Number(profile.iibbAliquot)) / 100)}</b></td></tr>` : '';
  const orgName = escapeHtml(organization?.name || 'Organización');
  const orgCuit = organization?.cuit || organization?.taxId ? `<div>CUIT/Tax ID: <b>${escapeHtml(organization?.cuit || organization?.taxId || '')}</b></div>` : '';
  const profileRows: string[] = [];
  if (profile?.ivaCondition) profileRows.push(`<tr><td>Condición IVA</td><td>${escapeHtml(profile.ivaCondition)}${profile.monotributoCategory ? ` (Cat. ${escapeHtml(profile.monotributoCategory)})` : ''}</td></tr>`);
  if (profile?.iibbInscribed) profileRows.push(`<tr><td>Ingresos Brutos</td><td>Inscripto${profile.iibbJurisdictions ? ` — ${escapeHtml(profile.iibbJurisdictions)}` : ''}${profile.iibbAliquot ? ` — Alícuota ${escapeHtml(profile.iibbAliquot)}%` : ''}</td></tr>`);
  if (profile?.gananciasInscribed) profileRows.push(`<tr><td>Ganancias</td><td>Inscripto${profile.gananciasNumber ? ` — N° ${escapeHtml(profile.gananciasNumber)}` : ''}</td></tr>`);
  const profileSection = profileRows.length
    ? `<h2>Condiciones impositivas</h2><table>${profileRows.join('')}</table>`
    : `<h2>Condiciones impositivas</h2><div class="meta">Sin configurar — completar en Configuración &rsaquo; Condiciones impositivas.</div>`;
  w.document.write(`<!DOCTYPE html><html><head><title>Resumen Impuestos — ${orgName}</title><style>
    body{font-family:Arial,sans-serif;padding:30px;color:#111}
    h1{color:#00b8d4;font-size:22px;margin:0 0 4px} h2{color:#333;font-size:14px;margin:18px 0 6px}
    .meta{color:#555;font-size:12px;margin-bottom:18px}
    table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:12px}
    th,td{border:1px solid #ccc;padding:6px 8px;text-align:left} th{background:#f0f9ff}
    .footer{margin-top:24px;font-size:10px;color:#888}
  </style></head><body>
    <h1>${orgName}</h1>
    ${orgCuit}
    <h2 style="margin-top:8px">Resumen de Impuestos</h2>
    <div class="meta">Período: ${escapeHtml(startDate)} a ${escapeHtml(endDate)} · Moneda: ${escapeHtml(currency)}</div>
    ${profileSection}
    <h2>Totales</h2>
    <table>
      <tr><th>Concepto</th><th>Valor</th></tr>
      <tr><td>Ventas - Neto</td><td>${fmt(s.sales.net)}</td></tr>
      <tr><td>Ventas - IVA Débito Fiscal</td><td>${fmt(s.sales.iva)}</td></tr>
      <tr><td>Ventas - Total</td><td>${fmt(s.sales.total)} (${s.sales.count} comp.)</td></tr>
      <tr><td>Compras - Neto</td><td>${fmt(s.purchases.net)}</td></tr>
      <tr><td>Compras - IVA Crédito Fiscal</td><td>${fmt(s.purchases.iva)}</td></tr>
      <tr><td>Compras - Total</td><td>${fmt(s.purchases.total)} (${s.purchases.count} comp.)</td></tr>
      <tr><td><b>Saldo IVA</b></td><td><b>${fmt(s.ivaBalance)}</b> ${s.ivaBalance >= 0 ? '(a pagar)' : '(saldo a favor)'}</td></tr>
      <tr><td><b>Utilidad estimada</b></td><td><b>${fmt(s.utility)}</b></td></tr>
      ${ganancias}${iibb}
    </table>
    ${aliquotRows ? `<h2>IVA por alícuota</h2><table><tr><th>Alícuota</th><th>Ventas Neto</th><th>IVA Débito</th><th>Compras Neto</th><th>IVA Crédito</th><th>Saldo</th></tr>${aliquotRows}</table>` : ''}
    ${monthlyRows ? `<h2>Comparativa mensual</h2><table><tr><th>Mes</th><th>Ventas Neto</th><th>IVA Débito</th><th>Compras Neto</th><th>IVA Crédito</th></tr>${monthlyRows}</table>` : ''}
    <div class="footer">Aikestar — Información tributaria. Documento informativo, no apto para presentación oficial.</div>
  </body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 300);
}

