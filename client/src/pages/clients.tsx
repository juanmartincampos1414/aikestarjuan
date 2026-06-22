import React from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { clientAPI, transactionAPI, employeeAPI, getAuthToken, fetchWithAuth } from '@/lib/api';
import { useMembership, useExchangeRates } from '@/lib/hooks';
import { ROLE_PERMISSIONS, type Role, CURRENCY_SYMBOLS, CLIENT_STATUSES, CLIENT_STATUS_LABELS, CONTRACT_TYPE_LABELS, CLIENT_TYPES, CLIENT_TYPE_LABELS, TAX_IVA_CONDITION_LABELS, CURRENCIES, type SubscriptionPlan } from '@shared/schema';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useUndoDelete } from '@/hooks/use-undo-delete';
import { Users, Plus, Trash2, Pencil, MoreVertical, Phone, Mail, MapPin, FileText, Eye, ArrowUpRight, ArrowDownRight, ShieldAlert, Download, Upload, CheckCircle2, Calendar, Search, UserCheck, UserX, Clock, TrendingUp, FolderOpen, X, SlidersHorizontal, ChevronDown, Scale, Maximize2, Minimize2, FileSpreadsheet, FileArchive, FileBarChart, Loader2, Send, Repeat, Settings, Package, AlertTriangle, RotateCcw, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import { Checkbox } from '@/components/ui/checkbox';
import { BackButton } from '@/components/BackButton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CreatableCombobox } from '@/components/ui/creatable-combobox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { format, startOfMonth, endOfMonth, subMonths } from 'date-fns';
import { es } from 'date-fns/locale';
import type { Client, Transaction } from '@shared/schema';
import { normalizeAmountInput } from '@/lib/currency';
import { safeParseDate, filterCancellationPairs, getEffectiveTransactionDate, getArgentinaToday } from '@/lib/utils';
import { type CCMovement, type CCTotalsByCurrency, normalizeCurrencyKey, getCurrencySymbol, calculateClientCC, calculateAllClientsCCTotal } from '@/lib/cc-utils';

function escapeCSVField(field: string): string {
  if (field.includes(',') || field.includes('"') || field.includes('\n')) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

function exportCCtoCSV(client: Client, movements: CCMovement[], totalDebe: number, totalHaber: number, saldoFinal: number) {
  const headers = ['Fecha', 'Descripción', 'Moneda', 'Estado', 'Debe', 'Haber', 'Saldo'];
  const rows = movements.map(m => [
    format(m.date, 'dd/MM/yyyy'),
    escapeCSVField(m.description),
    m.currency,
    (m.type === 'expense' || m.type === 'payable') ? 'Ajuste' : m.status === 'completed' ? 'Cobrado' : 'Pendiente',
    m.debe > 0 ? m.debe.toFixed(2) : '',
    m.haber > 0 ? m.haber.toFixed(2) : '',
    m.saldo.toFixed(2)
  ]);
  
  rows.push(['', '', '', '', '', '', '']);
  rows.push(['', 'TOTALES', '', '', totalDebe.toFixed(2), totalHaber.toFixed(2), saldoFinal.toFixed(2)]);
  
  const csvContent = [
    escapeCSVField(`Cuenta Corriente - ${client.name}`),
    `CUIT;${client.taxId || 'N/A'}`,
    `Generado;${format(new Date(), 'dd/MM/yyyy HH:mm')}`,
    '',
    headers.join(';'),
    ...rows.map(r => r.join(';'))
  ].join('\n');
  
  const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `CC_${client.name.replace(/\s+/g, '_')}_${format(new Date(), 'yyyyMMdd')}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function exportCCtoPDF(client: Client, movements: CCMovement[], totalDebe: number, totalHaber: number, saldoFinal: number) {
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
      <title>Cuenta Corriente - ${client.name}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; color: #333; }
        .header { border-bottom: 2px solid #0ea5e9; padding-bottom: 20px; margin-bottom: 20px; }
        .header h1 { margin: 0; color: #0ea5e9; font-size: 24px; }
        .header p { margin: 5px 0; color: #666; }
        .client-info { background: #f8fafc; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
        .client-info h2 { margin: 0 0 10px; font-size: 18px; }
        .client-info p { margin: 3px 0; font-size: 14px; }
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
        <h1>CUENTA CORRIENTE</h1>
        <p>Generado: ${format(new Date(), "dd 'de' MMMM 'de' yyyy, HH:mm", { locale: es })}</p>
      </div>
      
      <div class="client-info">
        <h2>${client.name}</h2>
        ${client.taxId ? `<p><strong>CUIT:</strong> ${client.taxId}</p>` : ''}
        ${client.email ? `<p><strong>Email:</strong> ${client.email}</p>` : ''}
        ${client.phone ? `<p><strong>Teléfono:</strong> ${client.phone}</p>` : ''}
        ${client.address ? `<p><strong>Dirección:</strong> ${client.address}</p>` : ''}
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
              <td>${(m.type === 'expense' || m.type === 'payable') ? 'Ajuste' : m.status === 'completed' ? 'Cobrado' : 'Pendiente'}</td>
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

function formatSaldoByCurrency(byCurrency: CCTotalsByCurrency): string {
  const entries = Object.entries(byCurrency).filter(([, d]) => d.saldo !== 0);
  if (!entries.length) return 'Al día';
  return entries
    .map(([curr, d]) => `${getCurrencySymbol(curr)} ${d.saldo.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`)
    .join(' / ');
}

type ClientExportRow = {
  nombre: string; email: string; telefono: string; cuit: string;
  iva: string; tipo: string; direccion: string; notas: string;
  estado: string; saldo: string;
};

function buildClientsListWorkbook(rows: ClientExportRow[]): XLSX.WorkBook {
  const data = rows.map((r) => ({
    'Nombre': r.nombre,
    'Email': r.email,
    'Teléfono': r.telefono,
    'CUIT/CUIL': r.cuit,
    'Condición IVA': r.iva,
    'Tipo de cliente': r.tipo,
    'Dirección': r.direccion,
    'Notas': r.notas,
    'Estado': r.estado,
    'Saldo cuenta corriente': r.saldo,
  }));
  const ws = XLSX.utils.json_to_sheet(data, {
    header: ['Nombre', 'Email', 'Teléfono', 'CUIT/CUIL', 'Condición IVA', 'Tipo de cliente', 'Dirección', 'Notas', 'Estado', 'Saldo cuenta corriente'],
  });
  ws['!cols'] = [
    { wch: 30 }, { wch: 26 }, { wch: 18 }, { wch: 16 }, { wch: 20 },
    { wch: 16 }, { wch: 32 }, { wch: 30 }, { wch: 12 }, { wch: 22 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Clientes');
  return wb;
}

function exportClientsListToPDF(rows: ClientExportRow[]) {
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
      <title>Lista de Clientes</title>
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
        <h1>LISTA DE CLIENTES</h1>
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

interface ClientEmployee {
  employeeId: string;
  fullName: string;
  contractType: string;
  grossSalary: string;
  currency: string;
  status: string;
  projectId: string;
  projectName: string;
  percentage: string;
  commissionRate: string;
}

function ClientProfitabilitySection({ clientId, clientTransactions }: { clientId: string; clientTransactions: Transaction[] }) {
  const { data: team = [], isLoading } = useQuery<ClientEmployee[]>({
    queryKey: ['/api/clients', clientId, 'employees'],
    queryFn: () => clientAPI.getEmployees(clientId),
    enabled: !!clientId,
  });
  const { data: exchangeRates } = useExchangeRates();
  const usdRate = exchangeRates?.usdToLocal || 1050;
  const isRateLive = !!exchangeRates?.usdToLocal;

  if (isLoading) {
    return (
      <div className="py-2">
        <p className="text-xs text-muted-foreground">Calculando rentabilidad...</p>
      </div>
    );
  }

  const pendingStatuses = ['scheduled'];
  const revenueByCurrency: Record<string, number> = {};
  clientTransactions
    .filter(tx =>
      tx.type === 'receivable' &&
      !tx.isUniquePayment &&
      pendingStatuses.includes(tx.status) &&
      !(tx.description || '').startsWith('[CANCELACIÓN]')
    )
    .forEach(tx => {
      const curr = normalizeCurrencyKey(tx.currency || 'ARS');
      revenueByCurrency[curr] = (revenueByCurrency[curr] || 0) + (normalizeAmountInput(tx.amount) || 0);
    });

  const revenueCurrencies = Object.keys(revenueByCurrency);
  const totalRevenueAllCurrenciesInARS = revenueCurrencies.reduce((sum, curr) => {
    const amount = revenueByCurrency[curr] || 0;
    return sum + (curr === 'USD' ? amount * usdRate : amount);
  }, 0);

  const convertCost = (amount: number, fromCurr: string, toCurr: string): number => {
    if (fromCurr === toCurr) return amount;
    if (fromCurr === 'ARS' && toCurr === 'USD') return amount / usdRate;
    if (fromCurr === 'USD' && toCurr === 'ARS') return amount * usdRate;
    return amount;
  };

  const costByCurrency: Record<string, number> = {};
  let hadConversion = false;

  if (revenueCurrencies.length === 0) {
    team.forEach(emp => {
      const pct = parseFloat(emp.percentage) || 0;
      const gross = parseFloat(emp.grossSalary) || 0;
      const curr = normalizeCurrencyKey(emp.currency || 'ARS');
      costByCurrency[curr] = (costByCurrency[curr] || 0) + (gross * pct) / 100;
    });
  } else if (revenueCurrencies.length === 1) {
    const targetCurr = revenueCurrencies[0];
    team.forEach(emp => {
      const pct = parseFloat(emp.percentage) || 0;
      const gross = parseFloat(emp.grossSalary) || 0;
      const empCurr = normalizeCurrencyKey(emp.currency || 'ARS');
      const costInEmpCurr = (gross * pct) / 100;
      const converted = convertCost(costInEmpCurr, empCurr, targetCurr);
      if (empCurr !== targetCurr && costInEmpCurr > 0) hadConversion = true;
      costByCurrency[targetCurr] = (costByCurrency[targetCurr] || 0) + converted;
    });
  } else {
    team.forEach(emp => {
      const pct = parseFloat(emp.percentage) || 0;
      const gross = parseFloat(emp.grossSalary) || 0;
      const empCurr = normalizeCurrencyKey(emp.currency || 'ARS');
      const costInEmpCurr = (gross * pct) / 100;
      const costInARS = empCurr === 'USD' ? costInEmpCurr * usdRate : costInEmpCurr;

      for (const revCurr of revenueCurrencies) {
        const revInARS = revCurr === 'USD' ? (revenueByCurrency[revCurr] || 0) * usdRate : (revenueByCurrency[revCurr] || 0);
        const proportion = totalRevenueAllCurrenciesInARS > 0 ? revInARS / totalRevenueAllCurrenciesInARS : 0;
        const costShareInARS = costInARS * proportion;
        const costShareInRevCurr = revCurr === 'USD' ? costShareInARS / usdRate : costShareInARS;
        if (empCurr !== revCurr && costInEmpCurr > 0) hadConversion = true;
        costByCurrency[revCurr] = (costByCurrency[revCurr] || 0) + costShareInRevCurr;
      }
    });
  }

  const allCurrencies = revenueCurrencies.length > 0
    ? revenueCurrencies.sort((a, b) => a === 'ARS' ? -1 : b === 'ARS' ? 1 : a.localeCompare(b))
    : [...new Set(Object.keys(costByCurrency))].sort((a, b) => a === 'ARS' ? -1 : b === 'ARS' ? 1 : a.localeCompare(b));
  const hasMultiCurrency = allCurrencies.length > 1;

  const formatMoneyWithSymbol = (val: number, curr: string) =>
    `${getCurrencySymbol(curr)} ${Math.abs(val).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

  const totalRevenue = Object.values(revenueByCurrency).reduce((s, v) => s + v, 0);
  const totalCost = Object.values(costByCurrency).reduce((s, v) => s + v, 0);

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground font-medium flex items-center gap-1.5">
        <TrendingUp className="h-3.5 w-3.5" />
        Rentabilidad
      </p>
      {allCurrencies.length === 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="rounded-lg border px-3 py-2" data-testid="profitability-revenue">
            <p className="text-[10px] text-muted-foreground">Ingreso fijo</p>
            <p className="text-sm font-mono font-bold text-green-500">$ 0</p>
          </div>
          <div className="rounded-lg border px-3 py-2" data-testid="profitability-cost">
            <p className="text-[10px] text-muted-foreground">Costo equipo</p>
            <p className="text-sm font-mono font-bold text-red-400">$ 0</p>
          </div>
          <div className="rounded-lg border px-3 py-2 border-green-500/30 bg-green-500/5" data-testid="profitability-result">
            <p className="text-[10px] text-muted-foreground">Resultado</p>
            <p className="text-sm font-mono font-bold text-green-500">$ 0</p>
          </div>
          <div className="rounded-lg border px-3 py-2 border-green-500/30 bg-green-500/5" data-testid="profitability-margin">
            <p className="text-[10px] text-muted-foreground">Margen</p>
            <p className="text-sm font-mono font-bold text-green-500">-</p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {allCurrencies.map(curr => {
            const revenue = revenueByCurrency[curr] || 0;
            const cost = costByCurrency[curr] || 0;
            const profit = revenue - cost;
            const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

            return (
              <div key={curr}>
                {hasMultiCurrency && (
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">{curr}</p>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="rounded-lg border px-3 py-2" data-testid={`profitability-revenue-${curr}`}>
                    <p className="text-[10px] text-muted-foreground">Ingreso fijo</p>
                    <p className="text-sm font-mono font-bold text-green-500">{formatMoneyWithSymbol(revenue, curr)}</p>
                  </div>
                  <div className="rounded-lg border px-3 py-2" data-testid={`profitability-cost-${curr}`}>
                    <p className="text-[10px] text-muted-foreground">Costo equipo</p>
                    <p className="text-sm font-mono font-bold text-red-400">{formatMoneyWithSymbol(cost, curr)}</p>
                  </div>
                  <div className={`rounded-lg border px-3 py-2 ${profit >= 0 ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'}`} data-testid={`profitability-result-${curr}`}>
                    <p className="text-[10px] text-muted-foreground">Resultado</p>
                    <p className={`text-sm font-mono font-bold ${profit >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      {profit >= 0 ? '' : '-'}{formatMoneyWithSymbol(profit, curr)}
                    </p>
                  </div>
                  <div className={`rounded-lg border px-3 py-2 ${margin >= 0 ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'}`} data-testid={`profitability-margin-${curr}`}>
                    <p className="text-[10px] text-muted-foreground">Margen</p>
                    <p className={`text-sm font-mono font-bold ${margin >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      {revenue > 0 ? `${margin.toFixed(1)}%` : '-'}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {hadConversion && (
        <p className="text-[10px] text-muted-foreground text-right" data-testid="profitability-exchange-rate">
          TC: ${usdRate.toLocaleString('es-AR')} USD/ARS{!isRateLive ? ' (estimado)' : ''}
        </p>
      )}
      {totalRevenue === 0 && totalCost === 0 && (
        <p className="text-[10px] text-muted-foreground text-center">Sin datos suficientes. Creá cobros recurrentes para este cliente y asigná empleados para ver la rentabilidad.</p>
      )}
    </div>
  );
}

function ClientProjectsAndTeamSection({ clientId }: { clientId: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [newProjectName, setNewProjectName] = React.useState('');
  const [adding, setAdding] = React.useState(false);
  const [editingProject, setEditingProject] = React.useState<{ id: string; name: string } | null>(null);
  const [editName, setEditName] = React.useState('');
  const [showAddTeamMember, setShowAddTeamMember] = React.useState(false);
  const [selectedEmployeeId, setSelectedEmployeeId] = React.useState('');
  const [selectedProjectId, setSelectedProjectId] = React.useState('');
  const [selectedCommission, setSelectedCommission] = React.useState('0');
  const [addingMember, setAddingMember] = React.useState(false);

  const { data: projects = [], isLoading: loadingProjects } = useQuery<{ id: string; name: string; description: string | null; isActive: boolean }[]>({
    queryKey: ['/api/clients', clientId, 'projects'],
    queryFn: () => clientAPI.getProjects(clientId),
    enabled: !!clientId,
  });

  const { data: team = [], isLoading: loadingTeam } = useQuery<ClientEmployee[]>({
    queryKey: ['/api/clients', clientId, 'employees'],
    queryFn: () => clientAPI.getEmployees(clientId),
    enabled: !!clientId,
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => clientAPI.createProject(clientId, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/clients', clientId, 'projects'] });
      setNewProjectName('');
      setAdding(false);
      toast({ title: 'Proyecto creado' });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ projectId, name }: { projectId: string; name: string }) => clientAPI.updateProject(clientId, projectId, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/clients', clientId, 'projects'] });
      setEditingProject(null);
      toast({ title: 'Proyecto actualizado' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (projectId: string) => clientAPI.deleteProject(clientId, projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/clients', clientId, 'projects'] });
      toast({ title: 'Proyecto eliminado' });
    },
  });

  const { data: allEmployees = [] } = useQuery<{ id: string; fullName: string; status: string; allocations?: { clientId: string }[] }[]>({
    queryKey: ['/api/employees'],
    queryFn: () => employeeAPI.getAll(),
    enabled: showAddTeamMember,
  });

  const availableEmployees = React.useMemo(() => {
    const assignedIds = new Set(team.map(t => t.employeeId));
    return allEmployees.filter(e => e.status === 'active' && !assignedIds.has(e.id));
  }, [allEmployees, team]);

  const handleAddTeamMember = async () => {
    if (!selectedEmployeeId) return;
    setAddingMember(true);
    try {
      const currentAllocations = await employeeAPI.getAllocations(selectedEmployeeId);
      const newAllocation = {
        clientId,
        projectId: selectedProjectId || undefined,
        projectName: selectedProjectId ? (projects.find(p => p.id === selectedProjectId)?.name || '') : '',
        percentage: '0',
        commissionRate: selectedCommission || '0',
      };
      type Allocation = { clientId: string; projectId?: string; projectName?: string; percentage: string; commissionRate?: string };
      const allAllocs: Allocation[] = [...(currentAllocations || []), newAllocation];
      const base = Math.floor(100 / allAllocs.length);
      const remainder = 100 - base * allAllocs.length;
      const redistributed = allAllocs.map((a, i) => ({
        ...a,
        percentage: (base + (i < remainder ? 1 : 0)).toString(),
      }));
      await employeeAPI.setAllocations(selectedEmployeeId, redistributed);
      queryClient.invalidateQueries({ queryKey: ['/api/clients', clientId, 'employees'] });
      queryClient.invalidateQueries({ queryKey: ['/api/allocations/by-organization'] });
      toast({ title: 'Empleado agregado al equipo' });
      setShowAddTeamMember(false);
      setSelectedEmployeeId('');
      setSelectedProjectId('');
      setSelectedCommission('0');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'No se pudo agregar';
      toast({ title: 'Error', description: message, variant: 'destructive' });
    } finally {
      setAddingMember(false);
    }
  };

  const handleAdd = () => {
    if (!newProjectName.trim()) return;
    createMutation.mutate(newProjectName.trim());
  };

  const handleEdit = () => {
    if (!editingProject || !editName.trim()) return;
    updateMutation.mutate({ projectId: editingProject.id, name: editName.trim() });
  };

  const formatSalary = (val: string, currency: string) => {
    const symbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || '$';
    const num = parseFloat(val) || 0;
    return `${symbol} ${num.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  const isLoading = loadingProjects || loadingTeam;

  const teamByProject = React.useMemo(() => {
    const groups: Record<string, ClientEmployee[]> = {};
    for (const emp of team) {
      const key = emp.projectId || '__none__';
      if (!groups[key]) groups[key] = [];
      groups[key].push(emp);
    }
    return groups;
  }, [team]);

  const renderTeamMembers = (members: ClientEmployee[]) => (
    <div className="space-y-1 mt-2">
      {members.map((emp, idx) => {
        const commRate = parseFloat(emp.commissionRate) || 0;
        return (
          <div key={`${emp.employeeId}-${idx}`} className="flex items-center justify-between gap-2 pl-4 pr-2 py-1.5 rounded bg-muted/30" data-testid={`team-member-${emp.employeeId}-${idx}`}>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{emp.fullName}</p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{CONTRACT_TYPE_LABELS[emp.contractType as keyof typeof CONTRACT_TYPE_LABELS] || emp.contractType}</span>
                {commRate > 0 && (
                  <>
                    <span>·</span>
                    <span>{commRate}% comisión</span>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );

  if (isLoading) {
    return <p className="text-xs text-muted-foreground py-2">Cargando proyectos y equipo...</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground font-medium flex items-center gap-1.5">
          <FolderOpen className="h-4 w-4" />
          Proyectos y equipo
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => setShowAddTeamMember(true)} data-testid="button-add-team-member">
            <Users className="h-3.5 w-3.5" /> Agregar al equipo
          </Button>
          {!adding && (
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => setAdding(true)} data-testid="button-add-project">
              <Plus className="h-3.5 w-3.5" /> Nuevo proyecto
            </Button>
          )}
        </div>
      </div>

      {adding && (
        <div className="flex items-center gap-2 p-2 rounded-lg bg-secondary/40 border">
          <Input
            placeholder="Nombre del proyecto"
            className="h-8 text-sm flex-1"
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            autoFocus
            data-testid="input-new-project-name"
          />
          <Button size="sm" className="h-8" onClick={handleAdd} disabled={createMutation.isPending || !newProjectName.trim()} data-testid="button-save-project">
            Crear
          </Button>
          <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => { setAdding(false); setNewProjectName(''); }}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {projects.length === 0 && team.length === 0 && !adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="w-full py-3 px-4 rounded-lg border-2 border-dashed hover:border-primary/40 hover:bg-secondary/30 transition-colors cursor-pointer"
          data-testid="text-no-projects"
        >
          <p className="text-xs text-muted-foreground text-center">Sin proyectos ni equipo. Hacé clic para agregar un proyecto.</p>
        </button>
      )}

      <div className="space-y-3">
        {projects.map((p) => {
          const projectMembers = teamByProject[p.id] || [];
          const isEditing = editingProject?.id === p.id;
          return (
            <div key={p.id} className="rounded-lg border overflow-hidden" data-testid={`project-${p.id}`}>
              <div className="group flex items-center justify-between px-3 py-2.5 bg-secondary/30">
                {isEditing ? (
                  <div className="flex items-center gap-2 flex-1">
                    <Input
                      className="h-7 text-sm flex-1"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleEdit()}
                      autoFocus
                      data-testid={`input-edit-project-${p.id}`}
                    />
                    <Button size="sm" className="h-7 text-xs" onClick={handleEdit} disabled={updateMutation.isPending || !editName.trim()}>
                      Guardar
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={() => setEditingProject(null)}>
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <FolderOpen className="h-4 w-4 text-primary" />
                      <span className="text-sm font-semibold">{p.name}</span>
                      {projectMembers.length > 0 && (
                        <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium">
                          {projectMembers.length} {projectMembers.length === 1 ? 'persona' : 'personas'}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => { setEditingProject(p); setEditName(p.name); }}
                        data-testid={`button-edit-project-${p.id}`}
                      >
                        <Pencil className="h-3 w-3 text-muted-foreground" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => deleteMutation.mutate(p.id)}
                        data-testid={`button-delete-project-${p.id}`}
                      >
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    </div>
                  </>
                )}
              </div>
              {projectMembers.length > 0 && (
                <div className="px-2 py-2">
                  {renderTeamMembers(projectMembers)}
                </div>
              )}
              {projectMembers.length === 0 && (
                <div className="px-3 py-2">
                  <p className="text-[11px] text-muted-foreground italic">Sin equipo asignado a este proyecto</p>
                </div>
              )}
            </div>
          );
        })}

        {(teamByProject['__none__'] || []).length > 0 && (
          <div className="rounded-lg border overflow-hidden" data-testid="team-general">
            <div className="flex items-center gap-2 px-3 py-2.5 bg-secondary/30">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold text-muted-foreground">Equipo general (sin proyecto)</span>
              <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full font-medium">
                {teamByProject['__none__'].length}
              </span>
            </div>
            <div className="px-2 py-2">
              {renderTeamMembers(teamByProject['__none__'])}
            </div>
          </div>
        )}
      </div>

      <AlertDialog open={showAddTeamMember} onOpenChange={(open) => { if (!open) { setShowAddTeamMember(false); setSelectedEmployeeId(''); setSelectedProjectId(''); setSelectedCommission('0'); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Agregar empleado al equipo</AlertDialogTitle>
            <AlertDialogDescription>
              Seleccioná un empleado para asignarlo a este cliente. Opcionalmente podés elegir un proyecto y porcentaje de comisión.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-sm font-medium mb-1.5 block">Empleado</label>
              <Select value={selectedEmployeeId} onValueChange={setSelectedEmployeeId}>
                <SelectTrigger data-testid="select-team-employee">
                  <SelectValue placeholder="Seleccionar empleado" />
                </SelectTrigger>
                <SelectContent>
                  {availableEmployees.map(e => (
                    <SelectItem key={e.id} value={e.id}>{e.fullName}</SelectItem>
                  ))}
                  {availableEmployees.length === 0 && (
                    <div className="px-2 py-3 text-xs text-muted-foreground text-center">No hay empleados disponibles</div>
                  )}
                </SelectContent>
              </Select>
            </div>
            {projects.length > 0 && (
              <div>
                <label className="text-sm font-medium mb-1.5 block">Proyecto (opcional)</label>
                <Select value={selectedProjectId || '__none__'} onValueChange={(v) => setSelectedProjectId(v === '__none__' ? '' : v)}>
                  <SelectTrigger data-testid="select-team-project">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Sin proyecto específico</SelectItem>
                    {projects.map(p => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <label className="text-sm font-medium mb-1.5 block">Comisión sobre ingresos (%)</label>
              <Input
                type="number"
                min="0"
                max="100"
                step="1"
                value={selectedCommission}
                onChange={(e) => setSelectedCommission(e.target.value)}
                className="w-24"
                data-testid="input-team-commission"
              />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <Button
              onClick={handleAddTeamMember}
              disabled={!selectedEmployeeId || addingMember}
              data-testid="button-confirm-add-team"
            >
              {addingMember ? 'Agregando...' : 'Agregar'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ClientInvoiceEmailPrefsEditor({ clientId, clientEmail }: { clientId: string; clientEmail?: string | null }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ clientId: string; defaultCcEmails: string[]; sendCopyToSelf: boolean }>({
    queryKey: ['/api/clients', clientId, 'invoice-email-prefs'],
    queryFn: () => clientAPI.getInvoiceEmailPrefs(clientId),
    enabled: !!clientId,
  });

  const [ccList, setCcList] = React.useState<string[]>([]);
  const [ccInput, setCcInput] = React.useState('');
  const [sendCopyToMe, setSendCopyToMe] = React.useState<boolean>(false);
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    if (data && !hydrated) {
      setCcList(Array.isArray(data.defaultCcEmails) ? data.defaultCcEmails : []);
      setSendCopyToMe(data.sendCopyToSelf === true);
      setHydrated(true);
    }
  }, [data, hydrated]);

  React.useEffect(() => {
    setHydrated(false);
  }, [clientId]);

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
    mutationFn: () => clientAPI.updateInvoiceEmailPrefs(clientId, {
      defaultCcEmails: ccList,
      sendCopyToSelf: sendCopyToMe,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/clients', clientId, 'invoice-email-prefs'] });
      toast({ title: 'Preferencias guardadas', description: 'Las preferencias de email del cliente se actualizaron.' });
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error?.message || 'No se pudieron guardar las preferencias', variant: 'destructive' });
    },
  });

  return (
    <div className="space-y-3 border rounded-lg p-4 bg-muted/20" data-testid="section-email-prefs">
      <div className="flex items-center gap-2">
        <Send className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Preferencias de email para facturación</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Estas preferencias se aplicarán por defecto al emitir una factura para este cliente.
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
              id={`send-copy-${clientId}`}
              checked={sendCopyToMe}
              onCheckedChange={(checked) => setSendCopyToMe(checked === true)}
              data-testid="checkbox-email-prefs-send-copy"
            />
            <label htmlFor={`send-copy-${clientId}`} className="text-sm cursor-pointer">
              Enviarme una copia (BCC) al emitir facturas a este cliente
            </label>
          </div>
          {!clientEmail && (
            <p className="text-[11px] text-amber-600" data-testid="text-email-prefs-no-client-email">
              ⚠️ Este cliente no tiene un email principal cargado. Agregalo arriba para poder enviar facturas por email.
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

const clientSchema = z.object({
  name: z.string().min(2, 'El nombre es requerido'),
  email: z.string().email('Email inválido').optional().or(z.literal('')),
  phone: z.string().optional(),
  address: z.string().optional(),
  taxId: z.string().optional(),
  notes: z.string().optional(),
  clientType: z.string().optional(),
  subscriberPlanId: z.string().optional(),
  subscriberQuantity: z.string().optional(),
  subscriberUnitPriceOverride: z.string().optional(),
  subscriberCurrencyOverride: z.string().optional(),
  subscriberBillingDay: z.string().optional(),
  subscriberStartMonth: z.string().optional(),
  status: z.enum(['active', 'potential', 'inactive']).default('active'),
});

type ClientFormValues = z.infer<typeof clientSchema>;

function ClientFormFields({ formInstance, testIdPrefix = '', plans = [], onManagePlans, originalClientType }: { formInstance: ReturnType<typeof useForm<ClientFormValues>>; testIdPrefix?: string; plans?: SubscriptionPlan[]; onManagePlans?: () => void; originalClientType?: string | null }) {
  const clientType = formInstance.watch('clientType');
  const normalizedCurrent = clientType && clientType !== '__none__' ? clientType : '';
  const normalizedOriginal = originalClientType || '';
  const typeChanged = originalClientType !== undefined && normalizedCurrent !== normalizedOriginal;
  const leavingSubscriber = typeChanged && normalizedOriginal === 'suscriptores' && normalizedCurrent !== 'suscriptores';
  const becomingSubscriber = typeChanged && normalizedOriginal !== 'suscriptores' && normalizedCurrent === 'suscriptores';
  const selectedPlanId = formInstance.watch('subscriberPlanId');
  const quantityStr = formInstance.watch('subscriberQuantity');
  const overridePriceStr = formInstance.watch('subscriberUnitPriceOverride');
  const overrideCurrency = formInstance.watch('subscriberCurrencyOverride');
  const selectedPlan = plans.find(p => p.id === selectedPlanId);
  const effectiveUnitPrice = overridePriceStr && overridePriceStr.trim() !== ''
    ? parseFloat(overridePriceStr.replace(',', '.'))
    : selectedPlan ? parseFloat(selectedPlan.monthlyPrice) : NaN;
  const effectiveCurrency = overrideCurrency || selectedPlan?.currency || 'ARS';
  const quantity = quantityStr ? parseInt(quantityStr, 10) : NaN;
  const total = Number.isFinite(effectiveUnitPrice) && Number.isFinite(quantity) ? effectiveUnitPrice * quantity : null;
  return (
    <div className="space-y-4">
      <FormField control={formInstance.control} name="name" render={({ field }) => (
        <FormItem>
          <FormLabel>Nombre *</FormLabel>
          <FormControl><Input placeholder="Nombre o razón social" {...field} data-testid={`input-${testIdPrefix}client-name`} /></FormControl>
          <FormMessage />
        </FormItem>
      )} />
      <div className="grid grid-cols-2 gap-4">
        <FormField control={formInstance.control} name="email" render={({ field }) => (
          <FormItem>
            <FormLabel>Email</FormLabel>
            <FormControl><Input type="email" placeholder="email@ejemplo.com" {...field} data-testid={`input-${testIdPrefix}client-email`} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={formInstance.control} name="phone" render={({ field }) => (
          <FormItem>
            <FormLabel>Teléfono</FormLabel>
            <FormControl><Input placeholder="+54 11 1234-5678" {...field} data-testid={`input-${testIdPrefix}client-phone`} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <FormField control={formInstance.control} name="taxId" render={({ field }) => (
          <FormItem>
            <FormLabel>CUIT/CUIL/DNI</FormLabel>
            <FormControl><Input placeholder="20-12345678-9" {...field} data-testid={`input-${testIdPrefix}client-taxid`} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={formInstance.control} name="clientType" render={({ field }) => {
          const suggested = CLIENT_TYPES.map(t => ({ value: t, label: CLIENT_TYPE_LABELS[t] }));
          const current = (field.value || '').trim();
          const isCustom = current && !CLIENT_TYPES.includes(current as any);
          const options = isCustom
            ? [...suggested, { value: current, label: current }]
            : suggested;
          return (
            <FormItem>
              <FormLabel>Tipo</FormLabel>
              <FormControl>
                <CreatableCombobox
                  options={options}
                  value={current}
                  onValueChange={(v) => field.onChange(v)}
                  onCreateOption={(v) => field.onChange(v.trim())}
                  placeholder="Elegí o escribí un tipo"
                  searchPlaceholder="Buscar o escribir nuevo..."
                  createText="Crear tipo"
                  data-testid={`select-${testIdPrefix}client-type`}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          );
        }} />
      </div>

      {(leavingSubscriber || becomingSubscriber) && (
        <div
          className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 flex gap-3 text-sm dark:bg-amber-500/15"
          data-testid={`alert-${testIdPrefix}client-type-change`}
        >
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-300 mt-0.5" />
          <div className="space-y-1 text-amber-900 dark:text-amber-100">
            {leavingSubscriber && (
              <>
                <div className="font-semibold">Vas a dejar de generarle cobros automáticos a este cliente.</div>
                <div className="text-amber-800/90 dark:text-amber-100/80">
                  Al cambiar el tipo de "Suscriptores" a "{normalizedCurrent ? (CLIENT_TYPE_LABELS as any)[normalizedCurrent] || normalizedCurrent : 'Sin tipo'}", el sistema deja de crear la cuenta a cobrar mensual automática. Las cuentas a cobrar ya generadas se mantienen como están.
                </div>
              </>
            )}
            {becomingSubscriber && (
              <>
                <div className="font-semibold">Vas a activar el cobro mensual automático.</div>
                <div className="text-amber-800/90 dark:text-amber-100/80">
                  Completá plan (o precio personalizado), cantidad de suscriptores, día de cobro y mes de inicio para que empiece a facturarse a partir del próximo ciclo.
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {clientType === 'suscriptores' && (
        <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-4 space-y-3" data-testid={`section-${testIdPrefix}subscriber`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-cyan-400">
              <Repeat className="h-4 w-4" /> Suscripción mensual
            </div>
            {onManagePlans && (
              <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={onManagePlans} data-testid={`button-${testIdPrefix}manage-plans`}>
                <Settings className="mr-1 h-3 w-3" /> Gestionar planes
              </Button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField control={formInstance.control} name="subscriberPlanId" render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">Plan</FormLabel>
                <Select onValueChange={field.onChange} value={field.value || ''}>
                  <FormControl>
                    <SelectTrigger data-testid={`select-${testIdPrefix}subscriber-plan`}>
                      <SelectValue placeholder={plans.length === 0 ? 'No hay planes — creá uno' : 'Elegí un plan'} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="__none__">Sin plan (usar precio manual)</SelectItem>
                    {plans.filter(p => p.isActive).map(p => (
                      <SelectItem key={p.id} value={p.id} data-testid={`option-plan-${p.id}`}>
                        {p.name} · {p.currency} {parseFloat(p.monthlyPrice).toLocaleString('es-AR')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={formInstance.control} name="subscriberQuantity" render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">Cantidad de suscriptores</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min="1"
                    inputMode="numeric"
                    placeholder="1"
                    {...field}
                    data-testid={`input-${testIdPrefix}subscriber-quantity`}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField control={formInstance.control} name="subscriberUnitPriceOverride" render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">Precio unitario {selectedPlan ? '(override)' : ''}</FormLabel>
                <FormControl>
                  <Input
                    type="text"
                    inputMode="decimal"
                    placeholder={selectedPlan ? `Usa ${selectedPlan.currency} ${parseFloat(selectedPlan.monthlyPrice).toLocaleString('es-AR')}` : 'Ej: 9999.00'}
                    {...field}
                    data-testid={`input-${testIdPrefix}subscriber-price`}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={formInstance.control} name="subscriberCurrencyOverride" render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">Moneda {selectedPlan ? '(override)' : ''}</FormLabel>
                <Select onValueChange={field.onChange} value={field.value || ''}>
                  <FormControl>
                    <SelectTrigger data-testid={`select-${testIdPrefix}subscriber-currency`}>
                      <SelectValue placeholder={selectedPlan ? selectedPlan.currency : 'ARS'} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="__none__">Usar la del plan</SelectItem>
                    {CURRENCIES.map(c => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField control={formInstance.control} name="subscriberBillingDay" render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">Día de facturación (1-28)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min="1"
                    max="28"
                    inputMode="numeric"
                    placeholder="1"
                    {...field}
                    data-testid={`input-${testIdPrefix}subscriber-day`}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={formInstance.control} name="subscriberStartMonth" render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">Mes de inicio</FormLabel>
                <FormControl>
                  <Input
                    type="month"
                    {...field}
                    data-testid={`input-${testIdPrefix}subscriber-start`}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />
          </div>
          {total != null && total > 0 && (
            <div className="text-sm text-muted-foreground" data-testid={`text-${testIdPrefix}subscriber-total`}>
              Cobro mensual estimado:{' '}
              <span className="font-semibold text-foreground">
                {effectiveCurrency} {total.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
              </span>
              {Number.isFinite(quantity) && Number.isFinite(effectiveUnitPrice) && (
                <span className="text-xs"> ({quantity} × {effectiveCurrency} {effectiveUnitPrice.toLocaleString('es-AR', { minimumFractionDigits: 2 })})</span>
              )}
            </div>
          )}
        </div>
      )}
      <FormField control={formInstance.control} name="status" render={({ field }) => (
        <FormItem>
          <FormLabel>Estado</FormLabel>
          <Select onValueChange={field.onChange} value={field.value}>
            <FormControl><SelectTrigger data-testid={`select-${testIdPrefix}client-status`}><SelectValue /></SelectTrigger></FormControl>
            <SelectContent>
              {CLIENT_STATUSES.map(s => (
                <SelectItem key={s} value={s}>{CLIENT_STATUS_LABELS[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )} />
      <FormField control={formInstance.control} name="address" render={({ field }) => (
        <FormItem>
          <FormLabel>Dirección</FormLabel>
          <FormControl><Input placeholder="Av. Corrientes 1234, CABA" {...field} data-testid={`input-${testIdPrefix}client-address`} /></FormControl>
          <FormMessage />
        </FormItem>
      )} />
      <FormField control={formInstance.control} name="notes" render={({ field }) => (
        <FormItem>
          <FormLabel>Notas</FormLabel>
          <FormControl><Textarea placeholder="Notas adicionales..." {...field} data-testid={`input-${testIdPrefix}client-notes`} /></FormControl>
          <FormMessage />
        </FormItem>
      )} />
    </div>
  );
}

function SubscriptionPlansDialog({ open, onOpenChange, plans }: { open: boolean; onOpenChange: (v: boolean) => void; plans: SubscriptionPlan[] }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<{ name: string; currency: string; monthlyPrice: string; isActive: boolean }>({ name: '', currency: 'ARS', monthlyPrice: '', isActive: true });

  const resetDraft = () => setDraft({ name: '', currency: 'ARS', monthlyPrice: '', isActive: true });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: draft.name.trim(),
        currency: draft.currency,
        monthlyPrice: draft.monthlyPrice.replace(',', '.'),
        isActive: draft.isActive,
      };
      if (editingId) {
        return fetchWithAuth(`/subscription-plans/${editingId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      }
      return fetchWithAuth('/subscription-plans', { method: 'POST', body: JSON.stringify(payload) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/subscription-plans'] });
      toast({ title: editingId ? 'Plan actualizado' : 'Plan creado' });
      setEditingId(null);
      resetDraft();
    },
    onError: (err: any) => toast({ title: 'Error', description: err?.message || 'No se pudo guardar el plan', variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => fetchWithAuth(`/subscription-plans/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/subscription-plans'] });
      queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
      toast({ title: 'Plan eliminado', description: 'Se desvincularon los clientes asociados.' });
    },
    onError: (err: any) => toast({ title: 'Error', description: err?.message || 'No se pudo eliminar', variant: 'destructive' }),
  });

  const startEdit = (plan: SubscriptionPlan) => {
    setEditingId(plan.id);
    setDraft({ name: plan.name, currency: plan.currency, monthlyPrice: plan.monthlyPrice, isActive: plan.isActive });
  };

  const cancelEdit = () => {
    setEditingId(null);
    resetDraft();
  };

  const handleSave = () => {
    if (!draft.name.trim()) {
      toast({ title: 'Falta el nombre del plan', variant: 'destructive' });
      return;
    }
    const price = parseFloat(draft.monthlyPrice.replace(',', '.'));
    if (!Number.isFinite(price) || price <= 0) {
      toast({ title: 'Precio inválido', description: 'Indicá un precio mensual mayor a 0.', variant: 'destructive' });
      return;
    }
    saveMutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) cancelEdit(); }}>
      <DialogContent className="sm:max-w-[640px] max-h-[90vh] overflow-y-auto" data-testid="dialog-subscription-plans">
        <DialogHeader>
          <DialogTitle>Planes de suscripción</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg border p-4 space-y-3 bg-muted/30">
            <div className="text-sm font-semibold">{editingId ? 'Editar plan' : 'Nuevo plan'}</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-1">
                <label className="text-xs text-muted-foreground">Nombre</label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Ej: Plan Básico"
                  data-testid="input-plan-name"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Moneda</label>
                <Select value={draft.currency} onValueChange={(v) => setDraft({ ...draft, currency: v })}>
                  <SelectTrigger data-testid="select-plan-currency"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Precio mensual</label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={draft.monthlyPrice}
                  onChange={(e) => setDraft({ ...draft, monthlyPrice: e.target.value })}
                  placeholder="0.00"
                  data-testid="input-plan-price"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.isActive}
                onCheckedChange={(checked) => setDraft({ ...draft, isActive: !!checked })}
                data-testid="checkbox-plan-active"
              />
              Plan activo
            </label>
            <div className="flex justify-end gap-2">
              {editingId && (
                <Button variant="outline" size="sm" onClick={cancelEdit} data-testid="button-plan-cancel">Cancelar</Button>
              )}
              <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending} data-testid="button-plan-save">
                {saveMutation.isPending ? 'Guardando...' : editingId ? 'Actualizar' : 'Crear plan'}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold">Planes existentes</div>
            {plans.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">Todavía no tenés planes creados.</p>
            ) : (
              <div className="border rounded-lg divide-y">
                {plans.map(p => (
                  <div key={p.id} className="flex items-center justify-between p-3" data-testid={`row-plan-${p.id}`}>
                    <div>
                      <div className="font-medium flex items-center gap-2">
                        {p.name}
                        {!p.isActive && <Badge variant="outline" className="text-xs">Inactivo</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {p.currency} {parseFloat(p.monthlyPrice).toLocaleString('es-AR', { minimumFractionDigits: 2 })} / mes
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => startEdit(p)} data-testid={`button-plan-edit-${p.id}`}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => {
                          if (confirm(`¿Eliminar el plan "${p.name}"? Los clientes con este plan quedarán sin plan asignado.`)) {
                            deleteMutation.mutate(p.id);
                          }
                        }}
                        disabled={deleteMutation.isPending}
                        data-testid={`button-plan-delete-${p.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

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

const CLIENT_EXPECTED_HEADERS = ['Nombre', 'Email', 'Teléfono', 'CUIT/CUIL', 'Condición IVA', 'Tipo de cliente', 'Dirección', 'Notas'];

// Columnas que el usuario puede editar en la vista previa antes de confirmar.
const CLIENT_IMPORT_EDIT_COLUMNS: { key: string; label: string; width: string }[] = [
  { key: 'Nombre', label: 'Nombre', width: 'w-40' },
  { key: 'Email', label: 'Email', width: 'w-48' },
  { key: 'Teléfono', label: 'Teléfono', width: 'w-32' },
  { key: 'CUIT/CUIL', label: 'CUIT/CUIL', width: 'w-32' },
  { key: 'Condición IVA', label: 'Condición IVA', width: 'w-40' },
  { key: 'Tipo de cliente', label: 'Tipo de cliente', width: 'w-36' },
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

function buildClientTemplateWorkbook(): XLSX.WorkBook {
  const exampleRows = [
    {
      'Nombre': 'Acme S.A.',
      'Email': 'contacto@acme.com',
      'Teléfono': '+54 11 4321-0000',
      'CUIT/CUIL': '30-12345678-9',
      'Condición IVA': 'Responsable Inscripto',
      'Tipo de cliente': 'Mayorista',
      'Dirección': 'Av. Corrientes 1234, CABA',
      'Notas': 'Cliente desde 2024',
    },
    {
      'Nombre': 'Juan Pérez',
      'Email': 'juan.perez@gmail.com',
      'Teléfono': '+54 9 11 5555-1234',
      'CUIT/CUIL': '20-30111222-3',
      'Condición IVA': 'Monotributo',
      'Tipo de cliente': 'Minorista',
      'Dirección': '',
      'Notas': '',
    },
  ];

  const ws = XLSX.utils.json_to_sheet(exampleRows, { header: CLIENT_EXPECTED_HEADERS });
  ws['!cols'] = [
    { wch: 28 }, { wch: 26 }, { wch: 18 }, { wch: 16 },
    { wch: 22 }, { wch: 16 }, { wch: 32 }, { wch: 30 },
  ];

  const instructions = [
    ['Columna', 'Obligatoria', 'Valores válidos / Formato'],
    ['Nombre', 'Sí', 'Texto libre. Es la única columna que no puede quedar vacía.'],
    ['Email', 'No', 'Email válido (ej: nombre@empresa.com). Si está mal escrito, esa fila da error.'],
    ['Teléfono', 'No', 'Texto libre.'],
    ['CUIT/CUIL', 'No', 'Si coincide con un cliente existente, se actualiza esa ficha.'],
    ['Condición IVA', 'No', 'Responsable Inscripto, Monotributo, IVA Exento o Consumidor Final.'],
    ['Tipo de cliente', 'No', 'Mayorista, Minorista, Fijo, Suscriptores u Otro. También se acepta texto libre.'],
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
  XLSX.utils.book_append_sheet(wb, ws, 'Clientes');
  XLSX.utils.book_append_sheet(wb, wsInst, 'Instrucciones');
  return wb;
}

function downloadClientTemplate() {
  const wb = buildClientTemplateWorkbook();
  XLSX.writeFile(wb, 'clientes-plantilla.xlsx');
}

function ImportClientsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
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
        const res = await clientAPI.bulkImport(rows, true) as ImportPreview;
        setEditableRows(rows.map((r) => extractCanonicalImportRow(r, CLIENT_EXPECTED_HEADERS)));
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
                <button type="button" onClick={() => downloadClientTemplate()} className="underline font-medium" data-testid="button-toast-download-template">
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
      const res = await clientAPI.bulkImport(editableRows, true) as ImportPreview;
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
      const res = await clientAPI.bulkImport(editableRows, false) as ImportPreview & { applyErrors?: any[] };
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
        queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
      } catch {
        // ignorar errores de invalidación: la próxima navegación recarga.
      }
      toast({
        title: errorCount > 0 ? 'Importación completada con errores' : 'Importación completada',
        description: `${successCount} cliente(s) procesado(s) correctamente${errorCount > 0 ? `, ${errorCount} con errores` : ''}.`,
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
      <DialogContent className={`${isMaximized ? 'sm:max-w-[98vw] w-[98vw] h-[95vh]' : 'sm:max-w-[1100px] w-[95vw] max-h-[90vh]'} overflow-y-auto transition-all duration-200`} data-testid="dialog-import-clients">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <span className="flex-1">Importar clientes desde Excel</span>
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
            Seguí estos pasos: 1) descargá la plantilla, 2) completá una fila por cliente, 3) subí el .xlsx y revisá la vista previa, 4) confirmá. El match con clientes existentes se hace por CUIT/CUIL; si no hay CUIT, por nombre exacto.
          </DialogDescription>
        </DialogHeader>

        {!preview && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-4 py-3">
              <div className="text-sm">
                <p className="font-medium">¿No sabés cómo armar el archivo?</p>
                <p className="text-muted-foreground text-xs">Descargá la plantilla con los encabezados correctos, dos filas de ejemplo y una hoja de instrucciones.</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={downloadClientTemplate} data-testid="button-download-clients-template">
                <FileSpreadsheet className="mr-2 h-4 w-4" />
                Descargar plantilla
              </Button>
            </div>
            <div className="rounded-md border border-dashed p-6 text-center bg-muted/30">
              <FileSpreadsheet className="h-10 w-10 mx-auto text-muted-foreground mb-3" aria-hidden="true" />
              <p className="text-sm text-muted-foreground mb-3">
                Columnas esperadas: {CLIENT_EXPECTED_HEADERS.join(', ')}
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
                data-testid="input-clients-import-file"
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
                    {CLIENT_IMPORT_EDIT_COLUMNS.map((col) => (
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
                      {CLIENT_IMPORT_EDIT_COLUMNS.map((col) => (
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
                          <span className="text-muted-foreground">Se actualizará el cliente existente</span>
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

export default function ClientsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { showUndoToast } = useUndoDelete();
  const { data: membership } = useMembership();
  const { data: exchangeRates } = useExchangeRates();
  const [isOpen, setIsOpen] = React.useState(false);
  const [isImportOpen, setIsImportOpen] = React.useState(false);
  const [editClient, setEditClient] = React.useState<Client | null>(null);
  const [deleteClientId, setDeleteClientId] = React.useState<string | null>(null);
  const [viewClient, setViewClient] = React.useState<Client | null>(null);
  const [exportingInvoices, setExportingInvoices] = React.useState<string | null>(null);
  const prevViewClientRef = React.useRef<Client | null>(null);

  async function downloadClientInvoices(clientId: string, format: 'xlsx' | 'pdf' | 'zip') {
    try {
      setExportingInvoices(format);
      const params = new URLSearchParams();
      params.set('clientId', clientId);
      const url = `/api/invoicing/invoices.${format}?${params.toString()}`;
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
      setExportingInvoices(null);
    }
  }
  React.useEffect(() => {
    if (viewClient?.id !== prevViewClientRef.current?.id) {
      setShowReconcileDialog(false);
      setReconcileReason('Ajuste por retenciones');
      setReconcileCustomReason('');
    }
    prevViewClientRef.current = viewClient;
  }, [viewClient]);
  const [searchTerm, setSearchTerm] = React.useState('');
  const [filterStatus, setFilterStatus] = React.useState<string>('all');
  const [filterType, setFilterType] = React.useState<string>('all');
  const [showScrollShadow, setShowScrollShadow] = React.useState(false);
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  const [visibleColumns, setVisibleColumns] = React.useState<Record<string, boolean>>({
    contacto: true,
    tipo: true,
    saldoCC: true,
    rentabilidad: true,
    estado: true,
    registro: true,
  });
  const toggleColumn = React.useCallback((col: string) => {
    setVisibleColumns(prev => ({ ...prev, [col]: !prev[col] }));
  }, []);
  
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

  const { data: clients = [], isLoading } = useQuery({
    queryKey: ['/api/clients', { includeArchived: true }],
    queryFn: () => clientAPI.getAll(false, { includeArchived: true }),
  });

  const { data: transactions = [] } = useQuery<Transaction[]>({
    queryKey: ['/api/transactions'],
    queryFn: () => transactionAPI.getAll(),
  });

  const { data: subscriptionPlans = [] } = useQuery<SubscriptionPlan[]>({
    queryKey: ['/api/subscription-plans'],
    queryFn: () => fetchWithAuth('/subscription-plans'),
  });

  const [isPlansDialogOpen, setIsPlansDialogOpen] = React.useState(false);
  const canManagePlans = userRole === 'admin' || userRole === 'owner';
  const runGenerateCharge = React.useCallback(async (clientId: string, opts: { force?: boolean } = {}) => {
    try {
      const data: any = await fetchWithAuth(`/clients/${clientId}/generate-subscription-charge`, {
        method: 'POST',
        body: JSON.stringify(opts.force ? { force: true } : {}),
      });
      queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
      const amount = data?.transaction?.amount;
      const currency = data?.transaction?.currency;
      toast({
        title: opts.force ? 'Cobro regenerado' : 'Cobro generado',
        description: amount
          ? `Se creó una cuenta a cobrar por ${currency} ${parseFloat(amount).toLocaleString('es-AR', { minimumFractionDigits: 2 })}.`
          : 'Se creó la cuenta a cobrar del mes.',
      });
    } catch (err: any) {
      const code = err?.code || '';
      const msg = err?.message || '';
      if (!opts.force && (code === 'already_billed' || msg.includes('Ya se generó el cobro'))) {
        const confirmed = typeof window !== 'undefined' && window.confirm(
          `${msg}\n\n¿Querés crear igual una cuenta a cobrar adicional para este mes?`
        );
        if (confirmed) {
          await runGenerateCharge(clientId, { force: true });
        }
        return;
      }
      if (code === 'not_subscriber') {
        toast({ title: 'No es un suscriptor', description: 'Configurá el tipo de cliente como Suscriptores.', variant: 'destructive' });
      } else if (code === 'no_quantity' || code === 'no_price') {
        toast({ title: 'Falta configuración', description: msg || 'Completá plan o precio y cantidad antes de generar el cobro.', variant: 'destructive' });
      } else if (code === 'before_start') {
        toast({ title: 'Todavía no inicia', description: msg, variant: 'destructive' });
      } else if (code === 'invalid_plan') {
        toast({ title: 'Plan inválido', description: msg, variant: 'destructive' });
      } else {
        toast({ title: 'Error al generar el cobro', description: msg || 'Intentá de nuevo.', variant: 'destructive' });
      }
    }
  }, [queryClient, toast]);

  const [generatingChargeId, setGeneratingChargeId] = React.useState<string | null>(null);
  const generateChargeMutation = { isPending: generatingChargeId != null };
  const handleGenerateCharge = async (client: Client) => {
    setGeneratingChargeId(client.id);
    try {
      await runGenerateCharge(client.id);
    } finally {
      setGeneratingChargeId(null);
    }
  };

  const { data: allocationsByClient = {} } = useQuery<Record<string, Array<{ grossSalary: string; currency: string; percentage: string; commissionRate: string }>>>({
    queryKey: ['/api/allocations/by-organization'],
    queryFn: () => clientAPI.getAllAllocations(),
  });

  const recalcScrollShadow = React.useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) { setShowScrollShadow(false); return; }
    const canScrollMore = el.scrollWidth > el.clientWidth && el.scrollLeft + el.clientWidth < el.scrollWidth - 10;
    setShowScrollShadow(canScrollMore);
  }, []);

  React.useEffect(() => {
    recalcScrollShadow();
    const el = scrollContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => recalcScrollShadow());
    observer.observe(el);
    return () => observer.disconnect();
  }, [recalcScrollShadow, clients, searchTerm, filterStatus, filterType]);

  const createMutation = useMutation({
    mutationFn: clientAPI.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
      // Task #315 — El POST puede generar (como side-effect) una cuenta a
      // cobrar del mes para clientes suscriptores. Invalidamos transacciones
      // para que el KPI "Saldo a Cobrar" y la columna "Saldo CC" se
      // refresquen sin recargar la página.
      queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
      toast({ title: "Cliente creado", description: "El cliente ha sido registrado exitosamente." });
      setIsOpen(false);
      form.reset();
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<ClientFormValues & { isActive: boolean }> }) =>
      clientAPI.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
      // Task #315 — Idem POST: editar puede haber generado un cobro nuevo.
      queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
      toast({ title: "Cliente actualizado" });
      setEditClient(null);
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  // Task #363
  const [forceDeleteClient, setForceDeleteClient] = React.useState(false);

  const deleteMutation = useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) => clientAPI.delete(id, { force }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const unarchiveClientMutation = useMutation({
    mutationFn: (id: string) => clientAPI.unarchive(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
      toast({ title: "Cliente restaurado" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const handleDeleteClient = async () => {
    if (!deleteClientId) return;
    const clientName = clients.find((c: Client) => c.id === deleteClientId)?.name;
    try {
      const result = await deleteMutation.mutateAsync({ id: deleteClientId, force: forceDeleteClient });
      setDeleteClientId(null);
      setForceDeleteClient(false);
      if (result?.archived) {
        toast({
          title: 'Cliente archivado',
          description: 'Tenía movimientos asociados, así que se conservó como archivado.',
        });
      } else if (result?.undoKey) {
        showUndoToast(result.undoKey, 'client', clientName);
      } else {
        toast({ title: 'Cliente eliminado' });
      }
    } catch {}
  };

  const form = useForm<ClientFormValues>({
    resolver: zodResolver(clientSchema),
    defaultValues: { name: '', email: '', phone: '', address: '', taxId: '', notes: '', clientType: '', subscriberPlanId: '', subscriberQuantity: '', subscriberUnitPriceOverride: '', subscriberCurrencyOverride: '', subscriberBillingDay: '', subscriberStartMonth: '', status: 'active' },
  });

  const editForm = useForm<ClientFormValues>({
    resolver: zodResolver(clientSchema),
    defaultValues: { name: '', email: '', phone: '', address: '', taxId: '', notes: '', clientType: '', subscriberPlanId: '', subscriberQuantity: '', subscriberUnitPriceOverride: '', subscriberCurrencyOverride: '', subscriberBillingDay: '', subscriberStartMonth: '', status: 'active' },
  });

  const buildSubscriberPayload = (data: ClientFormValues): Record<string, any> => {
    const isSubscriber = data.clientType === 'suscriptores';
    const planId = isSubscriber && data.subscriberPlanId && data.subscriberPlanId !== '__none__' ? data.subscriberPlanId : null;
    const qty = isSubscriber && data.subscriberQuantity ? parseInt(data.subscriberQuantity, 10) : null;
    const overridePrice = isSubscriber && data.subscriberUnitPriceOverride && data.subscriberUnitPriceOverride.trim() !== ''
      ? data.subscriberUnitPriceOverride.replace(',', '.')
      : null;
    const overrideCurrency = isSubscriber && data.subscriberCurrencyOverride && data.subscriberCurrencyOverride !== '__none__'
      ? data.subscriberCurrencyOverride
      : null;
    const billingDay = isSubscriber && data.subscriberBillingDay ? parseInt(data.subscriberBillingDay, 10) : null;
    const startMonth = isSubscriber && data.subscriberStartMonth ? data.subscriberStartMonth : null;
    return {
      subscriberPlanId: planId,
      subscriberQuantity: Number.isFinite(qty) && qty! > 0 ? qty : null,
      subscriberUnitPriceOverride: overridePrice,
      subscriberCurrencyOverride: overrideCurrency,
      subscriberBillingDay: Number.isFinite(billingDay) ? billingDay : null,
      subscriberStartMonth: startMonth,
    };
  };

  const onSubmit = (data: ClientFormValues) => {
    const clientType = data.clientType && data.clientType !== '__none__' ? data.clientType : undefined;
    createMutation.mutate({
      name: data.name,
      email: data.email || undefined,
      phone: data.phone || undefined,
      address: data.address || undefined,
      taxId: data.taxId || undefined,
      notes: data.notes || undefined,
      clientType,
      ...buildSubscriberPayload(data),
      status: data.status,
    });
  };

  const handleEditOpen = (client: Client) => {
    editForm.reset({
      name: client.name,
      email: client.email || '',
      phone: client.phone || '',
      address: client.address || '',
      taxId: client.taxId || '',
      notes: client.notes || '',
      clientType: client.clientType || '',
      subscriberPlanId: client.subscriberPlanId || '',
      subscriberQuantity: client.subscriberQuantity != null ? String(client.subscriberQuantity) : '',
      subscriberUnitPriceOverride: client.subscriberUnitPriceOverride || '',
      subscriberCurrencyOverride: client.subscriberCurrencyOverride || '',
      subscriberBillingDay: client.subscriberBillingDay != null ? String(client.subscriberBillingDay) : '',
      subscriberStartMonth: client.subscriberStartMonth || '',
      status: (client.status as 'active' | 'potential' | 'inactive') || 'active',
    });
    setEditClient(client);
  };

  const onEditSubmit = (data: ClientFormValues) => {
    if (!editClient) return;
    const clientType = data.clientType && data.clientType !== '__none__' ? data.clientType : undefined;
    updateMutation.mutate({
      id: editClient.id,
      data: {
        name: data.name,
        email: data.email || undefined,
        phone: data.phone || undefined,
        address: data.address || undefined,
        taxId: data.taxId || undefined,
        notes: data.notes || undefined,
        clientType,
        ...buildSubscriberPayload(data),
        status: data.status,
      },
    });
  };

  const toggleActive = (client: Client) => {
    updateMutation.mutate({ id: client.id, data: { isActive: !client.isActive } });
  };

  const [ccPeriodFilter, setCCPeriodFilter] = React.useState<string>('all');
  const [showReconcileDialog, setShowReconcileDialog] = React.useState(false);
  const [isClientDialogMaximized, setIsClientDialogMaximized] = React.useState(false);
  const [reconcileReason, setReconcileReason] = React.useState('Ajuste por retenciones');
  const [reconcileCustomReason, setReconcileCustomReason] = React.useState('');
  const [isReconciling, setIsReconciling] = React.useState(false);

  const RECONCILE_REASONS = [
    'Ajuste por retenciones',
    'Descuento otorgado',
    'Diferencia de cambio',
    'Ajuste por nota de crédito',
    'Otro',
  ];

  const handleReconcile = async () => {
    if (!viewClient) return;
    const allTxs = getClientTransactions(viewClient.id);
    const { byCurrency } = calculateClientCC(allTxs);
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
        const isPositive = data.saldo > 0;

        await transactionAPI.create({
          type: isPositive ? 'income' : 'expense',
          amount: Math.abs(data.saldo).toString(),
          description: `Conciliación: ${reason}`,
          category: 'Ajuste Manual',
          date: now,
          imputationDate: now,
          status: 'completed',
          clientId: viewClient.id,
          currency,
          hasInvoice: false,
        });
      }

      queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
      toast({ title: 'Cuenta conciliada', description: `La cuenta corriente de ${viewClient.name} fue ajustada a cero.` });
      setShowReconcileDialog(false);
      setReconcileReason('Ajuste por retenciones');
      setReconcileCustomReason('');
    } catch (error) {
      toast({ title: 'Error al conciliar', description: 'No se pudo completar la conciliación. Intentá de nuevo.', variant: 'destructive' });
    } finally {
      setIsReconciling(false);
    }
  };

  const getClientTransactions = (clientId: string) => {
    return transactions.filter((tx: Transaction) => tx.clientId === clientId);
  };

  const getFilteredClientTransactions = (clientId: string) => {
    let txs = getClientTransactions(clientId);
    
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

  const getClientBalance = (clientId: string) => {
    const clientTxs = getClientTransactions(clientId);
    const { saldoFinal, byCurrency } = calculateClientCC(clientTxs);
    return { saldoFinal, byCurrency };
  };

  const profitabilityByClient = React.useMemo(() => {
    const usdRate = exchangeRates?.usdToLocal || 1050;
    const pendingStatuses = ['scheduled'];

    const convertCost = (amount: number, fromCurr: string, toCurr: string): number => {
      if (fromCurr === toCurr) return amount;
      if (fromCurr === 'ARS' && toCurr === 'USD') return amount / usdRate;
      if (fromCurr === 'USD' && toCurr === 'ARS') return amount * usdRate;
      return amount;
    };

    const result: Record<string, Record<string, { revenue: number; cost: number; margin: number }>> = {};
    const clientIds = new Set<string>(clients.map((c: Client) => c.id));

    for (const cId of clientIds) {
      const clientTxs = transactions.filter((tx: Transaction) => tx.clientId === cId);

      const revenueByCurrency: Record<string, number> = {};
      clientTxs
        .filter(tx =>
          tx.type === 'receivable' &&
          !tx.isUniquePayment &&
          pendingStatuses.includes(tx.status) &&
          !(tx.description || '').startsWith('[CANCELACIÓN]')
        )
        .forEach(tx => {
          const curr = normalizeCurrencyKey(tx.currency || 'ARS');
          revenueByCurrency[curr] = (revenueByCurrency[curr] || 0) + (normalizeAmountInput(tx.amount) || 0);
        });

      const revenueCurrencies = Object.keys(revenueByCurrency);
      const totalRevenueAllCurrenciesInARS = revenueCurrencies.reduce((sum, curr) => {
        const amount = revenueByCurrency[curr] || 0;
        return sum + (curr === 'USD' ? amount * usdRate : amount);
      }, 0);

      const costByCurrency: Record<string, number> = {};
      const allocs = allocationsByClient[cId] || [];

      if (revenueCurrencies.length === 0) {
        allocs.forEach(a => {
          const pct = parseFloat(a.percentage) || 0;
          const gross = parseFloat(a.grossSalary) || 0;
          const curr = normalizeCurrencyKey(a.currency || 'ARS');
          costByCurrency[curr] = (costByCurrency[curr] || 0) + (gross * pct) / 100;
        });
      } else if (revenueCurrencies.length === 1) {
        const targetCurr = revenueCurrencies[0];
        allocs.forEach(a => {
          const pct = parseFloat(a.percentage) || 0;
          const gross = parseFloat(a.grossSalary) || 0;
          const empCurr = normalizeCurrencyKey(a.currency || 'ARS');
          const costInEmpCurr = (gross * pct) / 100;
          const converted = convertCost(costInEmpCurr, empCurr, targetCurr);
          costByCurrency[targetCurr] = (costByCurrency[targetCurr] || 0) + converted;
        });
      } else {
        allocs.forEach(a => {
          const pct = parseFloat(a.percentage) || 0;
          const gross = parseFloat(a.grossSalary) || 0;
          const empCurr = normalizeCurrencyKey(a.currency || 'ARS');
          const costInEmpCurr = (gross * pct) / 100;
          const costInARS = empCurr === 'USD' ? costInEmpCurr * usdRate : costInEmpCurr;

          for (const revCurr of revenueCurrencies) {
            const revInARS = revCurr === 'USD' ? (revenueByCurrency[revCurr] || 0) * usdRate : (revenueByCurrency[revCurr] || 0);
            const proportion = totalRevenueAllCurrenciesInARS > 0 ? revInARS / totalRevenueAllCurrenciesInARS : 0;
            const costShareInARS = costInARS * proportion;
            const costShareInRevCurr = revCurr === 'USD' ? costShareInARS / usdRate : costShareInARS;
            costByCurrency[revCurr] = (costByCurrency[revCurr] || 0) + costShareInRevCurr;
          }
        });
      }

      const allCurrencies = revenueCurrencies.length > 0
        ? revenueCurrencies.sort((a, b) => a === 'ARS' ? -1 : b === 'ARS' ? 1 : a.localeCompare(b))
        : [...new Set(Object.keys(costByCurrency))].sort((a, b) => a === 'ARS' ? -1 : b === 'ARS' ? 1 : a.localeCompare(b));

      if (allCurrencies.length > 0) {
        result[cId] = {};
        for (const curr of allCurrencies) {
          const revenue = revenueByCurrency[curr] || 0;
          const cost = costByCurrency[curr] || 0;
          if (revenue === 0 && cost > 0) continue;
          const margin = revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0;
          result[cId][curr] = { revenue, cost, margin };
        }
      }
    }
    return result;
  }, [clients, transactions, allocationsByClient, exchangeRates]);

  const clientTypes = React.useMemo(() => {
    const types = new Set<string>();
    clients.forEach((c: Client) => {
      if (c.clientType) types.add(c.clientType);
    });
    return Array.from(types).sort();
  }, [clients]);

  const filteredClients = React.useMemo(() => {
    return clients.filter((client: Client) => {
      const matchesSearch = !searchTerm || client.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (client.email && client.email.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (client.taxId && client.taxId.includes(searchTerm));
      const clientStatus = client.status || 'active';
      const isArchived = !!(client as any).archivedAt;
      // Task #363: por defecto los archivados no se ven; sólo si filterStatus='archived'.
      if (filterStatus !== 'archived' && isArchived) return false;
      const matchesStatus =
        filterStatus === 'all'
          ? !isArchived
          : filterStatus === 'archived'
            ? isArchived
            : clientStatus === filterStatus;
      const matchesType = filterType === 'all' || client.clientType === filterType;
      return matchesSearch && matchesStatus && matchesType;
    });
  }, [clients, searchTerm, filterStatus, filterType]);

  const activeCount = clients.filter((c: Client) => (c.status || 'active') === 'active').length;
  const potentialCount = clients.filter((c: Client) => c.status === 'potential').length;
  const inactiveCount = clients.filter((c: Client) => (c.status || 'active') === 'inactive' || !c.isActive).length;

  const ccTotalsByCurrency = React.useMemo(() => {
    return calculateAllClientsCCTotal(clients, transactions);
  }, [clients, transactions]);

  const exportClientsList = (fmt: 'xlsx' | 'pdf') => {
    if (!filteredClients.length) {
      toast({ title: 'No hay clientes para exportar', variant: 'destructive' });
      return;
    }
    const rows: ClientExportRow[] = filteredClients.map((c: Client) => {
      const { byCurrency } = getClientBalance(c.id);
      const isArchived = !!(c as any).archivedAt;
      const estado = isArchived
        ? 'Archivado'
        : (CLIENT_STATUS_LABELS[(c.status || 'active') as keyof typeof CLIENT_STATUS_LABELS] || c.status || '');
      return {
        nombre: c.name || '',
        email: c.email || '',
        telefono: c.phone || '',
        cuit: c.taxId || '',
        iva: c.ivaCondition ? (TAX_IVA_CONDITION_LABELS[c.ivaCondition as keyof typeof TAX_IVA_CONDITION_LABELS] || c.ivaCondition) : '',
        tipo: c.clientType ? (CLIENT_TYPE_LABELS[c.clientType as keyof typeof CLIENT_TYPE_LABELS] || c.clientType) : '',
        direccion: c.address || '',
        notas: c.notes || '',
        estado,
        saldo: formatSaldoByCurrency(byCurrency),
      };
    });
    if (fmt === 'xlsx') {
      const wb = buildClientsListWorkbook(rows);
      const filename = `clientes-${getArgentinaToday()}.xlsx`;
      XLSX.writeFile(wb, filename);
      toast({ title: 'Exportación lista', description: filename });
    } else {
      exportClientsListToPDF(rows);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-lg text-muted-foreground">Cargando clientes...</div>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
        <div>
          <BackButton />
          <h1 className="text-3xl font-bold font-display mt-2">Clientes</h1>
          <p className="text-muted-foreground">Administra tu base de clientes.</p>
        </div>

        <div className="flex gap-2">
          {canManagePlans && (
            <Button
              variant="outline"
              onClick={() => setIsPlansDialogOpen(true)}
              data-testid="button-manage-plans"
            >
              <Package className="mr-2 h-4 w-4" /> Planes de suscripción
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" data-testid="button-download-clients-list">
                <Download className="mr-2 h-4 w-4" /> Descargar lista <ChevronDown className="ml-2 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => exportClientsList('xlsx')} data-testid="button-download-clients-list-xlsx">
                <FileSpreadsheet className="mr-2 h-4 w-4" /> Excel (.xlsx)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportClientsList('pdf')} data-testid="button-download-clients-list-pdf">
                <FileText className="mr-2 h-4 w-4" /> PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {canCreate && (
            <Button
              variant="outline"
              onClick={() => setIsImportOpen(true)}
              data-testid="button-import-clients"
            >
              <Upload className="mr-2 h-4 w-4" /> Importar desde Excel
            </Button>
          )}
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary text-primary-foreground shadow-lg shadow-primary/20" data-testid="button-new-client">
              <Plus className="mr-2 h-4 w-4" /> Nuevo Cliente
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
                  Tu rol actual (<span className="font-medium text-amber-600">{userRoleDisplay}</span>) no tiene permiso para crear clientes.
                </p>
                <Button variant="outline" className="mt-2" onClick={() => setIsOpen(false)}>Entendido</Button>
              </div>
            ) : (
              <>
                <DialogHeader><DialogTitle>Nuevo Cliente</DialogTitle></DialogHeader>
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)}>
                    <ClientFormFields formInstance={form} plans={subscriptionPlans} onManagePlans={canManagePlans ? () => setIsPlansDialogOpen(true) : undefined} />
                    <DialogFooter className="mt-6">
                      <Button type="submit" disabled={createMutation.isPending} data-testid="button-save-client">
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

      <SubscriptionPlansDialog open={isPlansDialogOpen} onOpenChange={setIsPlansDialogOpen} plans={subscriptionPlans} />
      <ImportClientsDialog open={isImportOpen} onOpenChange={setIsImportOpen} />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
        <Card className="bg-gradient-to-br from-blue-500/10 to-blue-600/5 border-blue-500/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                <Users className="h-5 w-5 text-blue-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total</p>
                <p className="text-2xl font-bold" data-testid="text-total-clients">{clients.length}</p>
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
                <p className="text-2xl font-bold" data-testid="text-active-clients">{activeCount}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-amber-500/10 to-amber-600/5 border-amber-500/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-amber-500/20 flex items-center justify-center">
                <Clock className="h-5 w-5 text-amber-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Potenciales</p>
                <p className="text-2xl font-bold" data-testid="text-potential-clients">{potentialCount}</p>
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
                <p className="text-2xl font-bold" data-testid="text-inactive-clients">{inactiveCount}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-cyan-500/10 to-cyan-600/5 border-cyan-500/20" data-testid="card-clients-cc-total">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-cyan-500/20 flex items-center justify-center">
                <Scale className="h-5 w-5 text-cyan-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Saldo a Cobrar</p>
                {Object.keys(ccTotalsByCurrency).length === 0 ? (
                  <p className="text-lg font-bold text-cyan-400" data-testid="text-cc-total">Al día</p>
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
            data-testid="input-search-clients"
          />
        </div>
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-[160px]" data-testid="filter-client-status">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            {CLIENT_STATUSES.map(s => (
              <SelectItem key={s} value={s}>{CLIENT_STATUS_LABELS[s]}</SelectItem>
            ))}
            <SelectItem value="archived" data-testid="filter-client-archived">Archivados</SelectItem>
          </SelectContent>
        </Select>
        {clientTypes.length > 0 && (
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger className="w-[160px]" data-testid="filter-client-type">
              <SelectValue placeholder="Tipo" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los tipos</SelectItem>
              {clientTypes.map(t => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Mobile: Card view */}
      <div className="md:hidden space-y-3" data-testid="clients-card-list">
        {filteredClients.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              {searchTerm || filterStatus !== 'all' || filterType !== 'all'
                ? 'No se encontraron clientes con esos filtros.'
                : 'No hay clientes registrados. Agregá el primero.'}
            </CardContent>
          </Card>
        ) : (
          filteredClients.map((client: Client) => {
            const { byCurrency: balanceByCurrency } = getClientBalance(client.id);
            const currencyEntries = Object.entries(balanceByCurrency).filter(([, d]) => d.saldo !== 0);
            const profitability = profitabilityByClient[client.id] || {};
            const profitEntries = Object.entries(profitability);
            const clientStatus = client.status || 'active';
            return (
              <Card key={client.id} className="cursor-pointer hover:bg-muted/30 transition-colors" onClick={() => setViewClient(client)} data-testid={`card-client-${client.id}`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{client.name}</p>
                      {client.taxId && <p className="text-xs text-muted-foreground">{client.taxId}</p>}
                    </div>
                    <div className="flex items-center gap-2 ml-2 shrink-0">
                      <Badge
                        variant={clientStatus === 'active' ? 'default' : clientStatus === 'potential' ? 'outline' : 'secondary'}
                        className={`text-xs ${
                          clientStatus === 'active' ? 'bg-green-500/20 text-green-400' :
                          clientStatus === 'potential' ? 'border-amber-500/50 text-amber-400' : ''
                        }`}
                      >
                        {CLIENT_STATUS_LABELS[clientStatus as keyof typeof CLIENT_STATUS_LABELS] || clientStatus}
                      </Badge>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7" data-testid={`button-menu-client-${client.id}`} onClick={(e) => e.stopPropagation()}>
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setViewClient(client); }}>
                            <Eye className="mr-2 h-4 w-4" /> Ver detalle
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleEditOpen(client); }}>
                            <Pencil className="mr-2 h-4 w-4" /> Editar
                          </DropdownMenuItem>
                          {client.clientType === 'suscriptores' && canCreate && (
                            <DropdownMenuItem
                              onClick={(e) => { e.stopPropagation(); handleGenerateCharge(client); }}
                              disabled={generateChargeMutation.isPending}
                              data-testid={`menu-generate-charge-mobile-${client.id}`}
                            >
                              <Repeat className="mr-2 h-4 w-4" /> Generar cobro del mes
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem className="text-destructive" onClick={(e) => { e.stopPropagation(); setDeleteClientId(client.id); }}>
                            <Trash2 className="mr-2 h-4 w-4" /> Eliminar
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    {(client.email || client.phone) && (
                      <div className="col-span-2 text-muted-foreground text-xs truncate">
                        {client.email || client.phone}
                      </div>
                    )}
                    <div>
                      <span className="text-xs text-muted-foreground">Saldo CC</span>
                      <div>
                        {currencyEntries.length > 0 ? currencyEntries.map(([curr, data]) => (
                          <span key={curr} className="block font-mono text-sm font-medium text-foreground">
                            {getCurrencySymbol(curr)} {Math.abs(data.saldo).toLocaleString('es-AR', { minimumFractionDigits: 0 })}
                          </span>
                        )) : <span className="text-muted-foreground text-sm">-</span>}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground">Rentabilidad</span>
                      <div data-testid={`profitability-cell-${client.id}`}>
                        {profitEntries.length > 0 ? profitEntries.map(([curr, data]) => (
                          <div key={curr} className="flex items-center gap-1">
                            <span className={`font-mono text-sm font-semibold ${data.margin >= 50 ? 'text-green-500' : data.margin >= 0 ? 'text-amber-500' : 'text-red-500'}`}>
                              {data.margin.toFixed(1)}%
                            </span>
                            <span className="text-[10px] text-muted-foreground font-medium">{curr}</span>
                          </div>
                        )) : <span className="text-muted-foreground text-sm">-</span>}
                      </div>
                    </div>
                    {client.clientType && (
                      <div>
                        <span className="text-xs text-muted-foreground">Tipo</span>
                        <div><Badge variant="outline" className="text-xs mt-0.5">{client.clientType}</Badge></div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {/* Desktop: Table with column toggle */}
      <div className="hidden md:block">
        <div className="flex justify-end mb-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5" data-testid="button-column-toggle">
                <SlidersHorizontal className="h-4 w-4" />
                Columnas
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Columnas visibles</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={visibleColumns.contacto} onCheckedChange={() => toggleColumn('contacto')}>Contacto</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={visibleColumns.tipo} onCheckedChange={() => toggleColumn('tipo')}>Tipo</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={visibleColumns.saldoCC} onCheckedChange={() => toggleColumn('saldoCC')}>Saldo CC</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={visibleColumns.rentabilidad} onCheckedChange={() => toggleColumn('rentabilidad')}>Rentabilidad</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={visibleColumns.estado} onCheckedChange={() => toggleColumn('estado')}>Estado</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={visibleColumns.registro} onCheckedChange={() => toggleColumn('registro')}>Registro</DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  {visibleColumns.contacto && <TableHead>Contacto</TableHead>}
                  {visibleColumns.tipo && <TableHead>Tipo</TableHead>}
                  {visibleColumns.saldoCC && <TableHead className="text-right">Saldo CC</TableHead>}
                  {visibleColumns.rentabilidad && <TableHead className="text-right">Rentabilidad</TableHead>}
                  {visibleColumns.estado && <TableHead>Estado</TableHead>}
                  {visibleColumns.registro && <TableHead>Registro</TableHead>}
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredClients.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={1 + Object.values(visibleColumns).filter(Boolean).length + 1} className="text-center py-8 text-muted-foreground">
                      {searchTerm || filterStatus !== 'all' || filterType !== 'all'
                        ? 'No se encontraron clientes con esos filtros.'
                        : 'No hay clientes registrados. Agregá el primero.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredClients.map((client: Client) => {
                    const { byCurrency: balanceByCurrency } = getClientBalance(client.id);
                    const currencyEntries = Object.entries(balanceByCurrency).filter(([, d]) => d.saldo !== 0);
                    const profitability = profitabilityByClient[client.id] || {};
                    const profitEntries = Object.entries(profitability);
                    const clientStatus = client.status || 'active';
                    return (
                      <TableRow key={client.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setViewClient(client)} data-testid={`row-client-${client.id}`}>
                        <TableCell>
                          <div>
                            <p className="font-medium">{client.name}</p>
                            {client.taxId && <p className="text-xs text-muted-foreground">{client.taxId}</p>}
                          </div>
                        </TableCell>
                        {visibleColumns.contacto && (
                          <TableCell className="text-sm text-muted-foreground">
                            {client.email || client.phone || '-'}
                          </TableCell>
                        )}
                        {visibleColumns.tipo && (
                          <TableCell>
                            {client.clientType ? (
                              <Badge variant="outline" className="text-xs">{client.clientType}</Badge>
                            ) : <span className="text-muted-foreground text-sm">-</span>}
                          </TableCell>
                        )}
                        {visibleColumns.saldoCC && (
                          <TableCell className="text-right">
                            {currencyEntries.length > 0 ? (
                              <div className="space-y-0.5">
                                {currencyEntries.map(([curr, data]) => (
                                  <span key={curr} className="block font-mono text-sm font-medium text-foreground">
                                    {getCurrencySymbol(curr)} {Math.abs(data.saldo).toLocaleString('es-AR', { minimumFractionDigits: 0 })}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="text-muted-foreground text-sm">-</span>
                            )}
                          </TableCell>
                        )}
                        {visibleColumns.rentabilidad && (
                          <TableCell className="text-right" data-testid={`profitability-cell-${client.id}`}>
                            {profitEntries.length > 0 ? (
                              <div className="space-y-0.5">
                                {profitEntries.map(([curr, data]) => (
                                  <div key={curr} className="flex items-center justify-end gap-1.5">
                                    <span className={`font-mono text-sm font-semibold ${data.margin >= 50 ? 'text-green-500' : data.margin >= 0 ? 'text-amber-500' : 'text-red-500'}`}>
                                      {data.margin.toFixed(1)}%
                                    </span>
                                    <span className="text-[10px] text-muted-foreground/70 font-medium w-6">{curr}</span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <span className="text-muted-foreground text-sm">-</span>
                            )}
                          </TableCell>
                        )}
                        {visibleColumns.estado && (
                          <TableCell>
                            <Badge
                              variant={clientStatus === 'active' ? 'default' : clientStatus === 'potential' ? 'outline' : 'secondary'}
                              className={
                                clientStatus === 'active' ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30' :
                                clientStatus === 'potential' ? 'border-amber-500/50 text-amber-400' : ''
                              }
                            >
                              {CLIENT_STATUS_LABELS[clientStatus as keyof typeof CLIENT_STATUS_LABELS] || clientStatus}
                            </Badge>
                          </TableCell>
                        )}
                        {visibleColumns.registro && (
                          <TableCell className="text-sm text-muted-foreground">
                            {client.createdAt ? format(new Date(client.createdAt), 'dd/MM/yyyy') : '-'}
                          </TableCell>
                        )}
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8" data-testid={`button-menu-client-${client.id}`} onClick={(e) => e.stopPropagation()}>
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setViewClient(client); }}>
                                <Eye className="mr-2 h-4 w-4" /> Ver detalle
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleEditOpen(client); }}>
                                <Pencil className="mr-2 h-4 w-4" /> Editar
                              </DropdownMenuItem>
                              {client.clientType === 'suscriptores' && canCreate && (
                                <DropdownMenuItem
                                  onClick={(e) => { e.stopPropagation(); handleGenerateCharge(client); }}
                                  disabled={generateChargeMutation.isPending}
                                  data-testid={`menu-generate-charge-${client.id}`}
                                >
                                  <Repeat className="mr-2 h-4 w-4" /> Generar cobro del mes
                                </DropdownMenuItem>
                              )}
                              {(client as any).archivedAt && (
                                <DropdownMenuItem
                                  onClick={(e) => { e.stopPropagation(); unarchiveClientMutation.mutate(client.id); }}
                                  disabled={unarchiveClientMutation.isPending}
                                  data-testid={`button-restore-client-${client.id}`}
                                >
                                  <RotateCcw className="mr-2 h-4 w-4" /> Restaurar
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={(e) => { e.stopPropagation(); setDeleteClientId(client.id); }}
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
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!editClient} onOpenChange={() => setEditClient(null)}>
        <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Editar Cliente</DialogTitle></DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(onEditSubmit)}>
              <ClientFormFields formInstance={editForm} testIdPrefix="edit-" plans={subscriptionPlans} onManagePlans={canManagePlans ? () => setIsPlansDialogOpen(true) : undefined} originalClientType={editClient?.clientType ?? ''} />
              <DialogFooter className="mt-6">
                <Button type="submit" disabled={updateMutation.isPending} data-testid="button-save-client">
                  {updateMutation.isPending ? 'Guardando...' : 'Guardar'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
          {editClient && (
            <div className="mt-4">
              <ClientInvoiceEmailPrefsEditor clientId={editClient.id} clientEmail={editClient.email} />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* View Client Detail Dialog - Cuenta Corriente */}
      <Dialog open={!!viewClient} onOpenChange={() => { setViewClient(null); setCCPeriodFilter('all'); setIsClientDialogMaximized(false); }}>
        <DialogContent className={`${isClientDialogMaximized ? 'sm:max-w-[98vw] w-[98vw] h-[95vh]' : 'sm:max-w-[900px] w-[95vw] max-h-[95vh]'} overflow-y-auto transition-all duration-200`}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              <span className="truncate flex-1">Cuenta Corriente - {viewClient?.name}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 ml-auto"
                onClick={() => setIsClientDialogMaximized(!isClientDialogMaximized)}
                data-testid="button-toggle-maximize"
              >
                {isClientDialogMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
            </DialogTitle>
          </DialogHeader>
          {viewClient && (() => {
            const filteredTxs = getFilteredClientTransactions(viewClient.id);
            const { movements, totalDebe, totalHaber, saldoFinal, byCurrency: filteredByCurrency } = calculateClientCC(filteredTxs);
            const allTxs = getClientTransactions(viewClient.id);
            const allCC = calculateClientCC(allTxs);
            const hasContactInfo = viewClient.taxId || viewClient.email || viewClient.phone || viewClient.address;
            const currencies = Object.keys(allCC.byCurrency);
            
            return (
              <div className="space-y-3 sm:space-y-4">
                <div className={`w-full px-4 py-2 rounded-lg ${allCC.saldoFinal > 0 ? 'bg-red-50 border border-red-200' : allCC.saldoFinal < 0 ? 'bg-green-50 border border-green-200' : 'bg-gray-50 dark:bg-slate-900 border'}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Saldo Actual</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {allCC.saldoFinal > 0 ? 'Debe' : allCC.saldoFinal < 0 ? 'A favor' : 'Al día'}
                      </span>
                      {Object.values(allCC.byCurrency).some(c => c.saldo !== 0) && canCreate && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs gap-1 hover:bg-cyan-100 hover:text-cyan-700 transition-colors cursor-pointer"
                          onClick={() => setShowReconcileDialog(true)}
                          data-testid="button-reconcile"
                        >
                          <Scale className="h-3 w-3" />
                          Conciliar
                        </Button>
                      )}
                    </div>
                  </div>
                  {currencies.length <= 1 ? (
                    <p className={`text-xl font-bold text-center ${allCC.saldoFinal > 0 ? 'text-red-600' : allCC.saldoFinal < 0 ? 'text-green-600' : ''}`}>
                      {getCurrencySymbol(currencies[0] || 'ARS')} {Math.abs(allCC.saldoFinal).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
                      {Object.entries(allCC.byCurrency).map(([curr, data]) => (
                        <p key={curr} className={`text-lg font-bold ${data.saldo > 0 ? 'text-red-600' : data.saldo < 0 ? 'text-green-600' : ''}`}>
                          {getCurrencySymbol(curr)} {Math.abs(data.saldo).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                        </p>
                      ))}
                    </div>
                  )}
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
                            <span className={`text-sm font-bold ${data.saldo > 0 ? 'text-red-600' : 'text-green-600'}`}>
                              {getCurrencySymbol(curr)} {Math.abs(data.saldo).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                              <span className="text-xs text-muted-foreground ml-1">
                                ({data.saldo > 0 ? 'pendiente de cobro' : 'a favor del cliente'})
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>

                      <div className="space-y-2">
                        <label className="text-sm font-medium">Motivo</label>
                        <Select value={reconcileReason} onValueChange={setReconcileReason}>
                          <SelectTrigger data-testid="select-reconcile-reason">
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
                            data-testid="input-reconcile-custom-reason"
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
                        data-testid="button-confirm-reconcile"
                      >
                        {isReconciling ? 'Conciliando...' : 'Conciliar'}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                {hasContactInfo && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    {viewClient.taxId && (
                      <div>
                        <span className="text-muted-foreground text-xs">CUIT/CUIL</span>
                        <p className="font-medium">{viewClient.taxId}</p>
                      </div>
                    )}
                    {viewClient.email && (
                      <div>
                        <span className="text-muted-foreground text-xs">Email</span>
                        <p className="font-medium truncate">{viewClient.email}</p>
                      </div>
                    )}
                    {viewClient.phone && (
                      <div>
                        <span className="text-muted-foreground text-xs">Teléfono</span>
                        <p className="font-medium">{viewClient.phone}</p>
                      </div>
                    )}
                    {viewClient.address && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground text-xs">Dirección</span>
                        <p className="font-medium">{viewClient.address}</p>
                      </div>
                    )}
                  </div>
                )}

                <ClientProjectsAndTeamSection clientId={viewClient.id} />

                <ClientProfitabilitySection clientId={viewClient.id} clientTransactions={allTxs} />

                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                  <div className="flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    <Select value={ccPeriodFilter} onValueChange={setCCPeriodFilter}>
                      <SelectTrigger className="w-[160px] sm:w-[180px] h-8" data-testid="select-cc-period">
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
                      onClick={() => exportCCtoCSV(viewClient, movements, totalDebe, totalHaber, saldoFinal)}
                      disabled={movements.length === 0}
                      data-testid="button-export-csv"
                    >
                      <Download className="h-4 w-4 mr-1" /> CSV
                    </Button>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => exportCCtoPDF(viewClient, movements, totalDebe, totalHaber, saldoFinal)}
                      disabled={movements.length === 0}
                      data-testid="button-export-pdf"
                    >
                      <FileText className="h-4 w-4 mr-1" /> PDF
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!!exportingInvoices}
                          data-testid="button-export-invoices"
                        >
                          {exportingInvoices ? (
                            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                          ) : (
                            <Download className="h-4 w-4 mr-1" />
                          )}
                          Exportar facturas
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => downloadClientInvoices(viewClient.id, 'xlsx')}
                          data-testid="menu-export-invoices-xlsx"
                        >
                          <FileSpreadsheet className="h-4 w-4 mr-2" /> Excel (.xlsx)
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => downloadClientInvoices(viewClient.id, 'pdf')}
                          data-testid="menu-export-invoices-pdf"
                        >
                          <FileBarChart className="h-4 w-4 mr-2" /> PDF Libro de IVA Ventas
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => downloadClientInvoices(viewClient.id, 'zip')}
                          data-testid="menu-export-invoices-zip"
                        >
                          <FileArchive className="h-4 w-4 mr-2" /> ZIP de PDFs
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
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
                    <div className="sm:hidden space-y-2 max-h-[320px] overflow-y-auto border rounded-lg p-2" data-testid="cc-mobile-list">
                      {movements.map((m) => {
                        const symbol = m.currency === 'USD' || m.currency === 'USD_CASH' ? 'US$' : m.currency === 'EUR' ? '€' : '$';
                        const isCancelled = m.description.startsWith('[CANCELACIÓN]');
                        return (
                          <div key={m.id} className="border rounded-lg p-2.5 space-y-1.5 bg-card" data-testid={`cc-card-${m.id}`}>
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <p className="text-xs text-muted-foreground">{format(m.date, 'dd/MM/yy')}</p>
                                <p className="text-sm font-medium truncate">{m.description}</p>
                              </div>
                              <Badge variant={isCancelled ? 'destructive' : m.status === 'completed' ? 'default' : 'secondary'} className="text-[10px] shrink-0">
                                {isCancelled ? 'Cancelado' : m.status === 'completed' ? 'Cobrado' : 'Pendiente'}
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
                              <span className={`font-bold ${m.saldo > 0 ? 'text-red-600' : m.saldo < 0 ? 'text-green-600' : ''}`}>
                                {symbol} {m.saldo.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                      <div className="border rounded-lg p-2.5 bg-muted/50 font-bold" data-testid="cc-totals-mobile">
                        {Object.entries(filteredByCurrency).map(([curr, data]) => (
                          <div key={curr} className="mb-1 last:mb-0">
                            <div className="flex items-center justify-between text-xs">
                              <span>TOTALES {Object.keys(filteredByCurrency).length > 1 ? curr : ''}</span>
                              <span className={`${data.saldo > 0 ? 'text-red-600' : data.saldo < 0 ? 'text-green-600' : ''}`}>
                                {getCurrencySymbol(curr)} {Math.abs(data.saldo).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                              </span>
                            </div>
                            <div className="flex gap-3 text-xs mt-0.5">
                              <span className="text-red-600">Debe: {getCurrencySymbol(curr)} {data.totalDebe.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                              <span className="text-green-600">Haber: {getCurrencySymbol(curr)} {data.totalHaber.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Desktop table layout */}
                    <ScrollArea className="hidden sm:block h-[320px] border rounded-lg">
                      <Table className="w-full">
                        <colgroup>
                          <col style={{ width: '10%' }} />
                          <col style={{ width: '30%' }} />
                          <col style={{ width: '8%' }} />
                          <col style={{ width: '10%' }} />
                          <col style={{ width: '14%' }} />
                          <col style={{ width: '14%' }} />
                          <col style={{ width: '14%' }} />
                        </colgroup>
                        <TableHeader className="sticky top-0 bg-background">
                          <TableRow>
                            <TableHead>Fecha</TableHead>
                            <TableHead>Descripción</TableHead>
                            <TableHead className="text-center">Moneda</TableHead>
                            <TableHead>Estado</TableHead>
                            <TableHead className="text-right">Debe</TableHead>
                            <TableHead className="text-right">Haber</TableHead>
                            <TableHead className="text-right">Saldo</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {movements.map((m) => {
                            const symbol = m.currency === 'USD' || m.currency === 'USD_CASH' ? 'US$' : m.currency === 'EUR' ? '€' : '$';
                            return (
                              <TableRow key={m.id}>
                                <TableCell className="text-sm">{format(m.date, 'dd/MM/yy')}</TableCell>
                                <TableCell className="text-sm font-medium truncate">{m.description}</TableCell>
                                <TableCell className="text-center text-xs text-muted-foreground">{m.currency}</TableCell>
                                <TableCell>
                                  <Badge variant={(m.type === 'expense' || m.type === 'payable') ? 'outline' : m.status === 'completed' ? 'default' : 'secondary'} className="text-xs">
                                    {(m.type === 'expense' || m.type === 'payable') ? 'Ajuste' : m.status === 'completed' ? 'Cobrado' : 'Pendiente'}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-right text-red-600 font-medium">
                                  {m.debe > 0 ? `${symbol} ${m.debe.toLocaleString('es-AR', { minimumFractionDigits: 2 })}` : '-'}
                                </TableCell>
                                <TableCell className="text-right text-green-600 font-medium">
                                  {m.haber > 0 ? `${symbol} ${m.haber.toLocaleString('es-AR', { minimumFractionDigits: 2 })}` : '-'}
                                </TableCell>
                                <TableCell className={`text-right font-bold ${m.saldo > 0 ? 'text-red-600' : m.saldo < 0 ? 'text-green-600' : ''}`}>
                                  {symbol} {m.saldo.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                          {Object.entries(filteredByCurrency).map(([curr, data]) => (
                            <TableRow key={`totals-${curr}`} className="bg-muted/50 font-bold">
                              <TableCell colSpan={4} className="text-right">TOTALES {Object.keys(filteredByCurrency).length > 1 ? curr : ''}</TableCell>
                              <TableCell className="text-right text-red-600">
                                {getCurrencySymbol(curr)} {data.totalDebe.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                              </TableCell>
                              <TableCell className="text-right text-green-600">
                                {getCurrencySymbol(curr)} {data.totalHaber.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                              </TableCell>
                              <TableCell className={`text-right ${data.saldo > 0 ? 'text-red-600' : data.saldo < 0 ? 'text-green-600' : ''}`}>
                                {getCurrencySymbol(curr)} {Math.abs(data.saldo).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                              </TableCell>
                            </TableRow>
                          ))}
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
        open={!!deleteClientId}
        onOpenChange={(open) => {
          if (!open) { setDeleteClientId(null); setForceDeleteClient(false); }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar cliente?</AlertDialogTitle>
            <AlertDialogDescription>
              Si el cliente no tiene movimientos asociados, se elimina y podés deshacerlo por unos segundos.
              Si tiene historia, en vez de borrarlo se archiva para preservar tus reportes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {(userRole === 'owner' || userRole === 'admin') && (
            <label className="flex items-start gap-2 text-sm rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <input
                type="checkbox"
                checked={forceDeleteClient}
                onChange={(e) => setForceDeleteClient(e.target.checked)}
                className="mt-0.5"
                data-testid="checkbox-force-delete-client"
              />
              <span>
                <span className="font-medium text-destructive">Eliminar definitivamente</span>
                <span className="block text-muted-foreground text-xs mt-0.5">
                  No se podrá deshacer. Falla si el cliente tiene movimientos asociados.
                </span>
              </span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-client">Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteClient}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete-client"
            >
              {forceDeleteClient ? 'Eliminar definitivamente' : 'Eliminar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
