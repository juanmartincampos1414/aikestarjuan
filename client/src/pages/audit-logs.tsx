import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { History, Search, User, Plus, Pencil, Trash2, Filter, Clock, Eye, Calendar, X, Maximize2, Minimize2, Download, FileText, FileType, Image, ExternalLink, ArrowLeftRight, ArrowRight, Wallet, RefreshCw, AlertTriangle } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { format, isAfter, isBefore, startOfDay, endOfDay, subDays } from 'date-fns';
import { es } from 'date-fns/locale';
import { cn } from '@/lib/utils';

type AuditLog = {
  id: string;
  organizationId: string;
  userId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  previousData: string | null;
  newData: string | null;
  createdAt: string;
};

type Member = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
};

export default function AuditLogsPage({ embedded = false }: { embedded?: boolean }) {
  const [, setLocation] = useLocation();
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const [entityFilter, setEntityFilter] = useState<string>('all');
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [userFilter, setUserFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState('');
  
  const fieldLabels: Record<string, string> = {
    id: 'ID',
    type: 'Tipo',
    amount: 'Monto',
    description: 'Descripción',
    category: 'Categoría',
    date: 'Fecha Programada',
    imputationDate: 'Fecha Contable',
    accountId: 'Cuenta',
    organizationId: 'ID de Organización',
    createdBy: 'Creado por',
    hasInvoice: 'Con Factura',
    invoiceType: 'Tipo de Factura',
    invoiceNumber: 'Número de Factura',
    clientId: 'Cliente',
    supplierId: 'Proveedor',
    productId: 'Producto',
    name: 'Nombre',
    email: 'Email',
    phone: 'Teléfono',
    address: 'Dirección',
    notes: 'Notas',
    cuit: 'CUIT',
    currency: 'Moneda',
    balance: 'Saldo',
    sku: 'SKU',
    stock: 'Stock',
    unit: 'Unidad',
    costPrice: 'Precio de Costo',
    salePrice: 'Precio de Venta',
    createdAt: 'Creado',
    updatedAt: 'Actualizado',
    invoiceFileUrl: 'Archivo de Factura',
    status: 'Estado',
    transactionNumber: 'Número de Movimiento',
    createdVia: 'Creado desde',
    transferType: 'Tipo de Transferencia',
    transferPairId: 'ID de Par de Transferencia',
    pairedTransactionId: 'Movimiento Asociado',
    pairedTransactionNumber: 'N° Mov. Asociado',
    transferDetails: 'Detalles de Transferencia',
    isCrossCurrency: 'Cambio de Moneda',
    isCurrencyExchange: 'Con Tipo de Cambio',
    exchangeRate: 'Tipo de Cambio',
    fromAccount: 'Cuenta Origen',
    toAccount: 'Cuenta Destino',
    amounts: 'Montos',
    balanceBefore: 'Saldo Antes',
    balanceAfter: 'Saldo Después',
    origin: 'Monto Origen',
    destination: 'Monto Destino',
    originCurrency: 'Moneda Origen',
    destinationCurrency: 'Moneda Destino'
  };
  
  const formatValue = (key: string, value: any, context?: Record<string, any>): string => {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'boolean') return value ? 'Sí' : 'No';
    if (key === 'accountId' && typeof value === 'string') {
      const account = accounts.find(a => a.id === value);
      return account ? `${account.name} (${account.currency})` : value;
    }
    if (key === 'amount' || key === 'balance' || key === 'costPrice' || key === 'salePrice') {
      const currency = context?.currency || 'ARS';
      const symbol = currency === 'USD' || currency === 'USD_CASH' ? 'US$' : currency === 'EUR' ? '€' : 'AR$';
      return symbol + new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));
    }
    if (key === 'date' || key === 'imputationDate') {
      try {
        const str = String(value);
        const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (isoMatch) {
          return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
        }
        return format(new Date(value), "dd/MM/yyyy", { locale: es });
      } catch { return String(value); }
    }
    if (key === 'createdAt' || key === 'updatedAt') {
      try { return format(new Date(value), "dd/MM/yyyy HH:mm", { locale: es }); } catch { return String(value); }
    }
    if (key === 'status') {
      const statusLabels: Record<string, string> = { 
        scheduled: 'Programado', 
        completed: 'Completado', 
        cancelled: 'Cancelado' 
      };
      return statusLabels[value] || value;
    }
    if (key === 'type') {
      const types: Record<string, string> = { income: 'Ingreso', expense: 'Egreso', payable: 'Por Pagar', receivable: 'Por Cobrar', transfer_in: 'Transferencia Entrada', transfer_out: 'Transferencia Salida' };
      return types[value] || value;
    }
    if (key === 'transferType') {
      const types: Record<string, string> = { transfer_in: 'Entrada', transfer_out: 'Salida' };
      return types[value] || value;
    }
    if (key === 'exchangeRate' && typeof value === 'number') {
      return new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
    }
    if (key === 'transferDetails' && typeof value === 'object') {
      const td = value as any;
      const parts: string[] = [];
      if (td.fromAccount?.name) parts.push(`Origen: ${td.fromAccount.name} (${td.fromAccount.currency})`);
      if (td.toAccount?.name) parts.push(`Destino: ${td.toAccount.name} (${td.toAccount.currency})`);
      if (td.amounts) {
        const originSymbol = td.amounts.originCurrency === 'ARS' ? 'AR$' : td.amounts.originCurrency === 'EUR' ? '€' : 'US$';
        const destSymbol = td.amounts.destinationCurrency === 'ARS' ? 'AR$' : td.amounts.destinationCurrency === 'EUR' ? '€' : 'US$';
        parts.push(`${originSymbol}${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2 }).format(td.amounts.origin)} → ${destSymbol}${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2 }).format(td.amounts.destination)}`);
      }
      if (td.exchangeRate) parts.push(`TC: ${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2 }).format(td.exchangeRate)}`);
      return parts.join(' | ');
    }
    if ((key === 'fromAccount' || key === 'toAccount') && typeof value === 'object') {
      const acc = value as any;
      const symbol = acc.currency === 'ARS' ? 'AR$' : acc.currency === 'EUR' ? '€' : 'US$';
      return `${acc.name} (${acc.currency}) - Saldo: ${symbol}${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2 }).format(acc.balanceBefore)} → ${symbol}${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2 }).format(acc.balanceAfter)}`;
    }
    if (key === 'amounts' && typeof value === 'object') {
      const am = value as any;
      const originSymbol = am.originCurrency === 'ARS' ? 'AR$' : am.originCurrency === 'EUR' ? '€' : 'US$';
      const destSymbol = am.destinationCurrency === 'ARS' ? 'AR$' : am.destinationCurrency === 'EUR' ? '€' : 'US$';
      return `${originSymbol}${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2 }).format(am.origin)} → ${destSymbol}${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2 }).format(am.destination)}`;
    }
    if (key === 'createdVia') {
      const sources: Record<string, string> = { web: 'Web', whatsapp: 'WhatsApp', api: 'API' };
      return sources[value] || value;
    }
    if (key === 'invoiceType') {
      const invoiceTypes: Record<string, string> = { A: 'Factura A', B: 'Factura B', C: 'Factura C', X: 'Ticket/Otro' };
      return invoiceTypes[value] || value;
    }
    if (key === 'invoiceFileUrl' && value) {
      return '[Ver archivo]';
    }
    return String(value);
  };

  const renderValue = (key: string, value: any, context?: Record<string, any>): React.ReactNode => {
    if (value === null || value === undefined) return '-';
    
    if (key === 'invoiceFileUrl' && value) {
      const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(value) || value.includes('/objects/');
      const isPdf = /\.pdf$/i.test(value);
      
      return (
        <div className="space-y-2">
          {isImage && (
            <img 
              src={value} 
              alt="Comprobante" 
              className="max-w-[200px] max-h-[150px] rounded border object-contain cursor-pointer hover:opacity-80"
              onClick={() => window.open(value, '_blank')}
            />
          )}
          <a 
            href={value} 
            target="_blank" 
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline text-sm"
          >
            {isPdf ? <FileText className="h-4 w-4" /> : <ExternalLink className="h-4 w-4" />}
            {isPdf ? 'Ver PDF' : 'Ver archivo'}
          </a>
        </div>
      );
    }
    
    return formatValue(key, value, context);
  };
  
  const { data: auditLogs = [], isLoading } = useQuery<AuditLog[]>({
    queryKey: ['/api/audit-logs'],
    queryFn: async () => {
      const res = await fetch('/api/audit-logs?limit=1000', {
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Failed to fetch audit logs');
      return res.json();
    }
  });
  
  const { data: members = [] } = useQuery<Member[]>({
    queryKey: ['/api/organization/members'],
    queryFn: async () => {
      const res = await fetch('/api/organization/members', {
        credentials: 'include'
      });
      if (!res.ok) return [];
      return res.json();
    }
  });
  
  const { data: accounts = [] } = useQuery<{ id: string; name: string; currency: string }[]>({
    queryKey: ['/api/accounts'],
    queryFn: async () => {
      const res = await fetch('/api/accounts', {
        credentials: 'include'
      });
      if (!res.ok) return [];
      return res.json();
    }
  });
  
  const getAccountName = (accountId: string | null) => {
    if (!accountId) return '-';
    const account = accounts.find(a => a.id === accountId);
    return account ? `${account.name} (${account.currency})` : accountId;
  };
  
  const getUserName = (userId: string | null) => {
    if (!userId) return 'Sistema';
    const member = members.find(m => m.userId === userId);
    return member?.name || 'Usuario';
  };
  
  const getEntityLabel = (type: string) => {
    const labels: Record<string, string> = {
      'transaction': 'Movimiento',
      'account': 'Cuenta',
      'client': 'Cliente',
      'supplier': 'Proveedor',
      'product': 'Producto',
      'organization': 'Organización',
      'employee': 'Empleado',
    };
    return labels[type] || type;
  };
  
  const getActionIcon = (action: string) => {
    switch (action) {
      case 'create': return <Plus className="h-4 w-4 text-green-600" />;
      case 'update': return <Pencil className="h-4 w-4 text-blue-600" />;
      case 'delete': return <Trash2 className="h-4 w-4 text-red-600" />;
      case 'invoice_emit_failed':
      case 'credit_note_emit_failed':
        return <AlertTriangle className="h-4 w-4 text-amber-600" />;
      default: return <History className="h-4 w-4" />;
    }
  };
  
  const getActionLabel = (action: string) => {
    switch (action) {
      case 'create': return 'Creación';
      case 'update': return 'Actualización';
      case 'delete': return 'Eliminación';
      case 'invoice_emit_failed': return 'Error al emitir factura';
      case 'credit_note_emit_failed': return 'Error al emitir nota de crédito';
      case 'credit_note_bad_response': return 'Nota de crédito en revisión';
      case 'credit_note_emitted': return 'Nota de crédito emitida';
      case 'invoicing_signup': return 'Alta de facturación electrónica';
      case 'facturitas_signup': return 'Alta de facturación electrónica';
      default: return action;
    }
  };
  
  const getActionColor = (action: string) => {
    switch (action) {
      case 'create': return 'bg-green-100 text-green-700 border-green-200';
      case 'update': return 'bg-blue-100 text-blue-700 border-blue-200';
      case 'delete': return 'bg-red-100 text-red-700 border-red-200';
      case 'invoice_emit_failed':
      case 'credit_note_emit_failed':
        return 'bg-amber-100 text-amber-700 border-amber-200';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  // Renders a free-form JSON payload from a non-CRUD audit log (e.g.
  // invoice_emit_failed, credit_note_emit_failed). Highlights the well-known
  // top-level diagnostic fields and falls back to a pretty-printed JSON block
  // for the rest of the payload (typically rawResponse from the provider).
  const renderErrorPayload = (payload: Record<string, unknown>) => {
    const highlightOrder = ['message', 'status', 'classifiedCode', 'providerCode'];
    const highlightLabels: Record<string, string> = {
      message: 'Mensaje',
      status: 'HTTP',
      classifiedCode: 'Código interno',
      providerCode: 'Código del proveedor',
    };
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (!highlightOrder.includes(k)) rest[k] = v;
    }
    return (
      <div className="space-y-4">
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              {highlightOrder
                .filter((k) => payload[k] !== undefined && payload[k] !== null && payload[k] !== '')
                .map((k) => (
                  <tr key={k} className="border-t first:border-t-0">
                    <td className="px-3 py-2 font-medium text-muted-foreground w-1/3 bg-muted/40">{highlightLabels[k]}</td>
                    <td className="px-3 py-2 break-words" data-testid={`audit-error-${k}`}>{String(payload[k])}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {Object.keys(rest).length > 0 && (
          <div className="rounded-lg border overflow-hidden">
            <div className="bg-muted px-3 py-2 font-medium text-sm border-b">
              Detalle adicional
            </div>
            <pre className="px-3 py-2 text-xs whitespace-pre-wrap break-words bg-secondary/30 max-h-96 overflow-y-auto" data-testid="audit-error-raw">
              {(() => {
                try { return JSON.stringify(rest, null, 2); } catch { return String(rest); }
              })()}
            </pre>
          </div>
        )}
      </div>
    );
  };
  
  const filteredLogs = useMemo(() => {
    return auditLogs.filter(log => {
      if (entityFilter !== 'all' && log.entityType !== entityFilter) return false;
      if (actionFilter !== 'all' && log.action !== actionFilter) return false;
      if (userFilter !== 'all' && log.userId !== userFilter) return false;
      
      const logDate = new Date(log.createdAt);
      if (dateFilter === 'today') {
        const today = startOfDay(new Date());
        if (isBefore(logDate, today)) return false;
      } else if (dateFilter === 'week') {
        const weekAgo = startOfDay(subDays(new Date(), 7));
        if (isBefore(logDate, weekAgo)) return false;
      } else if (dateFilter === 'month') {
        const monthAgo = startOfDay(subDays(new Date(), 30));
        if (isBefore(logDate, monthAgo)) return false;
      } else if (dateFilter === 'custom') {
        if (dateFrom) {
          const fromDate = startOfDay(new Date(dateFrom));
          if (isBefore(logDate, fromDate)) return false;
        }
        if (dateTo) {
          const toDate = endOfDay(new Date(dateTo));
          if (isAfter(logDate, toDate)) return false;
        }
      }
      
      if (searchTerm) {
        const search = searchTerm.toLowerCase();
        try {
          const prev = log.previousData ? JSON.stringify(JSON.parse(log.previousData)).toLowerCase() : '';
          const next = log.newData ? JSON.stringify(JSON.parse(log.newData)).toLowerCase() : '';
          if (!prev.includes(search) && !next.includes(search) && !log.entityId.toLowerCase().includes(search)) {
            return false;
          }
        } catch {
          return false;
        }
      }
      return true;
    });
  }, [auditLogs, entityFilter, actionFilter, userFilter, dateFilter, dateFrom, dateTo, searchTerm]);
  
  const entityTypes = useMemo(() => Array.from(new Set(auditLogs.map(log => log.entityType))), [auditLogs]);
  
  const clearFilters = () => {
    setEntityFilter('all');
    setActionFilter('all');
    setUserFilter('all');
    setDateFilter('all');
    setDateFrom('');
    setDateTo('');
    setSearchTerm('');
  };
  
  const hasActiveFilters = entityFilter !== 'all' || actionFilter !== 'all' || userFilter !== 'all' || dateFilter !== 'all' || searchTerm;
  
  const isEmptyValue = (value: any): boolean => {
    return value === null || value === undefined || value === '' || value === '-';
  };
  
  const shouldHideField = (key: string, value: any, data: Record<string, any>): boolean => {
    const hiddenFields = ['id', 'organizationId', 'createdBy', 'assetType', 'aiClassificationConfidence', 'classificationOverriddenBy', 'classificationOverriddenAt', 'originalTransactionData'];
    if (hiddenFields.includes(key)) return true;
    if (isEmptyValue(value)) return true;
    if (key === 'imputationDate' && data.date) {
      try {
        const extractDate = (val: string) => {
          const match = String(val).match(/^(\d{4})-(\d{2})-(\d{2})/);
          return match ? `${match[1]}-${match[2]}-${match[3]}` : val;
        };
        const date1 = extractDate(data.date);
        const date2 = extractDate(value);
        if (date1 === date2) return true;
      } catch {}
    }
    return false;
  };
  
  const renderDataTable = (data: Record<string, any>, bgColor: string) => (
    <div className={`rounded-lg border ${bgColor} overflow-hidden`}>
      <table className="w-full text-sm">
        <tbody>
          {Object.entries(data)
            .filter(([key, value]) => !shouldHideField(key, value, data))
            .map(([key, value]) => (
            <tr key={key} className="border-b last:border-0">
              <td className="px-3 py-2 font-medium text-muted-foreground w-1/3">{fieldLabels[key] || key}</td>
              <td className="px-3 py-2">{renderValue(key, value, data)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  
  // Special renderer for transfer transactions
  const renderTransferDetails = (data: Record<string, any>) => {
    const transferDetails = data.transferDetails;
    const isTransferIn = data.type === 'transfer_in' || data.transferType === 'transfer_in';
    const isCrossCurrency = transferDetails?.isCrossCurrency || data.category === 'Cambio de Moneda';
    const hasExchange = (transferDetails?.exchangeRate && transferDetails.exchangeRate > 1) || 
                        (data.description && data.description.includes('TC:'));
    
    // Fallback: If no transferDetails, show basic table format
    if (!transferDetails) {
      return (
        <div className="space-y-4">
          {/* Header */}
          <div className="flex items-center gap-3 p-3 bg-purple-50 rounded-lg border border-purple-200">
            <div className="p-2 bg-purple-100 rounded-full">
              <ArrowLeftRight className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <h4 className="font-semibold text-purple-900">
                {isCrossCurrency ? 'Cambio de Moneda' : 'Transferencia entre Cuentas'}
              </h4>
              <p className="text-sm text-purple-700">
                {isTransferIn ? 'Entrada de fondos' : 'Salida de fondos'} - {data.transactionNumber || 'Sin número'}
              </p>
            </div>
          </div>
          
          {/* Basic info table */}
          <div className="rounded-lg border overflow-hidden bg-slate-50">
            <table className="w-full text-sm">
              <tbody>
                {data.amount && (
                  <tr className="border-b">
                    <td className="px-3 py-2 font-medium text-muted-foreground w-1/3">Monto</td>
                    <td className="px-3 py-2 font-semibold">{formatValue('amount', data.amount, data)}</td>
                  </tr>
                )}
                {data.description && (
                  <tr className="border-b">
                    <td className="px-3 py-2 font-medium text-muted-foreground">Descripción</td>
                    <td className="px-3 py-2">{data.description}</td>
                  </tr>
                )}
                {data.category && (
                  <tr className="border-b">
                    <td className="px-3 py-2 font-medium text-muted-foreground">Categoría</td>
                    <td className="px-3 py-2">{data.category}</td>
                  </tr>
                )}
                {data.date && (
                  <tr className="border-b">
                    <td className="px-3 py-2 font-medium text-muted-foreground">Fecha</td>
                    <td className="px-3 py-2">{formatValue('date', data.date, data)}</td>
                  </tr>
                )}
                {data.status && (
                  <tr className="border-b">
                    <td className="px-3 py-2 font-medium text-muted-foreground">Estado</td>
                    <td className="px-3 py-2">{formatValue('status', data.status, data)}</td>
                  </tr>
                )}
                {data.pairedTransactionNumber && (
                  <tr className="border-b">
                    <td className="px-3 py-2 font-medium text-muted-foreground">Mov. Asociado</td>
                    <td className="px-3 py-2"><Badge variant="outline">{data.pairedTransactionNumber}</Badge></td>
                  </tr>
                )}
                {data.transferPairId && (
                  <tr>
                    <td className="px-3 py-2 font-medium text-muted-foreground">ID Transferencia</td>
                    <td className="px-3 py-2 font-mono text-xs">{data.transferPairId}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    
    const formatAmount = (amount: number, currency: string) => {
      const symbol = currency === 'ARS' ? 'AR$' : currency === 'EUR' ? '€' : 'US$';
      return `${symbol}${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)}`;
    };
    
    const formatBalance = (amount: number, currency: string) => {
      const symbol = currency === 'ARS' ? 'AR$' : currency === 'EUR' ? '€' : 'US$';
      return `${symbol}${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)}`;
    };
    
    return (
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3 p-3 bg-purple-50 rounded-lg border border-purple-200">
          <div className="p-2 bg-purple-100 rounded-full">
            <ArrowLeftRight className="h-5 w-5 text-purple-600" />
          </div>
          <div>
            <h4 className="font-semibold text-purple-900">
              {isCrossCurrency && hasExchange ? 'Cambio de Moneda' : 'Transferencia entre Cuentas'}
            </h4>
            <p className="text-sm text-purple-700">
              {isTransferIn ? 'Entrada de fondos' : 'Salida de fondos'} - {data.transactionNumber}
            </p>
          </div>
        </div>
        
        {/* Flow: Origin → Destination */}
        {transferDetails && (
          <div className="rounded-lg border overflow-hidden">
            <div className="bg-muted px-3 py-2 font-medium text-sm border-b flex items-center gap-2">
              <RefreshCw className="h-4 w-4" />
              Flujo de la Transferencia
            </div>
            <div className="p-4">
              <div className="flex items-center gap-4 flex-wrap">
                {/* Origin Account */}
                <div className="flex-1 min-w-[200px] p-3 bg-red-50 rounded-lg border border-red-200">
                  <div className="flex items-center gap-2 mb-2">
                    <Wallet className="h-4 w-4 text-red-600" />
                    <span className="font-medium text-red-900">Cuenta Origen</span>
                  </div>
                  <p className="font-semibold text-lg">{transferDetails.fromAccount?.name}</p>
                  <p className="text-sm text-muted-foreground">{transferDetails.fromAccount?.currency}</p>
                  {transferDetails.fromAccount?.balanceBefore !== undefined && (
                    <div className="mt-2 pt-2 border-t border-red-200 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Saldo antes:</span>
                        <span>{formatBalance(transferDetails.fromAccount.balanceBefore, transferDetails.fromAccount.currency)}</span>
                      </div>
                      <div className="flex justify-between text-red-600">
                        <span>Saldo después:</span>
                        <span className="font-medium">{formatBalance(transferDetails.fromAccount.balanceAfter, transferDetails.fromAccount.currency)}</span>
                      </div>
                    </div>
                  )}
                </div>
                
                {/* Arrow */}
                <div className="flex flex-col items-center gap-1">
                  <ArrowRight className="h-6 w-6 text-purple-500" />
                  {hasExchange && (
                    <Badge className="bg-purple-100 text-purple-700 text-xs">
                      TC: {new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2 }).format(transferDetails.exchangeRate)}
                    </Badge>
                  )}
                </div>
                
                {/* Destination Account */}
                <div className="flex-1 min-w-[200px] p-3 bg-green-50 rounded-lg border border-green-200">
                  <div className="flex items-center gap-2 mb-2">
                    <Wallet className="h-4 w-4 text-green-600" />
                    <span className="font-medium text-green-900">Cuenta Destino</span>
                  </div>
                  <p className="font-semibold text-lg">{transferDetails.toAccount?.name}</p>
                  <p className="text-sm text-muted-foreground">{transferDetails.toAccount?.currency}</p>
                  {transferDetails.toAccount?.balanceBefore !== undefined && (
                    <div className="mt-2 pt-2 border-t border-green-200 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Saldo antes:</span>
                        <span>{formatBalance(transferDetails.toAccount.balanceBefore, transferDetails.toAccount.currency)}</span>
                      </div>
                      <div className="flex justify-between text-green-600">
                        <span>Saldo después:</span>
                        <span className="font-medium">{formatBalance(transferDetails.toAccount.balanceAfter, transferDetails.toAccount.currency)}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
        
        {/* Amounts Section */}
        {transferDetails?.amounts && (
          <div className="rounded-lg border overflow-hidden">
            <div className="bg-muted px-3 py-2 font-medium text-sm border-b">
              Detalle de Montos
            </div>
            <div className="p-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-center">
                <div className="p-3 bg-slate-50 rounded-lg">
                  <p className="text-sm text-muted-foreground mb-1">Monto Origen</p>
                  <p className="text-xl font-bold">{formatAmount(transferDetails.amounts.origin, transferDetails.amounts.originCurrency)}</p>
                </div>
                {hasExchange && (
                  <div className="p-3 bg-purple-50 rounded-lg">
                    <p className="text-sm text-muted-foreground mb-1">Tipo de Cambio</p>
                    <p className="text-xl font-bold text-purple-700">
                      1 {transferDetails.amounts.originCurrency === 'ARS' ? transferDetails.amounts.destinationCurrency : transferDetails.amounts.originCurrency} = {new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2 }).format(transferDetails.exchangeRate)} ARS
                    </p>
                  </div>
                )}
                <div className="p-3 bg-slate-50 rounded-lg">
                  <p className="text-sm text-muted-foreground mb-1">Monto Destino</p>
                  <p className="text-xl font-bold">{formatAmount(transferDetails.amounts.destination, transferDetails.amounts.destinationCurrency)}</p>
                </div>
              </div>
            </div>
          </div>
        )}
        
        {/* Additional Info */}
        <div className="rounded-lg border overflow-hidden">
          <div className="bg-muted px-3 py-2 font-medium text-sm border-b">
            Información Adicional
          </div>
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b">
                <td className="px-3 py-2 font-medium text-muted-foreground w-1/3">Fecha</td>
                <td className="px-3 py-2">{formatValue('date', data.date, data)}</td>
              </tr>
              <tr className="border-b">
                <td className="px-3 py-2 font-medium text-muted-foreground">Descripción</td>
                <td className="px-3 py-2">{data.description || '-'}</td>
              </tr>
              <tr className="border-b">
                <td className="px-3 py-2 font-medium text-muted-foreground">Estado</td>
                <td className="px-3 py-2">{formatValue('status', data.status, data)}</td>
              </tr>
              {data.pairedTransactionNumber && (
                <tr className="border-b">
                  <td className="px-3 py-2 font-medium text-muted-foreground">Movimiento Asociado</td>
                  <td className="px-3 py-2">
                    <Badge variant="outline">{data.pairedTransactionNumber}</Badge>
                  </td>
                </tr>
              )}
              <tr>
                <td className="px-3 py-2 font-medium text-muted-foreground">Creado desde</td>
                <td className="px-3 py-2">{formatValue('createdVia', data.createdVia, data)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  };
  
  const renderDataDiff = (log: AuditLog) => {
    try {
      const prev = log.previousData ? JSON.parse(log.previousData) : null;
      const next = log.newData ? JSON.parse(log.newData) : null;
      
      // Special handling for transfer transactions
      if (log.action === 'create' && next && (next.type === 'transfer_in' || next.type === 'transfer_out' || next.transferType)) {
        return renderTransferDetails(next);
      }
      
      if (log.action === 'create' && next) {
        return (
          <div className="space-y-3">
            <h4 className="font-medium text-sm flex items-center gap-2">
              <Plus className="h-4 w-4 text-green-600" />
              Datos creados:
            </h4>
            {renderDataTable(next, 'bg-green-50')}
          </div>
        );
      }
      
      if (log.action === 'delete' && prev) {
        return (
          <div className="space-y-3">
            <h4 className="font-medium text-sm flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-red-600" />
              Datos eliminados:
            </h4>
            {renderDataTable(prev, 'bg-red-50')}
          </div>
        );
      }
      
      // Non-CRUD actions (invoice_emit_failed, credit_note_emit_failed, etc.)
      // store a free-form JSON payload in newData. Render it as highlighted
      // diagnostic fields + raw JSON so ops can read the provider response
      // straight from the UI.
      if (next && typeof next === 'object' && !['create', 'update', 'delete'].includes(log.action)) {
        return (
          <div className="space-y-3">
            <h4 className="font-medium text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              Detalle del error
            </h4>
            {renderErrorPayload(next as Record<string, unknown>)}
          </div>
        );
      }

      if (log.action === 'update' && prev && next) {
        const hiddenFields = ['id','organizationId','createdBy','assetType','aiClassificationConfidence','classificationOverriddenBy','classificationOverriddenAt','originalTransactionData'];
        const changedFields = Object.keys(next).filter(key => 
          JSON.stringify(prev[key]) !== JSON.stringify(next[key]) && !hiddenFields.includes(key)
        );
        
        return (
          <div className="space-y-4">
            <h4 className="font-medium text-sm flex items-center gap-2">
              <Pencil className="h-4 w-4 text-blue-600" />
              Campos modificados: <Badge variant="secondary">{changedFields.length}</Badge>
            </h4>
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Campo</th>
                    <th className="px-3 py-2 text-left font-medium text-red-600">Antes</th>
                    <th className="px-3 py-2 text-left font-medium text-green-600">Después</th>
                  </tr>
                </thead>
                <tbody>
                  {changedFields.map(key => (
                    <tr key={key} className="border-t">
                      <td className="px-3 py-2 font-medium text-muted-foreground">{fieldLabels[key] || key}</td>
                      <td className="px-3 py-2 bg-red-50">{renderValue(key, prev[key], prev)}</td>
                      <td className="px-3 py-2 bg-green-50">{renderValue(key, next[key], next)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      }
      
      return <p className="text-muted-foreground text-sm">No hay datos de cambio disponibles</p>;
    } catch (e) {
      return <p className="text-muted-foreground text-sm">Error al procesar datos</p>;
    }
  };
  
  // Escapes any string for safe interpolation into HTML written to a new
  // window or Blob (PDF print view / Word export). Used to prevent stored-XSS
  // via fields like provider error messages, user names, entity ids, or
  // transaction descriptions that may contain attacker-controlled markup.
  const esc = (s: unknown): string => {
    if (s == null) return '';
    const str = typeof s === 'string' ? s : String(s);
    return str.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c] || c));
  };
  const escFmt = (k: string, v: any, ctx: any): string => esc(formatValue(k, v, ctx));

  const downloadAuditPdf = (log: AuditLog) => {
    const prev = log.previousData ? JSON.parse(log.previousData) : null;
    const next = log.newData ? JSON.parse(log.newData) : null;
    const hiddenFields = ['id','organizationId','createdBy','assetType','aiClassificationConfidence','classificationOverriddenBy','classificationOverriddenAt','originalTransactionData'];
    const changedFields = prev && next ? Object.keys(next).filter(key => JSON.stringify(prev[key]) !== JSON.stringify(next[key]) && !hiddenFields.includes(key)) : [];
    
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    
    const escapeHtml = esc;
    const buildErrorHtml = (payload: Record<string, unknown>) => {
      const highlightOrder = ['message','status','classifiedCode','providerCode'];
      const labels: Record<string,string> = { message:'Mensaje', status:'HTTP', classifiedCode:'Código interno', providerCode:'Código del proveedor' };
      const rest: Record<string, unknown> = {};
      for (const [k,v] of Object.entries(payload)) if (!highlightOrder.includes(k)) rest[k] = v;
      const top = highlightOrder
        .filter((k) => payload[k] !== undefined && payload[k] !== null && payload[k] !== '')
        .map((k) => `<tr><td><strong>${labels[k]}</strong></td><td>${escapeHtml(String(payload[k]))}</td></tr>`).join('');
      let rawHtml = '';
      if (Object.keys(rest).length > 0) {
        let raw = '';
        try { raw = JSON.stringify(rest, null, 2); } catch { raw = String(rest); }
        rawHtml = `<h3>Detalle adicional:</h3><pre style="background:#f5f5f5;padding:12px;border:1px solid #ddd;font-family:monospace;font-size:12px;white-space:pre-wrap;word-break:break-word">${escapeHtml(raw)}</pre>`;
      }
      return `<h3>Detalle del error:</h3><table>${top}</table>${rawHtml}`;
    };

    let dataHtml = '';
    if (log.action === 'create' && next) {
      dataHtml = `<h3>Datos creados:</h3><table>${Object.entries(next).filter(([k]) => !['id','organizationId','createdBy','assetType','aiClassificationConfidence','classificationOverriddenBy','classificationOverriddenAt','originalTransactionData'].includes(k)).filter(([_,v]) => v !== null && v !== undefined && v !== '' && v !== '-').map(([k,v]) => `<tr><td><strong>${esc(fieldLabels[k]||k)}</strong></td><td>${escFmt(k,v,next)}</td></tr>`).join('')}</table>`;
    } else if (log.action === 'delete' && prev) {
      dataHtml = `<h3>Datos eliminados:</h3><table>${Object.entries(prev).filter(([k]) => !['id','organizationId','createdBy','assetType','aiClassificationConfidence','classificationOverriddenBy','classificationOverriddenAt','originalTransactionData'].includes(k)).map(([k,v]) => `<tr><td><strong>${esc(fieldLabels[k]||k)}</strong></td><td>${escFmt(k,v,prev)}</td></tr>`).join('')}</table>`;
    } else if (log.action === 'update' && prev && next) {
      dataHtml = `<h3>Campos modificados (${changedFields.length}):</h3><table><tr><th>Campo</th><th>Antes</th><th>Después</th></tr>${changedFields.map(k => `<tr><td><strong>${esc(fieldLabels[k]||k)}</strong></td><td style="background:#fee">${escFmt(k,prev[k],prev)}</td><td style="background:#efe">${escFmt(k,next[k],next)}</td></tr>`).join('')}</table>`;
    } else if (next && typeof next === 'object') {
      dataHtml = buildErrorHtml(next as Record<string, unknown>);
    }
    
    printWindow.document.write(`<!DOCTYPE html><html><head><title>Auditoría - ${esc(log.id)}</title><style>body{font-family:Arial,sans-serif;padding:20px}h1{color:#333}h2{color:#555;border-bottom:1px solid #ddd;padding-bottom:8px}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{border:1px solid #ddd;padding:8px;text-align:left}.info{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:16px 0}.info-item{margin-bottom:8px}.label{color:#666;font-size:14px}.value{font-weight:500}</style></head><body><h1>Registro de Auditoría</h1><h2>${esc(getActionLabel(log.action))} de ${esc(getEntityLabel(log.entityType))}</h2><div class="info"><div class="info-item"><div class="label">Usuario</div><div class="value">${esc(getUserName(log.userId))}</div></div><div class="info-item"><div class="label">Fecha</div><div class="value">${esc(format(new Date(log.createdAt), "dd/MM/yyyy HH:mm:ss", { locale: es }))}</div></div><div class="info-item"><div class="label">Entidad</div><div class="value">${esc(getEntityLabel(log.entityType))}</div></div><div class="info-item"><div class="label">ID</div><div class="value" style="font-family:monospace;font-size:12px">${esc(log.entityId)}</div></div></div>${dataHtml}</body></html>`);
    printWindow.document.close();
    printWindow.print();
  };
  
  const downloadAuditWord = (log: AuditLog) => {
    const prev = log.previousData ? JSON.parse(log.previousData) : null;
    const next = log.newData ? JSON.parse(log.newData) : null;
    const hiddenFields = ['id','organizationId','createdBy','assetType','aiClassificationConfidence','classificationOverriddenBy','classificationOverriddenAt','originalTransactionData'];
    const changedFields = prev && next ? Object.keys(next).filter(key => JSON.stringify(prev[key]) !== JSON.stringify(next[key]) && !hiddenFields.includes(key)) : [];
    
    let dataHtml = '';
    if (log.action === 'create' && next) {
      dataHtml = `<h3>Datos creados:</h3><table border="1" cellpadding="6">${Object.entries(next).filter(([k]) => !['id','organizationId','createdBy','assetType','aiClassificationConfidence','classificationOverriddenBy','classificationOverriddenAt','originalTransactionData'].includes(k)).filter(([_,v]) => v !== null && v !== undefined && v !== '' && v !== '-').map(([k,v]) => `<tr><td><b>${esc(fieldLabels[k]||k)}</b></td><td>${escFmt(k,v,next)}</td></tr>`).join('')}</table>`;
    } else if (log.action === 'delete' && prev) {
      dataHtml = `<h3>Datos eliminados:</h3><table border="1" cellpadding="6">${Object.entries(prev).filter(([k]) => !['id','organizationId','createdBy','assetType','aiClassificationConfidence','classificationOverriddenBy','classificationOverriddenAt','originalTransactionData'].includes(k)).map(([k,v]) => `<tr><td><b>${esc(fieldLabels[k]||k)}</b></td><td>${escFmt(k,v,prev)}</td></tr>`).join('')}</table>`;
    } else if (log.action === 'update' && prev && next) {
      dataHtml = `<h3>Campos modificados (${changedFields.length}):</h3><table border="1" cellpadding="6"><tr><th>Campo</th><th>Antes</th><th>Después</th></tr>${changedFields.map(k => `<tr><td><b>${esc(fieldLabels[k]||k)}</b></td><td bgcolor="#ffeeee">${escFmt(k,prev[k],prev)}</td><td bgcolor="#eeffee">${escFmt(k,next[k],next)}</td></tr>`).join('')}</table>`;
    } else if (next && typeof next === 'object') {
      const payload = next as Record<string, unknown>;
      const highlightOrder = ['message','status','classifiedCode','providerCode'];
      const labels: Record<string,string> = { message:'Mensaje', status:'HTTP', classifiedCode:'Código interno', providerCode:'Código del proveedor' };
      const rest: Record<string, unknown> = {};
      for (const [k,v] of Object.entries(payload)) if (!highlightOrder.includes(k)) rest[k] = v;
      const topRows = highlightOrder
        .filter((k) => payload[k] !== undefined && payload[k] !== null && payload[k] !== '')
        .map((k) => `<tr><td><b>${esc(labels[k])}</b></td><td>${esc(String(payload[k]))}</td></tr>`).join('');
      let raw = '';
      if (Object.keys(rest).length > 0) {
        try { raw = JSON.stringify(rest, null, 2); } catch { raw = String(rest); }
      }
      dataHtml = `<h3>Detalle del error:</h3><table border="1" cellpadding="6">${topRows}</table>` + (raw ? `<h3>Detalle adicional:</h3><pre style="font-family:Courier New,monospace;font-size:11px;border:1px solid #999;padding:8px;background:#f5f5f5">${esc(raw)}</pre>` : '');
    }
    
    const content = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>Auditoría</title></head><body><h1>Registro de Auditoría</h1><h2>${esc(getActionLabel(log.action))} de ${esc(getEntityLabel(log.entityType))}</h2><table cellpadding="6"><tr><td><b>Usuario:</b></td><td>${esc(getUserName(log.userId))}</td><td><b>Fecha:</b></td><td>${esc(format(new Date(log.createdAt), "dd/MM/yyyy HH:mm:ss", { locale: es }))}</td></tr><tr><td><b>Entidad:</b></td><td>${esc(getEntityLabel(log.entityType))}</td><td><b>ID:</b></td><td style="font-family:monospace">${esc(log.entityId)}</td></tr></table><br/>${dataHtml}</body></html>`;
    
    const blob = new Blob([content], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `auditoria-${log.id.slice(0,8)}.doc`;
    a.click();
    URL.revokeObjectURL(url);
  };
  
  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          {!embedded && (
          <div>
            <h1 className="text-2xl font-bold font-display flex items-center gap-2">
              <History className="h-6 w-6 text-primary" />
              Historial de Auditoría
            </h1>
            <p className="text-muted-foreground">
              Registro de todos los cambios realizados en el sistema
            </p>
          </div>
          )}
          {hasActiveFilters && (
            <Button variant="outline" size="sm" onClick={clearFilters} data-testid="button-clear-filters">
              <X className="h-4 w-4 mr-2" />
              Limpiar filtros
            </Button>
          )}
        </div>
        
        <Card>
          <CardHeader className="pb-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
              <div className="relative sm:col-span-2 lg:col-span-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input 
                  placeholder="Buscar en registros..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-9"
                  data-testid="input-search-audit"
                />
              </div>
              
              <Select value={userFilter} onValueChange={setUserFilter}>
                <SelectTrigger data-testid="select-user-filter">
                  <User className="h-4 w-4 mr-2 flex-shrink-0" />
                  <SelectValue placeholder="Usuario" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos los usuarios</SelectItem>
                  {members.map(member => (
                    <SelectItem key={member.userId} value={member.userId}>{member.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              
              <Select value={entityFilter} onValueChange={setEntityFilter}>
                <SelectTrigger data-testid="select-entity-filter">
                  <Filter className="h-4 w-4 mr-2 flex-shrink-0" />
                  <SelectValue placeholder="Tipo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas las entidades</SelectItem>
                  {entityTypes.map(type => (
                    <SelectItem key={type} value={type}>{getEntityLabel(type)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              
              <Select value={actionFilter} onValueChange={setActionFilter}>
                <SelectTrigger data-testid="select-action-filter">
                  <SelectValue placeholder="Acción" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas las acciones</SelectItem>
                  <SelectItem value="create">Creación</SelectItem>
                  <SelectItem value="update">Actualización</SelectItem>
                  <SelectItem value="delete">Eliminación</SelectItem>
                </SelectContent>
              </Select>
              
              <Select value={dateFilter} onValueChange={setDateFilter}>
                <SelectTrigger data-testid="select-date-filter">
                  <Calendar className="h-4 w-4 mr-2 flex-shrink-0" />
                  <SelectValue placeholder="Fecha" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas las fechas</SelectItem>
                  <SelectItem value="today">Hoy</SelectItem>
                  <SelectItem value="week">Últimos 7 días</SelectItem>
                  <SelectItem value="month">Últimos 30 días</SelectItem>
                  <SelectItem value="custom">Rango personalizado</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            {dateFilter === 'custom' && (
              <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Desde:</span>
                  <Input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="w-auto"
                    data-testid="input-date-from"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Hasta:</span>
                  <Input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="w-auto"
                    data-testid="input-date-to"
                  />
                </div>
              </div>
            )}
            
            {hasActiveFilters && (
              <div className="mt-3 pt-3 border-t">
                <p className="text-sm text-muted-foreground">
                  Mostrando <span className="font-medium text-foreground">{filteredLogs.length}</span> de{' '}
                  <span className="font-medium text-foreground">{auditLogs.length}</span> registros
                </p>
              </div>
            )}
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-12 text-muted-foreground">
                Cargando historial...
              </div>
            ) : filteredLogs.length === 0 ? (
              <div className="text-center py-12">
                <History className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
                <p className="text-muted-foreground">
                  {auditLogs.length === 0 
                    ? "No hay registros de auditoría aún. Los cambios se registrarán automáticamente."
                    : "No se encontraron registros con los filtros aplicados."
                  }
                </p>
              </div>
            ) : (
              <ScrollArea className="h-[600px]">
                <div className="space-y-2">
                  {filteredLogs.map((log) => (
                    <div 
                      key={log.id}
                      className="flex items-center gap-4 p-3 rounded-lg border hover:bg-secondary/50 transition-colors cursor-pointer"
                      onClick={() => setSelectedLog(log)}
                      data-testid={`audit-log-${log.id}`}
                    >
                      <div className={cn("p-2 rounded-full flex-shrink-0", getActionColor(log.action))}>
                        {getActionIcon(log.action)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{getActionLabel(log.action)}</span>
                          <Badge variant="outline">{getEntityLabel(log.entityType)}</Badge>
                        </div>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1 flex-wrap">
                          <span className="flex items-center gap-1">
                            <User className="h-3 w-3" />
                            {getUserName(log.userId)}
                          </span>
                          <span className="hidden sm:inline">•</span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {format(new Date(log.createdAt), "dd MMM yyyy HH:mm", { locale: es })}
                          </span>
                        </div>
                      </div>
                      <Button variant="ghost" size="icon" className="flex-shrink-0">
                        <Eye className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
        
        <Dialog open={!!selectedLog} onOpenChange={() => { setSelectedLog(null); setIsMaximized(false); }}>
          <DialogContent className={`${isMaximized ? 'sm:max-w-[95vw] h-[95vh]' : 'max-w-3xl max-h-[90vh]'} overflow-y-auto transition-all duration-200`}>
            <DialogHeader>
              <div className="flex items-center justify-between">
                <DialogTitle className="flex items-center gap-2">
                  <div className={cn("p-2 rounded-full", selectedLog ? getActionColor(selectedLog.action) : '')}>
                    {selectedLog && getActionIcon(selectedLog.action)}
                  </div>
                  {selectedLog && getActionLabel(selectedLog.action)} de {selectedLog && getEntityLabel(selectedLog.entityType)}
                </DialogTitle>
                <div className="flex items-center gap-3 mr-6">
                  {selectedLog && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" data-testid="button-download-audit">
                          <Download className="h-4 w-4 mr-2" />
                          Descargar
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => downloadAuditPdf(selectedLog)} data-testid="button-download-audit-pdf">
                          <FileText className="h-4 w-4 mr-2" />
                          PDF (Imprimir)
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => downloadAuditWord(selectedLog)} data-testid="button-download-audit-word">
                          <FileType className="h-4 w-4 mr-2" />
                          Word (.doc)
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setIsMaximized(!isMaximized)}
                    data-testid="button-maximize-audit"
                  >
                    {isMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </DialogHeader>
            {selectedLog && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Usuario:</span>
                    <span className="ml-2 font-medium">{getUserName(selectedLog.userId)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Fecha:</span>
                    <span className="ml-2 font-medium">
                      {format(new Date(selectedLog.createdAt), "dd 'de' MMMM yyyy 'a las' HH:mm:ss", { locale: es })}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Entidad:</span>
                    <span className="ml-2 font-medium">{getEntityLabel(selectedLog.entityType)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">ID:</span>
                    <span className="font-mono text-xs bg-secondary px-2 py-1 rounded">{selectedLog.entityId}</span>
                    {selectedLog.entityType === 'transaction' && selectedLog.action !== 'delete' && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="ml-2"
                        onClick={() => {
                          setSelectedLog(null);
                          setLocation(`/transactions?id=${selectedLog.entityId}`);
                        }}
                        data-testid="button-view-transaction"
                      >
                        <ExternalLink className="h-3 w-3 mr-1" />
                        Ver Movimiento
                      </Button>
                    )}
                  </div>
                </div>
                <div className="border-t pt-4">
                  {renderDataDiff(selectedLog)}
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </>
  );
}
