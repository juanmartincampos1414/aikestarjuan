import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ArrowLeft, AlertTriangle, ArrowUpRight, ArrowDownLeft, Wrench, Loader2, RefreshCw, X, Filter, ArrowUpDown } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { useAccounts } from '@/lib/hooks';
import type { Account } from '@shared/schema';

type Orphan = {
  id: string;
  transactionNumber: string | null;
  type: 'transfer_in' | 'transfer_out';
  amount: string;
  currency: string | null;
  description: string | null;
  category: string | null;
  imputationDate: string | null;
  date: string | null;
  accountId: string | null;
  accountName: string | null;
  accountCurrency: string | null;
  transferPairId: string | null;
  reason: 'no_pair_id' | 'missing_counterpart_leg';
};

type OrphansResponse = { orphans: Orphan[] };

type RepairAction = 'create_pair' | 'convert_to_regular' | 'cancel';

type BatchResult = {
  id: string;
  ok: boolean;
  action?: string;
  message?: string;
  status?: number;
};
type BatchResponse = { success: boolean; succeeded: number; failed: number; results: BatchResult[] };

export default function OrphanTransfersPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const accountsQuery = useAccounts();

  const orphansQuery = useQuery<OrphansResponse>({
    queryKey: ['/api/transactions/orphan-transfers'],
  });

  const [pairOpenFor, setPairOpenFor] = useState<Orphan | null>(null);
  const [pairAccountId, setPairAccountId] = useState<string>('');
  const [convertOpenFor, setConvertOpenFor] = useState<Orphan | null>(null);
  const [convertType, setConvertType] = useState<'income' | 'expense'>('income');
  const [convertCategory, setConvertCategory] = useState<string>('');
  const [cancelOpenFor, setCancelOpenFor] = useState<Orphan | null>(null);

  // Selection state for bulk actions (Task #179).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Bulk dialog state.
  const [bulkPairOpen, setBulkPairOpen] = useState(false);
  const [bulkPairAccountId, setBulkPairAccountId] = useState<string>('');
  const [bulkConvertOpen, setBulkConvertOpen] = useState(false);
  const [bulkConvertType, setBulkConvertType] = useState<'income' | 'expense'>('income');
  const [bulkConvertCategory, setBulkConvertCategory] = useState<string>('');
  const [bulkCancelOpen, setBulkCancelOpen] = useState(false);

  // Filters & sorting (Task #180).
  const [filterAccount, setFilterAccount] = useState<string>('all');
  const [filterCurrency, setFilterCurrency] = useState<string>('all');
  const [filterType, setFilterType] = useState<'all' | 'transfer_in' | 'transfer_out'>('all');
  const [filterReason, setFilterReason] = useState<'all' | 'no_pair_id' | 'missing_counterpart_leg'>('all');
  const [filterDateFrom, setFilterDateFrom] = useState<string>('');
  const [filterDateTo, setFilterDateTo] = useState<string>('');
  const [sortBy, setSortBy] = useState<'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc' | 'account_asc'>('date_desc');

  const orphans = orphansQuery.data?.orphans ?? [];

  // Selected orphans, in the same order as the listing.
  const selectedOrphans = useMemo(
    () => orphans.filter(o => selectedIds.has(o.id)),
    [orphans, selectedIds],
  );

  // Prune stale ids from the selection when the orphan list refreshes (e.g.
  // after a successful repair or a manual refetch). Otherwise the toolbar
  // counter ("3 seleccionadas") would diverge from the number of items
  // actually sent in the next batch call (`selectedOrphans.length`), making
  // the UI lie to the user about what's about to be processed.
  useEffect(() => {
    if (orphansQuery.isLoading) return;
    setSelectedIds(prev => {
      if (prev.size === 0) return prev;
      const live = new Set(orphans.map(o => o.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [orphans, orphansQuery.isLoading]);

  // Group selected orphans by currency. If they aren't all in the same
  // currency, the "create counterpart" bulk action is disabled because the
  // backend currently only supports same-currency repairs.
  const selectedCurrencies = useMemo(() => {
    const set = new Set<string>();
    for (const o of selectedOrphans) set.add((o.accountCurrency ?? o.currency ?? 'ARS'));
    return set;
  }, [selectedOrphans]);
  const selectedCurrency = selectedCurrencies.size === 1 ? Array.from(selectedCurrencies)[0]! : null;

  // Selected orphans must all share the SAME source account for a one-shot
  // bulk "create counterpart" — otherwise asking the user for a single
  // counterpart account would be ambiguous (orphan from account A vs B both
  // pointing to the same destination C is fine, but in batch we want a
  // predictable, single counterpart).
  const selectedAccountIds = useMemo(() => {
    const set = new Set<string>();
    for (const o of selectedOrphans) if (o.accountId) set.add(o.accountId);
    return set;
  }, [selectedOrphans]);

  const repairMutation = useMutation({
    mutationFn: async (vars: {
      id: string;
      action: RepairAction;
      counterpartAccountId?: string;
      regularType?: 'income' | 'expense';
      regularCategory?: string;
    }) => {
      const res = await apiRequest('POST', `/api/transactions/orphan-transfers/${vars.id}/repair`, {
        action: vars.action,
        counterpartAccountId: vars.counterpartAccountId,
        regularType: vars.regularType,
        regularCategory: vars.regularCategory,
      });
      return res.json();
    },
    onSuccess: (_data, vars) => {
      const message = vars.action === 'create_pair'
        ? 'Contraparte creada correctamente.'
        : vars.action === 'convert_to_regular'
          ? 'Transferencia convertida en movimiento regular.'
          : 'Transferencia cancelada.';
      toast({ title: 'Reparación aplicada', description: message });
      qc.invalidateQueries({ queryKey: ['/api/transactions/orphan-transfers'] });
      qc.invalidateQueries({ queryKey: ['/api/transactions'] });
      qc.invalidateQueries({ queryKey: ['/api/transactions/calendar'] });
      qc.invalidateQueries({ queryKey: ['/api/accounts'] });
      setPairOpenFor(null);
      setPairAccountId('');
      setConvertOpenFor(null);
      setConvertCategory('');
      setCancelOpenFor(null);
    },
    onError: (err: any) => {
      toast({
        title: 'No se pudo reparar',
        description: err?.message ?? 'Probá de nuevo en unos segundos.',
        variant: 'destructive',
      });
    },
  });

  const batchMutation = useMutation({
    mutationFn: async (vars: {
      action: RepairAction;
      counterpartAccountId?: string;
      regularType?: 'income' | 'expense';
      regularCategory?: string;
    }) => {
      const items = selectedOrphans.map(o => ({
        id: o.id,
        action: vars.action,
        counterpartAccountId: vars.counterpartAccountId,
        regularType: vars.regularType,
        regularCategory: vars.regularCategory,
      }));
      const res = await apiRequest('POST', '/api/transactions/orphan-transfers/repair-batch', { items });
      return res.json() as Promise<BatchResponse>;
    },
    onSuccess: (data) => {
      const { succeeded, failed } = data;
      if (failed === 0) {
        toast({
          title: 'Reparación masiva completada',
          description: `${succeeded} ${succeeded === 1 ? 'transferencia reparada' : 'transferencias reparadas'}.`,
        });
      } else {
        const firstError = data.results.find(r => !r.ok)?.message;
        toast({
          title: `${succeeded} OK / ${failed} con errores`,
          description: firstError
            ? `Algunas no se pudieron reparar: ${firstError}`
            : 'Algunas no se pudieron reparar. Refrescá la lista para ver el estado.',
          variant: 'destructive',
        });
      }
      qc.invalidateQueries({ queryKey: ['/api/transactions/orphan-transfers'] });
      qc.invalidateQueries({ queryKey: ['/api/transactions'] });
      qc.invalidateQueries({ queryKey: ['/api/transactions/calendar'] });
      qc.invalidateQueries({ queryKey: ['/api/accounts'] });
      // Drop only the IDs that were repaired successfully — keep the failed
      // ones still selected so the user can retry/inspect them.
      setSelectedIds(prev => {
        const next = new Set(prev);
        for (const r of data.results) if (r.ok) next.delete(r.id);
        return next;
      });
      setBulkPairOpen(false);
      setBulkPairAccountId('');
      setBulkConvertOpen(false);
      setBulkConvertCategory('');
      setBulkCancelOpen(false);
    },
    onError: (err: any) => {
      toast({
        title: 'No se pudo ejecutar la reparación masiva',
        description: err?.message ?? 'Probá de nuevo en unos segundos.',
        variant: 'destructive',
      });
    },
  });

  // Distinct accounts and currencies present in orphans (for filter options).
  const orphanAccountOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const o of orphans) {
      if (o.accountId && !seen.has(o.accountId)) {
        seen.set(o.accountId, o.accountName ?? '(eliminada)');
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [orphans]);

  const orphanCurrencyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const o of orphans) {
      const ccy = o.currency ?? o.accountCurrency;
      if (ccy) set.add(ccy);
    }
    return Array.from(set).sort();
  }, [orphans]);

  const hasActiveFilters =
    filterAccount !== 'all' ||
    filterCurrency !== 'all' ||
    filterType !== 'all' ||
    filterReason !== 'all' ||
    !!filterDateFrom ||
    !!filterDateTo;

  const clearFilters = () => {
    setFilterAccount('all');
    setFilterCurrency('all');
    setFilterType('all');
    setFilterReason('all');
    setFilterDateFrom('');
    setFilterDateTo('');
  };

  const visibleOrphans = useMemo(() => {
    const fromTs = filterDateFrom ? new Date(`${filterDateFrom}T00:00:00`).getTime() : null;
    const toTs = filterDateTo ? new Date(`${filterDateTo}T23:59:59.999`).getTime() : null;

    const filtered = orphans.filter((o) => {
      if (filterAccount !== 'all' && o.accountId !== filterAccount) return false;
      if (filterCurrency !== 'all') {
        const ccy = o.currency ?? o.accountCurrency;
        if (ccy !== filterCurrency) return false;
      }
      if (filterType !== 'all' && o.type !== filterType) return false;
      if (filterReason !== 'all' && o.reason !== filterReason) return false;
      if (fromTs !== null || toTs !== null) {
        const raw = o.imputationDate ?? o.date;
        if (!raw) return false;
        const ts = new Date(raw).getTime();
        if (Number.isNaN(ts)) return false;
        if (fromTs !== null && ts < fromTs) return false;
        if (toTs !== null && ts > toTs) return false;
      }
      return true;
    });

    const dateValue = (o: Orphan) => {
      const raw = o.imputationDate ?? o.date;
      if (!raw) return 0;
      const t = new Date(raw).getTime();
      return Number.isNaN(t) ? 0 : t;
    };
    const amountValue = (o: Orphan) => {
      const n = parseFloat(o.amount);
      return Number.isNaN(n) ? 0 : Math.abs(n);
    };

    const sorted = [...filtered].sort((a, b) => {
      switch (sortBy) {
        case 'date_asc': return dateValue(a) - dateValue(b);
        case 'date_desc': return dateValue(b) - dateValue(a);
        case 'amount_asc': return amountValue(a) - amountValue(b);
        case 'amount_desc': return amountValue(b) - amountValue(a);
        case 'account_asc':
          return (a.accountName ?? '').localeCompare(b.accountName ?? '', 'es');
        default: return 0;
      }
    });

    return sorted;
  }, [orphans, filterAccount, filterCurrency, filterType, filterReason, filterDateFrom, filterDateTo, sortBy]);

  // Eligible counterparts for a given orphan: same currency, distinct account.
  const eligibleCounterparts = useMemo<Account[]>(() => {
    if (!pairOpenFor) return [];
    const list = (accountsQuery.data as Account[] | undefined) ?? [];
    return list.filter((a) =>
      a.id !== pairOpenFor.accountId &&
      (a.currency === (pairOpenFor.accountCurrency ?? pairOpenFor.currency)),
    );
  }, [accountsQuery.data, pairOpenFor]);

  // Eligible counterparts for the BULK create-pair flow: same currency for the
  // whole selection, and not equal to any of the source accounts in the
  // selection.
  const bulkEligibleCounterparts = useMemo<Account[]>(() => {
    if (!selectedCurrency) return [];
    const list = (accountsQuery.data as Account[] | undefined) ?? [];
    return list.filter(a =>
      a.currency === selectedCurrency && !selectedAccountIds.has(a.id),
    );
  }, [accountsQuery.data, selectedCurrency, selectedAccountIds]);

  // "Select all" applies to the currently visible (filtered) list, so the
  // checkbox state and bulk actions stay consistent with what the user sees
  // after Task #180's filters/sort were applied.
  const allSelected = visibleOrphans.length > 0
    && visibleOrphans.every(o => selectedIds.has(o.id));
  const someSelected = !allSelected
    && visibleOrphans.some(o => selectedIds.has(o.id));

  const toggleAll = (checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) for (const o of visibleOrphans) next.add(o.id);
      else for (const o of visibleOrphans) next.delete(o.id);
      return next;
    });
  };
  const toggleOne = (id: string, checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };

  const fmtAmount = (a: string, ccy: string | null) => {
    const n = parseFloat(a);
    if (Number.isNaN(n)) return a;
    return `${ccy ?? 'ARS'} ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };
  const fmtDate = (d: string | null) => {
    if (!d) return '—';
    try { return format(new Date(d), "dd 'de' MMMM 'de' yyyy", { locale: es }); }
    catch { return d; }
  };

  const bulkCreatePairDisabledReason = (() => {
    if (selectedOrphans.length === 0) return null;
    if (selectedCurrencies.size > 1) {
      return 'Las seleccionadas tienen monedas distintas. Filtrá por una sola moneda para crear contrapartes en lote.';
    }
    if (bulkEligibleCounterparts.length === 0) {
      return 'No hay otras cuentas con la misma moneda disponibles como contraparte.';
    }
    return null;
  })();

  return (
    <div className="container mx-auto p-4 sm:p-6 max-w-6xl space-y-4" data-testid="page-orphan-transfers">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLocation('/calendar')}
          data-testid="button-back-to-calendar"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Volver al calendario
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-orphan-transfers-page-title">
            Transferencias internas sin contraparte
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Una transferencia interna debería tener dos patas (origen y destino). Estas quedaron con una sola, así que el dinero no se ve reflejado en los totales. Reparalas eligiendo la contraparte correcta, convirtiéndolas en un movimiento regular o cancelándolas.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => orphansQuery.refetch()}
          disabled={orphansQuery.isFetching}
          data-testid="button-refresh-orphans"
        >
          <RefreshCw className={`h-4 w-4 mr-1 ${orphansQuery.isFetching ? 'animate-spin' : ''}`} />
          Actualizar
        </Button>
      </div>

      {orphansQuery.isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground" data-testid="status-orphans-loading">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          Buscando transferencias huérfanas…
        </div>
      ) : orphans.length === 0 ? (
        <Card data-testid="card-no-orphans">
          <CardHeader>
            <CardTitle>Todo en orden</CardTitle>
            <CardDescription>No hay transferencias internas sin contraparte. Tus totales son consistentes.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <Alert
            className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400"
            data-testid="alert-orphan-summary"
          >
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle data-testid="text-orphan-summary-title">
              {orphans.length === 1
                ? '1 transferencia huérfana'
                : `${orphans.length} transferencias huérfanas`}
              {hasActiveFilters && (
                <span data-testid="text-orphan-summary-filtered">
                  {' — mostrando '}{visibleOrphans.length}
                </span>
              )}
            </AlertTitle>
            <AlertDescription>
              Revisá cada una y elegí cómo arreglarla. Mientras estén huérfanas, el dinero no figura en cashflow ni en burn rate.
            </AlertDescription>
          </Alert>

          <Card data-testid="card-orphan-filters">
            <CardContent className="pt-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Filter className="h-4 w-4" />
                  Filtros y orden
                </div>
                {hasActiveFilters && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearFilters}
                    className="h-7 text-xs"
                    data-testid="button-clear-filters"
                  >
                    <X className="h-3 w-3 mr-1" /> Limpiar filtros
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs" htmlFor="filter-account">Cuenta</Label>
                  <Select value={filterAccount} onValueChange={setFilterAccount}>
                    <SelectTrigger id="filter-account" className="h-8 mt-1" data-testid="select-filter-account">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todas</SelectItem>
                      {orphanAccountOptions.map(a => (
                        <SelectItem key={a.id} value={a.id} data-testid={`option-filter-account-${a.id}`}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs" htmlFor="filter-currency">Moneda</Label>
                  <Select value={filterCurrency} onValueChange={setFilterCurrency}>
                    <SelectTrigger id="filter-currency" className="h-8 mt-1" data-testid="select-filter-currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todas</SelectItem>
                      {orphanCurrencyOptions.map(ccy => (
                        <SelectItem key={ccy} value={ccy} data-testid={`option-filter-currency-${ccy}`}>
                          {ccy}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs" htmlFor="filter-type">Tipo</Label>
                  <Select value={filterType} onValueChange={(v) => setFilterType(v as typeof filterType)}>
                    <SelectTrigger id="filter-type" className="h-8 mt-1" data-testid="select-filter-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos</SelectItem>
                      <SelectItem value="transfer_in" data-testid="option-filter-type-in">Entrada</SelectItem>
                      <SelectItem value="transfer_out" data-testid="option-filter-type-out">Salida</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs" htmlFor="filter-reason">Motivo</Label>
                  <Select value={filterReason} onValueChange={(v) => setFilterReason(v as typeof filterReason)}>
                    <SelectTrigger id="filter-reason" className="h-8 mt-1" data-testid="select-filter-reason">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos</SelectItem>
                      <SelectItem value="no_pair_id" data-testid="option-filter-reason-no-pair-id">Sin ID de par</SelectItem>
                      <SelectItem value="missing_counterpart_leg" data-testid="option-filter-reason-missing-counterpart">Falta contraparte</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs" htmlFor="filter-date-from">Desde</Label>
                  <Input
                    id="filter-date-from"
                    type="date"
                    className="h-8 mt-1"
                    value={filterDateFrom}
                    onChange={(e) => setFilterDateFrom(e.target.value)}
                    data-testid="input-filter-date-from"
                  />
                </div>
                <div>
                  <Label className="text-xs" htmlFor="filter-date-to">Hasta</Label>
                  <Input
                    id="filter-date-to"
                    type="date"
                    className="h-8 mt-1"
                    value={filterDateTo}
                    onChange={(e) => setFilterDateTo(e.target.value)}
                    data-testid="input-filter-date-to"
                  />
                </div>
                <div>
                  <Label className="text-xs flex items-center gap-1" htmlFor="sort-by">
                    <ArrowUpDown className="h-3 w-3" /> Ordenar por
                  </Label>
                  <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                    <SelectTrigger id="sort-by" className="h-8 mt-1" data-testid="select-sort-by">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="date_desc" data-testid="option-sort-date-desc">Fecha (más nuevas)</SelectItem>
                      <SelectItem value="date_asc" data-testid="option-sort-date-asc">Fecha (más viejas)</SelectItem>
                      <SelectItem value="amount_desc" data-testid="option-sort-amount-desc">Monto (mayor a menor)</SelectItem>
                      <SelectItem value="amount_asc" data-testid="option-sort-amount-asc">Monto (menor a mayor)</SelectItem>
                      <SelectItem value="account_asc" data-testid="option-sort-account-asc">Cuenta (A–Z)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Select-all + bulk action bar */}
          <Card data-testid="card-bulk-toolbar">
            <CardContent className="py-3">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={(v) => toggleAll(v === true)}
                    data-testid="checkbox-select-all"
                  />
                  <span data-testid="text-selection-count">
                    {selectedIds.size === 0
                      ? 'Seleccionar todas'
                      : allSelected
                        ? `Todas seleccionadas (${selectedIds.size})`
                        : `${selectedIds.size} seleccionadas`}
                  </span>
                </label>

                {selectedIds.size > 0 && (
                  <div className="flex flex-wrap gap-2" data-testid="bulk-action-bar">
                    <Button
                      size="sm"
                      variant="default"
                      disabled={!!bulkCreatePairDisabledReason || batchMutation.isPending}
                      title={bulkCreatePairDisabledReason ?? undefined}
                      onClick={() => { setBulkPairAccountId(''); setBulkPairOpen(true); }}
                      data-testid="button-bulk-create-pair"
                    >
                      <Wrench className="h-4 w-4 mr-1" />
                      Crear contraparte ({selectedIds.size})
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={batchMutation.isPending}
                      onClick={() => {
                        // Default new type per-orphan handled server-side, but
                        // we offer a single dropdown for the bulk operation.
                        setBulkConvertType('income');
                        setBulkConvertCategory('');
                        setBulkConvertOpen(true);
                      }}
                      data-testid="button-bulk-convert"
                    >
                      Convertir a regular ({selectedIds.size})
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={batchMutation.isPending}
                      onClick={() => setBulkCancelOpen(true)}
                      data-testid="button-bulk-cancel"
                    >
                      Cancelar ({selectedIds.size})
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={batchMutation.isPending}
                      onClick={() => setSelectedIds(new Set())}
                      data-testid="button-bulk-clear"
                    >
                      Limpiar selección
                    </Button>
                  </div>
                )}
              </div>
              {bulkCreatePairDisabledReason && selectedIds.size > 0 && (
                <p
                  className="text-xs text-amber-600 dark:text-amber-400 mt-2"
                  data-testid="text-bulk-create-pair-warning"
                >
                  {bulkCreatePairDisabledReason}
                </p>
              )}
            </CardContent>
          </Card>

          {visibleOrphans.length === 0 ? (
            <Card data-testid="card-no-orphans-filtered">
              <CardHeader>
                <CardTitle>No hay huérfanas con esos filtros</CardTitle>
                <CardDescription>
                  Probá ajustar los filtros o {' '}
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-foreground"
                    onClick={clearFilters}
                    data-testid="button-clear-filters-empty"
                  >
                    limpiarlos
                  </button>{' '}
                  para ver todas las transferencias huérfanas.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : (
          <div className="space-y-3">
            {visibleOrphans.map(o => (
              <Card key={o.id} data-testid={`card-orphan-${o.id}`}>
                <CardContent className="pt-5">
                  <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <Checkbox
                        className="mt-1"
                        checked={selectedIds.has(o.id)}
                        onCheckedChange={(v) => toggleOne(o.id, v === true)}
                        data-testid={`checkbox-orphan-${o.id}`}
                        aria-label="Seleccionar transferencia"
                      />
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          {o.type === 'transfer_in' ? (
                            <Badge variant="secondary" className="gap-1" data-testid={`badge-type-${o.id}`}>
                              <ArrowDownLeft className="h-3 w-3" /> Entrada
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="gap-1" data-testid={`badge-type-${o.id}`}>
                              <ArrowUpRight className="h-3 w-3" /> Salida
                            </Badge>
                          )}
                          <span className="text-xs text-muted-foreground" data-testid={`text-tx-number-${o.id}`}>
                            {o.transactionNumber || '(sin número)'}
                          </span>
                          <Badge variant="outline" className="text-xs" data-testid={`badge-reason-${o.id}`}>
                            {o.reason === 'no_pair_id' ? 'Sin ID de par' : 'Falta contraparte'}
                          </Badge>
                        </div>
                        <div className="font-semibold" data-testid={`text-amount-${o.id}`}>
                          {fmtAmount(o.amount, o.currency ?? o.accountCurrency)}
                        </div>
                        <div className="text-sm text-muted-foreground" data-testid={`text-account-${o.id}`}>
                          Cuenta: {o.accountName ?? '(eliminada)'}
                        </div>
                        <div className="text-sm text-muted-foreground" data-testid={`text-date-${o.id}`}>
                          {fmtDate(o.imputationDate ?? o.date)}
                        </div>
                        {o.description && (
                          <div className="text-xs text-muted-foreground truncate" data-testid={`text-description-${o.id}`}>
                            {o.description}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="default"
                        onClick={() => { setPairOpenFor(o); setPairAccountId(''); }}
                        data-testid={`button-create-pair-${o.id}`}
                      >
                        <Wrench className="h-4 w-4 mr-1" />
                        Crear contraparte
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setConvertOpenFor(o);
                          setConvertType(o.type === 'transfer_in' ? 'income' : 'expense');
                          setConvertCategory('');
                        }}
                        data-testid={`button-convert-regular-${o.id}`}
                      >
                        Convertir a regular
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setCancelOpenFor(o)}
                        data-testid={`button-cancel-${o.id}`}
                      >
                        Cancelar
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          )}
        </>
      )}

      {/* Create-pair dialog (single) */}
      <Dialog open={!!pairOpenFor} onOpenChange={open => { if (!open) setPairOpenFor(null); }}>
        <DialogContent data-testid="dialog-create-pair">
          <DialogHeader>
            <DialogTitle>Elegí la cuenta de contraparte</DialogTitle>
            <DialogDescription>
              {pairOpenFor && (
                <>Vamos a crear la pata <strong>{pairOpenFor.type === 'transfer_in' ? 'salida' : 'entrada'}</strong> en otra cuenta para
                completar la transferencia. La cuenta debe tener la misma moneda ({pairOpenFor.accountCurrency ?? pairOpenFor.currency ?? 'ARS'}).</>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Select value={pairAccountId} onValueChange={setPairAccountId}>
              <SelectTrigger data-testid="select-counterpart-account">
                <SelectValue placeholder="Seleccioná una cuenta" />
              </SelectTrigger>
              <SelectContent>
                {eligibleCounterparts.length === 0 && (
                  <SelectItem disabled value="__none__">
                    No hay otras cuentas con la misma moneda
                  </SelectItem>
                )}
                {eligibleCounterparts.map(a => (
                  <SelectItem key={a.id} value={a.id} data-testid={`option-counterpart-${a.id}`}>
                    {a.name} ({a.currency})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPairOpenFor(null)} data-testid="button-pair-cancel">Cancelar</Button>
            <Button
              disabled={!pairAccountId || repairMutation.isPending}
              onClick={() => pairOpenFor && repairMutation.mutate({
                id: pairOpenFor.id,
                action: 'create_pair',
                counterpartAccountId: pairAccountId,
              })}
              data-testid="button-pair-confirm"
            >
              {repairMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              Crear contraparte
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Convert-to-regular dialog (single) */}
      <Dialog open={!!convertOpenFor} onOpenChange={open => { if (!open) setConvertOpenFor(null); }}>
        <DialogContent data-testid="dialog-convert-regular">
          <DialogHeader>
            <DialogTitle>Convertir en movimiento regular</DialogTitle>
            <DialogDescription>
              {convertOpenFor && (
                <>Vamos a convertir esta transferencia en un <strong>{convertType === 'income' ? 'ingreso' : 'gasto'}</strong>.
                {((convertOpenFor.type === 'transfer_in' && convertType === 'expense')
                  || (convertOpenFor.type === 'transfer_out' && convertType === 'income')) && (
                  <span className="block mt-2 text-amber-600 dark:text-amber-400">
                    Atención: el saldo de la cuenta se va a invertir porque cambiaste el sentido del movimiento.
                  </span>
                )}</>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-sm font-medium block mb-1">Tipo</label>
              <Select value={convertType} onValueChange={v => setConvertType(v as 'income' | 'expense')}>
                <SelectTrigger data-testid="select-convert-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="income" data-testid="option-convert-income">Ingreso</SelectItem>
                  <SelectItem value="expense" data-testid="option-convert-expense">Gasto</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Categoría (opcional)</label>
              <Select value={convertCategory || '__none__'} onValueChange={v => setConvertCategory(v === '__none__' ? '' : v)}>
                <SelectTrigger data-testid="select-convert-category">
                  <SelectValue placeholder="Categoría por defecto" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Categoría por defecto</SelectItem>
                  <SelectItem value="Otros ingresos">Otros ingresos</SelectItem>
                  <SelectItem value="Otros gastos">Otros gastos</SelectItem>
                  <SelectItem value="Servicios">Servicios</SelectItem>
                  <SelectItem value="Sueldos">Sueldos</SelectItem>
                  <SelectItem value="Ventas">Ventas</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConvertOpenFor(null)} data-testid="button-convert-cancel">Cancelar</Button>
            <Button
              disabled={repairMutation.isPending}
              onClick={() => convertOpenFor && repairMutation.mutate({
                id: convertOpenFor.id,
                action: 'convert_to_regular',
                regularType: convertType,
                regularCategory: convertCategory || undefined,
              })}
              data-testid="button-convert-confirm"
            >
              {repairMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              Convertir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel confirmation (single) */}
      <AlertDialog open={!!cancelOpenFor} onOpenChange={open => { if (!open) setCancelOpenFor(null); }}>
        <AlertDialogContent data-testid="dialog-cancel-orphan">
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar transferencia huérfana</AlertDialogTitle>
            <AlertDialogDescription>
              Esto va a marcar la transferencia como cancelada y revertir el saldo de la cuenta. Queda un registro de cancelación visible en la auditoría. ¿Continuamos?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-orphan-cancel">Volver</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => cancelOpenFor && repairMutation.mutate({ id: cancelOpenFor.id, action: 'cancel' })}
              data-testid="button-cancel-orphan-confirm"
            >
              {repairMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              Cancelar transferencia
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk: create-pair dialog */}
      <Dialog open={bulkPairOpen} onOpenChange={open => { if (!open) setBulkPairOpen(false); }}>
        <DialogContent data-testid="dialog-bulk-create-pair">
          <DialogHeader>
            <DialogTitle>Crear contraparte para {selectedIds.size} transferencias</DialogTitle>
            <DialogDescription>
              Vamos a crear la pata faltante para cada una en la cuenta que elijas. La cuenta debe tener la misma
              moneda ({selectedCurrency ?? '—'}) y no puede ser una de las cuentas de origen.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Select value={bulkPairAccountId} onValueChange={setBulkPairAccountId}>
              <SelectTrigger data-testid="select-bulk-counterpart-account">
                <SelectValue placeholder="Seleccioná una cuenta" />
              </SelectTrigger>
              <SelectContent>
                {bulkEligibleCounterparts.length === 0 && (
                  <SelectItem disabled value="__none__">
                    No hay otras cuentas con la misma moneda disponibles
                  </SelectItem>
                )}
                {bulkEligibleCounterparts.map(a => (
                  <SelectItem key={a.id} value={a.id} data-testid={`option-bulk-counterpart-${a.id}`}>
                    {a.name} ({a.currency})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkPairOpen(false)} data-testid="button-bulk-pair-cancel">Cancelar</Button>
            <Button
              disabled={!bulkPairAccountId || batchMutation.isPending}
              onClick={() => batchMutation.mutate({ action: 'create_pair', counterpartAccountId: bulkPairAccountId })}
              data-testid="button-bulk-pair-confirm"
            >
              {batchMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              Crear contrapartes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk: convert-to-regular dialog */}
      <Dialog open={bulkConvertOpen} onOpenChange={open => { if (!open) setBulkConvertOpen(false); }}>
        <DialogContent data-testid="dialog-bulk-convert">
          <DialogHeader>
            <DialogTitle>Convertir {selectedIds.size} transferencias en regulares</DialogTitle>
            <DialogDescription>
              Vamos a convertir cada una en un <strong>{bulkConvertType === 'income' ? 'ingreso' : 'gasto'}</strong>.
              Para las que no coincidan con su sentido natural, el saldo de la cuenta se ajusta automáticamente.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-sm font-medium block mb-1">Tipo</label>
              <Select value={bulkConvertType} onValueChange={v => setBulkConvertType(v as 'income' | 'expense')}>
                <SelectTrigger data-testid="select-bulk-convert-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="income" data-testid="option-bulk-convert-income">Ingreso</SelectItem>
                  <SelectItem value="expense" data-testid="option-bulk-convert-expense">Gasto</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Categoría (opcional)</label>
              <Select value={bulkConvertCategory || '__none__'} onValueChange={v => setBulkConvertCategory(v === '__none__' ? '' : v)}>
                <SelectTrigger data-testid="select-bulk-convert-category">
                  <SelectValue placeholder="Categoría por defecto" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Categoría por defecto</SelectItem>
                  <SelectItem value="Otros ingresos">Otros ingresos</SelectItem>
                  <SelectItem value="Otros gastos">Otros gastos</SelectItem>
                  <SelectItem value="Servicios">Servicios</SelectItem>
                  <SelectItem value="Sueldos">Sueldos</SelectItem>
                  <SelectItem value="Ventas">Ventas</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkConvertOpen(false)} data-testid="button-bulk-convert-cancel">Cancelar</Button>
            <Button
              disabled={batchMutation.isPending}
              onClick={() => batchMutation.mutate({
                action: 'convert_to_regular',
                regularType: bulkConvertType,
                regularCategory: bulkConvertCategory || undefined,
              })}
              data-testid="button-bulk-convert-confirm"
            >
              {batchMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              Convertir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk: cancel confirmation */}
      <AlertDialog open={bulkCancelOpen} onOpenChange={open => { if (!open) setBulkCancelOpen(false); }}>
        <AlertDialogContent data-testid="dialog-bulk-cancel">
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar {selectedIds.size} transferencias huérfanas</AlertDialogTitle>
            <AlertDialogDescription>
              Vamos a marcar todas las seleccionadas como canceladas y a revertir el saldo de las cuentas
              correspondientes. Cada cancelación queda en la auditoría. ¿Continuamos?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-bulk-cancel-cancel">Volver</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => batchMutation.mutate({ action: 'cancel' })}
              data-testid="button-bulk-cancel-confirm"
            >
              {batchMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              Cancelar transferencias
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
