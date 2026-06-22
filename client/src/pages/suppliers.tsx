import React from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supplierAPI, transactionAPI, fetchWithAuth } from '@/lib/api';
import { useMembership } from '@/lib/hooks';
import { ROLE_PERMISSIONS, type Role, CURRENCY_SYMBOLS, TAX_IVA_CONDITION_LABELS } from '@shared/schema';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useUndoDelete } from '@/hooks/use-undo-delete';
import { Building2, Plus, Trash2, Pencil, MoreVertical, Phone, Mail, MapPin, Eye, ArrowUpRight, ArrowDownRight, ShieldAlert, FileText, Download, Upload, CheckCircle2, FileSpreadsheet, Loader2, Calendar, Search, UserCheck, UserX, Scale, X, Send, RotateCcw, RefreshCw, ChevronDown, Maximize2, Minimize2 } from 'lucide-react';
import * as XLSX from 'xlsx';
import { Checkbox } from '@/components/ui/checkbox';
import { BackButton } from '@/components/BackButton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { format, startOfMonth, endOfMonth, subMonths } from 'date-fns';
import { es } from 'date-fns/locale';
import type { Supplier, Transaction } from '@shared/schema';
import { normalizeAmountInput } from '@/lib/currency';
import { safeParseDate, getEffectiveTransactionDate, getArgentinaToday } from '@/lib/utils';
import { type CCMovement, calculateSupplierCC, calculateAllSuppliersCCTotal, normalizeCurrencyKey, getCurrencySymbol } from '@/lib/cc-utils';

