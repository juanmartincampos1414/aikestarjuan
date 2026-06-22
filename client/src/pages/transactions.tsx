import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useLocation, useSearch } from 'wouter';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCompletedTransactions, useScheduledTransactions, useAccounts, useCreateTransaction, useUpdateTransaction, useDeleteTransaction, useOrganization, useMembers, useIsPersonalBasic, useMembership } from '@/lib/hooks';
import { ROLE_PERMISSIONS, type Role } from '@shared/schema';
import { Loader2, Eye, User, Building, Package, Receipt as ReceiptIcon, CreditCard, MapPin, Phone, Mail, MailWarning, Send, Hash, Copy, Check, AlertCircle, FileX2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { useUndoDelete } from '@/hooks/use-undo-delete';
import { pushGlobalUndoAction } from '@/components/UndoButton';
import { ArrowUpRight, ArrowDownLeft, ArrowUp, ArrowDown, ArrowUpDown, ArrowLeft, Search, Filter, Pencil, Trash2, MoreVertical, Download, FileSpreadsheet, FileText, FileType, X, AlertTriangle, Clock, CalendarClock, Calendar as CalendarIcon, Maximize2, Minimize2, XCircle, Link, ExternalLink, CheckCircle2, RefreshCw, CheckSquare, Upload } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { format, parseISO, isWithinInterval, startOfDay, endOfDay, formatDistanceToNow, isBefore, isToday } from 'date-fns';
import { es } from 'date-fns/locale';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { Checkbox } from '@/components/ui/checkbox';
import { TransactionWizard } from '@/components/transaction-wizard';
import { CategoryPicker, type CategoryPickerCategory } from '@/components/CategoryPicker';
import { ensureCategoryExists } from '@/lib/categories';
import {
  normalizeInvoiceNumber,
  validateInvoiceNumber,
  INVOICE_NUMBER_FORMAT_HINT,
  INVOICE_NUMBER_FORMAT_ERROR,
} from '@/components/transaction-wizard/utils';
import { Switch } from '@/components/ui/switch';
import { type Account, type Transaction, CURRENCY_SYMBOLS } from '@shared/schema';
import { normalizeAmountInput } from '@/lib/currency';
import { fetchWithAuth } from '@/lib/api';
import { EmitInvoiceModal } from '@/components/EmitInvoiceModal';
import { CreditNoteModal } from '@/components/CreditNoteModal';
import { SellingPointSetupGuide } from '@/components/SellingPointSetupGuide';
import { FEATURE_FLAGS } from '@/lib/constants';
import { safeParseDate, filterCancellationPairs, cn, getArgentinaToday } from '@/lib/utils';


function getTransactionTypeLabel(type: string, status?: string): string {
  if (type === 'income') return 'Ingreso';
  if (type === 'expense') return 'Egreso';
  if (type === 'transfer_in') return 'Transferencia Entrante';
  if (type === 'transfer_out') return 'Transferencia Saliente';
  if (type === 'receivable') {
    return status === 'completed' ? 'Cobrado' : 'Por Cobrar';
  }
  if (type === 'payable') {
    return status === 'completed' ? 'Pagado' : 'Por Pagar';
  }
  return type;
}

function getTransactionTypeBadgeClass(type: string, status?: string): string {
  if (type === 'income') return 'bg-green-100 text-green-700';
  if (type === 'expense') return 'bg-red-100 text-red-700';
  if (type === 'transfer_in' || type === 'transfer_out') return 'bg-purple-100 text-purple-700';
  if (type === 'receivable') {
    return status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700';
  }
  if (type === 'payable') {
    return status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700';
  }
  return 'bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-200';
}

const exportToCSV = (data: any[], filename: string) => {
  if (data.length === 0) return;
  const headers = Object.keys(data[0]);
  const csvContent = [
    headers.join(','),
    ...data.map(row => headers.map(h => `"${row[h] ?? ''}"`).join(','))
  ].join('\n');
  
  const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${filename}_${format(new Date(), 'yyyy-MM-dd')}.csv`;
  link.click();
};

interface ReportAnalytics {
  totalIncome: number;
  totalExpense: number;
  netResult: number;
  transactionCount: number;
  avgTransaction: number;
  categoryBreakdown: { name: string; income: number; expense: number }[];
  topCategories: { name: string; total: number; percentage: number }[];
}

const generateAnalytics = (transactions: any[]): ReportAnalytics => {
  const income = transactions.filter(t => t.type === 'income' || t.type === 'receivable');
  const expense = transactions.filter(t => t.type === 'expense' || t.type === 'payable');
  
  const totalIncome = income.reduce((sum, t) => sum + normalizeAmountInput(t.Monto || t.amount || 0), 0);
  const totalExpense = expense.reduce((sum, t) => sum + normalizeAmountInput(t.Monto || t.amount || 0), 0);
  
  const categoryMap: Record<string, { income: number; expense: number }> = {};
  transactions.forEach(t => {
    const cat = t['Categoría'] || t.category || 'Sin categoría';
    if (!categoryMap[cat]) categoryMap[cat] = { income: 0, expense: 0 };
    const amount = normalizeAmountInput(t.Monto || t.amount || 0);
    if (t.Tipo === 'Ingreso' || t.type === 'income') {
      categoryMap[cat].income += amount;
    } else {
      categoryMap[cat].expense += amount;
    }
  });
  
  const categoryBreakdown = Object.entries(categoryMap)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => (b.income + b.expense) - (a.income + a.expense));
  
  const topCategories = categoryBreakdown
    .map(c => ({ name: c.name, total: c.expense, percentage: totalExpense > 0 ? (c.expense / totalExpense) * 100 : 0 }))
    .filter(c => c.total > 0)
    .slice(0, 5);
  
  return {
    totalIncome,
    totalExpense,
    netResult: totalIncome - totalExpense,
    transactionCount: transactions.length,
    avgTransaction: transactions.length > 0 ? (totalIncome + totalExpense) / transactions.length : 0,
    categoryBreakdown,
    topCategories,
  };
};

const formatNumber = (val: number) => new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);

const exportFullReportPDF = (title: string, data: any[], analytics: ReportAnalytics) => {
  const win = window.open('', '_blank');
  if (!win) return;
  
  const headers = data.length > 0 ? Object.keys(data[0]) : [];
  
  const barChartHTML = analytics.topCategories.map(cat => `
    <div style="display:flex;align-items:center;margin:8px 0;">
      <div style="width:120px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${cat.name}</div>
      <div style="flex:1;background:#f0f0f0;height:24px;border-radius:4px;overflow:hidden;">
        <div style="width:${Math.min(cat.percentage, 100)}%;height:100%;background:linear-gradient(90deg,#3b82f6,#60a5fa);display:flex;align-items:center;padding-left:8px;">
          <span style="color:white;font-size:11px;font-weight:bold;">${cat.percentage.toFixed(1)}%</span>
        </div>
      </div>
      <div style="width:100px;text-align:right;font-size:12px;font-weight:bold;">AR$${formatNumber(cat.total)}</div>
    </div>
  `).join('');
  
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>${title} - Aikestar</title>
      <style>
        * { box-sizing: border-box; }
        body { font-family: 'Segoe UI', Arial, sans-serif; padding: 40px; color: #1f2937; line-height: 1.5; }
        h1 { color: #1e40af; margin-bottom: 4px; font-size: 28px; }
        h2 { color: #374151; margin-top: 32px; margin-bottom: 16px; font-size: 18px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; }
        .subtitle { color: #6b7280; margin-bottom: 32px; font-size: 14px; }
        .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 32px; }
        .summary-card { background: linear-gradient(135deg, #f8fafc, #f1f5f9); border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; text-align: center; }
        .summary-card.income { background: linear-gradient(135deg, #dcfce7, #bbf7d0); border-color: #86efac; }
        .summary-card.expense { background: linear-gradient(135deg, #fee2e2, #fecaca); border-color: #fca5a5; }
        .summary-card.net { background: linear-gradient(135deg, #dbeafe, #bfdbfe); border-color: #93c5fd; }
        .summary-label { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
        .summary-value { font-size: 24px; font-weight: bold; margin-top: 8px; }
        .summary-card.income .summary-value { color: #16a34a; }
        .summary-card.expense .summary-value { color: #dc2626; }
        .summary-card.net .summary-value { color: #2563eb; }
        .chart-container { background: #f9fafb; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
        table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 10px; }
        th, td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; }
        th { background: #f3f4f6; font-weight: 600; color: #374151; }
        tr:nth-child(even) { background: #f9fafb; }
        .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #9ca3af; display: flex; justify-content: space-between; }
        @media print { body { padding: 20px; } .summary-grid { grid-template-columns: repeat(2, 1fr); } }
      </style>
    </head>
    <body>
      <h1>📊 ${title}</h1>
      <p class="subtitle">Reporte generado el ${format(new Date(), "d 'de' MMMM 'de' yyyy 'a las' HH:mm", { locale: es })}</p>
      
      <h2>Resumen Ejecutivo</h2>
      <div class="summary-grid">
        <div class="summary-card income">
          <div class="summary-label">Total Ingresos</div>
          <div class="summary-value">AR$${formatNumber(analytics.totalIncome)}</div>
        </div>
        <div class="summary-card expense">
          <div class="summary-label">Total Egresos</div>
          <div class="summary-value">AR$${formatNumber(analytics.totalExpense)}</div>
        </div>
        <div class="summary-card net">
          <div class="summary-label">Resultado Neto</div>
          <div class="summary-value">${analytics.netResult >= 0 ? '+' : ''}AR$${formatNumber(analytics.netResult)}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">Movimientos</div>
          <div class="summary-value" style="color:#374151;">${analytics.transactionCount}</div>
        </div>
      </div>
      
      ${analytics.topCategories.length > 0 ? `
      <h2>Distribución de Gastos por Categoría</h2>
      <div class="chart-container">
        ${barChartHTML}
      </div>
      ` : ''}
      
      ${analytics.categoryBreakdown.length > 0 ? `
      <h2>Análisis por Categoría</h2>
      <table>
        <thead>
          <tr>
            <th>Categoría</th>
            <th style="text-align:right;">Ingresos</th>
            <th style="text-align:right;">Egresos</th>
            <th style="text-align:right;">Balance</th>
          </tr>
        </thead>
        <tbody>
          ${analytics.categoryBreakdown.map(cat => `
            <tr>
              <td>${cat.name}</td>
              <td style="text-align:right;color:#16a34a;">AR$${formatNumber(cat.income)}</td>
              <td style="text-align:right;color:#dc2626;">AR$${formatNumber(cat.expense)}</td>
              <td style="text-align:right;font-weight:bold;color:${cat.income - cat.expense >= 0 ? '#16a34a' : '#dc2626'};">
                ${cat.income - cat.expense >= 0 ? '+' : ''}AR$${formatNumber(cat.income - cat.expense)}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ` : ''}
      
      <h2>Detalle de Movimientos (${data.length})</h2>
      <table>
        <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${data.map(row => `<tr>${headers.map(h => `<td>${row[h]}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
      
      <div class="footer">
        <span>Aikestar - Sistema de Gestión Administrativa</span>
        <span>Página 1</span>
      </div>
    </body>
    </html>
  `);
  win.document.close();
  win.print();
};

const exportFullReportWord = (title: string, data: any[], analytics: ReportAnalytics) => {
  const headers = data.length > 0 ? Object.keys(data[0]) : [];
  
  const categoryTable = analytics.categoryBreakdown.map(cat => `
    <tr>
      <td style="border:1px solid #ddd;padding:8px">${cat.name}</td>
      <td style="border:1px solid #ddd;padding:8px;text-align:right;color:#16a34a">AR$${formatNumber(cat.income)}</td>
      <td style="border:1px solid #ddd;padding:8px;text-align:right;color:#dc2626">AR$${formatNumber(cat.expense)}</td>
      <td style="border:1px solid #ddd;padding:8px;text-align:right;font-weight:bold">AR$${formatNumber(cat.income - cat.expense)}</td>
    </tr>
  `).join('');
  
  const content = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
    <head><meta charset="utf-8"><title>${title}</title></head>
    <body style="font-family:Arial,sans-serif;color:#1f2937">
      <h1 style="color:#1e40af;font-size:24px">${title}</h1>
      <p style="color:#6b7280">Generado: ${format(new Date(), "d 'de' MMMM 'de' yyyy, HH:mm", { locale: es })}</p>
      
      <h2 style="color:#374151;margin-top:24px;border-bottom:2px solid #e5e7eb;padding-bottom:8px">Resumen Ejecutivo</h2>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr>
          <td style="padding:16px;background:#dcfce7;border:1px solid #86efac;text-align:center;width:25%">
            <div style="font-size:11px;color:#6b7280">TOTAL INGRESOS</div>
            <div style="font-size:20px;font-weight:bold;color:#16a34a;margin-top:4px">AR$${formatNumber(analytics.totalIncome)}</div>
          </td>
          <td style="padding:16px;background:#fee2e2;border:1px solid #fca5a5;text-align:center;width:25%">
            <div style="font-size:11px;color:#6b7280">TOTAL EGRESOS</div>
            <div style="font-size:20px;font-weight:bold;color:#dc2626;margin-top:4px">AR$${formatNumber(analytics.totalExpense)}</div>
          </td>
          <td style="padding:16px;background:#dbeafe;border:1px solid #93c5fd;text-align:center;width:25%">
            <div style="font-size:11px;color:#6b7280">RESULTADO NETO</div>
            <div style="font-size:20px;font-weight:bold;color:#2563eb;margin-top:4px">${analytics.netResult >= 0 ? '+' : ''}AR$${formatNumber(analytics.netResult)}</div>
          </td>
          <td style="padding:16px;background:#f3f4f6;border:1px solid #e5e7eb;text-align:center;width:25%">
            <div style="font-size:11px;color:#6b7280">MOVIMIENTOS</div>
            <div style="font-size:20px;font-weight:bold;color:#374151;margin-top:4px">${analytics.transactionCount}</div>
          </td>
        </tr>
      </table>
      
      <h2 style="color:#374151;margin-top:24px;border-bottom:2px solid #e5e7eb;padding-bottom:8px">Análisis por Categoría</h2>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:11px">
        <thead>
          <tr style="background:#f3f4f6">
            <th style="border:1px solid #ddd;padding:8px;text-align:left">Categoría</th>
            <th style="border:1px solid #ddd;padding:8px;text-align:right">Ingresos</th>
            <th style="border:1px solid #ddd;padding:8px;text-align:right">Egresos</th>
            <th style="border:1px solid #ddd;padding:8px;text-align:right">Balance</th>
          </tr>
        </thead>
        <tbody>${categoryTable}</tbody>
      </table>
      
      <h2 style="color:#374151;margin-top:24px;border-bottom:2px solid #e5e7eb;padding-bottom:8px">Detalle de Movimientos (${data.length})</h2>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:10px">
        <thead>
          <tr style="background:#f3f4f6">${headers.map(h => `<th style="border:1px solid #ddd;padding:6px;text-align:left">${h}</th>`).join('')}</tr>
        </thead>
        <tbody>${data.map(row => `<tr>${headers.map(h => `<td style="border:1px solid #ddd;padding:6px">${row[h] ?? ''}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
      
      <p style="margin-top:40px;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:16px">Aikestar - Sistema de Gestión Administrativa</p>
    </body>
    </html>
  `;
  
  const blob = new Blob(['\ufeff' + content], { type: 'application/msword' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${title.replace(/\s+/g, '_')}_${format(new Date(), 'yyyy-MM-dd')}.doc`;
  link.click();
};

// Formatea un monto "crudo" (decimal con punto, sin agrupar, ej "457742.5")
// para mostrarlo en formato es-AR: miles con punto y decimal con coma
// ("457.742,5"). Conserva la coma final mientras se tipean los decimales.
const formatAmountForDisplay = (raw: string): string => {
  if (raw == null || raw === '') return '';
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [intPartRaw, decPart] = unsigned.split('.');
  const intDigits = (intPartRaw || '').replace(/\D/g, '');
  const grouped = intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  let out = grouped === '' ? (decPart !== undefined ? '0' : '') : grouped;
  if (decPart !== undefined) out += ',' + decPart;
  return negative && out !== '' ? '-' + out : out;
};

// Convierte lo que el usuario escribe al valor crudo numérico con punto decimal y
// sin agrupación, máximo 2 decimales, que es lo que espera el formulario y el
// servidor. Acepta el formato es-AR (miles "." y decimal ",") y, por costumbre o
// pegado, el punto como decimal cuando deja una cola de 0-2 dígitos; cuando el
// punto separa grupos de 3 dígitos se trata como separador de miles.
const parseAmountFromDisplay = (display: string): string => {
  if (display == null) return '';
  const negative = display.trim().startsWith('-');
  const s = display.replace(/[^0-9.,]/g, '');
  // Determinar el separador decimal: la coma siempre lo es; el punto solo si su
  // cola tiene 0-2 dígitos (decimal tipeado/pegado) y no son grupos de miles.
  let decSepIndex = -1;
  const lastComma = s.lastIndexOf(',');
  if (lastComma !== -1) {
    decSepIndex = lastComma;
  } else {
    const lastDot = s.lastIndexOf('.');
    if (lastDot !== -1 && s.slice(lastDot + 1).length <= 2) {
      decSepIndex = lastDot;
    }
  }
  let raw: string;
  if (decSepIndex === -1) {
    raw = s.replace(/\D/g, '');
  } else {
    let intPart = s.slice(0, decSepIndex).replace(/\D/g, '');
    const decPart = s.slice(decSepIndex + 1).replace(/\D/g, '').slice(0, 2);
    if (intPart === '') intPart = '0';
    raw = intPart + '.' + decPart;
  }
  if (raw === '') return '';
  return negative ? '-' + raw : raw;
};

const transactionBaseSchema = z.object({
  type: z.enum(['income', 'expense', 'payable', 'receivable']),
  amount: z.string().min(1, 'El monto es requerido'),
  description: z.string().min(3, 'La descripción es requerida'),
  category: z.string().min(1, 'La categoría es requerida'),
  accountId: z.string().min(1, 'La cuenta es requerida'),
  date: z.string(),
  hasInvoice: z.boolean().default(false),
  invoiceType: z.string().optional(),
  invoiceNumber: z.string().optional(),
  // Task #489: carries the invoice number as it was loaded when editing, so the
  // refine below can tell "unchanged pre-existing value" (allowed) from "newly
  // typed value" (must match the canonical format). Not sent to the server.
  originalInvoiceNumber: z.string().optional(),
  profitabilityCodeId: z.string().nullable().optional(),
  clientId: z.string().nullable().optional(),
  supplierId: z.string().nullable().optional(),
});

const transactionSchema = transactionBaseSchema.superRefine((data, ctx) => {
  if (!data.hasInvoice) return;
  const raw = (data.invoiceNumber ?? '').trim();
  if (!raw) return;
  // Task #489: don't re-validate a stored invoice number that wasn't changed.
  // Movements created before the canonical format was enforced (or ARCA-emitted
  // ones) carry non-canonical numbers; blocking them here made them un-editable.
  if (raw === (data.originalInvoiceNumber ?? '').trim()) return;
  if (!validateInvoiceNumber(raw)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['invoiceNumber'],
      message: INVOICE_NUMBER_FORMAT_ERROR,
    });
  }
});

type TransactionFormValues = z.infer<typeof transactionSchema>;

// El endpoint /api/transactions enriquece cada movimiento con `creatorName`
// (nombre del usuario que creó el registro) además de los campos del schema.
// Lo modelamos explícitamente acá para evitar `as any` en la UI.
type TransactionWithCreator = Transaction & { creatorName?: string | null };

type CreatorDisplay = {
  isUnassigned: boolean;
  fullName: string;
  firstName: string;
  initials: string;
};

function getCreatorDisplay(t: TransactionWithCreator): CreatorDisplay {
  const isUnassigned = !t.createdBy;
  const fullName = isUnassigned ? 'Sin asignar' : (t.creatorName || 'Usuario');
  const tokens = fullName.split(/\s+/).filter(Boolean);
  const firstName = isUnassigned ? 'Sin asignar' : (tokens[0] || fullName);
  const initials = isUnassigned
    ? '?'
    : (tokens
        .slice(0, 2)
        .map((s) => s[0]?.toUpperCase() || '')
        .join('') || fullName[0]?.toUpperCase() || '?');
  return { isUnassigned, fullName, firstName, initials };
}

export default function TransactionsPage() {
  const { data: completedTransactionsData = [], isLoading: completedLoading } = useCompletedTransactions();
  const { data: scheduledTransactionsData = [], isLoading: scheduledLoading } = useScheduledTransactions();
  const { data: accountsData = [] } = useAccounts();
  
  // Type the arrays properly
  const completedTransactions = completedTransactionsData as TransactionWithCreator[];
  const scheduledTransactions = scheduledTransactionsData as TransactionWithCreator[];
  const accounts = accountsData as Account[];

  // For completed payables/receivables, prefer the actual completion date over the original due date
  const getDisplayDate = (t: Transaction) => {
    const isCompletedCommitment = (t.type === 'payable' || t.type === 'receivable') && t.status === 'completed';
    return isCompletedCommitment && t.completedAt ? t.completedAt : t.date;
  };
  const { data: organization } = useOrganization();
  const isPersonalBasic = useIsPersonalBasic();
  const { data: members = [] } = useMembers();
  const { data: membership } = useMembership();
  const userRole = (membership?.role as Role) || 'viewer';
  const userPermissions = ROLE_PERMISSIONS[userRole] || [];
  // Inline category create requires the same permission as
  // `POST /api/organization/categories` (`organization:settings`), which only
  // owners/admins have. Si dejamos a un operador tipear un concepto nuevo,
  // el server rechaza el movimiento con "La categoría X no existe en la
  // organización" (task #337).
  const canWriteTransactionCategory = userRole === 'owner' || userRole === 'admin';
  const canBulkDelete = userRole === 'owner' || userRole === 'admin';
  const canBulkApprove = userPermissions.includes('transactions:edit');
  const queryClient = useQueryClient();
  const createTransactionMutation = useCreateTransaction();
  const updateTransactionMutation = useUpdateTransaction();
  const deleteTransactionMutation = useDeleteTransaction();
  const { toast } = useToast();
  const { showUndoToast } = useUndoDelete();
  const [isOpen, setIsOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<any>(null);
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [invoiceFileUrl, setInvoiceFileUrl] = useState<string | null>(null);
  const [isUploadingInvoice, setIsUploadingInvoice] = useState(false);
  const invoiceFileInputRef = useRef<HTMLInputElement>(null);
  const [deletingTransaction, setDeletingTransaction] = useState<any>(null);
  const [viewingInvoice, setViewingInvoice] = useState<any>(null);
  const [viewingDetails, setViewingDetails] = useState<string | null>(null);
  const [isDetailsMaximized, setIsDetailsMaximized] = useState(false);
  const [detailsHistory, setDetailsHistory] = useState<string[]>([]);
  
  // Navigate to a linked transaction with history
  const navigateToLinkedTransaction = (transactionId: string) => {
    if (viewingDetails) {
      setDetailsHistory(prev => [...prev, viewingDetails]);
    }
    setIsEditingDetail(false);
    setViewingDetails(transactionId);
  };
  
  // Go back to previous transaction in history
  const goBackInHistory = () => {
    if (detailsHistory.length > 0) {
      const previousId = detailsHistory[detailsHistory.length - 1];
      setDetailsHistory(prev => prev.slice(0, -1));
      setViewingDetails(previousId);
    }
  };
  const [activeTab, setActiveTab] = useState('completed');
  const [selectedTransactionIds, setSelectedTransactionIds] = useState<Set<string>>(new Set());
  const [bulkApproving, setBulkApproving] = useState(false);
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  
  // Get reactive search params from wouter
  const searchString = useSearch();
  const [, setLocation] = useLocation();
  
  // Auto-open transaction detail from query parameter (reactive to URL changes)
  useEffect(() => {
    const params = new URLSearchParams(searchString);
    const transactionId = params.get('id');
    if (transactionId) {
      setViewingDetails(transactionId);
      // Clean up the URL without triggering full navigation
      window.history.replaceState({}, '', '/transactions');
    }
  }, [searchString]);
  
  // Fetch transaction details when viewing
  const { data: transactionDetails, isLoading: detailsLoading } = useQuery({
    queryKey: ['transaction', viewingDetails],
    queryFn: async () => {
      const res = await fetch(`/api/transactions/${viewingDetails}`, {
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
    enabled: !!viewingDetails,
  });

  // Narrow accessor for the field we added in this task. Avoids untyped `as any`
  // by exposing a single typed helper (the underlying query is intentionally
  // left implicit to preserve compatibility with pre-existing relation accesses
  // like `creator`, `client`, `supplier` on `transactionDetails` that are not
  // in the base Transaction type).
  const transactionDetailsProfitabilityCodeId =
    (transactionDetails as { profitabilityCodeId?: string | null } | undefined)
      ?.profitabilityCodeId ?? null;

  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [filterAccount, setFilterAccount] = useState<string>('all');
  const [filterCategories, setFilterCategories] = useState<string[]>([]);
  const [filterCreator, setFilterCreator] = useState<string>('all');
  const [filterCounterpart, setFilterCounterpart] = useState<string>('all');
  const [filterDateFrom, setFilterDateFrom] = useState<string>('');
  const [filterDateTo, setFilterDateTo] = useState<string>('');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  
  const transactions = activeTab === 'completed' ? completedTransactions : scheduledTransactions;
  const transactionsLoading = activeTab === 'completed' ? completedLoading : scheduledLoading;

  // Mostrar la columna y el filtro de "Creado por" sólo si la organización
  // tiene más de un miembro confirmado. Para orgs con un único miembro la
  // información sería redundante (siempre el mismo nombre) y agregaría ruido.
  const showCreatorColumn = members.length > 1;

  // Reseteo defensivo: el filtro "Creado por" no tiene control visible
  // fuera del popover, así que un valor stale puede recortar silenciosamente
  // la tabla y los exports. Forzamos "all" en cualquier escenario donde
  // el filtro quedaría activo pero sin sentido:
  //   - La columna deja de ser visible (org pasó a 1 sólo miembro).
  //   - El userId seleccionado ya no existe entre los miembros (miembro
  //     removido o cambio de organización activa).
  // El caso de "unassigned" sin huérfanos se trata más abajo, recién
  // cuando ya conocemos `hasUnassignedMovements` (depende de los otros
  // filtros del set actual).
  useEffect(() => {
    if (filterCreator === 'all') return;
    if (!showCreatorColumn) {
      setFilterCreator('all');
      return;
    }
    if (filterCreator === 'unassigned') return;
    const stillExists = members.some((m) => m.userId === filterCreator);
    if (!stillExists) setFilterCreator('all');
  }, [showCreatorColumn, members, filterCreator]);

  const hasActiveFilters = filterType !== 'all' || filterAccount !== 'all' || filterCategories.length > 0 || filterCreator !== 'all' || filterCounterpart !== 'all' || filterDateFrom || filterDateTo;

  // Task #250: categorías presentes en los movimientos visibles (tab
  // activo). Multi-select: array vacío = "todas". Orden por uso (cantidad
  // de movimientos) descendente, tiebreak alfabético es-AR, mismo criterio
  // que el resto del UX de categorías.
  const availableCategoryItems = useMemo<CategoryPickerCategory[]>(() => {
    const counts = new Map<string, number>();
    transactions.forEach((t) => {
      const cat = (t.category || '').trim();
      if (!cat) return;
      counts.set(cat, (counts.get(cat) || 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0], 'es-AR'))
      .map(([name]) => ({ id: name, name, type: 'expense' as const }));
  }, [transactions]);
  const availableCategories = useMemo(
    () => availableCategoryItems.map((c) => c.name),
    [availableCategoryItems],
  );

  // Reseteo defensivo: si alguna categoría seleccionada desaparece del
  // set (cambio de tab/org, eliminación del último movimiento) la sacamos
  // del filtro. Si el filtro queda vacío equivale a "todas".
  useEffect(() => {
    if (filterCategories.length === 0) return;
    const pruned = filterCategories.filter((c) => availableCategories.includes(c));
    if (pruned.length !== filterCategories.length) setFilterCategories(pruned);
  }, [availableCategories, filterCategories]);
  
  // Set "pre-creator": aplica todos los filtros (búsqueda, tipo, cuenta,
  // fechas) EXCEPTO el filtro "Creado por". Lo usamos para dos cosas:
  //   1) Decidir si la opción "Sin asignar" del filtro debe aparecer
  //      (debe matchear el contexto visible actual, no el set crudo).
  //   2) Derivar `filteredTransactions` aplicando el filtro de creador
  //      en una segunda pasada — así garantizamos coherencia entre
  //      "lo que se ve en pantalla" y "qué opciones ofrece el filtro".
  // Load clients and suppliers so we can show counterpart name in the
  // movements list. Both lists are typically small (<100) and cached, so
  // doing the lookup client-side avoids an N+1 enrichment server-side.
  // Declarados antes de los useMemo de orden/filtrado para evitar TDZ.
  const { data: orgClientsList = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['/api/clients'],
    queryFn: () => fetchWithAuth('/clients'),
  });
  const { data: orgSuppliersList = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['/api/suppliers'],
    queryFn: () => fetchWithAuth('/suppliers'),
  });
  const clientsById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of orgClientsList) if (c?.id) m.set(c.id, c.name);
    return m;
  }, [orgClientsList]);
  const suppliersById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of orgSuppliersList) if (s?.id) m.set(s.id, s.name);
    return m;
  }, [orgSuppliersList]);

  useEffect(() => {
    if (filterCounterpart === 'all') return;
    const stillExists =
      !isPersonalBasic &&
      (orgClientsList.some((c) => c.id === filterCounterpart) ||
        orgSuppliersList.some((s) => s.id === filterCounterpart));
    if (!stillExists) setFilterCounterpart('all');
  }, [isPersonalBasic, orgClientsList, orgSuppliersList, filterCounterpart]);

  const preCreatorFilteredTransactions = useMemo(() => {
    const visibleTransactions = filterCancellationPairs(transactions);
    return visibleTransactions.filter((t) => {
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesSearch =
          t.description.toLowerCase().includes(query) ||
          (t.category?.toLowerCase().includes(query) ?? false) ||
          t.amount.toString().includes(query) ||
          t.id.toLowerCase().includes(query) ||
          (t.transactionNumber && t.transactionNumber.toLowerCase().includes(query));
        if (!matchesSearch) return false;
      }

      if (filterType !== 'all' && t.type !== filterType) return false;

      if (filterAccount !== 'all' && t.accountId?.toString() !== filterAccount) return false;

      if (filterCategories.length > 0 && !filterCategories.includes(t.category || '')) return false;

      if (filterCounterpart !== 'all' && t.clientId !== filterCounterpart && t.supplierId !== filterCounterpart) return false;

      if (filterDateFrom || filterDateTo) {
        const txDate = safeParseDate(t.date);
        if (filterDateFrom && txDate < startOfDay(parseISO(filterDateFrom))) return false;
        if (filterDateTo && txDate > endOfDay(parseISO(filterDateTo))) return false;
      }

      return true;
    });
  }, [transactions, searchQuery, filterType, filterAccount, filterCategories, filterCounterpart, filterDateFrom, filterDateTo]);

  // "Sin asignar" sólo aparece como opción del filtro si el set actual
  // (post-otros-filtros) tiene huérfanos. Evita opciones que devolverían
  // 0 resultados al activarse y mantiene paridad con la vista.
  const hasUnassignedMovements = useMemo(
    () => preCreatorFilteredTransactions.some((t: any) => t.createdBy == null),
    [preCreatorFilteredTransactions]
  );

  // Reseteo defensivo complementario: si el filtro está en "unassigned"
  // y los otros filtros eliminaron todos los huérfanos del set visible,
  // la opción desaparece del Select pero el valor seguiría activo dando
  // 0 resultados de forma silenciosa. Lo volvemos a "all".
  useEffect(() => {
    if (filterCreator === 'unassigned' && !hasUnassignedMovements) {
      setFilterCreator('all');
    }
  }, [filterCreator, hasUnassignedMovements]);

  const filteredTransactions = useMemo(() => {
    return preCreatorFilteredTransactions
      .filter((t) => {
        // Filtro "Creado por": "all" no filtra; "unassigned" matchea sólo
        // huérfanos (createdBy == null); cualquier otro id matchea exacto.
        if (filterCreator === 'all') return true;
        const createdBy = (t as any).createdBy;
        if (filterCreator === 'unassigned') return createdBy == null;
        return createdBy === filterCreator;
      })
      .sort((a, b) => {
        // Orden por columna seleccionada (clic en encabezado). Cuando no hay
        // columna activa se usa el orden por defecto de cada pestaña.
        if (sortColumn) {
          const getColumnValue = (t: any): string | number => {
            switch (sortColumn) {
              case 'date':
                return safeParseDate(getDisplayDate(t)).getTime();
              case 'description':
                return (t.description || '').toLowerCase();
              case 'category':
                return (t.category || '').toLowerCase();
              case 'account':
                return (accounts.find((acc) => acc.id === t.accountId)?.name || '').toLowerCase();
              case 'type':
                return getTransactionTypeLabel(t.type, t.status).toLowerCase();
              case 'counterpart': {
                const name = t?.clientId && clientsById.has(t.clientId)
                  ? clientsById.get(t.clientId)!
                  : t?.supplierId && suppliersById.has(t.supplierId)
                    ? suppliersById.get(t.supplierId)!
                    : '';
                return name.toLowerCase();
              }
              case 'creator':
                return ((t as any).creatorName || '').toLowerCase();
              case 'amount': {
                const v = Math.abs(parseFloat(t.amount) || 0);
                return (t.type === 'income' || t.type === 'receivable' || t.type === 'transfer_in') ? v : -v;
              }
              default:
                return 0;
            }
          };
          const va = getColumnValue(a);
          const vb = getColumnValue(b);
          let cmp: number;
          if (typeof va === 'number' && typeof vb === 'number') {
            cmp = va - vb;
          } else {
            cmp = String(va).localeCompare(String(vb), 'es-AR', { numeric: true, sensitivity: 'base' });
          }
          if (cmp === 0) {
            // Desempate estable: más recientemente creado primero.
            cmp = safeParseDate((a as any).createdAt || a.date).getTime()
              - safeParseDate((b as any).createdAt || b.date).getTime();
          }
          return sortDir === 'asc' ? cmp : -cmp;
        }

        // Orden por defecto.
        if (activeTab === 'scheduled') {
          // Futuros: fecha de creación descendente (lo recién cargado arriba).
          const getCreated = (t: any) => safeParseDate(t.createdAt || t.date).getTime();
          return getCreated(b) - getCreated(a);
        }
        // Movimientos: más reciente arriba (completado > creado > fecha).
        const getEffectiveDate = (t: any) => {
          if (t.status === 'completed' && t.completedAt) {
            return safeParseDate(t.completedAt).getTime();
          }
          if (t.createdAt) {
            return safeParseDate(t.createdAt).getTime();
          }
          return safeParseDate(t.date).getTime();
        };
        return getEffectiveDate(b) - getEffectiveDate(a);
      });
  }, [preCreatorFilteredTransactions, filterCreator, activeTab, sortColumn, sortDir, accounts, clientsById, suppliersById]);

  // Prune selección al cambiar filtros/tab: el contador y los totales por
  // moneda en la barra siempre deben coincidir con lo visible.
  useEffect(() => {
    if (selectedTransactionIds.size === 0) return;
    const visible = new Set(filteredTransactions.map(t => t.id));
    let changed = false;
    const next = new Set<string>();
    selectedTransactionIds.forEach(id => {
      if (visible.has(id)) next.add(id);
      else changed = true;
    });
    if (changed) setSelectedTransactionIds(next);
  }, [filteredTransactions]);

  const clearFilters = () => {
    setFilterType('all');
    setFilterAccount('all');
    setFilterCategories([]);
    setFilterCreator('all');
    setFilterCounterpart('all');
    setFilterDateFrom('');
    setFilterDateTo('');
    setSearchQuery('');
  };
  
  const getExportData = () => {
    return filteredTransactions.map(t => {
      const account = accounts.find(a => a.id === t.accountId);
      // En orgs multi-miembro incluimos "Creado por" en los exports
      // para mantener paridad con la columna visible. Lo insertamos
      // antes de "Monto", replicando el orden de la tabla en pantalla
      // (Fecha → Descripción → Categoría → Cuenta → Tipo → Creado por
      // → Monto). Las columnas extra del export que no existen en la
      // tabla (Hora, Moneda, Factura, Estado) se mantienen al final.
      const row: Record<string, string> = {
        'Fecha': format(safeParseDate(t.date), "dd/MM/yyyy", { locale: es }),
        'Hora': format(safeParseDate(t.date), "HH:mm:ss", { locale: es }),
        'Tipo': getTransactionTypeLabel(t.type, t.status),
        'Descripción': t.description,
        'Categoría': t.category ?? '',
        'Cuenta': account?.name || 'Sin cuenta',
      };
      const cp = getCounterpart(t);
      row['Cliente/Proveedor'] = cp.name
        ? `${cp.kind === 'client' ? 'Cliente' : 'Proveedor'}: ${cp.name}`
        : '';
      if (showCreatorColumn) {
        row['Creado por'] = (t as any).creatorName || 'Sin asignar';
      }
      row['Monto'] = normalizeAmountInput(t.amount).toFixed(2);
      row['Moneda'] = account?.currency || 'ARS';
      row['Factura'] = t.hasInvoice ? `${t.invoiceType || ''} ${t.invoiceNumber || ''}`.trim() : 'No';
      row['Estado'] = t.status === 'completed' ? 'Completado' : 'Pendiente';
      return row;
    });
  };

  const form = useForm<TransactionFormValues>({
    resolver: zodResolver(transactionSchema),
    defaultValues: {
      type: 'expense',
      amount: '',
      description: '',
      category: '',
      accountId: '',
      date: getArgentinaToday(),
      hasInvoice: false,
      invoiceType: '',
      invoiceNumber: '',
      originalInvoiceNumber: '',
      profitabilityCodeId: null,
    },
  });

  const openEditModal = (transaction: any) => {
    setEditingTransaction(transaction);
    form.reset({
      type: transaction.type,
      amount: transaction.amount.toString(),
      description: transaction.description,
      category: transaction.category,
      accountId: transaction.accountId || '',
      date: safeParseDate(transaction.date).toISOString().split('T')[0],
      hasInvoice: !!transaction.hasInvoice,
      invoiceType: transaction.invoiceType ?? '',
      invoiceNumber: transaction.invoiceNumber ?? '',
      originalInvoiceNumber: transaction.invoiceNumber ?? '',
      profitabilityCodeId: transaction.profitabilityCodeId ?? null,
      clientId: transaction.clientId ?? null,
      supplierId: transaction.supplierId ?? null,
    });
    setInvoiceFile(null);
    setInvoiceFileUrl(transaction.invoiceFileUrl ?? null);
    setIsOpen(true);
  };

  const openCreateModal = () => {
    setEditingTransaction(null);
    form.reset({
      type: 'expense',
      amount: '',
      description: '',
      category: '',
      accountId: '',
      date: getArgentinaToday(),
      hasInvoice: false,
      invoiceType: '',
      invoiceNumber: '',
      originalInvoiceNumber: '',
      profitabilityCodeId: null,
      clientId: null,
      supplierId: null,
    });
    setInvoiceFile(null);
    setInvoiceFileUrl(null);
    setIsOpen(true);
  };

  const handleInvoiceFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowedTypes.includes(file.type)) {
      toast({
        title: 'Formato no válido',
        description: 'Solo se permiten archivos JPG, PNG, WebP o PDF',
        variant: 'destructive',
      });
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: 'Archivo muy grande',
        description: 'El archivo no puede superar los 10MB',
        variant: 'destructive',
      });
      return;
    }

    setIsUploadingInvoice(true);
    setInvoiceFile(file);

    try {
      const { uploadURL, objectPath } = await fetchWithAuth('/uploads/request-url', {
        method: 'POST',
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          contentType: file.type,
        }),
      });

      await fetch(uploadURL, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });

      setInvoiceFileUrl(objectPath);

      toast({
        title: 'Archivo subido',
        description: 'El comprobante se subió correctamente.',
      });
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo subir el archivo',
        variant: 'destructive',
      });
      setInvoiceFile(null);
      setInvoiceFileUrl(null);
    } finally {
      setIsUploadingInvoice(false);
      e.target.value = '';
    }
  };

  const removeInvoiceFile = () => {
    setInvoiceFile(null);
    setInvoiceFileUrl(null);
  };

  const onSubmit = async (data: TransactionFormValues) => {
    try {
      const normalizedInvoiceNumber = data.hasInvoice && data.invoiceNumber
        ? normalizeInvoiceNumber(data.invoiceNumber)
        : null;
      const invoiceTypeValue = data.hasInvoice && data.invoiceType ? data.invoiceType : null;

      // Si el usuario tipeó un concepto nuevo ("Usar 'X'") hay que persistirlo
      // antes de mandar el movimiento; el server valida contra el catálogo y
      // rechaza con 400 si no existe (task #337).
      let canonicalCategory: string | null;
      try {
        canonicalCategory = await ensureCategoryExists(
          data.category,
          data.type,
          transactionCategories,
          queryClient,
        );
      } catch (catErr: any) {
        toast({
          title: 'No se pudo crear el concepto',
          description: catErr?.message || 'Intentá de nuevo en unos segundos.',
          variant: 'destructive',
        });
        return;
      }

      if (editingTransaction) {
        await updateTransactionMutation.mutateAsync({
          id: editingTransaction.id,
          data: {
            type: data.type,
            amount: data.amount,
            description: data.description,
            category: canonicalCategory ?? data.category,
            accountId: data.accountId,
            date: new Date(data.date).toISOString(),
            imputationDate: new Date(data.date).toISOString(),
            hasInvoice: data.hasInvoice,
            invoiceType: invoiceTypeValue,
            invoiceNumber: normalizedInvoiceNumber,
            invoiceFileUrl: data.hasInvoice ? invoiceFileUrl : null,
            profitabilityCodeId: data.profitabilityCodeId || null,
            clientId: data.clientId || null,
            supplierId: data.supplierId || null,
          },
        });
        
        toast({
          title: "Movimiento actualizado",
          description: "Los cambios han sido guardados correctamente.",
        });
      } else {
        const createdTx = await createTransactionMutation.mutateAsync({
          type: data.type,
          amount: data.amount,
          description: data.description,
          category: canonicalCategory ?? data.category,
          accountId: data.accountId,
          organizationId: organization?.id,
          date: new Date(data.date).toISOString(),
          imputationDate: new Date(data.date).toISOString(),
          hasInvoice: data.hasInvoice,
          invoiceType: invoiceTypeValue,
          invoiceNumber: normalizedInvoiceNumber,
          invoiceTaxId: null,
          invoiceFileUrl: data.hasInvoice ? invoiceFileUrl : null,
          profitabilityCodeId: data.profitabilityCodeId || null,
          clientId: data.clientId || null,
          supplierId: data.supplierId || null,
          status: 'completed',
        });
        
        if (createdTx?.undoKey) {
          pushGlobalUndoAction({
            undoKey: createdTx.undoKey,
            entityType: 'transaction_created',
            entityName: data.description,
            expiresAt: Date.now() + 60000,
          });
        }
        
        toast({
          title: "Movimiento registrado",
          description: `${data.description} por $${data.amount} ha sido guardado.`,
        });
      }
      
      setIsOpen(false);
      setEditingTransaction(null);
      setInvoiceFile(null);
      setInvoiceFileUrl(null);
      form.reset();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo guardar el movimiento",
        variant: "destructive",
      });
    }
  };

  const handleDelete = async () => {
    if (!deletingTransaction) return;
    const txDescription = deletingTransaction.description || deletingTransaction.concept;
    
    try {
      const result = await deleteTransactionMutation.mutateAsync(deletingTransaction.id);
      setDeletingTransaction(null);
      if (result?.undoKey) {
        showUndoToast(result.undoKey, 'transaction', txDescription);
      }
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo eliminar el movimiento",
        variant: "destructive",
      });
    }
  };

  const { data: transactionCategories = [] } = useQuery<Array<{id: string; name: string; type: string}>>({
    queryKey: ["/organization/categories"],
    queryFn: () => fetchWithAuth("/organization/categories"),
  });

  // Build sets of valid category names by bucket so we can flag transactions
  // whose category was deleted from the org config ("ghost" categories).
  const knownIncomeCategoryNames = useMemo(
    () => new Set(transactionCategories.filter(c => c.type === 'income').map(c => c.name)),
    [transactionCategories]
  );
  const knownExpenseCategoryNames = useMemo(
    () => new Set(transactionCategories.filter(c => c.type === 'expense').map(c => c.name)),
    [transactionCategories]
  );
  const isGhostCategory = (txType: string | undefined, category: string | null | undefined) => {
    if (!category) return false;
    if (transactionCategories.length === 0) return false; // categories still loading
    const incomeTypes = txType === 'income' || txType === 'receivable';
    const set = incomeTypes ? knownIncomeCategoryNames : knownExpenseCategoryNames;
    return !set.has(category);
  };

  const { data: profitabilityCodes = [] } = useQuery<Array<{id: string; code: string; name: string; color: string | null; isActive: boolean}>>({
    queryKey: ['/api/profitability-codes'],
    queryFn: async () => {
      const res = await fetch('/api/profitability-codes', { credentials: 'include' });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const getCounterpart = (t: any): { kind: 'client' | 'supplier' | null; name: string | null } => {
    if (t?.clientId && clientsById.has(t.clientId)) return { kind: 'client', name: clientsById.get(t.clientId)! };
    if (t?.supplierId && suppliersById.has(t.supplierId)) return { kind: 'supplier', name: suppliersById.get(t.supplierId)! };
    return { kind: null, name: null };
  };

  // Alterna la columna/dirección de orden. Al elegir una columna nueva, los
  // campos de fecha y monto arrancan descendente; el resto, ascendente.
  const toggleSort = (column: string) => {
    if (sortColumn === column) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDir(column === 'date' || column === 'amount' ? 'desc' : 'asc');
    }
  };

  const renderSortHeader = (
    column: string,
    label: string,
    thClassName: string,
    align: 'left' | 'right' = 'left',
    testId?: string,
  ) => {
    const active = sortColumn === column;
    const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
    return (
      <th className={thClassName} data-testid={testId}>
        <button
          type="button"
          onClick={() => toggleSort(column)}
          className={`group inline-flex items-center gap-1 hover:text-foreground transition-colors ${align === 'right' ? 'flex-row-reverse' : ''} ${active ? 'text-foreground' : ''}`}
          data-testid={`button-sort-${column}`}
          aria-label={`Ordenar por ${label}`}
        >
          <span>{label}</span>
          <Icon className={`h-3 w-3 shrink-0 ${active ? 'opacity-100' : 'opacity-40 group-hover:opacity-70'}`} />
        </button>
      </th>
    );
  };

  const [isEditingDetail, setIsEditingDetail] = useState(false);
  const [editDetailAmount, setEditDetailAmount] = useState('');
  const [editDetailCategory, setEditDetailCategory] = useState('');
  const [editDetailAccountId, setEditDetailAccountId] = useState('');
  const [editDetailProfitabilityCodeId, setEditDetailProfitabilityCodeId] = useState<string | null>(null);
  // Task #475: editable multi-product line items in the detail edit mode. Only
  // populated when the transaction has 2+ line items; quantity/price/code per
  // line are editable, the amount is derived from the sum and items[] is sent.
  const [editDetailItems, setEditDetailItems] = useState<Array<{ productId: string; productName: string; quantity: string; unitPrice: string; profitabilityCodeId: string | null }>>([]);
  const [savingDetail, setSavingDetail] = useState(false);
  const [emitInvoiceTarget, setEmitInvoiceTarget] = useState<any>(null);
  const [creditNoteTarget, setCreditNoteTarget] = useState<any>(null);
  const [resendingEmail, setResendingEmail] = useState(false);
  const [showSellingPointGuide, setShowSellingPointGuide] = useState(false);

  // Orphan transfer repair state
  const [repairCounterpartAccountId, setRepairCounterpartAccountId] = useState('');
  const [repairCounterpartAmount, setRepairCounterpartAmount] = useState('');
  const [repairing, setRepairing] = useState(false);
  const [repairMode, setRepairMode] = useState<'recreate' | 'convert' | null>(null);

  type RepairTransferResponse =
    | {
        success: true;
        mode: 'recreate-pair';
        transferPairId: string;
        createdCounterpart: { id: string; transactionNumber: string | null };
      }
    | {
        success: true;
        mode: 'convert';
        transaction: { id: string; type: 'income' | 'expense' };
      };

  async function submitRepairTransfer(
    transactionId: string,
    mode: 'recreate' | 'convert',
    convertNewType?: 'income' | 'expense',
  ) {
    try {
      setRepairing(true);
      const body = mode === 'recreate'
        ? {
            action: 'recreate-pair',
            counterpartAccountId: repairCounterpartAccountId,
            counterpartAmount: repairCounterpartAmount || undefined,
          }
        : {
            action: 'convert',
            newType: convertNewType,
          };
      const result = await fetchWithAuth(`/transactions/${transactionId}/repair-transfer`, {
        method: 'POST',
        body: JSON.stringify(body),
      }) as RepairTransferResponse;
      const successMsg = result.mode === 'recreate-pair'
        ? `Se creó la contraparte ${result.createdCounterpart.transactionNumber ?? ''}. La transferencia ya tiene ambas patas.`
        : `Se convirtió la transferencia huérfana en un ${result.transaction.type === 'income' ? 'ingreso' : 'gasto'}.`;
      toast({ title: 'Transferencia reparada', description: successMsg });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['transaction', transactionId] }),
        queryClient.invalidateQueries({ queryKey: ['/api/transactions'] }),
        queryClient.invalidateQueries({ queryKey: ['/api/transactions/completed'] }),
        queryClient.invalidateQueries({ queryKey: ['/api/accounts'] }),
        queryClient.invalidateQueries({ queryKey: ['/api/audit-logs'] }),
      ]);
      setRepairMode(null);
      setRepairCounterpartAccountId('');
      setRepairCounterpartAmount('');
    } catch (err: any) {
      toast({
        title: 'No se pudo reparar la transferencia',
        description: err?.message || 'Ocurrió un error inesperado',
        variant: 'destructive',
      });
    } finally {
      setRepairing(false);
    }
  }

  async function resendInvoiceEmail(t: any) {
    if (!t?.id) return;
    let recipients: { to?: string[]; cc?: string[]; bcc?: string[]; message?: string | null } = {};
    if (t.invoiceEmailLastRecipients) {
      try { recipients = JSON.parse(t.invoiceEmailLastRecipients); } catch { /* noop */ }
    }
    let to = (recipients.to || []).filter(Boolean);
    if (to.length === 0) {
      const entered = window.prompt('Ingresá el email del destinatario para reenviar la factura:');
      if (!entered || !entered.trim()) return;
      to = [entered.trim()];
    }
    try {
      setResendingEmail(true);
      const resp = await fetchWithAuth(
        `/invoicing/transactions/${t.id}/send-pdf`,
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
      queryClient.invalidateQueries({ queryKey: ['transaction', t.id] });
      queryClient.invalidateQueries({ queryKey: ['/api/invoicing/invoices'] });
    } catch (e: any) {
      toast({
        title: 'No se pudo reenviar',
        description: e?.message || 'Error al reenviar el email',
        variant: 'destructive',
      });
    } finally {
      setResendingEmail(false);
    }
  }

  // Determines the fiscal status of a transaction's invoice and what to do on click.
  const getFiscalChipInfo = (t: any) => {
    if (!t || !t.hasInvoice) return null;
    const status = t.invoiceEmissionStatus;
    const cae = t.invoiceCae;
    if (status === 'cancelled') {
      return {
        key: 'cancelled',
        label: 'Anulada por NC',
        cls: 'bg-gray-200 text-gray-700 dark:text-slate-200 hover:bg-gray-300',
        action: 'view' as const,
      };
    }
    if (cae || status === 'emitted') {
      const shortCae = cae ? String(cae).slice(-6) : '';
      return {
        key: 'emitted',
        label: shortCae ? `Ya emitida - CAE ${shortCae}` : 'Ya emitida',
        cls: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200',
        action: 'pdf' as const,
      };
    }
    if (status === 'pending') {
      return {
        key: 'pending',
        label: 'Emitiendo…',
        cls: 'bg-amber-100 text-amber-700',
        action: 'none' as const,
      };
    }
    if (status === 'failed') {
      return {
        key: 'failed',
        label: 'Falló · reintentar',
        cls: 'bg-red-100 text-red-700 hover:bg-red-200',
        action: 'emit' as const,
      };
    }
    return {
      key: 'ready',
      label: 'Lista para emitir',
      cls: 'bg-amber-100 text-amber-800 hover:bg-amber-200',
      action: 'emit' as const,
    };
  };

  const handleFiscalChipClick = (t: any) => {
    const info = getFiscalChipInfo(t);
    if (!info) return;
    if (info.action === 'emit') {
      setEmitInvoiceTarget(t);
    } else if (info.action === 'pdf') {
      if (t.invoiceUuid || t.invoicePdfUrl) {
        // Always go through the server redirect so it can refresh the
        // provider's expiring SAS-signed PDF link for old comprobantes.
        window.open(`/api/invoicing/transactions/${t.id}/pdf`, '_blank', 'noopener,noreferrer');
      } else {
        setViewingInvoice(t);
      }
    } else if (info.action === 'view') {
      setViewingInvoice(t);
    }
  };

  const startEditingDetail = () => {
    if (!transactionDetails) return;
    const num = parseFloat(transactionDetails.amount.toString());
    const formatted = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num);
    setEditDetailAmount(formatted);
    setEditDetailCategory(transactionDetails.category);
    setEditDetailAccountId(transactionDetails.accountId || '');
    setEditDetailProfitabilityCodeId(transactionDetailsProfitabilityCodeId);
    const detailItems = Array.isArray((transactionDetails as any).items) ? (transactionDetails as any).items : [];
    if (detailItems.length >= 2) {
      setEditDetailItems(detailItems.map((it: any) => ({
        productId: it.productId,
        productName: it.product?.name || it.description || 'Producto',
        quantity: String(parseFloat(it.quantity || '0')),
        unitPrice: String(parseFloat(it.unitPrice || '0')),
        profitabilityCodeId: it.profitabilityCodeId ?? null,
      })));
    } else {
      setEditDetailItems([]);
    }
    setIsEditingDetail(true);
  };

  const cancelEditingDetail = () => {
    setEditDetailItems([]);
    setIsEditingDetail(false);
  };

  const saveDetailEdits = async () => {
    if (!transactionDetails) return;
    setSavingDetail(true);
    try {
      const isMultiProductEdit = editDetailItems.length >= 2;
      // Validate line items and derive the amount from their sum (source of truth).
      let itemsPayload: Array<{ productId: string; quantity: string; unitPrice: string; profitabilityCodeId: string | null }> | undefined;
      let numericAmount = editDetailAmount.replace(/\./g, '').replace(',', '.');
      if (isMultiProductEdit) {
        let sum = 0;
        for (const it of editDetailItems) {
          const qty = parseFloat(it.quantity);
          const price = parseFloat(it.unitPrice);
          if (isNaN(qty) || qty <= 0 || isNaN(price) || price < 0) {
            toast({
              title: 'Renglón inválido',
              description: `Revisá cantidad y precio de "${it.productName}".`,
              variant: 'destructive',
            });
            setSavingDetail(false);
            return;
          }
          sum += qty * price;
        }
        numericAmount = sum.toFixed(2);
        itemsPayload = editDetailItems.map((it) => ({
          productId: it.productId,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          profitabilityCodeId: it.profitabilityCodeId,
        }));
      }
      // Persistir concepto nuevo si el usuario lo tipeó vía "Usar 'X'" antes
      // de mandar el PATCH (task #337). Si falla, abortar el guardado.
      let canonicalCategory: string | null;
      try {
        canonicalCategory = await ensureCategoryExists(
          editDetailCategory,
          transactionDetails.type,
          transactionCategories,
          queryClient,
        );
      } catch (catErr: any) {
        toast({
          title: 'No se pudo crear el concepto',
          description: catErr?.message || 'Intentá de nuevo en unos segundos.',
          variant: 'destructive',
        });
        setSavingDetail(false);
        return;
      }
      await fetchWithAuth(`/transactions/${transactionDetails.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          amount: numericAmount,
          category: canonicalCategory ?? editDetailCategory,
          accountId: editDetailAccountId,
          profitabilityCodeId: editDetailProfitabilityCodeId || null,
          // Preservar el estado explícitamente. Editar un compromiso NO debe
          // confirmarlo: si no mandamos status, el backend lo deriva de la
          // fecha de vencimiento y, si vence hoy o ya venció, lo marca como
          // completado (confirmando el pago sin que el usuario lo pida).
          status: transactionDetails.status,
          ...(itemsPayload ? { items: itemsPayload } : {}),
        }),
      });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['transaction', transactionDetails.id] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast({
        title: "Cambios guardados",
        description: "El movimiento fue actualizado correctamente.",
      });
      setIsEditingDetail(false);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudieron guardar los cambios",
        variant: "destructive",
      });
    } finally {
      setSavingDetail(false);
    }
  };

  const [approvingTransaction, setApprovingTransaction] = useState(false);
  const [showApprovalDialog, setShowApprovalDialog] = useState(false);
  const [approvalRecurring, setApprovalRecurring] = useState(false);
  const [approvalFrequency, setApprovalFrequency] = useState<string>('monthly');
  const [approvalTransactionId, setApprovalTransactionId] = useState<string | null>(null);
  const [approvalSkipBalance, setApprovalSkipBalance] = useState(false);

  const approveDirectly = async (transactionId: string, isRecurring: boolean, frequency: string, skipBalance: boolean = false) => {
    setApprovingTransaction(true);
    try {
      const body: Record<string, any> = { status: 'completed' };
      if (isRecurring) {
        body.isRecurring = true;
        body.recurrenceFrequency = frequency;
      }
      if (skipBalance) {
        body.skipBalance = true;
      }
      const result = await fetchWithAuth(`/transactions/${transactionId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['transaction', transactionId] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/notifications'] });
      queryClient.invalidateQueries({ queryKey: ['/api/pending-commitments'] });
      toast({
        title: "Movimiento aprobado",
        description: "Completado y programado el próximo compromiso automáticamente.",
      });
      if (result?.undoKey) {
        pushGlobalUndoAction({
          undoKey: result.undoKey,
          entityType: 'transaction_approved',
          entityName: result.description || '',
          expiresAt: Date.now() + 55_000,
        });
      }
      setViewingDetails(null);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo aprobar el movimiento",
        variant: "destructive",
      });
    } finally {
      setApprovingTransaction(false);
    }
  };

  const openApprovalDialog = (transactionId: string, isAlreadyRecurring: boolean, existingFrequency?: string | null) => {
    setApprovalTransactionId(transactionId);
    setApprovalRecurring(isAlreadyRecurring);
    setApprovalFrequency(existingFrequency || 'monthly');
    setApprovalSkipBalance(false);
    setShowApprovalDialog(true);
  };
  
  const handleApproveTransaction = async () => {
    if (!approvalTransactionId) return;
    setApprovingTransaction(true);
    try {
      const body: Record<string, any> = { status: 'completed' };
      if (approvalRecurring) {
        body.isRecurring = true;
        body.recurrenceFrequency = approvalFrequency;
      }
      if (approvalSkipBalance) {
        body.skipBalance = true;
      }
      
      const result = await fetchWithAuth(`/transactions/${approvalTransactionId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['transaction', approvalTransactionId] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/notifications'] });
      queryClient.invalidateQueries({ queryKey: ['/api/pending-commitments'] });
      
      toast({
        title: "Movimiento aprobado",
        description: approvalRecurring 
          ? "Completado y programado el próximo compromiso automáticamente."
          : "El movimiento ha sido completado exitosamente.",
      });
      if (result?.undoKey) {
        pushGlobalUndoAction({
          undoKey: result.undoKey,
          entityType: 'transaction_approved',
          entityName: result.description || '',
          expiresAt: Date.now() + 55_000,
        });
      }
      setShowApprovalDialog(false);
      setViewingDetails(null);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo aprobar el movimiento",
        variant: "destructive",
      });
    } finally {
      setApprovingTransaction(false);
    }
  };

  const toggleTransactionSelection = (id: string) => {
    setSelectedTransactionIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllTransactions = () => {
    const ids = filteredTransactions.map(t => t.id);
    const allSelected = ids.length > 0 && ids.every(id => selectedTransactionIds.has(id));
    setSelectedTransactionIds(prev => {
      const next = new Set(prev);
      if (allSelected) {
        ids.forEach(id => next.delete(id));
      } else {
        ids.forEach(id => next.add(id));
      }
      return next;
    });
  };

  const clearTransactionSelection = () => setSelectedTransactionIds(new Set());

  const selectedTransactionItems = useMemo(() => {
    return filteredTransactions.filter(t => selectedTransactionIds.has(t.id));
  }, [selectedTransactionIds, filteredTransactions]);

  const selectedTransactionTotal = useMemo(() => {
    const byCurrency: Record<string, number> = {};
    selectedTransactionItems.forEach(item => {
      const curr = (item.currency as string) || 'ARS';
      const amt = typeof item.amount === 'string' ? parseFloat(item.amount) : item.amount;
      byCurrency[curr] = (byCurrency[curr] || 0) + amt;
    });
    return byCurrency;
  }, [selectedTransactionItems]);

  const formatCurrencyForBulk = (val: number, currency: string) => {
    const symbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || 'AR$';
    return `${symbol}${val.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const bulkDeleteTransactions = async () => {
    if (selectedTransactionItems.length === 0) return;
    setBulkDeleting(true);
    try {
      const ids = selectedTransactionItems.map(t => t.id);
      const CHUNK = 200;
      const aggregated: { deleted: string[]; skipped: { id: string; reason: string }[] } = { deleted: [], skipped: [] };
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const r = await fetchWithAuth('/transactions/bulk-delete', {
          method: 'POST',
          body: JSON.stringify({ ids: chunk }),
        });
        if (Array.isArray(r?.deleted)) aggregated.deleted.push(...r.deleted);
        if (Array.isArray(r?.skipped)) aggregated.skipped.push(...r.skipped);
      }
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      queryClient.invalidateQueries({ queryKey: ['/api/notifications'] });
      queryClient.invalidateQueries({ queryKey: ['/api/pending-commitments'] });
      const deletedCount = aggregated.deleted.length;
      const skipped = aggregated.skipped;
      const skippedCount = skipped.length;
      if (skippedCount === 0) {
        toast({ title: 'Movimientos eliminados', description: `Se eliminaron ${deletedCount} movimientos.` });
      } else {
        const reasons = skipped.reduce((acc: Record<string, number>, s: any) => {
          acc[s.reason] = (acc[s.reason] || 0) + 1; return acc;
        }, {});
        const reasonLabels: Record<string, string> = {
          invoiced: 'facturados',
          cancellation: 'son cancelaciones',
          not_found: 'no encontrados',
          child_failed: 'tienen costos asociados que no se pudieron eliminar',
          delete_failed: 'no se pudieron eliminar',
          already_processed: 'ya procesados como pareados',
          pair_delete_failed: 'pareada de transferencia no se pudo eliminar',
          error: 'con error',
        };
        const detail = Object.entries(reasons)
          .map(([r, n]) => `${n} ${reasonLabels[r] || r}`)
          .join(', ');
        toast({
          title: deletedCount > 0 ? 'Eliminación parcial' : 'No se pudo eliminar',
          description: `${deletedCount} eliminados. ${skippedCount} omitidos: ${detail}.`,
          variant: deletedCount > 0 ? 'default' : 'destructive',
        });
      }
      clearTransactionSelection();
      setShowBulkDeleteDialog(false);
    } catch (error: any) {
      toast({ title: 'Error', description: error.message || 'No se pudieron eliminar los movimientos', variant: 'destructive' });
    } finally {
      setBulkDeleting(false);
    }
  };

  const bulkApproveTransactions = async () => {
    if (selectedTransactionItems.length === 0) return;
    setBulkApproving(true);
    let successCount = 0;
    let failCount = 0;
    for (const item of selectedTransactionItems) {
      try {
        const body: Record<string, any> = { status: 'completed' };
        if (item.isRecurring || item.recurrenceSourceId || item.recurrenceFrequency) {
          body.isRecurring = true;
          body.recurrenceFrequency = item.recurrenceFrequency || 'monthly';
        }
        await fetchWithAuth(`/transactions/${item.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        successCount++;
      } catch {
        failCount++;
      }
    }
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
    queryClient.invalidateQueries({ queryKey: ['accounts'] });
    queryClient.invalidateQueries({ queryKey: ['/api/notifications'] });
    queryClient.invalidateQueries({ queryKey: ['/api/pending-commitments'] });
    if (failCount === 0) {
      toast({ title: "Movimientos confirmados", description: `Se confirmaron ${successCount} movimientos exitosamente.` });
    } else {
      toast({ title: "Confirmación parcial", description: `${successCount} confirmados, ${failCount} con error.`, variant: "destructive" });
    }
    clearTransactionSelection();
    setBulkApproving(false);
  };

  const formatCurrency = (val: number | string, currency?: string) => {
    const numVal = parseFloat(val.toString());
    const formatted = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(numVal);
    if (currency === 'USD' || currency === 'USD_CASH') return `US$${formatted}`;
    if (currency === 'EUR') return `€${formatted}`;
    return `AR$${formatted}`;
  };
  
  const formatCurrencyWithSign = (val: number | string, currency?: string, isPositive?: boolean) => {
    const numVal = parseFloat(val.toString());
    const formatted = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(numVal);
    const sign = isPositive ? '+' : '-';
    if (currency === 'USD' || currency === 'USD_CASH') return `${sign}US$${formatted}`;
    if (currency === 'EUR') return `${sign}€${formatted}`;
    return `${sign}AR$${formatted}`;
  };
  
  if (transactionsLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-lg text-muted-foreground">Cargando movimientos...</div>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold font-display">Movimientos</h1>
          <p className="text-muted-foreground">Historial de ingresos y egresos.</p>
        </div>
        
        <TransactionWizard />
        
        <Dialog open={isOpen && !!editingTransaction} onOpenChange={(open) => {
          if (!open) {
            setIsOpen(false);
            setEditingTransaction(null);
            setInvoiceFile(null);
            setInvoiceFileUrl(null);
            form.reset();
          }
        }}>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>{editingTransaction ? 'Editar Movimiento' : 'Nuevo Movimiento'}</DialogTitle>
              <DialogDescription>
                {editingTransaction 
                  ? 'Modifica los datos del movimiento seleccionado.' 
                  : 'Completa los datos para registrar un nuevo movimiento.'}
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
                
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="type"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tipo</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-type">
                              <SelectValue placeholder="Seleccionar tipo" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="income">Ingreso</SelectItem>
                            <SelectItem value="expense">Egreso</SelectItem>
                            <SelectItem value="payable">Compromiso de Pago</SelectItem>
                            <SelectItem value="receivable">Compromiso de Cobro</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={form.control}
                    name="date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Fecha</FormLabel>
                        <FormControl>
                          <Input type="date" {...field} data-testid="input-date" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Monto</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                          <Input
                            type="text"
                            inputMode="decimal"
                            className="pl-7"
                            placeholder="0,00"
                            data-testid="input-amount"
                            name={field.name}
                            ref={field.ref}
                            onBlur={field.onBlur}
                            value={formatAmountForDisplay(field.value ?? '')}
                            onChange={(e) => field.onChange(parseAmountFromDisplay(e.target.value))}
                          />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Descripción</FormLabel>
                      <FormControl>
                        <Input placeholder="Ej: Pago de alquiler" {...field} data-testid="input-description" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-4">
                   <FormField
                    control={form.control}
                    name="category"
                    render={({ field }) => {
                      const txType = (form.watch('type') as 'income' | 'expense' | 'payable' | 'receivable') || 'expense';
                      return (
                        <FormItem>
                          <FormLabel>Categoría</FormLabel>
                          <FormControl>
                            <CategoryPicker
                              value={field.value || ''}
                              onChange={field.onChange}
                              type={txType}
                              categories={transactionCategories}
                              placeholder="Categoría"
                              testId="select-category"
                              allowInlineCreate={canWriteTransactionCategory}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      );
                    }}
                  />

                  <FormField
                    control={form.control}
                    name="accountId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Cuenta</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-account">
                              <SelectValue placeholder="Cuenta" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {accounts.map(acc => {
                              const currency = acc.currency || 'ARS';
                              const currencySymbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || 'AR$';
                              const balance = parseFloat(String(acc.balance) || '0').toLocaleString('es-AR', { minimumFractionDigits: 2 });
                              return (
                                <SelectItem key={acc.id} value={acc.id}>
                                  {acc.name} ({currency}) - {currencySymbol} {balance}
                                </SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {!isPersonalBasic && (
                  <div className="space-y-4">
                    <FormField
                      control={form.control}
                      name="clientId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-muted-foreground">Cliente (opcional)</FormLabel>
                          <Select
                            onValueChange={(val) => {
                              field.onChange(val === '__none__' ? null : val);
                              if (val !== '__none__') form.setValue('supplierId', null);
                            }}
                            value={field.value || '__none__'}
                          >
                            <FormControl>
                              <SelectTrigger data-testid="select-client">
                                <SelectValue placeholder="Sin cliente" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="__none__">Sin cliente</SelectItem>
                              {orgClientsList.map((c) => (
                                <SelectItem key={c.id} value={c.id} data-testid={`option-client-${c.id}`}>
                                  {c.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="supplierId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-muted-foreground">Proveedor (opcional)</FormLabel>
                          <Select
                            onValueChange={(val) => {
                              field.onChange(val === '__none__' ? null : val);
                              if (val !== '__none__') form.setValue('clientId', null);
                            }}
                            value={field.value || '__none__'}
                          >
                            <FormControl>
                              <SelectTrigger data-testid="select-supplier">
                                <SelectValue placeholder="Sin proveedor" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="__none__">Sin proveedor</SelectItem>
                              {orgSuppliersList.map((s) => (
                                <SelectItem key={s.id} value={s.id} data-testid={`option-supplier-${s.id}`}>
                                  {s.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />
                  </div>
                )}

                <FormField
                  control={form.control}
                  name="profitabilityCodeId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-muted-foreground">Código de rentabilidad (opcional)</FormLabel>
                      <Select
                        onValueChange={(val) => field.onChange(val === '__none__' ? null : val)}
                        value={field.value || '__none__'}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-profitability-code">
                            <SelectValue placeholder="Sin código" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">Sin código</SelectItem>
                          {profitabilityCodes.filter((c) => c.isActive).map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              <span className="flex items-center gap-2">
                                {c.color && <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: c.color }} />}
                                <span className="font-mono text-xs">{c.code}</span>
                                <span>· {c.name}</span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="hasInvoice"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-md border p-3">
                      <div className="space-y-0.5">
                        <FormLabel className="text-sm">Tiene factura</FormLabel>
                        <p className="text-xs text-muted-foreground">
                          Activá para registrar tipo y número de comprobante
                        </p>
                      </div>
                      <FormControl>
                        <Switch
                          checked={!!field.value}
                          onCheckedChange={(v) => {
                            field.onChange(v);
                            if (!v) {
                              form.setValue('invoiceType', '');
                              form.setValue('invoiceNumber', '');
                              form.clearErrors('invoiceNumber');
                              setInvoiceFile(null);
                              setInvoiceFileUrl(null);
                            }
                          }}
                          data-testid="switch-has-invoice"
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />

                {form.watch('hasInvoice') && (
                  <div className="space-y-3 rounded-lg border border-dashed p-3">
                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="invoiceType"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Tipo de comprobante</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value || ''}>
                              <FormControl>
                                <SelectTrigger data-testid="select-invoice-type">
                                  <SelectValue placeholder="Tipo" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="A">Factura A</SelectItem>
                                <SelectItem value="B">Factura B</SelectItem>
                                <SelectItem value="C">Factura C</SelectItem>
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="invoiceNumber"
                        render={({ field }) => {
                          const raw = (field.value ?? '').toString();
                          const trimmed = raw.trim();
                          // Task #489: don't flag a stored invoice number that
                          // wasn't changed (pre-canonical / ARCA voucher values).
                          const originalInv = (editingTransaction?.invoiceNumber ?? '').toString().trim();
                          const isUnchangedExisting = trimmed !== '' && trimmed === originalInv;
                          const inlineErr =
                            !isUnchangedExisting && trimmed !== '' && !validateInvoiceNumber(trimmed)
                              ? INVOICE_NUMBER_FORMAT_ERROR
                              : null;
                          return (
                            <FormItem>
                              <FormLabel>Número de comprobante</FormLabel>
                              <FormControl>
                                <Input
                                  placeholder="0001-00001234"
                                  data-testid="input-invoice-number"
                                  {...field}
                                  value={field.value ?? ''}
                                  onBlur={(e) => {
                                    const v = e.target.value;
                                    if (v && v.trim() !== '') {
                                      const norm = normalizeInvoiceNumber(v);
                                      if (norm !== v) form.setValue('invoiceNumber', norm);
                                    }
                                    field.onBlur();
                                  }}
                                />
                              </FormControl>
                              <p className="text-[11px] text-muted-foreground mt-1">
                                {INVOICE_NUMBER_FORMAT_HINT}
                              </p>
                              {inlineErr && (
                                <p
                                  className="text-xs text-destructive mt-1"
                                  data-testid="error-invoice-number"
                                >
                                  {inlineErr}
                                </p>
                              )}
                              <FormMessage />
                            </FormItem>
                          );
                        }}
                      />
                    </div>

                    <div>
                      <Label className="text-sm">Archivo del comprobante</Label>
                      <input
                        ref={invoiceFileInputRef}
                        type="file"
                        accept=".jpg,.jpeg,.png,.webp,.pdf"
                        onChange={handleInvoiceFileUpload}
                        className="hidden"
                        data-testid="input-invoice-file"
                      />
                      {!invoiceFile && !invoiceFileUrl ? (
                        <button
                          type="button"
                          onClick={() => invoiceFileInputRef.current?.click()}
                          disabled={isUploadingInvoice}
                          className="mt-1 w-full p-3 border-2 border-dashed border-border rounded-lg hover:border-primary hover:bg-primary/5 transition-all flex items-center justify-center gap-2 text-muted-foreground hover:text-primary text-sm"
                          data-testid="button-upload-invoice"
                        >
                          <Upload className="h-4 w-4" />
                          <span className="font-medium">Adjuntar comprobante (opcional)</span>
                        </button>
                      ) : isUploadingInvoice ? (
                        <div className="mt-1 w-full p-3 border-2 border-primary/30 bg-primary/5 rounded-lg flex items-center justify-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin text-primary" />
                          <span className="text-sm text-primary font-medium">Subiendo...</span>
                        </div>
                      ) : (
                        <div className="mt-1 w-full p-2 border-2 border-green-200 bg-green-50 rounded-lg flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            <FileText className="h-4 w-4 text-green-600 shrink-0" />
                            <span
                              className="text-sm font-medium text-green-700 truncate"
                              data-testid="text-invoice-file-name"
                            >
                              {invoiceFile?.name || 'Comprobante adjunto'}
                            </span>
                            {!invoiceFile && invoiceFileUrl && (
                              <a
                                href={invoiceFileUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-primary hover:underline ml-2 shrink-0"
                                data-testid="link-view-invoice-file"
                              >
                                Ver
                              </a>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={removeInvoiceFile}
                            className="p-1 hover:bg-red-100 rounded text-red-500 hover:text-red-700 transition-colors"
                            data-testid="button-remove-invoice"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <Button 
                  type="submit" 
                  className="w-full mt-4"
                  disabled={createTransactionMutation.isPending || updateTransactionMutation.isPending || isUploadingInvoice}
                  data-testid="button-save-transaction"
                >
                  {createTransactionMutation.isPending || updateTransactionMutation.isPending 
                    ? 'Guardando...' 
                    : editingTransaction ? 'Guardar Cambios' : 'Guardar Movimiento'}
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="border-none shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-4">
            <Tabs value={activeTab} onValueChange={(val) => { setActiveTab(val); clearTransactionSelection(); }} className="w-full">
              <TabsList className="grid w-full max-w-md grid-cols-2">
                <TabsTrigger value="completed" className="gap-2" data-testid="tab-completed">
                  <ArrowDownLeft className="h-4 w-4" />
                  Movimientos
                  {completedTransactions.length > 0 && (
                    <span className="ml-1 bg-primary/10 text-primary px-1.5 py-0.5 rounded-full text-xs">
                      {completedTransactions.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="scheduled" className="gap-2" data-testid="tab-scheduled">
                  <CalendarClock className="h-4 w-4" />
                  Futuros
                  {scheduledTransactions.length > 0 && (
                    <span className="ml-1 bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full text-xs">
                      {scheduledTransactions.length}
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <CardTitle>{activeTab === 'completed' ? 'Historial' : 'Próximos Movimientos'}</CardTitle>
                {hasActiveFilters && (
                  <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full">
                    {filteredTransactions.length} de {transactions.length}
                  </span>
                )}
              </div>
            <div className="flex flex-wrap gap-2 items-center w-full sm:w-auto">
              {(() => {
                const renderFiltersBody = () => (
                  <div className="space-y-3">
                      <div>
                        <Label className="text-xs">Tipo</Label>
                        <Select value={filterType} onValueChange={setFilterType}>
                          <SelectTrigger className="h-8 mt-1">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">Todos</SelectItem>
                            <SelectItem value="income">Ingresos</SelectItem>
                            <SelectItem value="expense">Egresos</SelectItem>
                            <SelectItem value="payable">Por Pagar</SelectItem>
                            <SelectItem value="receivable">Por Cobrar</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-xs">Cuenta</Label>
                        <Select value={filterAccount} onValueChange={setFilterAccount}>
                          <SelectTrigger className="h-8 mt-1">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">Todas</SelectItem>
                            {accounts.map(acc => {
                              const currency = acc.currency || 'ARS';
                              const currencySymbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || 'AR$';
                              const balance = parseFloat(String(acc.balance) || '0').toLocaleString('es-AR', { minimumFractionDigits: 2 });
                              return (
                                <SelectItem key={acc.id} value={acc.id.toString()}>
                                  {acc.name} ({currency}) - {currencySymbol} {balance}
                                </SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                      </div>
                      {!isPersonalBasic && (orgClientsList.length > 0 || orgSuppliersList.length > 0) && (
                        <div>
                          <Label className="text-xs">Cliente / Proveedor</Label>
                          <Select value={filterCounterpart} onValueChange={setFilterCounterpart}>
                            <SelectTrigger className="h-8 mt-1" data-testid="filter-counterpart">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="all" data-testid="filter-counterpart-all">Todos</SelectItem>
                              {orgClientsList.map((c) => (
                                <SelectItem key={`client-${c.id}`} value={c.id} data-testid={`filter-counterpart-client-${c.id}`}>
                                  Cliente: {c.name}
                                </SelectItem>
                              ))}
                              {orgSuppliersList.map((s) => (
                                <SelectItem key={`supplier-${s.id}`} value={s.id} data-testid={`filter-counterpart-supplier-${s.id}`}>
                                  Proveedor: {s.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      {availableCategoryItems.length > 0 && (
                        <div>
                          <Label className="text-xs">Categoría</Label>
                          <div className="mt-1">
                            <CategoryPicker
                              selectedValues={filterCategories}
                              onValuesChange={setFilterCategories}
                              categories={availableCategoryItems}
                              allowInlineCreate={false}
                              placeholder="Todas las categorías"
                              testId="filter-category"
                              triggerClassName="h-8"
                            />
                          </div>
                        </div>
                      )}
                      {showCreatorColumn && (
                        <div>
                          <Label className="text-xs">Creado por</Label>
                          <Select value={filterCreator} onValueChange={setFilterCreator}>
                            <SelectTrigger className="h-8 mt-1" data-testid="filter-creator">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="all" data-testid="filter-creator-all">Todos</SelectItem>
                              {members.map((m) => (
                                <SelectItem
                                  key={m.userId}
                                  value={m.userId}
                                  data-testid={`filter-creator-${m.userId}`}
                                >
                                  {m.name || m.email}
                                </SelectItem>
                              ))}
                              {hasUnassignedMovements && (
                                <SelectItem value="unassigned" data-testid="filter-creator-unassigned">
                                  Sin asignar
                                </SelectItem>
                              )}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label className="text-xs">Desde</Label>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                className={cn(
                                  'h-8 mt-1 w-full justify-start font-normal px-3',
                                  !filterDateFrom && 'text-muted-foreground',
                                )}
                                data-testid="filter-date-from"
                              >
                                <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                                {filterDateFrom
                                  ? format(parseISO(filterDateFrom), 'dd/MM/yyyy', { locale: es })
                                  : 'dd/mm/aaaa'}
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-0" align="start">
                              <Calendar
                                mode="single"
                                selected={filterDateFrom ? parseISO(filterDateFrom) : undefined}
                                onSelect={(date) => {
                                  if (date) setFilterDateFrom(format(date, 'yyyy-MM-dd'));
                                  else setFilterDateFrom('');
                                }}
                                locale={es}
                                initialFocus
                              />
                            </PopoverContent>
                          </Popover>
                        </div>
                        <div>
                          <Label className="text-xs">Hasta</Label>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                className={cn(
                                  'h-8 mt-1 w-full justify-start font-normal px-3',
                                  !filterDateTo && 'text-muted-foreground',
                                )}
                                data-testid="filter-date-to"
                              >
                                <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                                {filterDateTo
                                  ? format(parseISO(filterDateTo), 'dd/MM/yyyy', { locale: es })
                                  : 'dd/mm/aaaa'}
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-0" align="start">
                              <Calendar
                                mode="single"
                                selected={filterDateTo ? parseISO(filterDateTo) : undefined}
                                onSelect={(date) => {
                                  if (date) setFilterDateTo(format(date, 'yyyy-MM-dd'));
                                  else setFilterDateTo('');
                                }}
                                locale={es}
                                initialFocus
                              />
                            </PopoverContent>
                          </Popover>
                        </div>
                      </div>
                    </div>
                );
                return (<>
              <Popover open={isFilterOpen} onOpenChange={setIsFilterOpen}>
                <PopoverTrigger asChild>
                  <Button variant={hasActiveFilters ? "default" : "outline"} size="sm" className="h-8 gap-1 flex-shrink-0" data-testid="button-filter">
                    <Filter className="h-3.5 w-3.5" />
                    <span className="sm:inline hidden">Filtrar</span>
                    {hasActiveFilters && <span className="ml-1 bg-white dark:bg-card/20 px-1.5 rounded text-xs">!</span>}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-[calc(100vw-2rem)] sm:w-80 max-h-[80vh] overflow-y-auto"
                  align="end"
                  collisionPadding={16}
                >
                  <div className="space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="font-medium">Filtros</h4>
                      <div className="flex items-center gap-1">
                        {hasActiveFilters && (
                          <Button variant="ghost" size="sm" onClick={clearFilters} className="h-6 text-xs">
                            <X className="h-3 w-3 mr-1" /> Limpiar
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => { setIsFilterOpen(false); setIsFilterDialogOpen(true); }}
                          title="Maximizar"
                          data-testid="button-filter-maximize"
                        >
                          <Maximize2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    {renderFiltersBody()}
                    <Button className="w-full" size="sm" onClick={() => setIsFilterOpen(false)} data-testid="button-apply-filters-popover">
                      Aplicar Filtros
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
              <Dialog open={isFilterDialogOpen} onOpenChange={setIsFilterDialogOpen}>
                <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-xl max-h-[85vh] overflow-y-auto">
                  <DialogHeader>
                    <div className="flex items-center justify-between gap-2 pr-6">
                      <DialogTitle>Filtros</DialogTitle>
                      {hasActiveFilters && (
                        <Button variant="ghost" size="sm" onClick={clearFilters} className="h-7 text-xs" data-testid="button-clear-filters-dialog">
                          <X className="h-3.5 w-3.5 mr-1" /> Limpiar
                        </Button>
                      )}
                    </div>
                  </DialogHeader>
                  {renderFiltersBody()}
                  <DialogFooter className="mt-4">
                    <Button className="w-full sm:w-auto" onClick={() => setIsFilterDialogOpen(false)} data-testid="button-apply-filters-dialog">
                      Aplicar Filtros
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              </>);
              })()}
              
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 gap-1 flex-shrink-0" data-testid="button-export">
                    <Download className="h-3.5 w-3.5" />
                    <span className="sm:inline hidden">Exportar</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem 
                    onClick={() => exportToCSV(getExportData(), 'movimientos')}
                    data-testid="export-excel"
                  >
                    <FileSpreadsheet className="mr-2 h-4 w-4" />
                    Excel (CSV) - Solo datos
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem 
                    onClick={() => {
                      const data = getExportData();
                      const analytics = generateAnalytics(filteredTransactions);
                      exportFullReportPDF('Reporte de Movimientos', data, analytics);
                    }}
                    data-testid="export-pdf"
                  >
                    <FileText className="mr-2 h-4 w-4" />
                    PDF Completo (con análisis)
                  </DropdownMenuItem>
                  <DropdownMenuItem 
                    onClick={() => {
                      const data = getExportData();
                      const analytics = generateAnalytics(filteredTransactions);
                      exportFullReportWord('Reporte de Movimientos', data, analytics);
                    }}
                    data-testid="export-word"
                  >
                    <FileType className="mr-2 h-4 w-4" />
                    Word Completo (con análisis)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              
              <div className="relative flex-1 min-w-[100px]">
                <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
                <Input
                  type="search"
                  placeholder="Buscar..."
                  className="pl-8 h-8 w-full"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  data-testid="input-search"
                />
              </div>
            </div>
          </div>
          </div>
        </CardHeader>
        <CardContent className="p-0 sm:p-0">
          {(() => {
            const canSelectHere = canBulkDelete || (activeTab === 'scheduled' && canBulkApprove);
            if (!canSelectHere) return null;
            const selectableTransactions = filteredTransactions.filter(t => !t.description?.startsWith('[CANCELACIÓN]'));
            if (selectableTransactions.length === 0) return null;
            const allSelected = selectableTransactions.every(t => selectedTransactionIds.has(t.id));
            return (
              <div className="flex items-center gap-2 px-4 py-2 border-b">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={() => {
                    if (allSelected) {
                      clearTransactionSelection();
                    } else {
                      setSelectedTransactionIds(new Set(selectableTransactions.map(t => t.id)));
                    }
                  }}
                  data-testid="checkbox-select-all-transactions"
                />
                <span className="text-xs text-muted-foreground">Seleccionar todos</span>
              </div>
            );
          })()}
          {filteredTransactions.length === 0 && (
            <div className="text-center py-12 text-muted-foreground px-4">
              {transactions.length === 0 
                ? (activeTab === 'completed' 
                    ? 'No hay movimientos ejecutados. Los ingresos y egresos completados aparecerán aquí.'
                    : 'No hay movimientos pendientes. Los compromisos de pago y cobro pendientes aparecerán aquí.')
                : 'No hay movimientos que coincidan con los filtros aplicados.'}
            </div>
          )}
          {filteredTransactions.length > 0 && (
            <>
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      {renderSortHeader('date', 'Fecha', 'px-2 py-2 text-left font-medium text-muted-foreground whitespace-nowrap')}
                      {renderSortHeader('description', 'Descripción', 'px-2 py-2 text-left font-medium text-muted-foreground')}
                      {renderSortHeader('category', 'Categoría', 'px-2 py-2 text-left font-medium text-muted-foreground whitespace-nowrap hidden xl:table-cell')}
                      {renderSortHeader('account', 'Cuenta', 'px-2 py-2 text-left font-medium text-muted-foreground whitespace-nowrap hidden lg:table-cell')}
                      {renderSortHeader('type', 'Tipo', 'px-2 py-2 text-left font-medium text-muted-foreground whitespace-nowrap hidden lg:table-cell')}
                      {renderSortHeader('counterpart', 'Cliente / Proveedor', 'px-2 py-2 text-left font-medium text-muted-foreground whitespace-nowrap hidden lg:table-cell', 'left', 'header-counterpart')}
                      {showCreatorColumn && renderSortHeader('creator', 'Creado por', 'px-2 py-2 text-left font-medium text-muted-foreground whitespace-nowrap hidden lg:table-cell', 'left', 'header-creator')}
                      {renderSortHeader('amount', 'Monto', 'px-2 py-2 text-right font-medium text-muted-foreground whitespace-nowrap', 'right')}
                      <th className="px-2 py-2 text-right font-medium text-muted-foreground w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTransactions.map((t) => {
                      const account = accounts.find(a => a.id === t.accountId);
                      const accountName = account?.name || 'Sin cuenta';
                      const hasInsufficientBalance = t.type === 'payable' && t.status === 'scheduled' && account && normalizeAmountInput(account.balance) < normalizeAmountInput(t.amount);
                      const hasLinkedParent = !!t.linkedTransactionId;
                      const hasLinkedChildren = transactions.some((tx: any) => tx.linkedTransactionId === t.id);
                      const isLinked = hasLinkedParent || hasLinkedChildren;
                      const dueDate = safeParseDate(t.imputationDate || t.date);
                      const isDueToday = (t.type === 'payable' || t.type === 'receivable') && t.status === 'scheduled' && isToday(dueDate);
                      const isOverdue = !isDueToday && (t.type === 'payable' || t.type === 'receivable') && t.status === 'scheduled' && isBefore(safeParseDate(t.imputationDate || t.date), new Date());

                      const rowBg = isDueToday ? 'bg-gradient-to-r from-yellow-50 to-amber-50' :
                        t.description.startsWith('[CANCELACIÓN]') ? 'bg-amber-50' :
                        hasInsufficientBalance ? 'bg-red-50/50' : 'hover:bg-muted/30';

                      return (
                        <tr
                          key={t.id}
                          className={`border-b transition-colors cursor-pointer ${rowBg}`}
                          data-testid={`transaction-row-desktop-${t.id}`}
                          onClick={() => setViewingDetails(t.id)}
                        >
                          <td className="px-2 py-2 text-muted-foreground whitespace-nowrap align-top">
                            <div className="flex flex-col">
                              <span className="font-medium text-foreground text-xs">
                                {format(safeParseDate(getDisplayDate(t)), "dd MMM", { locale: es })}
                              </span>
                              <span className="text-[11px] text-muted-foreground">
                                {format(safeParseDate(getDisplayDate(t)), "yyyy", { locale: es })}
                              </span>
                              {(t.type === 'payable' || t.type === 'receivable') && t.status === 'completed' && t.completedAt && t.createdAt && (
                                <span
                                  className="text-[10px] text-muted-foreground mt-0.5"
                                  title={`Registrado el ${format(safeParseDate(t.createdAt), "d 'de' MMMM yyyy", { locale: es })}`}
                                  data-testid={`text-registered-date-${t.id}`}
                                >
                                  Reg. {format(safeParseDate(t.createdAt), "dd/MM/yy", { locale: es })}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-2 py-2 align-top max-w-[200px] lg:max-w-[220px] xl:max-w-[280px]">
                            <div className="flex items-start gap-2">
                              <div className={`mt-0.5 h-6 w-6 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold ${
                                t.description.startsWith('[CANCELACIÓN]') ? 'bg-amber-200 text-amber-700' :
                                t.type === 'income' ? 'bg-green-100 text-green-600' :
                                t.type === 'expense' ? 'bg-red-100 text-red-600' :
                                t.type === 'receivable' ? 'bg-blue-100 text-blue-600' :
                                t.type === 'transfer_in' || t.type === 'transfer_out' ? 'bg-purple-100 text-purple-600' :
                                'bg-orange-100 text-orange-600'
                              }`}>
                                {t.description.startsWith('[CANCELACIÓN]') ? '↩' : (t.type === 'income' || t.type === 'receivable' || t.type === 'transfer_in') ? '+' : '−'}
                              </div>
                              <div className="min-w-0">
                                <p className="font-medium text-foreground truncate" title={t.description}>
                                  {t.description.startsWith('[CANCELACIÓN]') ? 'Cancelación' : t.description}
                                </p>
                                <div className="flex flex-wrap items-center gap-1 mt-0.5">
                                  {isLinked && (
                                    <span className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0 rounded-full font-medium ${
                                      hasLinkedParent ? 'bg-cyan-100 text-cyan-700' : 'bg-pink-100 text-pink-700'
                                    }`}>
                                      <Link className="h-2.5 w-2.5" />
                                      {hasLinkedParent ? 'Vinculado' : 'Origen'}
                                    </span>
                                  )}
                                  {hasInsufficientBalance && (
                                    <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0 rounded-full font-medium bg-red-100 text-red-700 animate-pulse">
                                      <AlertTriangle className="h-2.5 w-2.5" />
                                      Saldo insuf.
                                    </span>
                                  )}
                                  {(t as any).recurrenceTotalInstallments != null && (
                                    <span
                                      className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0 rounded-full font-medium bg-violet-100 text-violet-700"
                                      data-testid={`text-installment-count-${t.id}`}
                                      title="Cuota dentro de una serie cerrada"
                                    >
                                      <RefreshCw className="h-2.5 w-2.5" />
                                      Cuota {(t as any).recurrenceCurrentInstallment ?? 1} de {(t as any).recurrenceTotalInstallments}
                                    </span>
                                  )}
                                  {(t as any).createdVia === 'whatsapp' && (
                                    <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0 rounded-full font-medium bg-green-100 text-green-700">
                                      <svg viewBox="0 0 24 24" className="w-2.5 h-2.5" fill="currentColor">
                                        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                                      </svg>
                                      WA
                                    </span>
                                  )}
                                  <span className={`lg:hidden inline-flex items-center text-[10px] px-1.5 py-0 rounded-full font-medium w-fit ${getTransactionTypeBadgeClass(t.type, t.status)}`}>
                                    {getTransactionTypeLabel(t.type, t.status)}
                                  </span>
                                  <span className="lg:hidden text-[10px] text-muted-foreground">{accountName}</span>
                                  {(() => {
                                    const cp = getCounterpart(t);
                                    if (!cp.name) return null;
                                    return (
                                      <span
                                        className={`lg:hidden inline-flex items-center text-[10px] px-1.5 py-0 rounded-full font-medium max-w-[140px] truncate ${
                                          cp.kind === 'client'
                                            ? 'bg-cyan-50 text-cyan-700 border border-cyan-200'
                                            : 'bg-orange-50 text-orange-700 border border-orange-200'
                                        }`}
                                        title={`${cp.kind === 'client' ? 'Cliente' : 'Proveedor'}: ${cp.name}`}
                                        data-testid={`text-counterpart-inline-${t.id}`}
                                      >
                                        {cp.kind === 'client' ? 'Cliente: ' : 'Prov.: '}{cp.name}
                                      </span>
                                    );
                                  })()}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-2 py-2 align-top hidden xl:table-cell">
                            {isGhostCategory(t.type, t.category) ? (
                              <span
                                className="inline-flex items-center gap-1 text-xs bg-amber-50 border border-amber-300 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/40 px-2 py-0.5 rounded truncate max-w-[140px]"
                                title="Esta categoría ya no existe en la organización. Editá el movimiento para asignar una nueva."
                                data-testid={`badge-ghost-category-${t.id}`}
                              >
                                <AlertTriangle className="h-3 w-3 shrink-0" />
                                <span className="truncate">{t.category || 'Sin categoría'}</span>
                              </span>
                            ) : (
                              <span className="text-xs bg-secondary px-2 py-0.5 rounded text-foreground/80 truncate block max-w-[120px]">{t.category}</span>
                            )}
                          </td>
                          <td className="px-2 py-2 align-top hidden lg:table-cell">
                            <span className="text-xs text-muted-foreground truncate block max-w-[120px]">{accountName}</span>
                          </td>
                          <td className="px-2 py-2 align-top hidden lg:table-cell">
                            <div className="flex flex-col gap-0.5">
                              <span className={`inline-flex items-center text-[11px] px-2 py-0.5 rounded-full font-medium w-fit ${getTransactionTypeBadgeClass(t.type, t.status)}`}>
                                {getTransactionTypeLabel(t.type, t.status)}
                              </span>
                              {(t.type === 'payable' || t.type === 'receivable') && t.status !== 'completed' && (
                                <span className="text-[10px] text-muted-foreground">
                                  {isDueToday ? (
                                    <span className="font-bold text-yellow-700">
                                      Vence HOY
                                    </span>
                                  ) : isOverdue ? (
                                    <span className="font-bold text-red-600">
                                      VENCIDO
                                    </span>
                                  ) : (
                                    <span className="text-orange-600">
                                      Vence {format(safeParseDate(t.imputationDate || t.date), "dd/MM", { locale: es })}
                                    </span>
                                  )}
                                </span>
                              )}
                              {(t.type === 'payable' || t.type === 'receivable') && t.status === 'completed' && (
                                <span className="text-[10px] text-green-600 font-medium">
                                  {t.type === 'receivable' ? 'Cobrado' : 'Pagado'} {format(safeParseDate((t as any).completedAt || t.date), "dd/MM", { locale: es })}
                                </span>
                              )}
                            </div>
                          </td>
                          {(() => {
                            const cp = getCounterpart(t);
                            return (
                              <td
                                className="px-2 py-2 align-top hidden lg:table-cell"
                                data-testid={`cell-counterpart-${t.id}`}
                              >
                                {cp.name ? (
                                  <span
                                    className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium max-w-[140px] ${
                                      cp.kind === 'client'
                                        ? 'bg-cyan-50 text-cyan-700 border border-cyan-200'
                                        : 'bg-orange-50 text-orange-700 border border-orange-200'
                                    }`}
                                    title={`${cp.kind === 'client' ? 'Cliente' : 'Proveedor'}: ${cp.name}`}
                                    data-testid={`text-counterpart-${t.id}`}
                                  >
                                    <span className="truncate">{cp.name}</span>
                                  </span>
                                ) : (
                                  <span className="text-xs text-muted-foreground italic">—</span>
                                )}
                              </td>
                            );
                          })()}
                          {showCreatorColumn && (() => {
                            // Avatar circular con iniciales (mismas iniciales que se
                            // calculan en Reportes para el bloque "Por miembro").
                            // Para huérfanos (createdBy null) mostramos un círculo
                            // gris con "?" y la etiqueta "Sin asignar" en cursiva.
                            const { isUnassigned, fullName, initials } = getCreatorDisplay(t);
                            return (
                              <td
                                className="px-2 py-2 align-top hidden lg:table-cell"
                                data-testid={`cell-creator-${t.id}`}
                              >
                                <div className="flex items-center gap-2">
                                  <div
                                    className={`h-6 w-6 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-bold ${
                                      isUnassigned
                                        ? 'bg-muted text-muted-foreground'
                                        : 'bg-blue-100 text-blue-700'
                                    }`}
                                    aria-hidden="true"
                                  >
                                    {initials}
                                  </div>
                                  <span
                                    className={`text-xs truncate max-w-[120px] ${
                                      isUnassigned ? 'italic text-muted-foreground' : 'text-foreground/80'
                                    }`}
                                    title={fullName}
                                    data-testid={`text-creator-name-${t.id}`}
                                  >
                                    {fullName}
                                  </span>
                                </div>
                              </td>
                            );
                          })()}
                          <td className="px-2 py-2 text-right align-top">
                            <div className="flex flex-col items-end gap-1">
                              <span className={`font-semibold whitespace-nowrap ${
                                t.description.startsWith('[CANCELACIÓN]') ? 'text-amber-600' :
                                t.type === 'income' ? 'text-green-600' :
                                t.type === 'receivable' ? 'text-blue-600' :
                                t.type === 'payable' ? 'text-orange-600' :
                                t.type === 'transfer_in' || t.type === 'transfer_out' ? 'text-purple-600' :
                                'text-foreground'
                              }`}>
                                {formatCurrencyWithSign(t.amount, account?.currency, t.type === 'income' || t.type === 'receivable' || t.type === 'transfer_in')}
                              </span>
                              {(() => {
                                const fiscalInfo = getFiscalChipInfo(t);
                                if (!fiscalInfo) return null;
                                const clickable = fiscalInfo.action !== 'none';
                                return (
                                  <button
                                    type="button"
                                    disabled={!clickable}
                                    onClick={(e) => { e.stopPropagation(); handleFiscalChipClick(t); }}
                                    className={`text-[10px] px-1.5 py-0 rounded-full font-medium transition-colors whitespace-nowrap ${fiscalInfo.cls} ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
                                    data-testid={`chip-fiscal-amount-${fiscalInfo.key}-${t.id}`}
                                    title={fiscalInfo.label}
                                  >
                                    {fiscalInfo.label}
                                  </button>
                                );
                              })()}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right align-top">
                            <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                              {(canBulkDelete || (activeTab === 'scheduled' && canBulkApprove)) && !t.description?.startsWith('[CANCELACIÓN]') && (
                                <Checkbox
                                  checked={selectedTransactionIds.has(t.id)}
                                  onCheckedChange={() => toggleTransactionSelection(t.id)}
                                  className="flex-shrink-0"
                                  data-testid={`checkbox-select-transaction-${t.id}`}
                                />
                              )}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  data-testid={`button-menu-${t.id}`}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <MoreVertical className="h-4 w-4 text-muted-foreground" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={(e) => { e.stopPropagation(); setViewingDetails(t.id); }}
                                  data-testid={`button-view-${t.id}`}
                                >
                                  <Eye className="mr-2 h-4 w-4" />
                                  Ver detalles
                                </DropdownMenuItem>
                                {!t.description?.startsWith('[CANCELACIÓN]') && (
                                  <>
                                    <DropdownMenuSeparator />
                                    {FEATURE_FLAGS.INVOICING_ENABLED &&
                                      !isPersonalBasic &&
                                      (t.type === 'income' || t.type === 'receivable') &&
                                      !(t as any).invoiceCae &&
                                      (t as any).invoiceEmissionStatus !== 'pending' && (
                                        <DropdownMenuItem
                                          onClick={(e) => { e.stopPropagation(); setEmitInvoiceTarget(t); }}
                                          data-testid={`button-emit-invoice-${t.id}`}
                                        >
                                          <ReceiptIcon className="mr-2 h-4 w-4" />
                                          {(t as any).invoiceEmissionStatus === 'failed' ? 'Reintentar facturación' : 'Facturar'}
                                        </DropdownMenuItem>
                                      )}
                                    <DropdownMenuItem
                                      onClick={(e) => { e.stopPropagation(); openEditModal(t); }}
                                      data-testid={`button-edit-${t.id}`}
                                    >
                                      <Pencil className="mr-2 h-4 w-4" />
                                      Editar
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={(e) => { e.stopPropagation(); setDeletingTransaction(t); }}
                                      className="text-red-600 focus:text-red-600"
                                      data-testid={`button-delete-${t.id}`}
                                    >
                                      <Trash2 className="mr-2 h-4 w-4" />
                                      Eliminar
                                    </DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="md:hidden space-y-3 p-4">
                {filteredTransactions.map((t) => {
                  const account = accounts.find(a => a.id === t.accountId);
                  const accountName = account?.name || 'Sin cuenta';
                  const hasInsufficientBalance = t.type === 'payable' && t.status === 'scheduled' && account && normalizeAmountInput(account.balance) < normalizeAmountInput(t.amount);
                  const hasLinkedParent = !!t.linkedTransactionId;
                  const hasLinkedChildren = transactions.some((tx: any) => tx.linkedTransactionId === t.id);
                  const isLinked = hasLinkedParent || hasLinkedChildren;
                  const dueDate = safeParseDate(t.imputationDate || t.date);
                  const isDueToday = (t.type === 'payable' || t.type === 'receivable') && t.status === 'scheduled' && isToday(dueDate);
                  return (
                    <div
                      key={t.id}
                      className={`p-3 rounded-lg border transition-colors cursor-pointer overflow-hidden ${
                        isDueToday ? 'border-yellow-400 bg-gradient-to-r from-yellow-50 to-amber-50 ring-2 ring-yellow-300 shadow-md' :
                        t.description.startsWith('[CANCELACIÓN]') ? 'border-amber-400 bg-amber-50' :
                        hasInsufficientBalance ? 'border-red-300 bg-red-50/50' : 'border-border/50 hover:bg-secondary/30'
                      }`}
                      data-testid={`transaction-row-mobile-${t.id}`}
                      onClick={() => setViewingDetails(t.id)}
                    >
                      <div className="flex items-start gap-2">
                        <div className={`h-7 w-7 rounded-full flex-shrink-0 mt-0.5 flex items-center justify-center text-xs font-bold ${
                          t.description.startsWith('[CANCELACIÓN]') ? 'bg-amber-200 text-amber-700' :
                          t.type === 'income' ? 'bg-green-100 text-green-600' :
                          t.type === 'expense' ? 'bg-red-100 text-red-600' :
                          t.type === 'receivable' ? 'bg-blue-100 text-blue-600' :
                          t.type === 'transfer_in' || t.type === 'transfer_out' ? 'bg-purple-100 text-purple-600' :
                          'bg-orange-100 text-orange-600'
                        }`}>
                          {t.description.startsWith('[CANCELACIÓN]') ? '↩' : (t.type === 'income' || t.type === 'receivable' || t.type === 'transfer_in') ? '+' : '−'}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-medium text-foreground text-sm truncate">
                              {t.description.startsWith('[CANCELACIÓN]') ? 'Cancelación' : t.description}
                            </p>
                            <div className="flex items-center gap-1.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                              {(canBulkDelete || (activeTab === 'scheduled' && canBulkApprove)) && !t.description?.startsWith('[CANCELACIÓN]') && (
                                <Checkbox
                                  checked={selectedTransactionIds.has(t.id)}
                                  onCheckedChange={() => toggleTransactionSelection(t.id)}
                                  className="flex-shrink-0"
                                  data-testid={`checkbox-select-transaction-${t.id}`}
                                />
                              )}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 flex-shrink-0"
                                  data-testid={`button-menu-${t.id}`}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <MoreVertical className="h-4 w-4 text-muted-foreground" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={(e) => { e.stopPropagation(); setViewingDetails(t.id); }}
                                  data-testid={`button-view-${t.id}`}
                                >
                                  <Eye className="mr-2 h-4 w-4" />
                                  Ver detalles
                                </DropdownMenuItem>
                                {!t.description?.startsWith('[CANCELACIÓN]') && (
                                  <>
                                    <DropdownMenuSeparator />
                                    {FEATURE_FLAGS.INVOICING_ENABLED &&
                                      !isPersonalBasic &&
                                      (t.type === 'income' || t.type === 'receivable') &&
                                      !(t as any).invoiceCae &&
                                      (t as any).invoiceEmissionStatus !== 'pending' && (
                                        <DropdownMenuItem
                                          onClick={(e) => { e.stopPropagation(); setEmitInvoiceTarget(t); }}
                                          data-testid={`button-emit-invoice-${t.id}`}
                                        >
                                          <ReceiptIcon className="mr-2 h-4 w-4" />
                                          {(t as any).invoiceEmissionStatus === 'failed' ? 'Reintentar facturación' : 'Facturar'}
                                        </DropdownMenuItem>
                                      )}
                                    <DropdownMenuItem
                                      onClick={(e) => { e.stopPropagation(); openEditModal(t); }}
                                      data-testid={`button-edit-${t.id}`}
                                    >
                                      <Pencil className="mr-2 h-4 w-4" />
                                      Editar
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={(e) => { e.stopPropagation(); setDeletingTransaction(t); }}
                                      className="text-red-600 focus:text-red-600"
                                      data-testid={`button-delete-${t.id}`}
                                    >
                                      <Trash2 className="mr-2 h-4 w-4" />
                                      Eliminar
                                    </DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                            </div>
                          </div>
                          <div className="flex items-center justify-between gap-2 mt-0.5">
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                <span className="flex-shrink-0">{format(safeParseDate(getDisplayDate(t)), "dd/MM/yy", { locale: es })}</span>
                                {(t.type === 'payable' || t.type === 'receivable') && t.status === 'completed' && t.completedAt && t.createdAt && (
                                  <>
                                    <span>·</span>
                                    <span
                                      className="flex-shrink-0"
                                      title={`Registrado el ${format(safeParseDate(t.createdAt), "d 'de' MMMM yyyy", { locale: es })}`}
                                      data-testid={`text-registered-date-mobile-${t.id}`}
                                    >
                                      Reg. {format(safeParseDate(t.createdAt), "dd/MM/yy", { locale: es })}
                                    </span>
                                  </>
                                )}
                                <span>·</span>
                                <span className="truncate">{accountName}</span>
                                {isDueToday && (
                                  <>
                                    <span>·</span>
                                    <span className="font-bold text-yellow-700 flex-shrink-0">HOY</span>
                                  </>
                                )}
                                {!isDueToday && (t.type === 'payable' || t.type === 'receivable') && t.status === 'scheduled' && isBefore(safeParseDate(t.imputationDate || t.date), new Date()) && (
                                  <>
                                    <span>·</span>
                                    <span className="font-bold text-red-600 flex-shrink-0">VENCIDO</span>
                                  </>
                                )}
                              </div>
                              {(() => {
                                const cp = getCounterpart(t);
                                if (!cp.name) return null;
                                return (
                                  <span
                                    className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full font-medium max-w-full truncate w-fit ${
                                      cp.kind === 'client'
                                        ? 'bg-cyan-50 text-cyan-700 border border-cyan-200'
                                        : 'bg-orange-50 text-orange-700 border border-orange-200'
                                    }`}
                                    title={`${cp.kind === 'client' ? 'Cliente' : 'Proveedor'}: ${cp.name}`}
                                    data-testid={`text-counterpart-mobile-${t.id}`}
                                  >
                                    {cp.kind === 'client' ? 'Cliente: ' : 'Prov.: '}{cp.name}
                                  </span>
                                );
                              })()}
                              {(t as any).recurrenceTotalInstallments != null && (
                                <span
                                  className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-violet-100 text-violet-700 w-fit"
                                  data-testid={`text-installment-count-mobile-${t.id}`}
                                  title="Cuota dentro de una serie cerrada"
                                >
                                  <RefreshCw className="h-2.5 w-2.5" />
                                  Cuota {(t as any).recurrenceCurrentInstallment ?? 1} de {(t as any).recurrenceTotalInstallments}
                                </span>
                              )}
                              {showCreatorColumn && (() => {
                                const { isUnassigned, fullName, firstName, initials } = getCreatorDisplay(t);
                                return (
                                  <div
                                    className="flex items-center gap-1 min-w-0"
                                    data-testid={`cell-creator-mobile-${t.id}`}
                                  >
                                    <div
                                      className={`h-4 w-4 rounded-full flex-shrink-0 flex items-center justify-center text-[8px] font-bold ${
                                        isUnassigned
                                          ? 'bg-muted text-muted-foreground'
                                          : 'bg-blue-100 text-blue-700'
                                      }`}
                                      aria-hidden="true"
                                    >
                                      {initials}
                                    </div>
                                    <span
                                      className={`text-[11px] truncate ${
                                        isUnassigned ? 'italic text-muted-foreground' : 'text-muted-foreground'
                                      }`}
                                      title={fullName}
                                      data-testid={`text-creator-name-mobile-${t.id}`}
                                    >
                                      {firstName}
                                    </span>
                                  </div>
                                );
                              })()}
                            </div>
                            <div className="flex flex-col items-end gap-1">
                              <div className={`font-semibold text-sm whitespace-nowrap ${
                                t.description.startsWith('[CANCELACIÓN]') ? 'text-amber-600' :
                                t.type === 'income' ? 'text-green-600' :
                                t.type === 'receivable' ? 'text-blue-600' :
                                t.type === 'payable' ? 'text-orange-600' :
                                t.type === 'transfer_in' || t.type === 'transfer_out' ? 'text-purple-600' :
                                'text-foreground'
                              }`}>
                                {formatCurrencyWithSign(t.amount, account?.currency, t.type === 'income' || t.type === 'receivable' || t.type === 'transfer_in')}
                              </div>
                              {(() => {
                                const fiscalInfo = getFiscalChipInfo(t);
                                if (!fiscalInfo) return null;
                                const clickable = fiscalInfo.action !== 'none';
                                return (
                                  <button
                                    type="button"
                                    disabled={!clickable}
                                    onClick={(e) => { e.stopPropagation(); handleFiscalChipClick(t); }}
                                    className={`text-[10px] px-1.5 py-0 rounded-full font-medium transition-colors ${fiscalInfo.cls} ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
                                    data-testid={`chip-fiscal-mobile-${fiscalInfo.key}-${t.id}`}
                                    title={fiscalInfo.label}
                                  >
                                    {fiscalInfo.label}
                                  </button>
                                );
                              })()}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!deletingTransaction} onOpenChange={(open) => !open && setDeletingTransaction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar movimiento?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Se eliminará el movimiento "{deletingTransaction?.description}" por {deletingTransaction && formatCurrency(deletingTransaction.amount, accounts.find(a => a.id === deletingTransaction.accountId)?.currency)}.
                </p>
                {deletingTransaction?.status === 'completed' && deletingTransaction?.accountId && (
                  <p className="text-amber-600 font-medium">
                    {deletingTransaction.type === 'income' 
                      ? `Se restarán ${formatCurrency(deletingTransaction.amount, accounts.find(a => a.id === deletingTransaction.accountId)?.currency)} de la cuenta.`
                      : `Se restituirán ${formatCurrency(deletingTransaction.amount, accounts.find(a => a.id === deletingTransaction.accountId)?.currency)} a la cuenta.`
                    }
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancelar</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700"
              data-testid="button-confirm-delete"
            >
              {deleteTransactionMutation.isPending ? 'Eliminando...' : 'Continuar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!viewingInvoice} onOpenChange={(open) => !open && setViewingInvoice(null)}>
        <DialogContent className="sm:max-w-[600px] max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-green-600" />
              Detalle de Factura
            </DialogTitle>
            <DialogDescription>
              Información del comprobante fiscal asociado a este movimiento
            </DialogDescription>
          </DialogHeader>
          {viewingInvoice && (
            <div className="space-y-4 overflow-y-auto flex-1 pr-1">
              <div className="grid grid-cols-2 gap-4 p-4 bg-secondary/30 rounded-lg">
                <div>
                  <p className="text-xs text-muted-foreground">Tipo de Factura</p>
                  <p className="font-semibold">Factura {viewingInvoice.invoiceType || '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Número</p>
                  <p className="font-semibold">{viewingInvoice.invoiceNumber || '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Monto</p>
                  <p className="font-semibold text-green-600">{formatCurrency(viewingInvoice.amount, accounts.find(a => a.id === viewingInvoice.accountId)?.currency)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Fecha</p>
                  <p className="font-semibold">{viewingInvoice.date ? format(safeParseDate(viewingInvoice.date), "d 'de' MMMM yyyy", { locale: es }) : '-'}</p>
                </div>
              </div>
              
              {viewingInvoice.invoiceFileUrl ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Archivo adjunto</p>
                  <div className="border rounded-lg overflow-hidden bg-secondary/20">
                    <img
                      src={viewingInvoice.invoiceFileUrl}
                      alt="Factura"
                      className="w-full max-h-[400px] object-contain"
                      data-testid="img-invoice-preview"
                      onError={(e) => {
                        const target = e.target as HTMLImageElement;
                        target.style.display = 'none';
                        const parent = target.parentElement;
                        if (!parent) return;

                        const url = viewingInvoice.invoiceFileUrl || '';
                        const isSafeUrl = /^(https?:|blob:|\/)/i.test(url);

                        parent.replaceChildren();

                        const wrapper = document.createElement('div');
                        wrapper.className = 'p-4 flex items-center justify-between';

                        const left = document.createElement('div');
                        left.className = 'flex items-center gap-2';

                        const SVG_NS = 'http://www.w3.org/2000/svg';
                        const svg = document.createElementNS(SVG_NS, 'svg');
                        svg.setAttribute('xmlns', SVG_NS);
                        svg.setAttribute('width', '32');
                        svg.setAttribute('height', '32');
                        svg.setAttribute('viewBox', '0 0 24 24');
                        svg.setAttribute('fill', 'none');
                        svg.setAttribute('stroke', 'currentColor');
                        svg.setAttribute('stroke-width', '2');
                        svg.setAttribute('stroke-linecap', 'round');
                        svg.setAttribute('stroke-linejoin', 'round');
                        svg.setAttribute('class', 'text-red-500');

                        const path = document.createElementNS(SVG_NS, 'path');
                        path.setAttribute('d', 'M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z');
                        svg.appendChild(path);

                        const polyline = document.createElementNS(SVG_NS, 'polyline');
                        polyline.setAttribute('points', '14 2 14 8 20 8');
                        svg.appendChild(polyline);

                        const span = document.createElement('span');
                        span.className = 'text-sm font-medium';
                        span.textContent = 'Documento adjunto';

                        left.appendChild(svg);
                        left.appendChild(span);
                        wrapper.appendChild(left);

                        if (isSafeUrl) {
                          const link = document.createElement('a');
                          link.setAttribute('href', url);
                          link.setAttribute('target', '_blank');
                          link.setAttribute('rel', 'noopener noreferrer');
                          link.className = 'text-primary hover:underline text-sm font-medium';
                          link.textContent = 'Abrir archivo';
                          wrapper.appendChild(link);
                        }

                        parent.appendChild(wrapper);
                      }}
                    />
                  </div>
                  <a
                    href={viewingInvoice.invoiceFileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                    data-testid="link-download-invoice"
                  >
                    <Download className="h-4 w-4" />
                    Ver en tamaño completo
                  </a>
                </div>
              ) : (
                <div className="border-2 border-dashed border-border rounded-lg p-6 text-center text-muted-foreground">
                  <FileText className="h-10 w-10 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">No hay archivo adjunto</p>
                  <p className="text-xs mt-1">El comprobante fue registrado sin imagen/PDF</p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Transaction Details Dialog */}
      <Dialog open={!!viewingDetails} onOpenChange={(open) => { if (!open) { setViewingDetails(null); setIsDetailsMaximized(false); setDetailsHistory([]); setIsEditingDetail(false); setRepairMode(null); setRepairCounterpartAccountId(''); setRepairCounterpartAmount(''); } }}>
        <DialogContent className={`${isDetailsMaximized ? 'sm:max-w-[95vw] h-[95vh]' : 'sm:max-w-[700px] max-h-[90vh]'} overflow-y-auto transition-all duration-200`}>
          <DialogHeader>
            <div className="flex items-center gap-2">
              {detailsHistory.length > 0 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={goBackInHistory}
                  data-testid="button-back-history"
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setIsDetailsMaximized(!isDetailsMaximized)}
                data-testid="button-maximize-details"
              >
                {isDetailsMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
              <DialogTitle className="flex items-center gap-2">
                <Eye className="h-5 w-5" />
                Detalle del Movimiento
              </DialogTitle>
            </div>
            <DialogDescription>
              {detailsHistory.length > 0 
                ? `Navegando trazabilidad (${detailsHistory.length} nivel${detailsHistory.length > 1 ? 'es' : ''} atrás)`
                : 'Información completa del movimiento seleccionado'}
            </DialogDescription>
          </DialogHeader>
          
          {detailsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : transactionDetails ? (
            <div className="space-y-6">
              {/* Transaction Number with copy button */}
              {transactionDetails.transactionNumber && (
                <div className="flex items-center justify-between p-3 rounded-lg bg-gradient-to-r from-primary/10 to-primary/5 border border-primary/20">
                  <div className="flex items-center gap-2">
                    <Hash className="h-4 w-4 text-primary" />
                    <span className="text-sm text-muted-foreground">N° de Movimiento:</span>
                    <span className="font-mono font-bold text-primary">{transactionDetails.transactionNumber}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={() => {
                      navigator.clipboard.writeText(transactionDetails.transactionNumber);
                      toast({ title: 'Copiado', description: 'Número de movimiento copiado al portapapeles' });
                    }}
                    data-testid="button-copy-transaction-number"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              )}

              {/* Header with type badge and amount */}
              {(() => {
                return (
                  <>
                    <div className="flex items-center justify-between p-4 rounded-lg bg-secondary/30">
                      <div className="flex items-center gap-3">
                        <div className={`h-12 w-12 rounded-full flex items-center justify-center text-xl font-bold ${
                          transactionDetails.type === 'income' ? 'bg-green-100 text-green-600' : 
                          transactionDetails.type === 'expense' ? 'bg-red-100 text-red-600' :
                          transactionDetails.type === 'receivable' ? 'bg-blue-100 text-blue-600' :
                          'bg-orange-100 text-orange-600'
                        }`}>
                          {(transactionDetails.type === 'income' || transactionDetails.type === 'receivable') ? '+' : '−'}
                        </div>
                        <div>
                          <h3 className="font-semibold text-lg">{transactionDetails.description}</h3>
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${getTransactionTypeBadgeClass(transactionDetails.type, transactionDetails.status)}`}>
                            {getTransactionTypeLabel(transactionDetails.type, transactionDetails.status)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {isEditingDetail ? (
                          <div className="flex items-center gap-1">
                            <span className={`text-lg font-bold ${
                              transactionDetails.type === 'income' ? 'text-green-600' : 
                              transactionDetails.type === 'receivable' ? 'text-blue-600' :
                              transactionDetails.type === 'payable' ? 'text-orange-600' :
                              'text-red-600'
                            }`}>
                              {(transactionDetails.type === 'income' || transactionDetails.type === 'receivable') ? '+' : '-'}
                            </span>
                            <Input
                              type="text"
                              inputMode="decimal"
                              value={editDetailItems.length >= 2
                                ? new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
                                    editDetailItems.reduce((s, it) => s + (parseFloat(it.quantity) || 0) * (parseFloat(it.unitPrice) || 0), 0))
                                : editDetailAmount}
                              disabled={editDetailItems.length >= 2}
                              title={editDetailItems.length >= 2 ? 'El total se calcula a partir de los renglones de productos' : undefined}
                              onChange={(e) => {
                                if (editDetailItems.length >= 2) return;
                                const raw = e.target.value.replace(/\./g, '').replace(',', '.');
                                const cleaned = raw.replace(/[^0-9.]/g, '');
                                const parts = cleaned.split('.');
                                if (parts.length > 2) return;
                                if (parts[1] && parts[1].length > 2) return;
                                const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
                                const formatted = parts.length === 2 ? `${intPart},${parts[1]}` : intPart;
                                setEditDetailAmount(formatted);
                              }}
                              className="w-44 text-right font-bold text-lg h-10"
                              data-testid="input-edit-detail-amount"
                            />
                          </div>
                        ) : (
                          <div className="flex flex-col items-end gap-1">
                            <div className={`text-2xl font-bold ${
                              transactionDetails.type === 'income' ? 'text-green-600' : 
                              transactionDetails.type === 'receivable' ? 'text-blue-600' :
                              transactionDetails.type === 'payable' ? 'text-orange-600' :
                              'text-red-600'
                            }`}>
                              {(transactionDetails.type === 'income' || transactionDetails.type === 'receivable') ? '+' : '-'}
                              {formatCurrency(transactionDetails.amount, transactionDetails.account?.currency)}
                            </div>
                            {(() => {
                              const fiscalInfo = getFiscalChipInfo(transactionDetails);
                              if (!fiscalInfo) return null;
                              const clickable = fiscalInfo.action !== 'none';
                              return (
                                <button
                                  type="button"
                                  disabled={!clickable}
                                  onClick={() => handleFiscalChipClick(transactionDetails)}
                                  className={`text-[11px] px-2 py-0.5 rounded-full font-semibold transition-colors ${fiscalInfo.cls} ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
                                  data-testid={`chip-fiscal-detail-${fiscalInfo.key}`}
                                  title={fiscalInfo.label}
                                >
                                  {fiscalInfo.label}
                                </button>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Basic info grid */}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <Hash className="h-3 w-3" /> Categoría
                        </p>
                        {isEditingDetail ? (
                          <CategoryPicker
                            value={editDetailCategory}
                            onChange={setEditDetailCategory}
                            type={transactionDetails.type as 'income' | 'expense' | 'payable' | 'receivable'}
                            categories={transactionCategories}
                            placeholder="Categoría"
                            testId="select-edit-detail-category"
                            triggerClassName="h-9"
                            allowInlineCreate={canWriteTransactionCategory}
                          />
                        ) : isGhostCategory(transactionDetails.type, transactionDetails.category) ? (
                          <div className="space-y-1">
                            <p className="font-medium flex items-center gap-1 text-amber-700 dark:text-amber-400" data-testid="text-detail-category-ghost">
                              <AlertTriangle className="h-3.5 w-3.5" />
                              {transactionDetails.category}
                            </p>
                            <p className="text-[11px] text-amber-700 dark:text-amber-400">
                              Esta categoría ya no existe. Editá el movimiento para elegir una nueva.
                            </p>
                          </div>
                        ) : (
                          <p className="font-medium">{transactionDetails.category}</p>
                        )}
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <CreditCard className="h-3 w-3" /> Cuenta
                        </p>
                        {isEditingDetail ? (
                          <Select value={editDetailAccountId} onValueChange={setEditDetailAccountId}>
                            <SelectTrigger className="h-9" data-testid="select-edit-detail-account">
                              <SelectValue placeholder="Cuenta" />
                            </SelectTrigger>
                            <SelectContent>
                              {accounts.map(acc => (
                                <SelectItem key={acc.id} value={acc.id.toString()}>{acc.name} ({acc.currency})</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <p className="font-medium">
                            {transactionDetails.account?.name || 'Sin cuenta'}
                            {transactionDetails.account?.currency && (
                              <span className="text-xs ml-1 text-muted-foreground">({transactionDetails.account.currency})</span>
                            )}
                          </p>
                        )}
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">
                          {(transactionDetails.type === 'payable' || transactionDetails.type === 'receivable') && transactionDetails.status === 'completed' 
                            ? (transactionDetails.type === 'receivable' ? 'Fecha de cobro' : 'Fecha de pago')
                            : (transactionDetails.type === 'payable' || transactionDetails.type === 'receivable') 
                              ? 'Fecha de vencimiento' 
                              : 'Fecha del movimiento'}
                        </p>
                        <p className="font-medium">
                          {(() => {
                            const isCompletedCommitment = (transactionDetails.type === 'payable' || transactionDetails.type === 'receivable') && transactionDetails.status === 'completed';
                            const dateToShow = isCompletedCommitment && (transactionDetails as any).completedAt 
                              ? (transactionDetails as any).completedAt 
                              : transactionDetails.date;
                            const dateFmt = isCompletedCommitment && (transactionDetails as any).completedAt ? "d 'de' MMMM yyyy, HH:mm" : "d 'de' MMMM yyyy";
                            return dateToShow ? format(safeParseDate(dateToShow), dateFmt, { locale: es }) : '-';
                          })()}
                        </p>
                      </div>
                      {(transactionDetails.type === 'payable' || transactionDetails.type === 'receivable') && transactionDetails.status === 'completed' && transactionDetails.completedAt && transactionDetails.date && (
                        <div className="space-y-1">
                          <p className="text-xs text-muted-foreground">Fecha de vencimiento original</p>
                          <p className="font-medium" data-testid="text-detail-original-due-date">
                            {format(safeParseDate(transactionDetails.date), "d 'de' MMMM yyyy", { locale: es })}
                          </p>
                        </div>
                      )}
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Fecha de imputación</p>
                        <p className="font-medium">{transactionDetails.imputationDate ? format(safeParseDate(transactionDetails.imputationDate), "MMMM yyyy", { locale: es }) : '-'}</p>
                      </div>
                      {(isEditingDetail || transactionDetailsProfitabilityCodeId) && (
                        <div className="space-y-1">
                          <p className="text-xs text-muted-foreground">Código de rentabilidad</p>
                          {isEditingDetail ? (
                            <Select
                              value={editDetailProfitabilityCodeId || '__none__'}
                              onValueChange={(val) => setEditDetailProfitabilityCodeId(val === '__none__' ? null : val)}
                            >
                              <SelectTrigger className="h-9" data-testid="select-edit-detail-profitability-code">
                                <SelectValue placeholder="Sin código" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">Sin código</SelectItem>
                                {profitabilityCodes.filter((c) => c.isActive).map((c) => (
                                  <SelectItem key={c.id} value={c.id}>
                                    <span className="flex items-center gap-2">
                                      {c.color && <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: c.color }} />}
                                      <span className="font-mono text-xs">{c.code}</span>
                                      <span>· {c.name}</span>
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <p className="font-medium">
                              {(() => {
                                const code = profitabilityCodes.find((c) => c.id === transactionDetailsProfitabilityCodeId);
                                if (!code) return '-';
                                return (
                                  <span className="inline-flex items-center gap-2">
                                    {code.color && <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: code.color }} />}
                                    <span className="font-mono text-xs">{code.code}</span>
                                    <span>· {code.name}</span>
                                  </span>
                                );
                              })()}
                            </p>
                          )}
                        </div>
                      )}
                    </div>

                    {isEditingDetail && (
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={cancelEditingDetail}
                          disabled={savingDetail}
                          data-testid="button-cancel-edit-detail"
                        >
                          Cancelar
                        </Button>
                        <Button
                          size="sm"
                          onClick={saveDetailEdits}
                          disabled={savingDetail}
                          className="bg-primary"
                          data-testid="button-save-edit-detail"
                        >
                          {savingDetail ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                          Guardar cambios
                        </Button>
                      </div>
                    )}
                  </>
                );
              })()}

              {/* Orphan transfer banner: a transfer leg with no counterpart */}
              {(transactionDetails.type === 'transfer_in' || transactionDetails.type === 'transfer_out') && (() => {
                // The /api/transactions/:id endpoint computes these fields
                // server-side for transfer legs. They are not on the base
                // Transaction type, so we narrow once to a typed view here
                // instead of sprinkling `as any` through the JSX.
                const orphanInfo = transactionDetails as {
                  isOrphanTransfer?: boolean;
                  orphanReason?: 'no_pair_id' | 'missing_counterpart';
                };
                if (!orphanInfo.isOrphanTransfer) return null;
                // Sign-preserving conversion (server enforces this too).
                const convertNewType: 'income' | 'expense' =
                  transactionDetails.type === 'transfer_in' ? 'income' : 'expense';
                const convertNewLabel = convertNewType === 'income' ? 'ingreso' : 'gasto';
                return (
                  <div
                    className="p-4 rounded-lg bg-amber-50 border border-amber-300 space-y-3"
                    data-testid="banner-orphan-transfer"
                  >
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
                      <div className="space-y-1">
                        <p className="font-semibold text-amber-900">Transferencia huérfana</p>
                        <p className="text-sm text-amber-800">
                          {orphanInfo.orphanReason === 'no_pair_id'
                            ? 'Esta transferencia quedó registrada sin contraparte (no tiene identificador de par). El movimiento no suma al cashflow porque las transferencias internas se excluyen de los totales.'
                            : 'No encontramos la contraparte de esta transferencia. Probablemente se eliminó manualmente. Mientras esté huérfana, el dinero no aparece en los totales del cashflow.'}
                        </p>
                        <p className="text-xs text-amber-700">
                          Podés <strong>recrear la pata faltante</strong> apuntando a la cuenta correcta, o <strong>convertirla en {convertNewLabel}</strong> para que vuelva a sumar al cashflow.
                        </p>
                      </div>
                    </div>

                    {repairMode === null && (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="default"
                          className="bg-amber-600 hover:bg-amber-700 text-white"
                          onClick={() => {
                            setRepairMode('recreate');
                            setRepairCounterpartAccountId('');
                            setRepairCounterpartAmount('');
                          }}
                          data-testid="button-orphan-recreate"
                        >
                          Recrear contraparte
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-amber-400 text-amber-900 hover:bg-amber-100"
                          onClick={() => setRepairMode('convert')}
                          data-testid="button-orphan-convert"
                        >
                          Convertir en {convertNewLabel}
                        </Button>
                      </div>
                    )}

                    {repairMode === 'recreate' && (
                      <div className="space-y-3 bg-white dark:bg-card/60 p-3 rounded-md border border-amber-200">
                        <p className="text-sm text-amber-900 font-medium">
                          {transactionDetails.type === 'transfer_in'
                            ? 'Elegí la cuenta desde la cual salió el dinero.'
                            : 'Elegí la cuenta a la cual entró el dinero.'}
                        </p>
                        <div className="space-y-1">
                          <p className="text-xs text-amber-800">Cuenta contraparte</p>
                          <Select
                            value={repairCounterpartAccountId}
                            onValueChange={setRepairCounterpartAccountId}
                          >
                            <SelectTrigger className="h-9" data-testid="select-orphan-counterpart-account">
                              <SelectValue placeholder="Seleccionar cuenta" />
                            </SelectTrigger>
                            <SelectContent>
                              {accounts
                                .filter(acc => acc.id !== transactionDetails.accountId)
                                .map(acc => (
                                  <SelectItem key={acc.id} value={acc.id.toString()}>
                                    {acc.name} ({acc.currency})
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs text-amber-800">
                            Monto contraparte (opcional, default = mismo monto)
                          </p>
                          <Input
                            type="text"
                            inputMode="decimal"
                            placeholder={transactionDetails.amount}
                            value={repairCounterpartAmount}
                            onChange={(e) => setRepairCounterpartAmount(e.target.value)}
                            className="h-9"
                            data-testid="input-orphan-counterpart-amount"
                          />
                          <p className="text-[11px] text-amber-700">
                            Si el par involucra distintas monedas, ingresá el monto convertido en la moneda de la cuenta contraparte.
                          </p>
                        </div>
                        <div className="flex justify-end gap-2 pt-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={repairing}
                            onClick={() => {
                              setRepairMode(null);
                              setRepairCounterpartAccountId('');
                              setRepairCounterpartAmount('');
                            }}
                            data-testid="button-orphan-cancel-recreate"
                          >
                            Cancelar
                          </Button>
                          <Button
                            size="sm"
                            className="bg-amber-600 hover:bg-amber-700 text-white"
                            disabled={repairing || !repairCounterpartAccountId}
                            onClick={() => submitRepairTransfer(transactionDetails.id, 'recreate')}
                            data-testid="button-orphan-confirm-recreate"
                          >
                            {repairing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                            Recrear y vincular
                          </Button>
                        </div>
                      </div>
                    )}

                    {repairMode === 'convert' && (
                      <div className="space-y-3 bg-white dark:bg-card/60 p-3 rounded-md border border-amber-200">
                        <p className="text-sm text-amber-900 font-medium">
                          La transferencia se convertirá en un {convertNewLabel} normal de la cuenta {transactionDetails.account?.name || ''}.
                        </p>
                        <p className="text-[11px] text-amber-700">
                          La cuenta ya {transactionDetails.type === 'transfer_in' ? 'recibió' : 'perdió'} el monto al crearse la transferencia, por eso solo se permite convertirla en {convertNewLabel} (no se ajusta el saldo).
                        </p>
                        <div className="flex justify-end gap-2 pt-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={repairing}
                            onClick={() => setRepairMode(null)}
                            data-testid="button-orphan-cancel-convert"
                          >
                            Cancelar
                          </Button>
                          <Button
                            size="sm"
                            className="bg-amber-600 hover:bg-amber-700 text-white"
                            disabled={repairing}
                            onClick={() => submitRepairTransfer(transactionDetails.id, 'convert', convertNewType)}
                            data-testid="button-orphan-confirm-convert"
                          >
                            {repairing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                            Convertir en {convertNewLabel}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Creator info */}
              {transactionDetails.creator && (
                <div className="p-3 rounded-lg bg-blue-50 border border-blue-200">
                  <p className="text-xs text-blue-600 mb-1 flex items-center gap-1">
                    <User className="h-3 w-3" /> Registrado por
                  </p>
                  <p className="font-medium text-blue-900">{transactionDetails.creator.name}</p>
                  <p className="text-xs text-blue-700">{transactionDetails.creator.email}</p>
                </div>
              )}

              {/* Approval info - only for completed payables/receivables */}
              {(transactionDetails.type === 'payable' || transactionDetails.type === 'receivable') && 
                transactionDetails.status === 'completed' && (transactionDetails as any).completedByName && (
                <div className="p-3 rounded-lg bg-green-50 border border-green-200">
                  <p className="text-xs text-green-600 mb-1 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> {transactionDetails.type === 'receivable' ? 'Aprobado por' : 'Aprobado por'}
                  </p>
                  <p className="font-medium text-green-900">{(transactionDetails as any).completedByName}</p>
                </div>
              )}

              {/* Client info */}
              {transactionDetails.client && (
                <div className="p-3 rounded-lg bg-green-50 border border-green-200">
                  <p className="text-xs text-green-600 mb-2 flex items-center gap-1">
                    <User className="h-3 w-3" /> Cliente
                  </p>
                  <p className="font-semibold text-green-900">{transactionDetails.client.name}</p>
                  <div className="flex flex-wrap gap-3 mt-2 text-xs text-green-700">
                    {transactionDetails.client.cuit && (
                      <span className="flex items-center gap-1"><Hash className="h-3 w-3" /> {transactionDetails.client.cuit}</span>
                    )}
                    {transactionDetails.client.email && (
                      <span className="flex items-center gap-1"><Mail className="h-3 w-3" /> {transactionDetails.client.email}</span>
                    )}
                    {transactionDetails.client.phone && (
                      <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> {transactionDetails.client.phone}</span>
                    )}
                  </div>
                </div>
              )}

              {/* Supplier info */}
              {transactionDetails.supplier && (
                <div className="p-3 rounded-lg bg-orange-50 border border-orange-200">
                  <p className="text-xs text-orange-600 mb-2 flex items-center gap-1">
                    <Building className="h-3 w-3" /> Proveedor
                  </p>
                  <p className="font-semibold text-orange-900">{transactionDetails.supplier.name}</p>
                  <div className="flex flex-wrap gap-3 mt-2 text-xs text-orange-700">
                    {transactionDetails.supplier.cuit && (
                      <span className="flex items-center gap-1"><Hash className="h-3 w-3" /> {transactionDetails.supplier.cuit}</span>
                    )}
                    {transactionDetails.supplier.email && (
                      <span className="flex items-center gap-1"><Mail className="h-3 w-3" /> {transactionDetails.supplier.email}</span>
                    )}
                    {transactionDetails.supplier.phone && (
                      <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> {transactionDetails.supplier.phone}</span>
                    )}
                  </div>
                </div>
              )}

              {/* Multi-product line items (Task #475) — editable in edit mode */}
              {isEditingDetail && editDetailItems.length >= 2 ? (
                <div className="p-3 rounded-lg bg-purple-50 border border-purple-200" data-testid="section-line-items-edit">
                  <p className="text-xs text-purple-600 mb-2 flex items-center gap-1">
                    <Package className="h-3 w-3" /> Productos ({editDetailItems.length})
                  </p>
                  <div className="space-y-3">
                    {editDetailItems.map((item, idx) => {
                      const qty = parseFloat(item.quantity) || 0;
                      const unit = parseFloat(item.unitPrice) || 0;
                      const lineTotal = qty * unit;
                      return (
                        <div key={idx} className="border-b border-purple-100 last:border-0 pb-3 last:pb-0 space-y-2" data-testid={`edit-line-item-${idx}`}>
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-semibold text-purple-900 truncate text-sm">{item.productName}</p>
                            <span className="font-semibold text-purple-900 whitespace-nowrap text-sm">AR$ {lineTotal.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <label className="text-[10px] text-purple-600">Cantidad</label>
                              <Input
                                type="text"
                                inputMode="decimal"
                                value={item.quantity}
                                onChange={(e) => {
                                  const v = e.target.value.replace(/[^0-9.]/g, '');
                                  setEditDetailItems((prev) => prev.map((p, i) => i === idx ? { ...p, quantity: v } : p));
                                }}
                                className="h-8 text-sm"
                                data-testid={`input-edit-line-qty-${idx}`}
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] text-purple-600">Precio unitario</label>
                              <Input
                                type="text"
                                inputMode="decimal"
                                value={item.unitPrice}
                                onChange={(e) => {
                                  const v = e.target.value.replace(/[^0-9.]/g, '');
                                  setEditDetailItems((prev) => prev.map((p, i) => i === idx ? { ...p, unitPrice: v } : p));
                                }}
                                className="h-8 text-sm"
                                data-testid={`input-edit-line-price-${idx}`}
                              />
                            </div>
                          </div>
                          <div className="space-y-1">
                            <label className="text-[10px] text-purple-600">Código de rentabilidad</label>
                            <Select
                              value={item.profitabilityCodeId || '__none__'}
                              onValueChange={(val) => setEditDetailItems((prev) => prev.map((p, i) => i === idx ? { ...p, profitabilityCodeId: val === '__none__' ? null : val } : p))}
                            >
                              <SelectTrigger className="h-8 text-sm" data-testid={`select-edit-line-code-${idx}`}>
                                <SelectValue placeholder="Sin código" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">Sin código</SelectItem>
                                {profitabilityCodes.filter((c) => c.isActive).map((c) => (
                                  <SelectItem key={c.id} value={c.id}>
                                    <span className="flex items-center gap-2">
                                      {c.color && <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: c.color }} />}
                                      <span className="font-mono text-xs">{c.code}</span>
                                      <span>· {c.name}</span>
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : Array.isArray(transactionDetails.items) && transactionDetails.items.length > 0 && (
                <div className="p-3 rounded-lg bg-purple-50 border border-purple-200" data-testid="section-line-items">
                  <p className="text-xs text-purple-600 mb-2 flex items-center gap-1">
                    <Package className="h-3 w-3" /> Productos ({transactionDetails.items.length})
                  </p>
                  <div className="space-y-2">
                    {transactionDetails.items.map((item: any, idx: number) => {
                      const qty = parseFloat(item.quantity || '0');
                      const unit = parseFloat(item.unitPrice || '0');
                      const lineTotal = qty * unit;
                      return (
                        <div key={item.id || idx} className="flex items-center justify-between gap-2 text-xs border-b border-purple-100 last:border-0 pb-1.5 last:pb-0" data-testid={`detail-line-item-${idx}`}>
                          <div className="min-w-0">
                            <p className="font-semibold text-purple-900 truncate">{item.product?.name || item.description || 'Producto'}</p>
                            <p className="text-purple-600">{qty} × AR$ {unit.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</p>
                          </div>
                          <span className="font-semibold text-purple-900 whitespace-nowrap">AR$ {lineTotal.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Product info */}
              {transactionDetails.product && (
                <div className="p-3 rounded-lg bg-purple-50 border border-purple-200">
                  <p className="text-xs text-purple-600 mb-2 flex items-center gap-1">
                    <Package className="h-3 w-3" /> Producto
                  </p>
                  <p className="font-semibold text-purple-900">{transactionDetails.product.name}</p>
                  <div className="flex flex-wrap gap-3 mt-2 text-xs text-purple-700">
                    {transactionDetails.product.sku && (
                      <span className="flex items-center gap-1"><Hash className="h-3 w-3" /> SKU: {transactionDetails.product.sku}</span>
                    )}
                    {transactionDetails.productQuantity && (
                      <span className="flex items-center gap-1"><Package className="h-3 w-3" /> Cantidad: {transactionDetails.productQuantity}</span>
                    )}
                    {transactionDetails.product.salePrice && (
                      <span className="flex items-center gap-1"><CreditCard className="h-3 w-3" /> Precio unitario: AR$ {parseFloat(transactionDetails.product.salePrice).toLocaleString('es-AR')}</span>
                    )}
                  </div>
                </div>
              )}

              {/* Invoice info */}
              {transactionDetails.hasInvoice && (
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <p className="text-xs text-emerald-600 flex items-center gap-1">
                      <ReceiptIcon className="h-3 w-3" /> Factura
                    </p>
                    {(() => {
                      const st = (transactionDetails as any).invoiceEmissionStatus;
                      if (!st) return null;
                      const map: Record<string, { label: string; cls: string }> = {
                        pending: { label: 'Emisión en curso', cls: 'bg-amber-100 text-amber-700' },
                        emitted: { label: 'Emitida (CAE)', cls: 'bg-emerald-100 text-emerald-700' },
                        failed: { label: 'Fallo en emisión', cls: 'bg-red-100 text-red-700' },
                        cancelled: { label: 'Anulada', cls: 'bg-gray-200 text-gray-700 dark:text-slate-200' },
                      };
                      const m = map[st] || { label: st, cls: 'bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-200' };
                      return (
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${m.cls}`} data-testid={`badge-emission-${st}`}>
                          {m.label}
                        </span>
                      );
                    })()}
                  </div>
                  <div className="flex flex-wrap gap-4 text-sm items-center">
                    <span><strong>Tipo:</strong> {(transactionDetails as any).invoiceDocType || transactionDetails.invoiceType || '-'}</span>
                    <span><strong>Número:</strong> {(transactionDetails as any).invoiceVoucherId || transactionDetails.invoiceNumber || '-'}</span>
                    {(transactionDetails as any).invoiceCae && (
                      <span><strong>CAE:</strong> <span className="font-mono">{(transactionDetails as any).invoiceCae}</span></span>
                    )}
                    {(transactionDetails as any).invoiceSimulated && (
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-pink-100 text-pink-700 border border-pink-300"
                        data-testid="badge-detail-simulated"
                        title="Comprobante generado en modo de pruebas — sin validez fiscal"
                      >
                        SIMULADA · sin validez fiscal
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 mt-2">
                    {((transactionDetails as any).invoiceUuid || (transactionDetails as any).invoicePdfUrl) && (
                      <a
                        href={`/api/invoicing/transactions/${transactionDetails.id}/pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                        data-testid="link-invoice-pdf"
                      >
                        <Download className="h-4 w-4" />{' '}
                        {(transactionDetails as any).invoiceSimulated
                          ? 'Descargar PDF (simulado)'
                          : 'Descargar PDF (ARCA)'}
                      </a>
                    )}
                    {transactionDetails.invoiceFileUrl && (
                      <a
                        href={transactionDetails.invoiceFileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                      >
                        <Download className="h-4 w-4" /> Ver archivo adjunto
                      </a>
                    )}
                  </div>
                  {/* Email delivery status (only meaningful when invoice has been emitted) */}
                  {((transactionDetails as any).invoiceCae || (transactionDetails as any).invoiceSimulated) && (() => {
                    const td: any = transactionDetails;
                    const status: 'sent' | 'failed' | null = td.invoiceEmailStatus || null;
                    const lastAttempt = td.invoiceEmailLastAttemptAt
                      ? new Date(td.invoiceEmailLastAttemptAt).toLocaleString('es-AR')
                      : null;
                    return (
                      <div className="flex flex-wrap items-center gap-3 mt-3">
                        {status === 'sent' ? (
                          <span
                            className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-semibold border border-emerald-500/50 text-emerald-700 bg-emerald-50"
                            data-testid="badge-detail-email-sent"
                            title={lastAttempt ? `Enviado el ${lastAttempt}` : 'Enviado'}
                          >
                            <Mail className="h-3 w-3" /> Email enviado
                          </span>
                        ) : status === 'failed' ? (
                          <span
                            className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-semibold bg-red-100 text-red-700 border border-red-300"
                            data-testid="badge-detail-email-failed"
                            title={td.invoiceEmailLastError || 'No se pudo enviar el email'}
                          >
                            <MailWarning className="h-3 w-3" /> Email pendiente
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-semibold bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300 border border-gray-300 dark:border-slate-700"
                            data-testid="badge-detail-email-none"
                            title="Sin intento de envío registrado"
                          >
                            <Mail className="h-3 w-3" /> Sin envío
                          </span>
                        )}
                        {status === 'failed' && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={resendingEmail}
                            onClick={() => resendInvoiceEmail(transactionDetails)}
                            data-testid="button-detail-resend-email"
                            className="h-7 px-2 text-xs gap-1"
                          >
                            {resendingEmail ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Send className="h-3 w-3" />
                            )}
                            Reenviar por email
                          </Button>
                        )}
                        {status === 'failed' && td.invoiceEmailLastError && (
                          <span className="text-[11px] text-red-700/80 truncate max-w-[260px]" title={td.invoiceEmailLastError}>
                            {td.invoiceEmailLastError}
                          </span>
                        )}
                      </div>
                    );
                  })()}
                  {/* Persisted emission error: when a previous emit attempt
                      failed, surface the actionable Spanish reason so the
                      user knows exactly what to fix or do (e.g. delegate
                      service in AFIP) — no need to retry just to see it. */}
                  {(transactionDetails as any).invoiceEmissionStatus === 'failed' &&
                    (transactionDetails as any).invoiceEmissionErrorMessage && (
                      <div
                        className="mt-3 rounded-lg border border-red-200 bg-red-50 text-red-800 p-3 text-sm flex gap-2"
                        data-testid="text-emission-error"
                      >
                        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                        <div className="space-y-1">
                          <p className="font-medium">No se pudo emitir la factura electrónica.</p>
                          <p className="text-red-700/90">{(transactionDetails as any).invoiceEmissionErrorMessage}</p>
                          <button
                            type="button"
                            onClick={() => setShowSellingPointGuide(true)}
                            className="text-red-700 underline underline-offset-2 hover:text-red-900 text-xs font-medium"
                            data-testid="link-open-selling-point-guide-from-error"
                          >
                            ¿Tu punto de venta no es compatible con facturación electrónica? Ver cómo solucionarlo →
                          </button>
                        </div>
                      </div>
                    )}
                  {/* Emit button: only for income / receivable that have not been emitted yet.
                      Hidden when org is Personal AND plan is basic personal
                      (Personal Pro and higher unlock invoicing on Personal orgs too). */}
                  {FEATURE_FLAGS.INVOICING_ENABLED &&
                    !isPersonalBasic &&
                    (transactionDetails.type === 'income' || transactionDetails.type === 'receivable') &&
                    !(transactionDetails as any).invoiceCae &&
                    (transactionDetails as any).invoiceEmissionStatus !== 'pending' && (
                      <Button
                        size="sm"
                        className="mt-3 bg-pink-600 hover:bg-pink-700 text-white"
                        onClick={() => setEmitInvoiceTarget(transactionDetails)}
                        data-testid="button-open-emit-invoice"
                      >
                        <ReceiptIcon className="h-4 w-4 mr-1" />
                        {(transactionDetails as any).invoiceEmissionStatus === 'failed' ? 'Reintentar emisión' : 'Emitir factura electrónica'}
                      </Button>
                    )}
                  {/* Anular con NC: only for emitted FA/FB/FC that have not been already cancelled.
                      NC/ND docTypes cannot be cancelled with another NC. */}
                  {FEATURE_FLAGS.INVOICING_ENABLED &&
                    !isPersonalBasic &&
                    (transactionDetails as any).invoiceCae &&
                    (transactionDetails as any).invoiceEmissionStatus === 'emitted' &&
                    !(transactionDetails as any).invoiceCreditNoteUuid &&
                    !((transactionDetails as any).invoiceDocType || '').startsWith('NC') &&
                    !((transactionDetails as any).invoiceDocType || '').startsWith('ND') && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-3 ml-2 border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800"
                        onClick={() => setCreditNoteTarget(transactionDetails)}
                        data-testid="button-open-credit-note"
                      >
                        <FileX2 className="h-4 w-4 mr-1" /> Anular con NC
                      </Button>
                    )}
                  {(transactionDetails as any).invoiceCreditNoteUuid && (
                    <div className="mt-3 space-y-2">
                      <p
                        className="text-xs text-muted-foreground italic"
                        data-testid="text-cancelled-by-nc"
                      >
                        Esta factura ya fue anulada con una Nota de Crédito.
                      </p>
                      {((transactionDetails as any).invoiceCreditNoteUuid || (transactionDetails as any).invoiceCreditNotePdfUrl) && (
                        <a
                          href={`/api/invoicing/transactions/${transactionDetails.id}/pdf?type=creditNote`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                          data-testid="link-credit-note-pdf"
                        >
                          <Download className="h-4 w-4" /> Descargar PDF de la Nota de Crédito
                        </a>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Tracking number */}
              {transactionDetails.trackingNumber && (
                <div className="p-3 rounded-lg bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-800">
                  <p className="text-xs text-gray-600 dark:text-slate-300 mb-1 flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> Número de Seguimiento
                  </p>
                  <p className="font-mono font-medium">{transactionDetails.trackingNumber}</p>
                </div>
              )}

              {/* Task #229: payment-method banner on parent (income/receivable) */}
              {transactionDetails.paymentMethod && (
                <div className="p-3 rounded-lg bg-cyan-50 border border-cyan-200" data-testid="payment-method-banner">
                  <p className="text-xs text-cyan-600 mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide">
                    Medio de cobro
                  </p>
                  <p className="font-medium text-cyan-900" data-testid="text-payment-method-name">
                    {transactionDetails.paymentMethod.name}
                    {!transactionDetails.paymentMethod.isActive && (
                      <span className="ml-2 text-xs font-normal text-cyan-700">(desactivado)</span>
                    )}
                  </p>
                  <p className="text-xs text-cyan-700 mt-0.5">
                    Se generaron automáticamente {transactionDetails.paymentMethod.concepts.length} costo{transactionDetails.paymentMethod.concepts.length === 1 ? '' : 's'} vinculado{transactionDetails.paymentMethod.concepts.length === 1 ? '' : 's'} a este movimiento.
                  </p>
                </div>
              )}

              {/* Traceability - Parent transaction (if this expense is linked to a source) */}
              {transactionDetails.parentTransaction && (
                <button
                  onClick={() => navigateToLinkedTransaction(transactionDetails.parentTransaction.id)}
                  className="w-full p-3 rounded-lg bg-cyan-50 border border-cyan-200 hover:bg-cyan-100 hover:border-cyan-300 transition-colors text-left cursor-pointer group"
                  data-testid="button-navigate-parent"
                >
                  <p className="text-xs text-cyan-600 mb-2 flex items-center gap-1 font-semibold">
                    <ArrowUp className="h-3 w-3" />
                    {(transactionDetails.type === 'expense' || transactionDetails.type === 'payable')
                      ? 'Costo asociado a venta'
                      : 'Origen del dinero'}
                    <ExternalLink className="h-3 w-3 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                  </p>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-cyan-900">
                        {transactionDetails.parentTransaction.transactionNumber || transactionDetails.parentTransaction.description}
                      </p>
                      <p className="text-xs text-cyan-700">{transactionDetails.parentTransaction.description}</p>
                    </div>
                    <span className="text-sm font-semibold text-green-600">
                      +{formatCurrency(transactionDetails.parentTransaction.amount, transactionDetails.account?.currency)}
                    </span>
                  </div>
                </button>
              )}

              {/* Traceability - Child transactions (expenses linked to this income) */}
              {transactionDetails.childTransactions && transactionDetails.childTransactions.length > 0 && (
                <div className="p-3 rounded-lg bg-pink-50 border border-pink-200">
                  <p className="text-xs text-pink-600 mb-2 flex items-center gap-1 font-semibold">
                    <ArrowDown className="h-3 w-3" /> Gastos vinculados ({transactionDetails.childTransactions.length})
                  </p>
                  <div className="space-y-2">
                    {transactionDetails.childTransactions.map((child: any) => (
                      <button
                        key={child.id}
                        onClick={() => navigateToLinkedTransaction(child.id)}
                        className="w-full flex items-center justify-between py-2 px-2 -mx-2 rounded hover:bg-pink-100 transition-colors cursor-pointer group"
                        data-testid={`button-navigate-child-${child.id}`}
                      >
                        <div className="text-left">
                          <p className="text-sm font-medium text-pink-900 flex items-center gap-1">
                            {child.transactionNumber || child.description}
                            <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                          </p>
                          <p className="text-xs text-pink-700">{child.description}</p>
                        </div>
                        <span className="text-sm font-semibold text-red-600">
                          -{formatCurrency(child.amount, transactionDetails.account?.currency)}
                        </span>
                      </button>
                    ))}
                    <div className="pt-2 border-t border-pink-200 flex justify-between text-sm font-semibold">
                      <span className="text-pink-700">Total gastado:</span>
                      <span className="text-red-600">
                        -{formatCurrency(
                          transactionDetails.childTransactions.reduce((sum: number, c: any) => sum + normalizeAmountInput(c.amount), 0).toString(),
                          transactionDetails.account?.currency
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Original transaction info for cancellations */}
              {transactionDetails.originalTransactionData && (() => {
                try {
                  const originalData = JSON.parse(transactionDetails.originalTransactionData);
                  const originalTypeLabel = getTransactionTypeLabel(originalData.type, originalData.status);
                  return (
                    <div className="p-3 rounded-lg bg-amber-50 border border-amber-300">
                      <p className="text-xs text-amber-700 mb-2 flex items-center gap-1 font-semibold">
                        <XCircle className="h-3 w-3" /> Movimiento Original Cancelado
                      </p>
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-amber-700">Tipo:</span>
                          <span className="font-medium text-amber-900">{originalTypeLabel}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-amber-700">Descripción:</span>
                          <span className="font-medium text-amber-900">{originalData.description}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-amber-700">Monto:</span>
                          <span className="font-medium text-amber-900">
                            {formatCurrency(originalData.amount, transactionDetails.account?.currency)}
                          </span>
                        </div>
                        {originalData.transactionNumber && (
                          <div className="flex justify-between">
                            <span className="text-amber-700">N° Movimiento:</span>
                            <span className="font-mono text-amber-900">{originalData.transactionNumber}</span>
                          </div>
                        )}
                        {originalData.date && (
                          <div className="flex justify-between">
                            <span className="text-amber-700">Fecha original:</span>
                            <span className="text-amber-900">{format(safeParseDate(originalData.date), "d MMM yyyy", { locale: es })}</span>
                          </div>
                        )}
                        {originalData.hasInvoice && (
                          <div className="flex justify-between">
                            <span className="text-amber-700">Factura:</span>
                            <span className="text-amber-900">{originalData.invoiceType} {originalData.invoiceNumber}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                } catch {
                  return null;
                }
              })()}

              {/* Task #353: recurrence summary */}
              {(transactionDetails.isRecurring || transactionDetails.recurrenceFrequency) && (
                <div className="p-3 rounded-lg bg-violet-50 border border-violet-200">
                  <p className="text-xs text-violet-700 mb-1 flex items-center gap-1 font-semibold">
                    <RefreshCw className="h-3 w-3" /> Recurrente
                  </p>
                  <p className="text-sm text-violet-900">
                    {(transactionDetails as any).recurrenceTotalInstallments != null ? (
                      <span data-testid={`text-installment-count-detail-${transactionDetails.id}`}>
                        Cuota {(transactionDetails as any).recurrenceCurrentInstallment ?? 1} de {(transactionDetails as any).recurrenceTotalInstallments}
                      </span>
                    ) : (
                      <span>Serie sin límite (se genera próxima al confirmar)</span>
                    )}
                  </p>
                </div>
              )}

              {/* Timestamps */}
              <div className="pt-4 border-t text-xs text-muted-foreground">
                {transactionDetails.createdAt && (
                  <p>Creado: {format(safeParseDate(transactionDetails.createdAt), "d 'de' MMMM yyyy 'a las' HH:mm", { locale: es })}</p>
                )}
                <p>ID: <span className="font-mono">{transactionDetails.id}</span></p>
              </div>

              {/* Action buttons */}
              <div className="pt-4 flex justify-end gap-2">
                {/* Edit button for pending/scheduled commitments: visible and
                    clearly separate from the confirm action so editing a
                    commitment isn't confused with confirming the payment. */}
                {(transactionDetails.type === 'payable' || transactionDetails.type === 'receivable') &&
                 transactionDetails.status === 'scheduled' && !isEditingDetail && (
                  <Button
                    variant="outline"
                    onClick={startEditingDetail}
                    className="gap-2"
                    data-testid="button-edit-detail"
                  >
                    <Pencil className="h-4 w-4" />
                    Editar
                  </Button>
                )}
                {/* Approve button for pending/scheduled payables/receivables */}
                {(transactionDetails.type === 'payable' || transactionDetails.type === 'receivable') && 
                 transactionDetails.status === 'scheduled' && !isEditingDetail && (
                  <Button
                    onClick={() => openApprovalDialog(
                      transactionDetails.id,
                      transactionDetails.isRecurring || false,
                      transactionDetails.recurrenceFrequency
                    )}
                    className="gap-2 bg-green-600 hover:bg-green-700 text-white"
                    data-testid="button-approve-transaction"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    {transactionDetails.type === 'payable' ? 'Confirmar Pago' : 'Confirmar Cobro'}
                  </Button>
                )}
                
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      data-testid="button-download-transaction"
                    >
                      <Download className="h-4 w-4" />
                      Descargar comprobante
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => {
                        const typeLabel = getTransactionTypeLabel(transactionDetails.type, transactionDetails.status);
                        const currencySymbol = CURRENCY_SYMBOLS[transactionDetails.account?.currency as keyof typeof CURRENCY_SYMBOLS] || '$';
                        const win = window.open('', '_blank');
                        if (!win) return;
                        win.document.write(`
                          <!DOCTYPE html>
                          <html>
                          <head>
                            <title>Comprobante - ${transactionDetails.transactionNumber || transactionDetails.id}</title>
                            <style>
                              body { font-family: Arial, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; }
                              h1 { color: #00D4FF; margin-bottom: 8px; font-size: 24px; }
                              .subtitle { color: #666; margin-bottom: 24px; font-size: 14px; }
                              .section { margin: 20px 0; padding: 16px; background: #f8f9fa; border-radius: 8px; }
                              .section-title { font-weight: bold; color: #333; margin-bottom: 8px; font-size: 14px; }
                              .row { display: flex; justify-content: space-between; margin: 8px 0; }
                              .label { color: #666; }
                              .value { font-weight: 500; }
                              .amount { font-size: 28px; font-weight: bold; color: ${(transactionDetails.type === 'income' || transactionDetails.type === 'receivable') ? '#16a34a' : '#dc2626'}; }
                              .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #999; }
                              .id { font-family: monospace; font-size: 11px; color: #999; }
                              @media print { body { padding: 20px; } }
                            </style>
                          </head>
                          <body>
                            <h1>COMPROBANTE DE MOVIMIENTO</h1>
                            <p class="subtitle">Aikestar - Sistema de Gestión Administrativa</p>
                            
                            <div class="section">
                              <div class="row">
                                <span class="label">N° de Movimiento:</span>
                                <span class="value">${transactionDetails.transactionNumber || 'Sin número'}</span>
                              </div>
                              <div class="row">
                                <span class="label">Tipo:</span>
                                <span class="value">${typeLabel}</span>
                              </div>
                              <div class="row">
                                <span class="label">Descripción:</span>
                                <span class="value">${transactionDetails.description}</span>
                              </div>
                              <div style="text-align: right; margin-top: 16px;">
                                <span class="amount">${(transactionDetails.type === 'income' || transactionDetails.type === 'receivable') ? '+' : '-'}${formatCurrency(transactionDetails.amount, transactionDetails.account?.currency)}</span>
                              </div>
                            </div>
                            
                            <div class="section">
                              <div class="row">
                                <span class="label">Categoría:</span>
                                <span class="value">${transactionDetails.category}</span>
                              </div>
                              <div class="row">
                                <span class="label">Cuenta:</span>
                                <span class="value">${transactionDetails.account?.name || 'Sin cuenta'} ${transactionDetails.account?.currency ? `(${transactionDetails.account.currency})` : ''}</span>
                              </div>
                              <div class="row">
                                <span class="label">${(transactionDetails.type === 'payable' || transactionDetails.type === 'receivable') && transactionDetails.status === 'completed' ? (transactionDetails.type === 'receivable' ? 'Fecha de cobro:' : 'Fecha de pago:') : (transactionDetails.type === 'payable' || transactionDetails.type === 'receivable') ? 'Fecha de vencimiento:' : 'Fecha del movimiento:'}</span>
                                <span class="value">${(() => { const isCompletedCommitment = (transactionDetails.type === 'payable' || transactionDetails.type === 'receivable') && transactionDetails.status === 'completed'; const dateToShow = isCompletedCommitment && (transactionDetails as any).completedAt ? (transactionDetails as any).completedAt : transactionDetails.date; const dateFmt = isCompletedCommitment && (transactionDetails as any).completedAt ? "d 'de' MMMM yyyy, HH:mm" : "d 'de' MMMM yyyy"; return dateToShow ? format(safeParseDate(dateToShow), dateFmt, { locale: es }) : '-'; })()}</span>
                              </div>
                              <div class="row">
                                <span class="label">Fecha de imputación:</span>
                                <span class="value">${transactionDetails.imputationDate ? format(safeParseDate(transactionDetails.imputationDate), "MMMM yyyy", { locale: es }) : '-'}</span>
                              </div>
                            </div>
                            
                            ${transactionDetails.creator ? `
                            <div class="section">
                              <div class="section-title">Registrado por</div>
                              <div class="row">
                                <span class="value">${transactionDetails.creator.name}</span>
                                <span class="label">${transactionDetails.creator.email}</span>
                              </div>
                            </div>
                            ` : ''}
                            
                            ${transactionDetails.client ? `
                            <div class="section">
                              <div class="section-title">Cliente</div>
                              <div class="row">
                                <span class="value">${transactionDetails.client.name}</span>
                                ${transactionDetails.client.cuit ? `<span class="label">CUIT: ${transactionDetails.client.cuit}</span>` : ''}
                              </div>
                            </div>
                            ` : ''}
                            
                            ${transactionDetails.supplier ? `
                            <div class="section">
                              <div class="section-title">Proveedor</div>
                              <div class="row">
                                <span class="value">${transactionDetails.supplier.name}</span>
                                ${transactionDetails.supplier.cuit ? `<span class="label">CUIT: ${transactionDetails.supplier.cuit}</span>` : ''}
                              </div>
                            </div>
                            ` : ''}
                            
                            ${transactionDetails.hasInvoice ? `
                            <div class="section">
                              <div class="section-title">Factura</div>
                              <div class="row">
                                <span class="label">Tipo:</span>
                                <span class="value">${transactionDetails.invoiceType || '-'}</span>
                              </div>
                              <div class="row">
                                <span class="label">Número:</span>
                                <span class="value">${transactionDetails.invoiceNumber || '-'}</span>
                              </div>
                            </div>
                            ` : ''}
                            
                            ${transactionDetails.parentTransaction ? `
                            <div class="section" style="background: #e0f7fa; border-left: 4px solid #00bcd4;">
                              <div class="section-title" style="color: #00838f;">↑ Origen del dinero (Trazabilidad)</div>
                              <div class="row">
                                <span class="label">N° Movimiento origen:</span>
                                <span class="value">${transactionDetails.parentTransaction.transactionNumber || 'Sin número'}</span>
                              </div>
                              <div class="row">
                                <span class="label">Descripción:</span>
                                <span class="value">${transactionDetails.parentTransaction.description}</span>
                              </div>
                              <div class="row">
                                <span class="label">Monto:</span>
                                <span class="value" style="color: #16a34a;">+${formatCurrency(transactionDetails.parentTransaction.amount, transactionDetails.account?.currency)}</span>
                              </div>
                            </div>
                            ` : ''}
                            
                            ${transactionDetails.childTransactions && transactionDetails.childTransactions.length > 0 ? `
                            <div class="section" style="background: #fce4ec; border-left: 4px solid #e91e63;">
                              <div class="section-title" style="color: #c2185b;">↓ Gastos vinculados (${transactionDetails.childTransactions.length})</div>
                              ${transactionDetails.childTransactions.map((child: any) => `
                              <div class="row" style="padding: 4px 0; border-bottom: 1px solid #f8bbd9;">
                                <span class="value">${child.transactionNumber || child.description}</span>
                                <span class="label" style="color: #dc2626;">-${formatCurrency(child.amount, transactionDetails.account?.currency)}</span>
                              </div>
                              `).join('')}
                              <div class="row" style="margin-top: 8px; font-weight: bold;">
                                <span class="label" style="color: #c2185b;">Total gastado:</span>
                                <span class="value" style="color: #dc2626;">-${formatCurrency(transactionDetails.childTransactions.reduce((sum: number, c: any) => sum + normalizeAmountInput(c.amount), 0).toString(), transactionDetails.account?.currency)}</span>
                              </div>
                            </div>
                            ` : ''}
                            
                            <div class="footer">
                              <p>Creado: ${transactionDetails.createdAt ? format(safeParseDate(transactionDetails.createdAt), "d 'de' MMMM yyyy 'a las' HH:mm", { locale: es }) : '-'}</p>
                              <p class="id">ID: ${transactionDetails.id}</p>
                              <p style="margin-top: 16px;">Generado: ${format(new Date(), "d 'de' MMMM yyyy 'a las' HH:mm", { locale: es })}</p>
                            </div>
                          </body>
                          </html>
                        `);
                        win.document.close();
                        win.print();
                        toast({ title: 'PDF generado', description: 'Usa Guardar como PDF en el diálogo de impresión' });
                      }}
                      data-testid="button-download-pdf"
                    >
                      <FileText className="h-4 w-4 mr-2" />
                      Descargar PDF
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        const typeLabel = getTransactionTypeLabel(transactionDetails.type, transactionDetails.status);
                        const content = `
COMPROBANTE DE MOVIMIENTO - AIKESTAR
=====================================

N° de Movimiento: ${transactionDetails.transactionNumber || 'Sin número'}
Tipo: ${typeLabel}
Descripción: ${transactionDetails.description}
Monto: ${(transactionDetails.type === 'income' || transactionDetails.type === 'receivable') ? '+' : '-'}${formatCurrency(transactionDetails.amount, transactionDetails.account?.currency)}

Categoría: ${transactionDetails.category}
Cuenta: ${transactionDetails.account?.name || 'Sin cuenta'} ${transactionDetails.account?.currency ? `(${transactionDetails.account.currency})` : ''}

${(() => { const isCompletedCommitment = (transactionDetails.type === 'payable' || transactionDetails.type === 'receivable') && transactionDetails.status === 'completed'; const label = isCompletedCommitment ? (transactionDetails.type === 'receivable' ? 'Fecha de cobro' : 'Fecha de pago') : (transactionDetails.type === 'payable' || transactionDetails.type === 'receivable') ? 'Fecha de vencimiento' : 'Fecha del movimiento'; const dateToShow = isCompletedCommitment && (transactionDetails as any).completedAt ? (transactionDetails as any).completedAt : transactionDetails.date; const dateFmt = isCompletedCommitment && (transactionDetails as any).completedAt ? "d 'de' MMMM yyyy, HH:mm" : "d 'de' MMMM yyyy"; return `${label}: ${dateToShow ? format(safeParseDate(dateToShow), dateFmt, { locale: es }) : '-'}`; })()}
Fecha de imputación: ${transactionDetails.imputationDate ? format(safeParseDate(transactionDetails.imputationDate), "MMMM yyyy", { locale: es }) : '-'}

${transactionDetails.creator ? `Registrado por: ${transactionDetails.creator.name} (${transactionDetails.creator.email})` : ''}
${transactionDetails.client ? `Cliente: ${transactionDetails.client.name}${transactionDetails.client.cuit ? ` - CUIT: ${transactionDetails.client.cuit}` : ''}` : ''}
${transactionDetails.supplier ? `Proveedor: ${transactionDetails.supplier.name}${transactionDetails.supplier.cuit ? ` - CUIT: ${transactionDetails.supplier.cuit}` : ''}` : ''}
${transactionDetails.product ? `Producto: ${transactionDetails.product.name}${transactionDetails.product.sku ? ` (SKU: ${transactionDetails.product.sku})` : ''}` : ''}

${transactionDetails.hasInvoice ? `Factura: Tipo ${transactionDetails.invoiceType || '-'}, N° ${transactionDetails.invoiceNumber || '-'}` : ''}
${transactionDetails.trackingNumber ? `N° de Seguimiento: ${transactionDetails.trackingNumber}` : ''}

${transactionDetails.parentTransaction ? `
TRAZABILIDAD - ORIGEN DEL DINERO
---------------------------------
N° Movimiento origen: ${transactionDetails.parentTransaction.transactionNumber || 'Sin número'}
Descripción: ${transactionDetails.parentTransaction.description}
Monto: +${formatCurrency(transactionDetails.parentTransaction.amount, transactionDetails.account?.currency)}
` : ''}
${transactionDetails.childTransactions && transactionDetails.childTransactions.length > 0 ? `
TRAZABILIDAD - GASTOS VINCULADOS (${transactionDetails.childTransactions.length})
---------------------------------
${transactionDetails.childTransactions.map((child: any) => `• ${child.transactionNumber || child.description}: -${formatCurrency(child.amount, transactionDetails.account?.currency)}`).join('\n')}
Total gastado: -${formatCurrency(transactionDetails.childTransactions.reduce((sum: number, c: any) => sum + normalizeAmountInput(c.amount), 0).toString(), transactionDetails.account?.currency)}
` : ''}
-------------------------------------
Creado: ${transactionDetails.createdAt ? format(safeParseDate(transactionDetails.createdAt), "d 'de' MMMM yyyy 'a las' HH:mm", { locale: es }) : '-'}
ID: ${transactionDetails.id}

Generado: ${format(new Date(), "d 'de' MMMM yyyy 'a las' HH:mm", { locale: es })}
Aikestar - Sistema de Gestión Administrativa
                        `.trim();
                        
                        const blob = new Blob([content], { type: 'application/msword' });
                        const link = document.createElement('a');
                        link.href = URL.createObjectURL(blob);
                        link.download = `movimiento_${transactionDetails.transactionNumber || transactionDetails.id}_${format(new Date(), 'yyyy-MM-dd')}.doc`;
                        link.click();
                        toast({ title: 'Descargado', description: 'Comprobante Word descargado correctamente' });
                      }}
                      data-testid="button-download-word"
                    >
                      <FileSpreadsheet className="h-4 w-4 mr-2" />
                      Descargar Word
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No se encontró la información del movimiento
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={showApprovalDialog} onOpenChange={setShowApprovalDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {transactionDetails?.type === 'receivable' ? 'Confirmar Cobro' : 'Confirmar Pago'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {transactionDetails?.type === 'receivable' 
                ? '¿Confirmás que recibiste este cobro?' 
                : '¿Confirmás que realizaste este pago?'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                <span className="text-sm font-medium">Ya fue registrado</span>
              </div>
              <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5" data-testid="toggle-approval-skip-balance">
                <Button
                  type="button"
                  variant={approvalSkipBalance ? "default" : "ghost"}
                  size="sm"
                  className={`h-7 px-3 text-xs font-medium ${approvalSkipBalance ? '' : 'text-muted-foreground'}`}
                  onClick={() => setApprovalSkipBalance(true)}
                >
                  Sí
                </Button>
                <Button
                  type="button"
                  variant={!approvalSkipBalance ? "default" : "ghost"}
                  size="sm"
                  className={`h-7 px-3 text-xs font-medium ${!approvalSkipBalance ? '' : 'text-muted-foreground'}`}
                  onClick={() => setApprovalSkipBalance(false)}
                >
                  No
                </Button>
              </div>
            </div>
            {approvalSkipBalance && (
              <p className="text-xs text-amber-600 bg-amber-50 rounded-md p-2">
                El movimiento ya fue cargado antes (por importación, WhatsApp, etc.). Se marcará como cumplido sin modificar el saldo de la cuenta.
              </p>
            )}

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <RefreshCw className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">¿Es recurrente?</span>
              </div>
              <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5" data-testid="toggle-approval-recurring">
                <Button
                  type="button"
                  variant={approvalRecurring ? "default" : "ghost"}
                  size="sm"
                  className={`h-7 px-3 text-xs font-medium ${approvalRecurring ? '' : 'text-muted-foreground'}`}
                  onClick={() => setApprovalRecurring(true)}
                >
                  Sí
                </Button>
                <Button
                  type="button"
                  variant={!approvalRecurring ? "default" : "ghost"}
                  size="sm"
                  className={`h-7 px-3 text-xs font-medium ${!approvalRecurring ? '' : 'text-muted-foreground'}`}
                  onClick={() => setApprovalRecurring(false)}
                >
                  No
                </Button>
              </div>
            </div>
            
            {approvalRecurring && (
              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">Frecuencia</label>
                <Select value={approvalFrequency} onValueChange={setApprovalFrequency}>
                  <SelectTrigger data-testid="select-approval-frequency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="weekly">Semanal</SelectItem>
                    <SelectItem value="biweekly">Quincenal</SelectItem>
                    <SelectItem value="monthly">Mensual</SelectItem>
                    <SelectItem value="quarterly">Trimestral</SelectItem>
                    <SelectItem value="yearly">Anual</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Se generará automáticamente el próximo compromiso programado.
                </p>
              </div>
            )}
          </div>
          
          <AlertDialogFooter>
            <AlertDialogCancel disabled={approvingTransaction}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleApproveTransaction(); }}
              disabled={approvingTransaction}
              className="bg-green-600 hover:bg-green-700"
              data-testid="button-confirm-approval"
            >
              {approvingTransaction ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <CheckCircle2 className="h-4 w-4 mr-2" />
              )}
              Confirmar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {selectedTransactionIds.size > 0 && (
        <div className="fixed bottom-28 md:bottom-4 left-1/2 -translate-x-1/2 z-[60] bg-slate-900 text-white rounded-xl shadow-2xl px-3 py-2.5 flex flex-wrap items-center justify-center gap-2 animate-in slide-in-from-bottom-4 w-[calc(100vw-2rem)] max-w-md md:max-w-xl md:w-auto">
          <div className="flex items-center gap-2">
            <CheckSquare className="h-4 w-4 text-cyan-400" />
            <span className="font-medium text-sm" data-testid="text-bulk-selection-count">{selectedTransactionIds.size}</span>
          </div>
          <div className="h-5 w-px bg-slate-600 hidden sm:block" />
          <div className="text-sm" data-testid="text-bulk-selection-totals">
            {Object.entries(selectedTransactionTotal).map(([curr, amt]) => (
              <span key={curr} className="mr-2">{formatCurrencyForBulk(amt, curr)}</span>
            ))}
          </div>
          <div className="flex items-center gap-1.5 ml-auto">
            {activeTab === 'scheduled' && canBulkApprove && (
              <Button
                size="sm"
                variant="default"
                className="bg-green-600 hover:bg-green-700 text-white text-xs h-7 px-3"
                onClick={bulkApproveTransactions}
                disabled={bulkApproving || bulkDeleting}
                data-testid="button-bulk-approve-future"
              >
                {bulkApproving ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />...</> : 'Confirmar'}
              </Button>
            )}
            {canBulkDelete && (
              <Button
                size="sm"
                variant="default"
                className="bg-red-600 hover:bg-red-700 text-white text-xs h-7 px-3"
                onClick={() => setShowBulkDeleteDialog(true)}
                disabled={bulkApproving || bulkDeleting}
                data-testid="button-bulk-delete-transactions"
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                Eliminar
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="text-slate-300 hover:text-white hover:bg-slate-700 h-7 w-7 p-0"
              onClick={clearTransactionSelection}
              data-testid="button-clear-transaction-selection"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
      <AlertDialog open={showBulkDeleteDialog} onOpenChange={(o) => !o && !bulkDeleting && setShowBulkDeleteDialog(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar {selectedTransactionIds.size} movimientos?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Se eliminarán los movimientos seleccionados. Esta acción no se puede deshacer en bloque.
                </p>
                <p className="text-amber-600 text-sm">
                  Los movimientos facturados (con CAE) y las cancelaciones se omitirán automáticamente. Para movimientos completados, los saldos de las cuentas y el stock de productos se ajustarán en consecuencia.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting} data-testid="button-cancel-bulk-delete">Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); bulkDeleteTransactions(); }}
              disabled={bulkDeleting}
              className="bg-red-600 hover:bg-red-700"
              data-testid="button-confirm-bulk-delete"
            >
              {bulkDeleting ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Eliminando...</> : 'Eliminar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {FEATURE_FLAGS.INVOICING_ENABLED && (
        <>
          <CreditNoteModal
            open={!!creditNoteTarget}
            onOpenChange={(o) => { if (!o) setCreditNoteTarget(null); }}
            transaction={creditNoteTarget}
          />
          <EmitInvoiceModal
            open={!!emitInvoiceTarget}
            onOpenChange={(o) => { if (!o) setEmitInvoiceTarget(null); }}
            transaction={emitInvoiceTarget}
          />
        </>
      )}
      <SellingPointSetupGuide
        open={showSellingPointGuide}
        onOpenChange={setShowSellingPointGuide}
      />
    </>
  );
}