function SupplierInvoiceEmailPrefsEditor({ supplierId, supplierEmail }: { supplierId: string; supplierEmail?: string | null }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = ['/api/suppliers', supplierId, 'invoice-email-prefs'];
  const { data: prefs, isLoading } = useQuery<{ supplierId: string; defaultCcEmails: string[]; sendCopyToSelf: boolean }>({
    queryKey,
    queryFn: () => fetchWithAuth(`/suppliers/${supplierId}/invoice-email-prefs`),
    enabled: !!supplierId,
  });

  const [ccList, setCcList] = React.useState<string[]>([]);
  const [ccInput, setCcInput] = React.useState('');
  const [sendCopyToMe, setSendCopyToMe] = React.useState<boolean>(false);
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    if (prefs && !hydrated) {
      setCcList(Array.isArray(prefs.defaultCcEmails) ? prefs.defaultCcEmails : []);
      setSendCopyToMe(prefs.sendCopyToSelf === true);
      setHydrated(true);
    }
  }, [prefs, hydrated]);

  React.useEffect(() => {
    setHydrated(false);
  }, [supplierId]);

  const isValidEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim());

  const addCc = () => {
    const value = ccInput.trim();
    if (!value) return;
    if (!isValidEmail(value)) {
      toast({ title: 'Email inválido', description: `"${value}" no es un email válido.`, variant: 'destructive' });
      return;
    }
    if (ccList.includes(value)) {
      setCcInput('');
      return;
    }
    setCcList([...ccList, value]);
    setCcInput('');
  };

  const removeCc = (email: string) => {
    setCcList(ccList.filter(e => e !== email));
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      fetchWithAuth(`/suppliers/${supplierId}/invoice-email-prefs`, {
        method: 'PUT',
        body: JSON.stringify({ defaultCcEmails: ccList, sendCopyToSelf: sendCopyToMe }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({ title: 'Preferencias guardadas', description: 'Las preferencias de email del proveedor se actualizaron.' });
    },
    onError: (err: any) => {
      toast({
        title: 'Error',
        description: err?.body?.message || err?.message || 'No se pudieron guardar las preferencias',
        variant: 'destructive',
      });
    },
  });

  return (
    <div className="space-y-3 border rounded-lg p-4 bg-muted/20" data-testid="section-email-prefs">
      <div className="flex items-center gap-2">
        <Send className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Preferencias de email para comprobantes</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Estas preferencias se aplicarán por defecto al emitir comprobantes para este proveedor.
      </p>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Cargando…</p>
      ) : (
        <>
          <div className="space-y-2">
            <label className="text-xs font-medium">CC por defecto</label>
            <div className="flex gap-2">
              <Input
                type="email"
                placeholder="cc@ejemplo.com"
                value={ccInput}
                onChange={(e) => setCcInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    addCc();
                  }
                }}
                data-testid="input-email-prefs-cc"
              />
              <Button type="button" variant="outline" size="sm" onClick={addCc} data-testid="button-email-prefs-add-cc">
                Agregar
              </Button>
            </div>
            {ccList.length > 0 && (
              <div className="flex flex-wrap gap-1.5" data-testid="list-email-prefs-cc">
                {ccList.map((email) => (
                  <Badge key={email} variant="secondary" className="gap-1" data-testid={`badge-email-prefs-cc-${email}`}>
                    {email}
                    <button
                      type="button"
                      onClick={() => removeCc(email)}
                      className="ml-1 hover:text-destructive"
                      data-testid={`button-email-prefs-remove-cc-${email}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`send-copy-${supplierId}`}
              checked={sendCopyToMe}
              onCheckedChange={(checked) => setSendCopyToMe(checked === true)}
              data-testid="checkbox-email-prefs-send-copy"
            />
            <label htmlFor={`send-copy-${supplierId}`} className="text-sm cursor-pointer">
              Enviarme una copia (BCC) al emitir comprobantes a este proveedor
            </label>
          </div>
          {!supplierEmail && (
            <p className="text-[11px] text-amber-600" data-testid="text-email-prefs-no-supplier-email">
              ⚠️ Este proveedor no tiene un email principal cargado. Agregalo arriba para poder enviar comprobantes por email.
            </p>
          )}
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              data-testid="button-email-prefs-save"
            >
              {saveMutation.isPending ? 'Guardando…' : 'Guardar preferencias'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function escapeCSVField(field: string): string {
  if (field.includes(',') || field.includes('"') || field.includes('\n')) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

function exportCCtoCSV(supplier: Supplier, movements: CCMovement[], totalDebe: number, totalHaber: number, saldoFinal: number) {
  const headers = ['Fecha', 'Descripción', 'Moneda', 'Estado', 'Debe', 'Haber', 'Saldo'];
  const rows = movements.map(m => [
    format(m.date, 'dd/MM/yyyy'),
    escapeCSVField(m.description),
    m.currency,
    m.description.startsWith('[CANCELACIÓN]') ? 'Cancelado' : m.status === 'completed' ? 'Pagado' : 'Pendiente',
    m.debe > 0 ? m.debe.toFixed(2) : '',
    m.haber > 0 ? m.haber.toFixed(2) : '',
    m.saldo.toFixed(2)
  ]);
  
  rows.push(['', '', '', '', '', '', '']);
  rows.push(['', 'TOTALES', '', '', totalDebe.toFixed(2), totalHaber.toFixed(2), saldoFinal.toFixed(2)]);
  
  const csvContent = [
    escapeCSVField(`Cuenta Corriente - ${supplier.name}`),
    `CUIT;${supplier.taxId || 'N/A'}`,
    `Generado;${format(new Date(), 'dd/MM/yyyy HH:mm')}`,
    '',
    headers.join(';'),
    ...rows.map(r => r.join(';'))
  ].join('\n');
  
  const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `CC_${supplier.name.replace(/\s+/g, '_')}_${format(new Date(), 'yyyyMMdd')}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function exportCCtoPDF(supplier: Supplier, movements: CCMovement[], totalDebe: number, totalHaber: number, saldoFinal: number) {
  const printWindow = window.open('', '_blank');
  if (!printWindow) return;
  
  const formatCurrency = (val: number, currency: string = 'ARS') => {
    const symbol = currency === 'USD' || currency === 'USD_CASH' ? 'US$' : currency === 'EUR' ? '€' : '$';
    return val !== 0 ? `${symbol} ${Math.abs(val).toLocaleString('es-AR', { minimumFractionDigits: 2 })}` : '-';
  };
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Cuenta Corriente - ${supplier.name}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; color: #333; }
        .header { border-bottom: 2px solid #0ea5e9; padding-bottom: 20px; margin-bottom: 20px; }
        .header h1 { margin: 0; color: #0ea5e9; font-size: 24px; }
        .header p { margin: 5px 0; color: #666; }
        .supplier-info { background: #f8fafc; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
        .supplier-info h2 { margin: 0 0 10px; font-size: 18px; }
        .supplier-info p { margin: 3px 0; font-size: 14px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th { background: #0ea5e9; color: white; padding: 10px; text-align: left; font-size: 12px; }
        td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; font-size: 12px; }
        tr:nth-child(even) { background: #f8fafc; }
        .text-right { text-align: right; }
        .text-center { text-align: center; }
        .debe { color: #ef4444; }
        .haber { color: #22c55e; }
        .totals { background: #1e293b !important; color: white; font-weight: bold; }
        .totals td { border: none; }
        .saldo-final { font-size: 16px; }
        .footer { margin-top: 30px; text-align: center; color: #94a3b8; font-size: 11px; }
        @media print { body { padding: 20px; } }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>CUENTA CORRIENTE - PROVEEDOR</h1>
        <p>Generado: ${format(new Date(), "dd 'de' MMMM 'de' yyyy, HH:mm", { locale: es })}</p>
      </div>
      
      <div class="supplier-info">
        <h2>${supplier.name}</h2>
        ${supplier.taxId ? `<p><strong>CUIT:</strong> ${supplier.taxId}</p>` : ''}
        ${supplier.email ? `<p><strong>Email:</strong> ${supplier.email}</p>` : ''}
        ${supplier.phone ? `<p><strong>Teléfono:</strong> ${supplier.phone}</p>` : ''}
        ${supplier.address ? `<p><strong>Dirección:</strong> ${supplier.address}</p>` : ''}
      </div>
      
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Descripción</th>
            <th class="text-center">Moneda</th>
            <th>Estado</th>
            <th class="text-right">Debe</th>
            <th class="text-right">Haber</th>
            <th class="text-right">Saldo</th>
          </tr>
        </thead>
        <tbody>
          ${movements.map(m => `
            <tr>
              <td>${format(m.date, 'dd/MM/yyyy')}</td>
              <td>${m.description}</td>
              <td class="text-center">${m.currency}</td>
              <td>${m.description.startsWith('[CANCELACIÓN]') ? 'Cancelado' : m.status === 'completed' ? 'Pagado' : 'Pendiente'}</td>
              <td class="text-right debe">${m.debe > 0 ? formatCurrency(m.debe, m.currency) : '-'}</td>
              <td class="text-right haber">${m.haber > 0 ? formatCurrency(m.haber, m.currency) : '-'}</td>
              <td class="text-right">${formatCurrency(m.saldo, m.currency)}</td>
            </tr>
          `).join('')}
          <tr class="totals">
            <td colspan="4"><strong>TOTALES</strong></td>
            <td class="text-right">${formatCurrency(totalDebe)}</td>
            <td class="text-right">${formatCurrency(totalHaber)}</td>
            <td class="text-right saldo-final">${formatCurrency(saldoFinal)}</td>
          </tr>
        </tbody>
      </table>
      
      <div class="footer">
        <p>Documento generado por Aikestar - Sistema de Gestión Administrativa</p>
      </div>
      
      <script>window.onload = function() { window.print(); }</script>
    </body>
    </html>
  `;
  
  printWindow.document.write(html);
  printWindow.document.close();
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSaldoByCurrency(byCurrency: Record<string, { saldo: number }>): string {
  const entries = Object.entries(byCurrency).filter(([, d]) => d.saldo !== 0);
  if (!entries.length) return 'Al día';
  return entries
    .map(([curr, d]) => `${getCurrencySymbol(curr)} ${d.saldo.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`)
    .join(' / ');
}

type SupplierExportRow = {
  nombre: string; email: string; telefono: string; cuit: string;
  iva: string; tipo: string; direccion: string; notas: string;
  estado: string; saldo: string;
};

function buildSuppliersListWorkbook(rows: SupplierExportRow[]): XLSX.WorkBook {
  const data = rows.map((r) => ({
    'Nombre': r.nombre,
    'Email': r.email,
    'Teléfono': r.telefono,
    'CUIT/CUIL': r.cuit,
    'Condición IVA': r.iva,
    'Tipo de proveedor': r.tipo,
    'Dirección': r.direccion,
    'Notas': r.notas,
    'Estado': r.estado,
    'Saldo cuenta corriente': r.saldo,
  }));
  const ws = XLSX.utils.json_to_sheet(data, {
    header: ['Nombre', 'Email', 'Teléfono', 'CUIT/CUIL', 'Condición IVA', 'Tipo de proveedor', 'Dirección', 'Notas', 'Estado', 'Saldo cuenta corriente'],
  });
  ws['!cols'] = [
    { wch: 30 }, { wch: 26 }, { wch: 18 }, { wch: 16 }, { wch: 20 },
    { wch: 18 }, { wch: 32 }, { wch: 30 }, { wch: 12 }, { wch: 22 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Proveedores');
  return wb;
}

function exportSuppliersListToPDF(rows: SupplierExportRow[]) {
  const printWindow = window.open('', '_blank');
  if (!printWindow) return;
  const generated = new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    dateStyle: 'long',
    timeStyle: 'short',
  });
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Lista de Proveedores</title>
      <style>
        @page { size: A4 landscape; margin: 14mm; }
        body { font-family: Arial, sans-serif; padding: 20px; color: #333; }
        .header { border-bottom: 2px solid #0ea5e9; padding-bottom: 16px; margin-bottom: 16px; }
        .header h1 { margin: 0; color: #0ea5e9; font-size: 22px; }
        .header p { margin: 4px 0 0; color: #666; font-size: 13px; }
        table { width: 100%; border-collapse: collapse; margin-top: 12px; }
        th { background: #0ea5e9; color: white; padding: 8px; text-align: left; font-size: 11px; }
        td { padding: 6px 8px; border-bottom: 1px solid #e2e8f0; font-size: 11px; }
        tr:nth-child(even) { background: #f8fafc; }
        .text-right { text-align: right; }
        .footer { margin-top: 24px; text-align: center; color: #94a3b8; font-size: 11px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>LISTA DE PROVEEDORES</h1>
        <p>Generado: ${generated} — Total: ${rows.length}</p>
      </div>
      <table>
        <thead>
          <tr>
            <th>Nombre</th>
            <th>CUIT/CUIL</th>
            <th>Email</th>
            <th>Teléfono</th>
            <th>Condición IVA</th>
            <th>Tipo</th>
            <th>Dirección</th>
            <th>Notas</th>
            <th>Estado</th>
            <th class="text-right">Saldo CC</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${escapeHtml(r.nombre)}</td>
              <td>${escapeHtml(r.cuit)}</td>
              <td>${escapeHtml(r.email)}</td>
              <td>${escapeHtml(r.telefono)}</td>
              <td>${escapeHtml(r.iva)}</td>
              <td>${escapeHtml(r.tipo)}</td>
              <td>${escapeHtml(r.direccion)}</td>
              <td>${escapeHtml(r.notas)}</td>
              <td>${escapeHtml(r.estado)}</td>
              <td class="text-right">${escapeHtml(r.saldo)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div class="footer">
        <p>Documento generado por Aikestar - Sistema de Gestión Administrativa</p>
      </div>
      <script>window.onload = function() { window.print(); }</script>
    </body>
    </html>
  `;
  printWindow.document.write(html);
  printWindow.document.close();
}

const supplierSchema = z.object({
  name: z.string().min(2, 'El nombre es requerido'),
  email: z.string().email('Email inválido').optional().or(z.literal('')),
  phone: z.string().optional(),
  address: z.string().optional(),
  taxId: z.string().optional(),
  notes: z.string().optional(),
  supplierType: z.string().optional(),
});

type SupplierFormValues = z.infer<typeof supplierSchema>;

const SupplierFormFields = ({ formInstance, testIdPrefix = '' }: { formInstance: ReturnType<typeof useForm<SupplierFormValues>>; testIdPrefix?: string }) => (
  <div className="space-y-4">
    <FormField control={formInstance.control} name="name" render={({ field }) => (
      <FormItem>
        <FormLabel>Nombre *</FormLabel>
        <FormControl><Input placeholder="Nombre o razón social" {...field} data-testid={`input-${testIdPrefix}supplier-name`} /></FormControl>
        <FormMessage />
      </FormItem>
    )} />
    <div className="grid grid-cols-2 gap-4">
      <FormField control={formInstance.control} name="email" render={({ field }) => (
        <FormItem>
          <FormLabel>Email</FormLabel>
          <FormControl><Input type="email" placeholder="email@ejemplo.com" {...field} data-testid={`input-${testIdPrefix}supplier-email`} /></FormControl>
          <FormMessage />
        </FormItem>
      )} />
      <FormField control={formInstance.control} name="phone" render={({ field }) => (
        <FormItem>
          <FormLabel>Teléfono</FormLabel>
          <FormControl><Input placeholder="+54 11 1234-5678" {...field} data-testid={`input-${testIdPrefix}supplier-phone`} /></FormControl>
          <FormMessage />
        </FormItem>
      )} />
    </div>
    <div className="grid grid-cols-2 gap-4">
      <FormField control={formInstance.control} name="taxId" render={({ field }) => (
        <FormItem>
          <FormLabel>CUIT/CUIL</FormLabel>
          <FormControl><Input placeholder="20-12345678-9" {...field} data-testid={`input-${testIdPrefix}supplier-taxid`} /></FormControl>
          <FormMessage />
        </FormItem>
      )} />
      <FormField control={formInstance.control} name="supplierType" render={({ field }) => (
        <FormItem>
          <FormLabel>Tipo</FormLabel>
          <FormControl><Input placeholder="Ej: Insumos, Servicios..." {...field} data-testid={`input-${testIdPrefix}supplier-type`} /></FormControl>
          <FormMessage />
        </FormItem>
      )} />
    </div>
    <FormField control={formInstance.control} name="address" render={({ field }) => (
      <FormItem>
        <FormLabel>Dirección</FormLabel>
        <FormControl><Input placeholder="Av. Corrientes 1234, CABA" {...field} data-testid={`input-${testIdPrefix}supplier-address`} /></FormControl>
        <FormMessage />
      </FormItem>
    )} />
    <FormField control={formInstance.control} name="notes" render={({ field }) => (
      <FormItem>
        <FormLabel>Notas</FormLabel>
        <FormControl><Textarea placeholder="Notas adicionales..." {...field} data-testid={`input-${testIdPrefix}supplier-notes`} /></FormControl>
        <FormMessage />
      </FormItem>
    )} />
  </div>
);

type ImportRowResult = {
  rowNumber: number;
  status: 'new' | 'update' | 'error';
  name: string;
  taxId: string;
  matchBy?: 'taxId' | 'name' | null;
  existingId?: string | null;
  errors: string[];
};
type ImportSummary = { total: number; new: number; update: number; errors: number; applied: number };
type ImportPreview = { summary: ImportSummary; rows: ImportRowResult[] };

const SUPPLIER_EXPECTED_HEADERS = ['Nombre', 'Email', 'Teléfono', 'CUIT/CUIL', 'Condición IVA', 'Tipo de proveedor', 'Dirección', 'Notas'];

// Columnas que el usuario puede editar en la vista previa antes de confirmar.
const SUPPLIER_IMPORT_EDIT_COLUMNS: { key: string; label: string; width: string }[] = [
  { key: 'Nombre', label: 'Nombre', width: 'w-40' },
  { key: 'Email', label: 'Email', width: 'w-48' },
  { key: 'Teléfono', label: 'Teléfono', width: 'w-32' },
  { key: 'CUIT/CUIL', label: 'CUIT/CUIL', width: 'w-32' },
  { key: 'Condición IVA', label: 'Condición IVA', width: 'w-40' },
  { key: 'Tipo de proveedor', label: 'Tipo de proveedor', width: 'w-36' },
  { key: 'Dirección', label: 'Dirección', width: 'w-44' },
  { key: 'Notas', label: 'Notas', width: 'w-44' },
];

const importNormalizeKey = (s: any): string =>
  String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

// Convierte una fila cruda del Excel (con encabezados arbitrarios) en una fila
// con las claves canónicas que entiende el servidor. Así, la fila editada se
// envía siempre con encabezados que el importador reconoce.
function extractCanonicalImportRow(raw: any, keys: string[]): Record<string, string> {
  const map = new Map<string, string>();
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(raw)) map.set(importNormalizeKey(k), k);
  }
  const out: Record<string, string> = {};
  for (const canonical of keys) {
    const actual = map.get(importNormalizeKey(canonical));
    const v = actual !== undefined ? raw?.[actual] : raw?.[canonical];
    out[canonical] = v == null ? '' : String(v);
  }
  return out;
}

function buildSupplierTemplateWorkbook(): XLSX.WorkBook {
  const exampleRows = [
    {
      'Nombre': 'Distribuidora Norte S.R.L.',
      'Email': 'ventas@distrinorte.com',
      'Teléfono': '+54 11 4000-1111',
      'CUIT/CUIL': '30-98765432-1',
      'Condición IVA': 'Responsable Inscripto',
      'Tipo de proveedor': 'Insumos',
      'Dirección': 'Ruta 8 Km 30, Pilar',
      'Notas': 'Entrega semanal',
    },
    {
      'Nombre': 'María Gómez',
      'Email': 'maria.gomez@gmail.com',
      'Teléfono': '+54 9 11 6666-2222',
      'CUIT/CUIL': '27-28999111-4',
      'Condición IVA': 'Monotributo',
      'Tipo de proveedor': 'Servicios',
      'Dirección': '',
      'Notas': '',
    },
  ];

  const ws = XLSX.utils.json_to_sheet(exampleRows, { header: SUPPLIER_EXPECTED_HEADERS });
  ws['!cols'] = [
    { wch: 30 }, { wch: 26 }, { wch: 18 }, { wch: 16 },
    { wch: 22 }, { wch: 18 }, { wch: 32 }, { wch: 30 },
  ];

  const instructions = [
    ['Columna', 'Obligatoria', 'Valores válidos / Formato'],
    ['Nombre', 'Sí', 'Texto libre. Es la única columna que no puede quedar vacía.'],
    ['Email', 'No', 'Email válido (ej: nombre@empresa.com). Si está mal escrito, esa fila da error.'],
    ['Teléfono', 'No', 'Texto libre.'],
    ['CUIT/CUIL', 'No', 'Si coincide con un proveedor existente, se actualiza esa ficha.'],
    ['Condición IVA', 'No', 'Responsable Inscripto, Monotributo, IVA Exento o Consumidor Final.'],
    ['Tipo de proveedor', 'No', 'Texto libre (ej: Insumos, Servicios, Logística).'],
    ['Dirección', 'No', 'Texto libre.'],
    ['Notas', 'No', 'Texto libre.'],
    [],
    ['Regla de match', '', 'Primero se busca por CUIT/CUIL. Si no hay CUIT, por Nombre exacto. Si no coincide, se crea uno nuevo.'],
    ['Mayúsculas y tildes', '', "El sistema reconoce 'nombre', 'Nombre', 'NOMBRE' o 'Telefono' sin tilde — pero usar exactamente estos encabezados evita errores."],
    ['Máximo de filas', '', '2000 por archivo.'],
  ];
  const wsInst = XLSX.utils.aoa_to_sheet(instructions);
  wsInst['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 80 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Proveedores');
  XLSX.utils.book_append_sheet(wb, wsInst, 'Instrucciones');
  return wb;
}

function downloadSupplierTemplate() {
  const wb = buildSupplierTemplateWorkbook();
  XLSX.writeFile(wb, 'proveedores-plantilla.xlsx');
}

function ImportSuppliersDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = React.useState<string>('');
  const [rawRows, setRawRows] = React.useState<any[] | null>(null);
  const [editableRows, setEditableRows] = React.useState<Record<string, string>[] | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [preview, setPreview] = React.useState<ImportPreview | null>(null);
  const [isParsing, setIsParsing] = React.useState(false);
  const [isPreviewing, setIsPreviewing] = React.useState(false);
  const [isApplying, setIsApplying] = React.useState(false);
  const [isMaximized, setIsMaximized] = React.useState(false);

  const reset = () => {
    setFileName('');
    setRawRows(null);
    setEditableRows(null);
    setDirty(false);
    setPreview(null);
    setIsParsing(false);
    setIsPreviewing(false);
    setIsApplying(false);
    setIsMaximized(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  React.useEffect(() => { if (!open) reset(); }, [open]);

  const handleFile = async (file: File) => {
    setIsParsing(true);
    setPreview(null);
    setRawRows(null);
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) throw new Error('El archivo no tiene hojas');
      const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: '', raw: false });
      if (!Array.isArray(rows) || rows.length === 0) {
        toast({ title: 'Archivo vacío', description: 'No se encontraron filas para importar', variant: 'destructive' });
        setIsParsing(false);
        return;
      }
      setRawRows(rows);
      setIsParsing(false);
      setIsPreviewing(true);
      try {
        const res = await supplierAPI.bulkImport(rows, true) as ImportPreview;
        setEditableRows(rows.map((r) => extractCanonicalImportRow(r, SUPPLIER_EXPECTED_HEADERS)));
        setDirty(false);
        setPreview(res);
      } catch (e: any) {
        if (e?.code === 'MISSING_NAME_COLUMN') {
          const detected: string[] = Array.isArray(e?.detectedHeaders)
            ? e.detectedHeaders.filter((h: any) => typeof h === 'string' && h.trim().length > 0)
            : [];
          const MAX_SHOWN = 10;
          const shown = detected.slice(0, MAX_SHOWN);
          const extra = detected.length - shown.length;
          toast({
            title: "Falta la columna 'Nombre'",
            description: (
              <div className="space-y-2">
                <p>No detectamos la columna 'Nombre' en el archivo. Descargá la plantilla y volvé a intentarlo.</p>
                <button type="button" onClick={() => downloadSupplierTemplate()} className="underline font-medium" data-testid="button-toast-download-template">
                  Descargar plantilla
                </button>
                {detected.length > 0 && (
                  <div className="pt-1" data-testid="text-detected-headers">
                    <p className="text-xs font-medium">Columnas detectadas en tu archivo:</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {shown.map((h, i) => (
                        <span
                          key={`${h}-${i}`}
                          className="inline-flex items-center rounded border border-current/30 bg-background/10 px-1.5 py-0.5 text-[11px]"
                          data-testid={`chip-detected-header-${i}`}
                        >
                          {h}
                        </span>
                      ))}
                      {extra > 0 && (
                        <span className="inline-flex items-center text-[11px] opacity-80" data-testid="text-detected-headers-more">
                          y {extra} más
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) as any,
            variant: 'destructive',
          });
          setRawRows(null);
          setEditableRows(null);
          setFileName('');
          if (fileInputRef.current) fileInputRef.current.value = '';
        } else {
          toast({ title: 'Error al analizar', description: e?.message || 'No se pudo procesar el archivo', variant: 'destructive' });
        }
      } finally {
        setIsPreviewing(false);
      }
    } catch (e: any) {
      toast({ title: 'No se pudo leer el archivo', description: e?.message || String(e), variant: 'destructive' });
      setIsParsing(false);
    }
  };

  const updateCell = (idx: number, key: string, value: string) => {
    setEditableRows((prev) => {
      if (!prev) return prev;
      const next = prev.slice();
      next[idx] = { ...next[idx], [key]: value };
      return next;
    });
    setDirty(true);
  };

  const revalidate = async () => {
    if (!editableRows) return;
    setIsPreviewing(true);
    try {
      const res = await supplierAPI.bulkImport(editableRows, true) as ImportPreview;
      setPreview(res);
      setDirty(false);
    } catch (e: any) {
      toast({ title: 'No se pudo revalidar', description: e?.message || String(e), variant: 'destructive' });
    } finally {
      setIsPreviewing(false);
    }
  };

  const applyImport = async () => {
    if (!editableRows) return;
    setIsApplying(true);
    try {
      const res = await supplierAPI.bulkImport(editableRows, false) as ImportPreview & { applyErrors?: any[] };
      const s = res.summary;
      const successCount = s.applied;
      const errorCount = s.errors;
      const fullSuccess = errorCount === 0 && successCount > 0;
      if (fullSuccess) {
        setIsApplying(false);
        onOpenChange(false);
      } else {
        setPreview(res);
        setDirty(false);
      }
      try {
        queryClient.invalidateQueries({ queryKey: ['/api/suppliers'] });
      } catch {
        // ignorar errores de invalidación: la próxima navegación recarga.
      }
      toast({
        title: errorCount > 0 ? 'Importación completada con errores' : 'Importación completada',
        description: `${successCount} proveedor(es) procesado(s) correctamente${errorCount > 0 ? `, ${errorCount} con errores` : ''}.`,
        variant: errorCount > 0 ? 'destructive' : 'default',
      });
    } catch (e: any) {
      toast({ title: 'Error al importar', description: e?.message || String(e), variant: 'destructive' });
    } finally {
      setIsApplying(false);
    }
  };

  const canApply = !!preview && preview.summary.total > 0 && (preview.summary.new + preview.summary.update) > 0 && !isApplying && !isPreviewing && !dirty;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`${isMaximized ? 'sm:max-w-[98vw] w-[98vw] h-[95vh]' : 'sm:max-w-[1100px] w-[95vw] max-h-[90vh]'} overflow-y-auto transition-all duration-200`} data-testid="dialog-import-suppliers">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <span className="flex-1">Importar proveedores desde Excel</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => setIsMaximized(!isMaximized)}
              data-testid="button-import-toggle-maximize"
            >
              {isMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
          </DialogTitle>
          <DialogDescription>
            Seguí estos pasos: 1) descargá la plantilla, 2) completá una fila por proveedor, 3) subí el .xlsx y revisá la vista previa, 4) confirmá. El match con proveedores existentes se hace por CUIT/CUIL; si no hay CUIT, por nombre exacto.
          </DialogDescription>
        </DialogHeader>

        {!preview && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-4 py-3">
              <div className="text-sm">
                <p className="font-medium">¿No sabés cómo armar el archivo?</p>
                <p className="text-muted-foreground text-xs">Descargá la plantilla con los encabezados correctos, dos filas de ejemplo y una hoja de instrucciones.</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={downloadSupplierTemplate} data-testid="button-download-suppliers-template">
                <FileSpreadsheet className="mr-2 h-4 w-4" />
                Descargar plantilla
              </Button>
            </div>
            <div className="rounded-md border border-dashed p-6 text-center bg-muted/30">
              <FileSpreadsheet className="h-10 w-10 mx-auto text-muted-foreground mb-3" aria-hidden="true" />
              <p className="text-sm text-muted-foreground mb-3">
                Columnas esperadas: {SUPPLIER_EXPECTED_HEADERS.join(', ')}
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
                data-testid="input-suppliers-import-file"
              />
              <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={isParsing || isPreviewing} data-testid="button-select-import-file">
                {(isParsing || isPreviewing) ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Analizando archivo…</>
                ) : (
                  <><Upload className="mr-2 h-4 w-4" /> Elegir archivo .xlsx</>
                )}
              </Button>
              {fileName && (
                <p className="text-xs text-muted-foreground mt-2" data-testid="text-import-filename">{fileName}</p>
              )}
            </div>
          </div>
        )}

        {preview && (
          <div className="space-y-4 min-w-0">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div className="rounded-md border p-3 text-center">
                <div className="text-xs text-muted-foreground">Filas</div>
                <div className="text-xl font-semibold" data-testid="text-import-total">{preview.summary.total}</div>
              </div>
              <div className="rounded-md border p-3 text-center bg-emerald-500/5 border-emerald-500/20">
                <div className="text-xs text-emerald-700">Nuevos</div>
                <div className="text-xl font-semibold text-emerald-700" data-testid="text-import-new">{preview.summary.new}</div>
              </div>
              <div className="rounded-md border p-3 text-center bg-cyan-500/5 border-cyan-500/20">
                <div className="text-xs text-cyan-700">A actualizar</div>
                <div className="text-xl font-semibold text-cyan-700" data-testid="text-import-update">{preview.summary.update}</div>
              </div>
              <div className="rounded-md border p-3 text-center bg-red-500/5 border-red-500/20">
                <div className="text-xs text-red-700">Con errores</div>
                <div className="text-xl font-semibold text-red-700" data-testid="text-import-errors">{preview.summary.errors}</div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-xs text-muted-foreground">
                Podés corregir cualquier dato directamente en la tabla. Después tocá "Revalidar" para actualizar la vista previa.
              </p>
              <Button
                type="button"
                variant={dirty ? 'default' : 'outline'}
                size="sm"
                onClick={revalidate}
                disabled={isPreviewing || isApplying || !editableRows}
                data-testid="button-import-revalidate"
              >
                {isPreviewing ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Revalidando…</>
                ) : (
                  <><RefreshCw className="mr-2 h-4 w-4" /> Revalidar</>
                )}
              </Button>
            </div>

            {dirty && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700" data-testid="text-import-dirty-warning">
                Tenés cambios sin revalidar. Tocá "Revalidar" para actualizar los estados antes de confirmar.
              </div>
            )}

            <div className="border rounded-md overflow-auto max-h-[55vh] min-w-0">
              <Table className="min-w-[1100px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Fila</TableHead>
                    <TableHead className="w-28">Estado</TableHead>
                    {SUPPLIER_IMPORT_EDIT_COLUMNS.map((col) => (
                      <TableHead key={col.key} className={col.width}>{col.label}</TableHead>
                    ))}
                    <TableHead className="min-w-[180px]">Detalle</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((r, idx) => (
                    <TableRow key={r.rowNumber} data-testid={`row-import-${r.rowNumber}`}>
                      <TableCell className="font-mono text-xs">{r.rowNumber}</TableCell>
                      <TableCell>
                        {r.status === 'new' && (
                          <Badge className="bg-emerald-500/10 text-emerald-700 border-emerald-500/20" variant="outline">Nuevo</Badge>
                        )}
                        {r.status === 'update' && (
                          <Badge className="bg-cyan-500/10 text-cyan-700 border-cyan-500/20" variant="outline">
                            Actualiza{r.matchBy ? ` (${r.matchBy === 'taxId' ? 'CUIT' : 'nombre'})` : ''}
                          </Badge>
                        )}
                        {r.status === 'error' && (
                          <Badge className="bg-red-500/10 text-red-700 border-red-500/20" variant="outline">Error</Badge>
                        )}
                      </TableCell>
                      {SUPPLIER_IMPORT_EDIT_COLUMNS.map((col) => (
                        <TableCell key={col.key} className={col.width}>
                          <Input
                            value={editableRows?.[idx]?.[col.key] ?? ''}
                            onChange={(e) => updateCell(idx, col.key, e.target.value)}
                            className="h-8 text-xs"
                            placeholder="—"
                            data-testid={`input-import-${idx}-${col.key}`}
                          />
                        </TableCell>
                      ))}
                      <TableCell className="text-xs">
                        {r.errors.length > 0 ? (
                          <span className="text-red-700">{r.errors.join(' · ')}</span>
                        ) : r.status === 'update' ? (
                          <span className="text-muted-foreground">Se actualizará el proveedor existente</span>
                        ) : (
                          <span className="text-muted-foreground">Se creará</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        <DialogFooter>
          {preview && (
            <Button variant="outline" onClick={reset} disabled={isApplying} data-testid="button-import-restart">
              Elegir otro archivo
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isApplying} data-testid="button-import-cancel">
            Cancelar
          </Button>
          {preview && (
            <Button onClick={applyImport} disabled={!canApply} data-testid="button-import-confirm">
              {isApplying ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Importando…</>
              ) : (
                <><CheckCircle2 className="mr-2 h-4 w-4" /> Confirmar importación</>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SuppliersPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { showUndoToast } = useUndoDelete();
  const { data: membership } = useMembership();
  const [isOpen, setIsOpen] = React.useState(false);
  const [isImportOpen, setIsImportOpen] = React.useState(false);
  const [editSupplier, setEditSupplier] = React.useState<Supplier | null>(null);
  const [deleteSupplierId, setDeleteSupplierId] = React.useState<string | null>(null);
  const [viewSupplier, setViewSupplier] = React.useState<Supplier | null>(null);
  const [showInactive, setShowInactive] = React.useState(false);
  const [ccPeriodFilter, setCCPeriodFilter] = React.useState<string>('all');
  const [searchTerm, setSearchTerm] = React.useState('');
  const [filterType, setFilterType] = React.useState<string>('all');
  const [showReconcileDialog, setShowReconcileDialog] = React.useState(false);
  const [reconcileReason, setReconcileReason] = React.useState('Ajuste por retenciones');
  const [reconcileCustomReason, setReconcileCustomReason] = React.useState('');
  const [isReconciling, setIsReconciling] = React.useState(false);
  const prevViewSupplierRef = React.useRef<Supplier | null>(null);

  const RECONCILE_REASONS = [
    'Ajuste por retenciones',
    'Descuento recibido',
    'Diferencia de cambio',
    'Ajuste por nota de crédito',
    'Otro',
  ];

  React.useEffect(() => {
    if (viewSupplier?.id !== prevViewSupplierRef.current?.id) {
      setShowReconcileDialog(false);
      setReconcileReason('Ajuste por retenciones');
      setReconcileCustomReason('');
    }
    prevViewSupplierRef.current = viewSupplier;
  }, [viewSupplier]);

  const userRole = (membership?.role as Role) || 'viewer';
  const userPermissions = ROLE_PERMISSIONS[userRole] || [];
  const canCreate = userPermissions.includes('transactions:create');
  
  const roleNameMap: Record<string, string> = {
    owner: 'Propietario',
    admin: 'Administrador',
    specialist: 'Especialista',
    operator: 'Operador',
    viewer: 'Veedor'
  };
  const userRoleDisplay = roleNameMap[userRole] || userRole;

  // Task #363: cuando se muestran "inactivos", pedimos también los archivados al servidor.
  const { data: suppliers = [], isLoading } = useQuery({
    queryKey: ['/api/suppliers', showInactive],
    queryFn: () => supplierAPI.getAll(!showInactive, { includeArchived: showInactive }),
  });

  const { data: transactions = [] } = useQuery<Transaction[]>({
    queryKey: ['/api/transactions'],
    queryFn: () => transactionAPI.getAll(),
  });

  const createMutation = useMutation({
    mutationFn: supplierAPI.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/suppliers'] });
      toast({ title: "Proveedor creado", description: "El proveedor ha sido registrado exitosamente." });
      setIsOpen(false);
      form.reset();
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<SupplierFormValues & { isActive: boolean }> }) =>
      supplierAPI.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/suppliers'] });
      toast({ title: "Proveedor actualizado" });
      setEditSupplier(null);
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  // Task #363
  const [forceDeleteSupplier, setForceDeleteSupplier] = React.useState(false);
  const canForceDelete = userRole === 'owner' || userRole === 'admin';

  const deleteMutation = useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) => supplierAPI.delete(id, { force }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/suppliers'] });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const unarchiveSupplierMutation = useMutation({
    mutationFn: (id: string) => supplierAPI.unarchive(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/suppliers'] });
      toast({ title: "Proveedor restaurado" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const handleDeleteSupplier = async () => {
    if (!deleteSupplierId) return;
    const supplierName = suppliers.find((s: Supplier) => s.id === deleteSupplierId)?.name;
    try {
      const result = await deleteMutation.mutateAsync({ id: deleteSupplierId, force: forceDeleteSupplier });
      setDeleteSupplierId(null);
      setForceDeleteSupplier(false);
      if (result?.archived) {
        toast({
          title: 'Proveedor archivado',
          description: 'Tenía movimientos asociados, así que se conservó como archivado.',
        });
      } else if (result?.undoKey) {
        showUndoToast(result.undoKey, 'supplier', supplierName);
      } else {
        toast({ title: 'Proveedor eliminado' });
      }
    } catch {}
  };

  const form = useForm<SupplierFormValues>({
    resolver: zodResolver(supplierSchema),
    defaultValues: { name: '', email: '', phone: '', address: '', taxId: '', notes: '', supplierType: '' },
  });

  const editForm = useForm<SupplierFormValues>({
    resolver: zodResolver(supplierSchema),
    defaultValues: { name: '', email: '', phone: '', address: '', taxId: '', notes: '', supplierType: '' },
  });

  const onSubmit = (data: SupplierFormValues) => {
    createMutation.mutate({
      name: data.name,
      email: data.email || undefined,
      phone: data.phone || undefined,
      address: data.address || undefined,
      taxId: data.taxId || undefined,
      notes: data.notes || undefined,
      supplierType: data.supplierType || undefined,
    });
  };

  const handleEditOpen = (supplier: Supplier) => {
    editForm.reset({
      name: supplier.name,
      email: supplier.email || '',
      phone: supplier.phone || '',
      address: supplier.address || '',
      taxId: supplier.taxId || '',
      notes: supplier.notes || '',
      supplierType: supplier.supplierType || '',
    });
    setEditSupplier(supplier);
  };

  const onEditSubmit = (data: SupplierFormValues) => {
    if (!editSupplier) return;
    updateMutation.mutate({
      id: editSupplier.id,
      data: {
        name: data.name,
        email: data.email || undefined,
        phone: data.phone || undefined,
        address: data.address || undefined,
        taxId: data.taxId || undefined,
        notes: data.notes || undefined,
        supplierType: data.supplierType || undefined,
      },
    });
  };

  const toggleActive = (supplier: Supplier) => {
    updateMutation.mutate({ id: supplier.id, data: { isActive: !supplier.isActive } });
  };

  const getSupplierTransactions = (supplierId: string) => {
    return transactions.filter((tx: Transaction) => tx.supplierId === supplierId);
  };

  const handleReconcile = async () => {
    if (!viewSupplier) return;
    const allTxs = getSupplierTransactions(viewSupplier.id);
    const { byCurrency } = calculateSupplierCC(allTxs);
    const reason = reconcileReason === 'Otro' ? reconcileCustomReason.trim() : reconcileReason;
    if (!reason) {
      toast({ title: 'Indicá un motivo para la conciliación', variant: 'destructive' });
      return;
    }

    setIsReconciling(true);
    try {
      const now = getArgentinaToday();
      for (const [currency, data] of Object.entries(byCurrency)) {
        if (data.saldo === 0) continue;
        const isFavor = data.saldo > 0;

        await transactionAPI.create({
          type: isFavor ? 'income' : 'expense',
          amount: Math.abs(data.saldo).toString(),
          description: `Conciliación: ${reason}`,
          category: 'Ajuste Manual',
          date: now,
          imputationDate: now,
          status: 'completed',
          supplierId: viewSupplier.id,
          currency,
          hasInvoice: false,
        });
      }

      queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
      toast({ title: 'Cuenta conciliada', description: `La cuenta corriente de ${viewSupplier.name} fue ajustada a cero.` });
      setShowReconcileDialog(false);
      setReconcileReason('Ajuste por retenciones');
      setReconcileCustomReason('');
    } catch (error) {
      toast({ title: 'Error al conciliar', description: 'No se pudo completar la conciliación. Intentá de nuevo.', variant: 'destructive' });
    } finally {
      setIsReconciling(false);
    }
  };

  const getFilteredSupplierTransactions = (supplierId: string) => {
    let txs = getSupplierTransactions(supplierId);
    
    if (ccPeriodFilter !== 'all') {
      const now = new Date();
      let startDate: Date;
      let endDate: Date = endOfMonth(now);
      
      switch (ccPeriodFilter) {
        case 'current_month':
          startDate = startOfMonth(now);
          break;
        case 'last_month':
          startDate = startOfMonth(subMonths(now, 1));
          endDate = endOfMonth(subMonths(now, 1));
          break;
        case 'last_3_months':
          startDate = startOfMonth(subMonths(now, 2));
          break;
        case 'last_6_months':
          startDate = startOfMonth(subMonths(now, 5));
          break;
        default:
          startDate = new Date(0);
      }
      
      txs = txs.filter(tx => {
        const txDate = getEffectiveTransactionDate(tx);
        return txDate >= startDate && txDate <= endDate;
      });
    }
    
    return txs;
  };

  const getSupplierBalance = (supplierId: string) => {
    const supplierTxs = getSupplierTransactions(supplierId);
    const { saldoFinal } = calculateSupplierCC(supplierTxs);
    return saldoFinal;
  };

  const supplierTypes = React.useMemo(() => {
    const types = new Set<string>();
    suppliers.forEach((s: Supplier) => {
      if (s.supplierType) types.add(s.supplierType);
    });
    return Array.from(types).sort();
  }, [suppliers]);

  const filteredSuppliers = React.useMemo(() => {
    return suppliers.filter((supplier: Supplier) => {
      const matchesSearch = !searchTerm || supplier.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (supplier.email && supplier.email.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (supplier.taxId && supplier.taxId.includes(searchTerm));
      const matchesType = filterType === 'all' || supplier.supplierType === filterType;
      const matchesActive = showInactive || supplier.isActive;
      return matchesSearch && matchesType && matchesActive;
    });
  }, [suppliers, searchTerm, filterType, showInactive]);

  const activeCount = suppliers.filter((s: Supplier) => s.isActive).length;
  const inactiveCount = suppliers.filter((s: Supplier) => !s.isActive).length;

  const ccTotalsByCurrency = React.useMemo(() => {
    return calculateAllSuppliersCCTotal(suppliers, transactions);
  }, [suppliers, transactions]);

  const exportSuppliersList = (fmt: 'xlsx' | 'pdf') => {
    if (!filteredSuppliers.length) {
      toast({ title: 'No hay proveedores para exportar', variant: 'destructive' });
      return;
    }
    const rows: SupplierExportRow[] = filteredSuppliers.map((s: Supplier) => {
      const { byCurrency } = calculateSupplierCC(getSupplierTransactions(s.id));
      return {
        nombre: s.name || '',
        email: s.email || '',
        telefono: s.phone || '',
        cuit: s.taxId || '',
        iva: s.ivaCondition ? (TAX_IVA_CONDITION_LABELS[s.ivaCondition as keyof typeof TAX_IVA_CONDITION_LABELS] || s.ivaCondition) : '',
        tipo: s.supplierType || '',
        direccion: s.address || '',
        notas: s.notes || '',
        estado: s.isActive ? 'Activo' : 'Inactivo',
        saldo: formatSaldoByCurrency(byCurrency),
      };
    });
    if (fmt === 'xlsx') {
      const wb = buildSuppliersListWorkbook(rows);
      const filename = `proveedores-${getArgentinaToday()}.xlsx`;
      XLSX.writeFile(wb, filename);
      toast({ title: 'Exportación lista', description: filename });
    } else {
      exportSuppliersListToPDF(rows);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-lg text-muted-foreground">Cargando proveedores...</div>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
        <div>
          <BackButton />
          <h1 className="text-3xl font-bold font-display mt-2">Proveedores</h1>
          <p className="text-muted-foreground">Administra tu base de proveedores.</p>
        </div>

        <div className="flex gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" data-testid="button-download-suppliers-list">
              <Download className="mr-2 h-4 w-4" /> Descargar lista <ChevronDown className="ml-2 h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => exportSuppliersList('xlsx')} data-testid="button-download-suppliers-list-xlsx">
              <FileSpreadsheet className="mr-2 h-4 w-4" /> Excel (.xlsx)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => exportSuppliersList('pdf')} data-testid="button-download-suppliers-list-pdf">
              <FileText className="mr-2 h-4 w-4" /> PDF
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {canCreate && (
          <Button
            variant="outline"
            onClick={() => setIsImportOpen(true)}
            data-testid="button-import-suppliers"
          >
            <Upload className="mr-2 h-4 w-4" /> Importar desde Excel
          </Button>
        )}
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary text-primary-foreground shadow-lg shadow-primary/20" data-testid="button-new-supplier">
              <Plus className="mr-2 h-4 w-4" /> Nuevo Proveedor
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
            {!canCreate ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="w-20 h-20 rounded-full bg-gradient-to-br from-amber-100 to-orange-100 flex items-center justify-center mb-6">
                  <ShieldAlert className="h-10 w-10 text-amber-600" />
                </div>
                <h3 className="text-xl font-bold text-gray-800 dark:text-slate-100 mb-3">Acceso restringido</h3>
                <p className="text-muted-foreground max-w-sm mb-6">
                  Tu rol actual (<span className="font-medium text-amber-600">{userRoleDisplay}</span>) no tiene permiso para crear proveedores.
                </p>
                <Button variant="outline" className="mt-2" onClick={() => setIsOpen(false)}>Entendido</Button>
              </div>
            ) : (
              <>
                <DialogHeader><DialogTitle>Nuevo Proveedor</DialogTitle></DialogHeader>
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)}>
                    <SupplierFormFields formInstance={form} />
                    <DialogFooter className="mt-6">
                      <Button type="submit" disabled={createMutation.isPending} data-testid="button-save-supplier">
                        {createMutation.isPending ? 'Guardando...' : 'Guardar'}
                      </Button>
                    </DialogFooter>
                  </form>
                </Form>
              </>
            )}
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <ImportSuppliersDialog open={isImportOpen} onOpenChange={setIsImportOpen} />

      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Card className="bg-gradient-to-br from-blue-500/10 to-blue-600/5 border-blue-500/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                <Building2 className="h-5 w-5 text-blue-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total</p>
                <p className="text-2xl font-bold" data-testid="text-total-suppliers">{suppliers.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-green-500/10 to-green-600/5 border-green-500/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-green-500/20 flex items-center justify-center">
                <UserCheck className="h-5 w-5 text-green-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Activos</p>
                <p className="text-2xl font-bold" data-testid="text-active-suppliers">{activeCount}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-red-500/10 to-red-600/5 border-red-500/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-red-500/20 flex items-center justify-center">
                <UserX className="h-5 w-5 text-red-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Inactivos</p>
                <p className="text-2xl font-bold" data-testid="text-inactive-suppliers">{inactiveCount}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-orange-500/10 to-orange-600/5 border-orange-500/20" data-testid="card-suppliers-cc-total">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-orange-500/20 flex items-center justify-center">
                <Scale className="h-5 w-5 text-orange-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Saldo a Pagar</p>
                {Object.keys(ccTotalsByCurrency).length === 0 ? (
                  <p className="text-lg font-bold text-orange-400" data-testid="text-cc-total">Al día</p>
                ) : (
                  Object.entries(ccTotalsByCurrency).map(([curr, total]) => (
                    <p key={curr} className="text-lg font-bold tabular-nums" data-testid={`text-cc-total-${curr}`}>
                      {getCurrencySymbol(curr)} {total.toLocaleString('es-AR', { minimumFractionDigits: 0 })}
                    </p>
                  ))
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nombre, email o CUIT..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
            data-testid="input-search-suppliers"
          />
        </div>
        {supplierTypes.length > 0 && (
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger className="w-[160px]" data-testid="filter-supplier-type">
              <SelectValue placeholder="Tipo" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los tipos</SelectItem>
              {supplierTypes.map(t => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="flex items-center gap-2">
          <Switch
            id="show-inactive"
            checked={showInactive}
            onCheckedChange={setShowInactive}
            data-testid="switch-show-inactive"
          />
          <label htmlFor="show-inactive" className="text-sm text-muted-foreground whitespace-nowrap">
            Inactivos
          </label>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead className="hidden md:table-cell">Contacto</TableHead>
                  <TableHead className="hidden md:table-cell">Tipo</TableHead>
                  <TableHead className="text-right">Saldo CC</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="hidden md:table-cell">Registro</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSuppliers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      {searchTerm || filterType !== 'all'
                        ? 'No se encontraron proveedores con esos filtros.'
                        : 'No hay proveedores registrados. Agregá el primero.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredSuppliers.map((supplier: Supplier) => {
                    const pendingBalance = getSupplierBalance(supplier.id);
                    return (
                      <TableRow key={supplier.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setViewSupplier(supplier)} data-testid={`row-supplier-${supplier.id}`}>
                        <TableCell>
                          <div>
                            <p className="font-medium">{supplier.name}</p>
                            {supplier.taxId && <p className="text-xs text-muted-foreground">{supplier.taxId}</p>}
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                          {supplier.email || supplier.phone || '-'}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {supplier.supplierType ? (
                            <Badge variant="outline" className="text-xs">{supplier.supplierType}</Badge>
                          ) : <span className="text-muted-foreground text-sm">-</span>}
                        </TableCell>
                        <TableCell className="text-right">
                          {pendingBalance !== 0 ? (
                            <span className={`font-mono text-sm font-medium ${pendingBalance < 0 ? 'text-red-500' : 'text-green-500'}`}>
                              {pendingBalance < 0 ? '-' : '+'} $ {Math.abs(pendingBalance).toLocaleString('es-AR', { minimumFractionDigits: 0 })}
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-sm">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={supplier.isActive ? 'default' : 'secondary'}
                            className={supplier.isActive ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30' : ''}
                          >
                            {supplier.isActive ? 'Activo' : 'Inactivo'}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                          {supplier.createdAt ? format(new Date(supplier.createdAt), 'dd/MM/yyyy') : '-'}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8" data-testid={`button-menu-supplier-${supplier.id}`} onClick={(e) => e.stopPropagation()}>
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setViewSupplier(supplier); }}>
                                <Eye className="mr-2 h-4 w-4" /> Ver detalle
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleEditOpen(supplier); }}>
                                <Pencil className="mr-2 h-4 w-4" /> Editar
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); toggleActive(supplier); }}>
                                {supplier.isActive ? 'Desactivar' : 'Activar'}
                              </DropdownMenuItem>
                              {(supplier as any).archivedAt && (
                                <DropdownMenuItem
                                  onClick={(e) => { e.stopPropagation(); unarchiveSupplierMutation.mutate(supplier.id); }}
                                  disabled={unarchiveSupplierMutation.isPending}
                                  data-testid={`button-restore-supplier-${supplier.id}`}
                                >
                                  <RotateCcw className="mr-2 h-4 w-4" /> Restaurar
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={(e) => { e.stopPropagation(); setDeleteSupplierId(supplier.id); }}
                              >
                                <Trash2 className="mr-2 h-4 w-4" /> Eliminar
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!editSupplier} onOpenChange={() => setEditSupplier(null)}>
        <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Editar Proveedor</DialogTitle></DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(onEditSubmit)}>
              <SupplierFormFields formInstance={editForm} testIdPrefix="edit-" />
              <DialogFooter className="mt-6">
                <Button type="submit" disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? 'Guardando...' : 'Guardar'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
          {editSupplier && (
            <div className="mt-6">
              <SupplierInvoiceEmailPrefsEditor supplierId={editSupplier.id} supplierEmail={editSupplier.email} />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* View Supplier Detail Dialog - Cuenta Corriente */}
      <Dialog open={!!viewSupplier} onOpenChange={() => { setViewSupplier(null); setCCPeriodFilter('all'); }}>
        <DialogContent className="sm:max-w-[900px] max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-primary" />
              <span className="truncate">Cuenta Corriente - {viewSupplier?.name}</span>
            </DialogTitle>
          </DialogHeader>
          {viewSupplier && (() => {
            const filteredTxs = getFilteredSupplierTransactions(viewSupplier.id);
            const { movements, totalDebe, totalHaber, saldoFinal } = calculateSupplierCC(filteredTxs);
            const allTxs = getSupplierTransactions(viewSupplier.id);
            const allCC = calculateSupplierCC(allTxs);
            const hasContactInfo = viewSupplier.taxId || viewSupplier.email || viewSupplier.phone || viewSupplier.address;
            
            return (
              <div className="space-y-3 sm:space-y-4">
                <div className={`w-full px-4 py-2 rounded-lg ${allCC.saldoFinal < 0 ? 'bg-red-50 border border-red-200' : allCC.saldoFinal > 0 ? 'bg-green-50 border border-green-200' : 'bg-gray-50 dark:bg-slate-900 border'}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Saldo Actual</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {allCC.saldoFinal < 0 ? 'Debemos' : allCC.saldoFinal > 0 ? 'A favor nuestro' : 'Al día'}
                      </span>
                      {Object.values(allCC.byCurrency).some(c => c.saldo !== 0) && canCreate && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs gap-1 hover:bg-cyan-100 hover:text-cyan-700 transition-colors cursor-pointer"
                          onClick={() => setShowReconcileDialog(true)}
                          data-testid="button-reconcile-supplier"
                        >
                          <Scale className="h-3 w-3" />
                          Conciliar
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className={`text-xl font-bold text-center ${allCC.saldoFinal < 0 ? 'text-red-600' : allCC.saldoFinal > 0 ? 'text-green-600' : ''}`}>
                    $ {Math.abs(allCC.saldoFinal).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                  </p>
                </div>

                <Dialog open={showReconcileDialog} onOpenChange={setShowReconcileDialog}>
                  <DialogContent className="sm:max-w-[420px]">
                    <DialogHeader>
                      <DialogTitle className="flex items-center gap-2">
                        <Scale className="h-5 w-5 text-primary" />
                        Conciliar cuenta corriente
                      </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div className="rounded-lg border p-3 space-y-2">
                        <p className="text-xs text-muted-foreground font-medium">Saldos a conciliar</p>
                        {Object.entries(allCC.byCurrency).filter(([, d]) => d.saldo !== 0).map(([curr, data]) => (
                          <div key={curr} className="flex items-center justify-between">
                            <span className="text-sm font-medium">{curr}</span>
                            <span className={`text-sm font-bold ${data.saldo < 0 ? 'text-red-600' : 'text-green-600'}`}>
                              {getCurrencySymbol(curr)} {Math.abs(data.saldo).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                              <span className="text-xs text-muted-foreground ml-1">
                                ({data.saldo < 0 ? 'pendiente de pago' : 'a favor nuestro'})
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>

                      <div className="space-y-2">
                        <label className="text-sm font-medium">Motivo</label>
                        <Select value={reconcileReason} onValueChange={setReconcileReason}>
                          <SelectTrigger data-testid="select-reconcile-reason-supplier">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {RECONCILE_REASONS.map(r => (
                              <SelectItem key={r} value={r}>{r}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {reconcileReason === 'Otro' && (
                        <div className="space-y-2">
                          <label className="text-sm font-medium">Describí el motivo</label>
                          <Input
                            value={reconcileCustomReason}
                            onChange={e => setReconcileCustomReason(e.target.value)}
                            placeholder="Ej: Compensación por servicio"
                            data-testid="input-reconcile-custom-reason-supplier"
                          />
                        </div>
                      )}

                      <p className="text-xs text-muted-foreground">
                        Se generará un movimiento de ajuste por cada moneda con saldo pendiente. La cuenta corriente quedará en cero.
                      </p>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setShowReconcileDialog(false)}>
                        Cancelar
                      </Button>
                      <Button
                        onClick={handleReconcile}
                        disabled={isReconciling || (reconcileReason === 'Otro' && !reconcileCustomReason.trim())}
                        data-testid="button-confirm-reconcile-supplier"
                      >
                        {isReconciling ? 'Conciliando...' : 'Conciliar'}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                {hasContactInfo && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    {viewSupplier.taxId && (
                      <div>
                        <span className="text-muted-foreground text-xs">CUIT/CUIL</span>
                        <p className="font-medium">{viewSupplier.taxId}</p>
                      </div>
                    )}
                    {viewSupplier.email && (
                      <div>
                        <span className="text-muted-foreground text-xs">Email</span>
                        <p className="font-medium truncate">{viewSupplier.email}</p>
                      </div>
                    )}
                    {viewSupplier.phone && (
                      <div>
                        <span className="text-muted-foreground text-xs">Teléfono</span>
                        <p className="font-medium">{viewSupplier.phone}</p>
                      </div>
                    )}
                    {viewSupplier.address && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground text-xs">Dirección</span>
                        <p className="font-medium">{viewSupplier.address}</p>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                  <div className="flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    <Select value={ccPeriodFilter} onValueChange={setCCPeriodFilter}>
                      <SelectTrigger className="w-[160px] sm:w-[180px] h-8" data-testid="select-cc-period-supplier">
                        <SelectValue placeholder="Período" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Todo el historial</SelectItem>
                        <SelectItem value="current_month">Este mes</SelectItem>
                        <SelectItem value="last_month">Mes anterior</SelectItem>
                        <SelectItem value="last_3_months">Últimos 3 meses</SelectItem>
                        <SelectItem value="last_6_months">Últimos 6 meses</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="flex gap-2">
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => exportCCtoCSV(viewSupplier, movements, totalDebe, totalHaber, saldoFinal)}
                      disabled={movements.length === 0}
                      data-testid="button-export-csv-supplier"
                    >
                      <Download className="h-4 w-4 mr-1" /> CSV
                    </Button>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => exportCCtoPDF(viewSupplier, movements, totalDebe, totalHaber, saldoFinal)}
                      disabled={movements.length === 0}
                      data-testid="button-export-pdf-supplier"
                    >
                      <FileText className="h-4 w-4 mr-1" /> PDF
                    </Button>
                  </div>
                </div>

                {movements.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center border rounded-lg">
                    <FileText className="h-10 w-10 text-muted-foreground mb-3" />
                    <p className="text-muted-foreground">No hay movimientos en el período seleccionado</p>
                  </div>
                ) : (
                  <>
                    {/* Mobile card layout */}
                    <div className="sm:hidden space-y-2 max-h-[320px] overflow-y-auto border rounded-lg p-2" data-testid="cc-mobile-list-supplier">
                      {movements.map((m) => {
                        const symbol = m.currency === 'USD' || m.currency === 'USD_CASH' ? 'US$' : m.currency === 'EUR' ? '€' : '$';
                        const isCancelled = m.description.startsWith('[CANCELACIÓN]');
                        return (
                          <div key={m.id} className="border rounded-lg p-2.5 space-y-1.5 bg-card" data-testid={`cc-card-supplier-${m.id}`}>
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <p className="text-xs text-muted-foreground">{format(m.date, 'dd/MM/yy')}</p>
                                <p className="text-sm font-medium truncate">{m.description}</p>
                              </div>
                              <Badge variant={isCancelled ? 'destructive' : m.status === 'completed' ? 'default' : 'secondary'} className="text-[10px] shrink-0">
                                {isCancelled ? 'Cancelado' : m.status === 'completed' ? 'Pagado' : 'Pendiente'}
                              </Badge>
                            </div>
                            <div className="flex items-center justify-between text-xs border-t pt-1.5">
                              <div className="flex gap-3">
                                <span className="text-red-600">
                                  Debe: {m.debe > 0 ? `${symbol} ${m.debe.toLocaleString('es-AR', { minimumFractionDigits: 2 })}` : '-'}
                                </span>
                                <span className="text-green-600">
                                  Haber: {m.haber > 0 ? `${symbol} ${m.haber.toLocaleString('es-AR', { minimumFractionDigits: 2 })}` : '-'}
                                </span>
                              </div>
                              <span className={`font-bold ${m.saldo < 0 ? 'text-red-600' : m.saldo > 0 ? 'text-green-600' : ''}`}>
                                {symbol} {m.saldo.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                      <div className="border rounded-lg p-2.5 bg-muted/50 font-bold" data-testid="cc-totals-mobile-supplier">
                        <div className="flex items-center justify-between text-xs">
                          <span>TOTALES</span>
                          <span className={`${saldoFinal < 0 ? 'text-red-600' : saldoFinal > 0 ? 'text-green-600' : ''}`}>
                            $ {saldoFinal.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                          </span>
                        </div>
                        <div className="flex gap-3 text-xs mt-1">
                          <span className="text-red-600">Debe: $ {totalDebe.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                          <span className="text-green-600">Haber: $ {totalHaber.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                        </div>
                      </div>
                    </div>

                    {/* Desktop table layout */}
                    <ScrollArea className="hidden sm:block h-[320px] border rounded-lg">
                      <Table>
                        <TableHeader className="sticky top-0 bg-background">
                          <TableRow>
                            <TableHead className="w-[90px]">Fecha</TableHead>
                            <TableHead>Descripción</TableHead>
                            <TableHead className="w-[60px] text-center">Moneda</TableHead>
                            <TableHead className="w-[80px]">Estado</TableHead>
                            <TableHead className="text-right w-[100px]">Debe</TableHead>
                            <TableHead className="text-right w-[100px]">Haber</TableHead>
                            <TableHead className="text-right w-[100px]">Saldo</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {movements.map((m) => {
                            const symbol = m.currency === 'USD' || m.currency === 'USD_CASH' ? 'US$' : m.currency === 'EUR' ? '€' : '$';
                            return (
                              <TableRow key={m.id}>
                                <TableCell className="text-sm">{format(m.date, 'dd/MM/yy')}</TableCell>
                                <TableCell className="text-sm font-medium">{m.description}</TableCell>
                                <TableCell className="text-center text-xs text-muted-foreground">{m.currency}</TableCell>
                                <TableCell>
                                  <Badge variant={m.description.startsWith('[CANCELACIÓN]') ? 'destructive' : m.status === 'completed' ? 'default' : 'secondary'} className="text-xs">
                                    {m.description.startsWith('[CANCELACIÓN]') ? 'Cancelado' : m.status === 'completed' ? 'Pagado' : 'Pendiente'}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-right text-red-600 font-medium">
                                  {m.debe > 0 ? `${symbol} ${m.debe.toLocaleString('es-AR', { minimumFractionDigits: 2 })}` : '-'}
                                </TableCell>
                                <TableCell className="text-right text-green-600 font-medium">
                                  {m.haber > 0 ? `${symbol} ${m.haber.toLocaleString('es-AR', { minimumFractionDigits: 2 })}` : '-'}
                                </TableCell>
                                <TableCell className={`text-right font-bold ${m.saldo < 0 ? 'text-red-600' : m.saldo > 0 ? 'text-green-600' : ''}`}>
                                  {symbol} {m.saldo.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                          <TableRow className="bg-muted/50 font-bold">
                            <TableCell colSpan={4} className="text-right">TOTALES</TableCell>
                            <TableCell className="text-right text-red-600">
                              $ {totalDebe.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                            </TableCell>
                            <TableCell className="text-right text-green-600">
                              $ {totalHaber.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                            </TableCell>
                            <TableCell className={`text-right ${saldoFinal < 0 ? 'text-red-600' : saldoFinal > 0 ? 'text-green-600' : ''}`}>
                              $ {saldoFinal.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                            </TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </ScrollArea>
                  </>
                )}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation - Task #363 */}
      <AlertDialog
        open={!!deleteSupplierId}
        onOpenChange={(open) => {
          if (!open) { setDeleteSupplierId(null); setForceDeleteSupplier(false); }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar proveedor?</AlertDialogTitle>
            <AlertDialogDescription>
              Si el proveedor no tiene movimientos asociados, se elimina y podés deshacerlo por unos segundos.
              Si tiene historia, en vez de borrarlo se archiva para preservar tus reportes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {canForceDelete && (
            <label className="flex items-start gap-2 text-sm rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <input
                type="checkbox"
                checked={forceDeleteSupplier}
                onChange={(e) => setForceDeleteSupplier(e.target.checked)}
                className="mt-0.5"
                data-testid="checkbox-force-delete-supplier"
              />
              <span>
                <span className="font-medium text-destructive">Eliminar definitivamente</span>
                <span className="block text-muted-foreground text-xs mt-0.5">
                  No se podrá deshacer. Falla si el proveedor tiene movimientos asociados.
                </span>
              </span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-supplier">Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteSupplier}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete-supplier"
            >
              {forceDeleteSupplier ? 'Eliminar definitivamente' : 'Eliminar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
