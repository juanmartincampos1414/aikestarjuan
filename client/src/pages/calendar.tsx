import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { useOrganization } from '@/lib/hooks';
import type { Organization } from '@shared/schema';
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, startOfYear, endOfYear, addMonths, subMonths, addWeeks, subWeeks, addYears, subYears, isSameDay, isSameMonth, eachDayOfInterval, getDay } from 'date-fns';
import { es } from 'date-fns/locale';

// Server day keys arrive as "YYYY-MM-DD" / month keys as "YYYY-MM" — both
// already bucketed in Argentina time. `new Date("YYYY-MM-DD")` parses as UTC
// midnight, which renders as the previous day in any UTC-3 (or earlier)
// browser. Construct a local Date at noon to side-step DST/TZ rounding for
// purely-presentational labels.
const argDayKeyToLocalDate = (dayKey: string): Date => {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0, 0);
};
const argMonthKeyToLocalDate = (monthKey: string): Date => {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, (m || 1) - 1, 1, 12, 0, 0, 0);
};
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ChevronLeft, ChevronRight, TrendingUp, TrendingDown, Clock, CreditCard, CalendarDays, ArrowUpRight, ArrowDownLeft, ExternalLink, Timer, AlertCircle, AlertTriangle, ArrowLeftRight } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { normalizeAmountInput } from '@/lib/currency';

type ViewMode = 'day' | 'week' | 'month' | 'year';

interface CalendarTransaction {
  id: string;
  type: 'income' | 'expense' | 'receivable' | 'payable' | 'transfer_in' | 'transfer_out';
  amount: string;
  currency?: string | null;
  description: string;
  category: string;
  date: string;
  transactionNumber?: string;
  status: string;
  account?: {
    id: string;
    name: string;
    currency: string;
  } | null;
  transferCounterpart?: {
    accountId: string | null;
    account: {
      id: string;
      name: string;
      currency: string;
    } | null;
  } | null;
}

interface DayGroup {
  date: string;
  transactions: CalendarTransaction[];
  totalIncomeARS: number;
  totalIncomeUSD: number;
  totalExpenseARS: number;
  totalExpenseUSD: number;
  totalReceivableARS: number;
  totalReceivableUSD: number;
  totalPayableARS: number;
  totalPayableUSD: number;
  pendingIncomeARS: number;
  pendingIncomeUSD: number;
  pendingExpenseARS: number;
  pendingExpenseUSD: number;
  pendingReceivableARS: number;
  pendingReceivableUSD: number;
  pendingPayableARS: number;
  pendingPayableUSD: number;
  count: number;
  pendingCount: number;
  cancelledCount: number;
  transferCount: number;
  hasPending: boolean;
}

interface MonthGroup {
  month: string;
  totalIncomeARS: number;
  totalIncomeUSD: number;
  totalExpenseARS: number;
  totalExpenseUSD: number;
  totalReceivableARS: number;
  totalReceivableUSD: number;
  totalPayableARS: number;
  totalPayableUSD: number;
  pendingReceivableARS: number;
  pendingReceivableUSD: number;
  pendingPayableARS: number;
  pendingPayableUSD: number;
  count: number;
  pendingCount: number;
  transferCount: number;
  hasPending: boolean;
}

const formatCurrency = (amount: number, currency: string = 'ARS') => {
  const isUSD = currency === 'USD' || currency.startsWith('USD');
  const symbol = isUSD ? 'US$' : 'AR$';
  const formatted = amount.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return `${symbol} ${formatted}`;
};

const typeLabels: Record<string, string> = {
  income: 'Ingreso',
  expense: 'Egreso',
  receivable: 'Por Cobrar',
  payable: 'Por Pagar',
  transfer_in: 'Transferencia',
  transfer_out: 'Transferencia',
};

const typeColors: Record<string, string> = {
  income: 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  expense: 'bg-red-500/20 text-red-600 dark:text-red-400 border-red-500/30',
  receivable: 'bg-cyan-500/20 text-cyan-600 dark:text-cyan-400 border-cyan-500/30',
  payable: 'bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30',
  transfer_in: 'bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30',
  transfer_out: 'bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30',
};

const isTransferType = (t: string) => t === 'transfer_in' || t === 'transfer_out';

export default function CalendarPage() {
  const [, setLocation] = useLocation();
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDay, setSelectedDay] = useState<DayGroup | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const { data: organization } = useOrganization() as { data: Organization | undefined };
  const primaryCurrency = organization?.defaultCurrency === 'USD' ? 'USD' : 'ARS';

  const handleTransactionClick = (transactionId: string) => {
    setLocation(`/transactions?id=${transactionId}`);
  };

  const dateRange = useMemo(() => {
    switch (viewMode) {
      case 'day': {
        const dayStart = new Date(currentDate);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(currentDate);
        dayEnd.setHours(23, 59, 59, 999);
        return { start: dayStart, end: dayEnd };
      }
      case 'week':
        return {
          start: startOfWeek(currentDate, { weekStartsOn: 1 }),
          end: endOfWeek(currentDate, { weekStartsOn: 1 }),
        };
      case 'month':
        return {
          start: startOfMonth(currentDate),
          end: endOfMonth(currentDate),
        };
      case 'year':
        return {
          start: startOfYear(currentDate),
          end: endOfYear(currentDate),
        };
    }
  }, [viewMode, currentDate]);

  const { data: calendarData, isLoading } = useQuery({
    queryKey: ['calendar', dateRange.start.toISOString(), dateRange.end.toISOString(), viewMode === 'year' ? 'month' : 'day'],
    queryFn: async () => {
      const groupBy = viewMode === 'year' ? 'month' : 'day';
      const res = await fetch(
        `/api/transactions/calendar?startDate=${dateRange.start.toISOString()}&endDate=${dateRange.end.toISOString()}&groupBy=${groupBy}&includeCancelled=1`,
        { credentials: 'include' }
      );
      if (!res.ok) throw new Error('Error al cargar datos');
      return res.json();
    },
  });

  const navigate = (direction: 'prev' | 'next') => {
    switch (viewMode) {
      case 'day':
        setCurrentDate(prev => direction === 'next' 
          ? new Date(prev.getTime() + 86400000) 
          : new Date(prev.getTime() - 86400000));
        break;
      case 'week':
        setCurrentDate(prev => direction === 'next' ? addWeeks(prev, 1) : subWeeks(prev, 1));
        break;
      case 'month':
        setCurrentDate(prev => direction === 'next' ? addMonths(prev, 1) : subMonths(prev, 1));
        break;
      case 'year':
        setCurrentDate(prev => direction === 'next' ? addYears(prev, 1) : subYears(prev, 1));
        break;
    }
  };

  const goToToday = () => setCurrentDate(new Date());

  const getDateLabel = () => {
    switch (viewMode) {
      case 'day':
        return format(currentDate, "EEEE d 'de' MMMM yyyy", { locale: es });
      case 'week':
        return `Semana del ${format(dateRange.start, "d 'de' MMMM", { locale: es })} al ${format(dateRange.end, "d 'de' MMMM yyyy", { locale: es })}`;
      case 'month':
        return format(currentDate, "MMMM yyyy", { locale: es });
      case 'year':
        return format(currentDate, "yyyy", { locale: es });
    }
  };

  const dayGroups = useMemo(() => {
    if (!calendarData?.groupedByDay) return new Map<string, DayGroup>();
    const map = new Map<string, DayGroup>();
    calendarData.groupedByDay.forEach((day: DayGroup) => {
      map.set(day.date, day);
    });
    return map;
  }, [calendarData]);

  const orphanTransferCount: number = calendarData?.summary?.orphanTransfers ?? 0;
  const orphanTransferIds = useMemo<Set<string>>(() => {
    const ids: string[] = calendarData?.summary?.orphanTransferIds ?? [];
    return new Set(ids);
  }, [calendarData]);
  const isOrphanTransfer = (tx: CalendarTransaction) =>
    isTransferType(tx.type) && orphanTransferIds.has(tx.id);

  const calendarDays = useMemo(() => {
    if (viewMode !== 'month') return [];
    const monthStart = startOfMonth(currentDate);
    const monthEnd = endOfMonth(currentDate);
    const calendarStart = startOfWeek(monthStart, { weekStartsOn: 1 });
    const calendarEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
    return eachDayOfInterval({ start: calendarStart, end: calendarEnd });
  }, [currentDate, viewMode]);

  const weekDays = useMemo(() => {
    if (viewMode !== 'week') return [];
    return eachDayOfInterval({ start: dateRange.start, end: dateRange.end });
  }, [dateRange, viewMode]);

  const handleDayClick = (day: DayGroup) => {
    setSelectedDay(day);
    setIsDetailOpen(true);
  };

  const renderMonthView = () => (
    <div className="grid grid-cols-7 gap-1">
      {['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map(day => (
        <div key={day} className="text-center text-xs font-medium text-muted-foreground py-2">
          {day}
        </div>
      ))}
      {calendarDays.map(day => {
        const dateKey = format(day, 'yyyy-MM-dd');
        const dayData = dayGroups.get(dateKey);
        const isCurrentMonth = isSameMonth(day, currentDate);
        const isToday = isSameDay(day, new Date());
        
        return (
          <div
            key={dateKey}
            onClick={() => dayData && handleDayClick(dayData)}
            className={`
              min-h-[80px] p-1 rounded-lg border transition-all relative
              ${isCurrentMonth ? 'bg-card' : 'bg-muted/30 opacity-50'}
              ${isToday ? 'ring-2 ring-primary' : 'border-border/50'}
              ${dayData?.hasPending ? 'border-dashed border-orange-400/50' : ''}
              ${dayData ? 'cursor-pointer hover:bg-accent/50' : ''}
            `}
            data-testid={`calendar-day-${dateKey}`}
          >
            <div className="flex items-center justify-between mb-1">
              <span className={`text-xs font-medium ${isToday ? 'text-primary' : 'text-foreground'}`}>
                {format(day, 'd')}
              </span>
              {dayData?.hasPending && (
                <Timer className="h-3 w-3 text-orange-600 dark:text-orange-400" />
              )}
            </div>
            {dayData && (
              <div className="space-y-0.5">
                {(dayData.totalIncomeARS > 0 || dayData.totalIncomeUSD > 0) && (
                  <div className="text-[10px] text-emerald-600 dark:text-emerald-400 truncate flex items-center gap-0.5">
                    <ArrowUpRight className="h-2.5 w-2.5" />
                    {dayData.totalIncomeARS > 0 && <span>AR${formatCompact(dayData.totalIncomeARS)}</span>}
                    {dayData.totalIncomeUSD > 0 && <span className="text-emerald-700 dark:text-emerald-300 ml-1">US${formatCompact(dayData.totalIncomeUSD)}</span>}
                  </div>
                )}
                {(dayData.totalExpenseARS > 0 || dayData.totalExpenseUSD > 0) && (
                  <div className="text-[10px] text-red-600 dark:text-red-400 truncate flex items-center gap-0.5">
                    <ArrowDownLeft className="h-2.5 w-2.5" />
                    {dayData.totalExpenseARS > 0 && <span>AR${formatCompact(dayData.totalExpenseARS)}</span>}
                    {dayData.totalExpenseUSD > 0 && <span className="text-red-700 dark:text-red-300 ml-1">US${formatCompact(dayData.totalExpenseUSD)}</span>}
                  </div>
                )}
                <div className="flex items-center gap-1">
                  {(dayData.count - dayData.pendingCount) > 0 && (
                    <Badge variant="secondary" className="text-[9px] px-1 py-0">
                      {dayData.count - dayData.pendingCount} ✓
                    </Badge>
                  )}
                  {dayData.pendingCount > 0 && (
                    <Badge className="text-[9px] px-1 py-0 bg-orange-500/20 text-orange-600 dark:text-orange-400 border-orange-500/30">
                      {dayData.pendingCount} ⏳
                    </Badge>
                  )}
                  {dayData.transferCount > 0 && (
                    <Badge
                      className="text-[9px] px-1 py-0 bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30"
                      data-testid={`badge-transfers-${dateKey}`}
                      title={`${dayData.transferCount} transferencia${dayData.transferCount === 1 ? '' : 's'}`}
                    >
                      <ArrowLeftRight className="h-2 w-2 mr-0.5" />
                      {dayData.transferCount}
                    </Badge>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const formatCompact = (amount: number) => {
    if (amount >= 1000000) return `${(amount / 1000000).toFixed(1)}M`;
    if (amount >= 1000) return `${(amount / 1000).toFixed(0)}k`;
    return amount.toFixed(0);
  };

  const renderWeekView = () => (
    <div className="grid grid-cols-7 gap-1 sm:gap-2">
      {weekDays.map(day => {
        const dateKey = format(day, 'yyyy-MM-dd');
        const dayData = dayGroups.get(dateKey);
        const isToday = isSameDay(day, new Date());
        
        return (
          <Card
            key={dateKey}
            onClick={() => dayData && handleDayClick(dayData)}
            className={`
              min-h-[160px] transition-all p-2
              ${isToday ? 'ring-2 ring-primary' : ''}
              ${dayData?.hasPending ? 'border-dashed border-orange-400/50' : ''}
              ${dayData ? 'cursor-pointer hover:bg-accent/30' : ''}
            `}
            data-testid={`calendar-week-day-${dateKey}`}
          >
            <div className="text-center mb-2">
              <div className="text-[10px] sm:text-xs font-medium text-muted-foreground capitalize flex items-center justify-center gap-1">
                {format(day, 'EEE', { locale: es })}
                {dayData?.hasPending && <Timer className="h-3 w-3 text-orange-600 dark:text-orange-400" />}
              </div>
              <div className={`text-lg font-bold ${isToday ? 'text-primary' : ''}`}>
                {format(day, 'd')}
              </div>
            </div>
            <div className="space-y-1">
              {dayData ? (
                <>
                  {(dayData.totalIncomeARS > 0 || dayData.totalIncomeUSD > 0) && (
                    <div className="text-center">
                      <div className="text-[9px] text-emerald-600/70 dark:text-emerald-400/70">Ing</div>
                      <div className="text-[10px] sm:text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                        {dayData.totalIncomeARS > 0 && <span>AR${formatCompact(dayData.totalIncomeARS)}</span>}
                        {dayData.totalIncomeUSD > 0 && <span className="text-emerald-700 dark:text-emerald-300 ml-1">US${formatCompact(dayData.totalIncomeUSD)}</span>}
                      </div>
                    </div>
                  )}
                  {(dayData.totalExpenseARS > 0 || dayData.totalExpenseUSD > 0) && (
                    <div className="text-center">
                      <div className="text-[9px] text-red-600/70 dark:text-red-400/70">Egr</div>
                      <div className="text-[10px] sm:text-xs font-semibold text-red-600 dark:text-red-400">
                        {dayData.totalExpenseARS > 0 && <span>AR${formatCompact(dayData.totalExpenseARS)}</span>}
                        {dayData.totalExpenseUSD > 0 && <span className="text-red-700 dark:text-red-300 ml-1">US${formatCompact(dayData.totalExpenseUSD)}</span>}
                      </div>
                    </div>
                  )}
                  {(dayData.totalReceivableARS > 0 || dayData.totalReceivableUSD > 0) && (
                    <div className="text-center">
                      <div className="text-[9px] text-cyan-600/70 dark:text-cyan-400/70">x Cob</div>
                      <div className="text-[10px] sm:text-xs font-semibold text-cyan-600 dark:text-cyan-400">
                        {dayData.totalReceivableARS > 0 && <span>AR${formatCompact(dayData.totalReceivableARS)}</span>}
                        {dayData.totalReceivableUSD > 0 && <span className="text-cyan-700 dark:text-cyan-300 ml-1">US${formatCompact(dayData.totalReceivableUSD)}</span>}
                      </div>
                    </div>
                  )}
                  {(dayData.totalPayableARS > 0 || dayData.totalPayableUSD > 0) && (
                    <div className="text-center">
                      <div className="text-[9px] text-amber-600/70 dark:text-amber-400/70">x Pag</div>
                      <div className="text-[10px] sm:text-xs font-semibold text-amber-600 dark:text-amber-400">
                        {dayData.totalPayableARS > 0 && <span>AR${formatCompact(dayData.totalPayableARS)}</span>}
                        {dayData.totalPayableUSD > 0 && <span className="text-amber-700 dark:text-amber-300 ml-1">US${formatCompact(dayData.totalPayableUSD)}</span>}
                      </div>
                    </div>
                  )}
                  <div className="text-[9px] text-center pt-1 flex justify-center items-center gap-1">
                    {(dayData.count - dayData.pendingCount) > 0 && (
                      <span className="text-muted-foreground">{dayData.count - dayData.pendingCount} ✓</span>
                    )}
                    {dayData.pendingCount > 0 && (
                      <span className="text-orange-600 dark:text-orange-400">{dayData.pendingCount} ⏳</span>
                    )}
                    {dayData.transferCount > 0 && (
                      <Badge
                        className="text-[9px] px-1 py-0 bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30"
                        data-testid={`badge-week-transfers-${dateKey}`}
                        title={`${dayData.transferCount} transferencia${dayData.transferCount === 1 ? '' : 's'}`}
                      >
                        <ArrowLeftRight className="h-2 w-2 mr-0.5" />
                        {dayData.transferCount}
                      </Badge>
                    )}
                  </div>
                </>
              ) : (
                <div className="text-[10px] text-center text-muted-foreground pt-4">
                  Sin mov.
                </div>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );

  const renderDayView = () => {
    const dateKey = format(currentDate, 'yyyy-MM-dd');
    const dayData = dayGroups.get(dateKey);
    
    if (!dayData) {
      return (
        <Card className="p-8 text-center">
          <CalendarDays className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">No hay movimientos para este día</p>
        </Card>
      );
    }

    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
          <Card className="p-3 sm:p-4">
            <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 mb-1 sm:mb-2">
              <TrendingUp className="h-4 w-4 flex-shrink-0" />
              <span className="text-xs sm:text-sm">Ingresos</span>
            </div>
            <div className="text-base sm:text-xl font-bold">
              {dayData.totalIncomeARS > 0 && <span>AR${formatCompact(dayData.totalIncomeARS)}</span>}
              {dayData.totalIncomeUSD > 0 && <span className="text-emerald-700 dark:text-emerald-300 ml-2">US${formatCompact(dayData.totalIncomeUSD)}</span>}
              {dayData.totalIncomeARS === 0 && dayData.totalIncomeUSD === 0 && <span>AR$0</span>}
            </div>
          </Card>
          <Card className="p-3 sm:p-4">
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400 mb-1 sm:mb-2">
              <TrendingDown className="h-4 w-4 flex-shrink-0" />
              <span className="text-xs sm:text-sm">Egresos</span>
            </div>
            <div className="text-base sm:text-xl font-bold">
              {dayData.totalExpenseARS > 0 && <span>AR${formatCompact(dayData.totalExpenseARS)}</span>}
              {dayData.totalExpenseUSD > 0 && <span className="text-red-700 dark:text-red-300 ml-2">US${formatCompact(dayData.totalExpenseUSD)}</span>}
              {dayData.totalExpenseARS === 0 && dayData.totalExpenseUSD === 0 && <span>AR$0</span>}
            </div>
          </Card>
          <Card className="p-3 sm:p-4">
            <div className="flex items-center gap-2 text-cyan-600 dark:text-cyan-400 mb-1 sm:mb-2">
              <Clock className="h-4 w-4 flex-shrink-0" />
              <span className="text-xs sm:text-sm">Por Cobrar</span>
            </div>
            <div className="text-base sm:text-xl font-bold">
              {dayData.totalReceivableARS > 0 && <span>AR${formatCompact(dayData.totalReceivableARS)}</span>}
              {dayData.totalReceivableUSD > 0 && <span className="text-cyan-700 dark:text-cyan-300 ml-2">US${formatCompact(dayData.totalReceivableUSD)}</span>}
              {dayData.totalReceivableARS === 0 && dayData.totalReceivableUSD === 0 && <span>AR$0</span>}
            </div>
          </Card>
          <Card className="p-3 sm:p-4">
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 mb-1 sm:mb-2">
              <CreditCard className="h-4 w-4 flex-shrink-0" />
              <span className="text-xs sm:text-sm">Por Pagar</span>
            </div>
            <div className="text-base sm:text-xl font-bold">
              {dayData.totalPayableARS > 0 && <span>AR${formatCompact(dayData.totalPayableARS)}</span>}
              {dayData.totalPayableUSD > 0 && <span className="text-amber-700 dark:text-amber-300 ml-2">US${formatCompact(dayData.totalPayableUSD)}</span>}
              {dayData.totalPayableARS === 0 && dayData.totalPayableUSD === 0 && <span>AR$0</span>}
            </div>
          </Card>
        </div>
        
        <Card className={dayData.hasPending ? 'border-dashed border-orange-400/50' : ''}>
          <CardHeader className="pb-2 sm:pb-4">
            <CardTitle className="text-base sm:text-lg flex items-center gap-2">
              Movimientos del día
              <span className="text-muted-foreground font-normal">
                ({dayData.count - dayData.pendingCount} completados{dayData.pendingCount > 0 && `, ${dayData.pendingCount} pendientes`}{dayData.transferCount > 0 && `, ${dayData.transferCount} transferencia${dayData.transferCount === 1 ? '' : 's'}`})
              </span>
              {dayData.hasPending && <Timer className="h-4 w-4 text-orange-600 dark:text-orange-400" />}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {dayData.transactions.map(tx => {
                const isPending = tx.status === 'scheduled';
                const isCancelled = tx.status === 'cancelled';
                const isTransfer = isTransferType(tx.type);
                const isOrphan = isOrphanTransfer(tx);
                const counterpartName = tx.transferCounterpart?.account?.name;
                const originName = tx.account?.name || 'Sin cuenta';
                const transferAccountsLabel = isTransfer
                  ? (tx.type === 'transfer_out'
                      ? `${originName}${counterpartName ? ` → ${counterpartName}` : ''}`
                      : `${counterpartName ? `${counterpartName} → ` : ''}${originName}`)
                  : null;
                return (
                  <div
                    key={tx.id}
                    className={`flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 rounded-lg transition-colors gap-2 cursor-pointer ${
                      isOrphan
                        ? 'bg-amber-500/10 border border-dashed border-amber-500/50 hover:bg-amber-500/15'
                        : isCancelled
                          ? 'bg-muted/20 border border-dashed border-muted-foreground/30 hover:bg-muted/30 opacity-60'
                          : isPending
                            ? 'bg-orange-500/10 border border-dashed border-orange-400/40 hover:bg-orange-500/15'
                            : isTransfer
                              ? 'bg-blue-500/5 border border-dashed border-blue-400/30 hover:bg-blue-500/10'
                              : 'bg-muted/30 hover:bg-muted/50'
                    }`}
                    data-testid={`transaction-${tx.id}`}
                    onClick={() => handleTransactionClick(tx.id)}
                  >
                    <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                      <div className="flex flex-col gap-1 flex-shrink-0">
                        <Badge className={`${typeColors[tx.type]} text-[10px] sm:text-xs`} data-testid={`badge-type-${tx.id}`}>
                          {typeLabels[tx.type]}
                        </Badge>
                        {isPending && (
                          <Badge className="bg-orange-500/20 text-orange-600 dark:text-orange-400 border-orange-500/30 text-[9px]">
                            <Timer className="h-2.5 w-2.5 mr-1" />
                            Programado
                          </Badge>
                        )}
                        {isCancelled && (
                          <Badge variant="outline" className="text-[9px] text-muted-foreground border-muted-foreground/40">
                            Cancelado
                          </Badge>
                        )}
                        {isOrphan && (
                          <Badge
                            className="bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-500/40 text-[9px]"
                            title="Esta transferencia interna no tiene contraparte"
                            data-testid={`badge-orphan-${tx.id}`}
                          >
                            <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                            Sin contraparte
                          </Badge>
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className={`font-medium text-sm sm:text-base truncate ${isCancelled ? 'line-through text-muted-foreground' : ''}`}>{tx.description}</p>
                        <p className="text-[10px] sm:text-xs text-muted-foreground truncate" data-testid={`text-meta-${tx.id}`}>
                          {isTransfer ? transferAccountsLabel : `${tx.category} • ${originName}`}
                        </p>
                      </div>
                    </div>
                    <div className="text-right sm:text-right pl-8 sm:pl-0 flex-shrink-0">
                      <p className={`font-semibold text-sm sm:text-base ${
                        isCancelled
                          ? 'text-muted-foreground line-through'
                          : isPending
                            ? 'text-orange-600 dark:text-orange-400'
                            : isTransfer
                              ? 'text-blue-600 dark:text-blue-400'
                              : tx.type === 'income' || tx.type === 'receivable'
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-red-600 dark:text-red-400'
                      }`}>
                        {isTransfer
                          ? formatCurrency(normalizeAmountInput(tx.amount), tx.currency || tx.account?.currency)
                          : `${tx.type === 'income' || tx.type === 'receivable' ? '+' : '-'}${formatCurrency(normalizeAmountInput(tx.amount), tx.currency || tx.account?.currency)}`}
                      </p>
                      {tx.transactionNumber && (
                        <p className="text-[10px] sm:text-xs text-muted-foreground">{tx.transactionNumber}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  };

  const renderYearView = () => {
    if (!calendarData?.groupedByMonth) return null;
    
    const chartDataARS = calendarData.groupedByMonth.map((m: MonthGroup) => ({
      name: format(argMonthKeyToLocalDate(m.month), 'MMM', { locale: es }),
      ingresos: m.totalIncomeARS,
      egresos: m.totalExpenseARS,
    }));
    const chartDataUSD = calendarData.groupedByMonth.map((m: MonthGroup) => ({
      name: format(argMonthKeyToLocalDate(m.month), 'MMM', { locale: es }),
      ingresos: m.totalIncomeUSD,
      egresos: m.totalExpenseUSD,
    }));
    const hasUSDActivity = calendarData.groupedByMonth.some(
      (m: MonthGroup) => m.totalIncomeUSD > 0 || m.totalExpenseUSD > 0,
    );
    const hasARSActivity = calendarData.groupedByMonth.some(
      (m: MonthGroup) => m.totalIncomeARS > 0 || m.totalExpenseARS > 0,
    );

    const summaryIncomeARS = calendarData.summary?.totalIncomeARS || 0;
    const summaryIncomeUSD = calendarData.summary?.totalIncomeUSD || 0;
    const summaryExpenseARS = calendarData.summary?.totalExpenseARS || 0;
    const summaryExpenseUSD = calendarData.summary?.totalExpenseUSD || 0;
    const summaryReceivableARS = calendarData.summary?.totalReceivableARS || 0;
    const summaryReceivableUSD = calendarData.summary?.totalReceivableUSD || 0;
    const summaryPayableARS = calendarData.summary?.totalPayableARS || 0;
    const summaryPayableUSD = calendarData.summary?.totalPayableUSD || 0;

    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
          <Card className="p-3 sm:p-4">
            <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 mb-1 sm:mb-2">
              <TrendingUp className="h-4 w-4 flex-shrink-0" />
              <span className="text-xs sm:text-sm">Ingresos</span>
            </div>
            <div className="text-base sm:text-xl font-bold">
              {summaryIncomeARS > 0 && <span>AR${formatCompact(summaryIncomeARS)}</span>}
              {summaryIncomeUSD > 0 && <span className="text-emerald-700 dark:text-emerald-300 ml-2">US${formatCompact(summaryIncomeUSD)}</span>}
              {summaryIncomeARS === 0 && summaryIncomeUSD === 0 && <span>AR$0</span>}
            </div>
          </Card>
          <Card className="p-3 sm:p-4">
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400 mb-1 sm:mb-2">
              <TrendingDown className="h-4 w-4 flex-shrink-0" />
              <span className="text-xs sm:text-sm">Egresos</span>
            </div>
            <div className="text-base sm:text-xl font-bold">
              {summaryExpenseARS > 0 && <span>AR${formatCompact(summaryExpenseARS)}</span>}
              {summaryExpenseUSD > 0 && <span className="text-red-700 dark:text-red-300 ml-2">US${formatCompact(summaryExpenseUSD)}</span>}
              {summaryExpenseARS === 0 && summaryExpenseUSD === 0 && <span>AR$0</span>}
            </div>
          </Card>
          <Card className="p-3 sm:p-4">
            <div className="flex items-center gap-2 text-cyan-600 dark:text-cyan-400 mb-1 sm:mb-2">
              <Clock className="h-4 w-4 flex-shrink-0" />
              <span className="text-xs sm:text-sm">Por Cobrar</span>
            </div>
            <div className="text-base sm:text-xl font-bold">
              {summaryReceivableARS > 0 && <span className="text-cyan-600 dark:text-cyan-400">AR${formatCompact(summaryReceivableARS)}</span>}
              {summaryReceivableUSD > 0 && <span className="text-cyan-700 dark:text-cyan-300 ml-2">US${formatCompact(summaryReceivableUSD)}</span>}
              {summaryReceivableARS === 0 && summaryReceivableUSD === 0 && <span className="text-cyan-600 dark:text-cyan-400">AR$0</span>}
            </div>
          </Card>
          <Card className="p-3 sm:p-4">
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 mb-1 sm:mb-2">
              <CreditCard className="h-4 w-4 flex-shrink-0" />
              <span className="text-xs sm:text-sm">Por Pagar</span>
            </div>
            <div className="text-base sm:text-xl font-bold">
              {summaryPayableARS > 0 && <span className="text-amber-600 dark:text-amber-400">AR${formatCompact(summaryPayableARS)}</span>}
              {summaryPayableUSD > 0 && <span className="text-amber-700 dark:text-amber-300 ml-2">US${formatCompact(summaryPayableUSD)}</span>}
              {summaryPayableARS === 0 && summaryPayableUSD === 0 && <span className="text-amber-600 dark:text-amber-400">AR$0</span>}
            </div>
          </Card>
        </div>

        {hasARSActivity && (
          <Card className="p-3 sm:p-6">
            <CardHeader className="px-0 pt-0">
              <CardTitle>Movimientos por mes — AR$</CardTitle>
            </CardHeader>
            <div className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartDataARS}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#888" strokeOpacity={0.2} />
                  <XAxis dataKey="name" stroke="currentColor" className="text-muted-foreground" />
                  <YAxis stroke="currentColor" className="text-muted-foreground" tickFormatter={(value) => `${(value / 1000).toFixed(0)}k`} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'hsl(var(--popover, 0 0% 100%))', border: '1px solid hsl(var(--border, 0 0% 90%))', borderRadius: 6 }}
                    formatter={(value: number, name: string) => [`AR$ ${formatCompact(value)}`, name]}
                  />
                  <Legend />
                  <Bar dataKey="ingresos" name="Ingresos" fill="#10b981" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="egresos" name="Egresos" fill="#ef4444" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        )}

        {hasUSDActivity && (
          <Card className="p-3 sm:p-6">
            <CardHeader className="px-0 pt-0">
              <CardTitle>Movimientos por mes — US$</CardTitle>
            </CardHeader>
            <div className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartDataUSD}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#888" strokeOpacity={0.2} />
                  <XAxis dataKey="name" stroke="currentColor" className="text-muted-foreground" />
                  <YAxis stroke="currentColor" className="text-muted-foreground" tickFormatter={(value) => `${value.toFixed(0)}`} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'hsl(var(--popover, 0 0% 100%))', border: '1px solid hsl(var(--border, 0 0% 90%))', borderRadius: 6 }}
                    formatter={(value: number, name: string) => [`US$ ${formatCompact(value)}`, name]}
                  />
                  <Legend />
                  <Bar dataKey="ingresos" name="Ingresos" fill="#059669" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="egresos" name="Egresos" fill="#dc2626" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-4">
          {calendarData.groupedByMonth.map((m: MonthGroup) => (
            <Card key={m.month} className={`p-3 sm:p-4 hover:bg-accent/30 transition-colors cursor-pointer ${m.hasPending ? 'border-dashed border-orange-400/40' : ''}`} data-testid={`month-card-${m.month}`}>
              <h3 className="font-semibold mb-1 sm:mb-2 capitalize text-sm sm:text-base">
                {format(argMonthKeyToLocalDate(m.month), 'MMM', { locale: es })}
              </h3>
              <div className="space-y-0.5 sm:space-y-1 text-[10px] sm:text-xs">
                {(m.totalIncomeARS > 0 || m.totalIncomeUSD > 0) && (
                  <div className="flex justify-between gap-1">
                    <span className="text-emerald-600 dark:text-emerald-400">Ing</span>
                    <div className="text-emerald-600 dark:text-emerald-400 font-medium">
                      {m.totalIncomeARS > 0 && <span>AR${formatCompact(m.totalIncomeARS)}</span>}
                      {m.totalIncomeUSD > 0 && <span className="text-emerald-700 dark:text-emerald-300 ml-1">US${formatCompact(m.totalIncomeUSD)}</span>}
                    </div>
                  </div>
                )}
                {(m.totalExpenseARS > 0 || m.totalExpenseUSD > 0) && (
                  <div className="flex justify-between gap-1">
                    <span className="text-red-600 dark:text-red-400">Egr</span>
                    <div className="text-red-600 dark:text-red-400 font-medium">
                      {m.totalExpenseARS > 0 && <span>AR${formatCompact(m.totalExpenseARS)}</span>}
                      {m.totalExpenseUSD > 0 && <span className="text-red-700 dark:text-red-300 ml-1">US${formatCompact(m.totalExpenseUSD)}</span>}
                    </div>
                  </div>
                )}
                <div className="text-muted-foreground pt-0.5 sm:pt-1 flex items-center gap-1 flex-wrap">
                  {m.count} mov
                  {m.pendingCount > 0 && (
                    <Badge className="bg-orange-500/20 text-orange-600 dark:text-orange-400 border-orange-500/30 text-[9px] px-1">
                      <Timer className="h-2 w-2 mr-0.5" />
                      {m.pendingCount}
                    </Badge>
                  )}
                  {m.transferCount > 0 && (
                    <span
                      className="text-blue-600 dark:text-blue-400 inline-flex items-center gap-0.5"
                      data-testid={`text-month-transfers-${m.month}`}
                      title={`${m.transferCount} transferencia${m.transferCount === 1 ? '' : 's'}`}
                    >
                      <ArrowLeftRight className="h-2.5 w-2.5" />
                      + {m.transferCount} transf.
                    </span>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <CalendarDays className="h-6 w-6 text-primary" />
              Calendario de Movimientos
            </h1>
            <p className="text-muted-foreground">
              Visualizá tus transacciones organizadas por fecha
            </p>
          </div>
          
          <div className="flex items-center gap-2">
            <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
              <TabsList>
                <TabsTrigger value="day" data-testid="view-day">Día</TabsTrigger>
                <TabsTrigger value="week" data-testid="view-week">Semana</TabsTrigger>
                <TabsTrigger value="month" data-testid="view-month">Mes</TabsTrigger>
                <TabsTrigger value="year" data-testid="view-year">Año</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>

        {orphanTransferCount > 0 && (
          <Alert
            className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400"
            data-testid="alert-orphan-transfers"
          >
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle data-testid="text-orphan-transfers-title">
              {orphanTransferCount === 1
                ? 'Hay 1 transferencia interna sin contraparte'
                : `Hay ${orphanTransferCount} transferencias internas sin contraparte`}
            </AlertTitle>
            <AlertDescription className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-sm" data-testid="text-orphan-transfers-description">
                Una transferencia interna debería tener dos patas (origen y destino). Estas quedaron con una sola, así que el dinero no se ve reflejado en los totales. Revisalas y corregilas o borralas.
              </span>
              <Button
                variant="outline"
                size="sm"
                className="border-amber-500/50 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300 self-start sm:self-auto"
                onClick={() => setLocation('/orphan-transfers')}
                data-testid="button-review-orphan-transfers"
              >
                Revisar transferencias
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <Button variant="outline" size="icon" onClick={() => navigate('prev')} data-testid="nav-prev">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            
            <div className="text-center">
              <h2 className="text-lg font-semibold capitalize">{getDateLabel()}</h2>
              <Button variant="ghost" size="sm" onClick={goToToday} data-testid="go-today">
                Hoy
              </Button>
            </div>
            
            <Button variant="outline" size="icon" onClick={() => navigate('next')} data-testid="nav-next">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </Card>

        {isLoading ? (
          <Card className="p-8 text-center">
            <div className="animate-pulse">Cargando datos...</div>
          </Card>
        ) : (
          <>
            {viewMode === 'month' && renderMonthView()}
            {viewMode === 'week' && renderWeekView()}
            {viewMode === 'day' && renderDayView()}
            {viewMode === 'year' && renderYearView()}
          </>
        )}

        {calendarData?.summary && viewMode !== 'year' && (() => {
          // Compute per-currency period totals client-side from groupedByDay.
          // We separate "real" money (completed income/expense) from
          // "comprometido" (still-scheduled receivables/payables). Receivables
          // already collected become real income via auto-apply, so summing
          // both buckets would double-count the same money.
          const days: DayGroup[] = calendarData?.groupedByDay || [];
          let incomeARS = 0, incomeUSD = 0, expenseARS = 0, expenseUSD = 0;
          let pendingInARS = 0, pendingInUSD = 0, pendingOutARS = 0, pendingOutUSD = 0;
          for (const d of days) {
            incomeARS += (d.totalIncomeARS || 0);
            incomeUSD += (d.totalIncomeUSD || 0);
            expenseARS += (d.totalExpenseARS || 0);
            expenseUSD += (d.totalExpenseUSD || 0);
            pendingInARS += (d.pendingReceivableARS || 0);
            pendingInUSD += (d.pendingReceivableUSD || 0);
            pendingOutARS += (d.pendingPayableARS || 0);
            pendingOutUSD += (d.pendingPayableUSD || 0);
          }
          const balanceARS = incomeARS - expenseARS;
          const balanceUSD = incomeUSD - expenseUSD;
          const hasARS = incomeARS > 0 || expenseARS > 0;
          const hasUSD = incomeUSD > 0 || expenseUSD > 0;
          const hasAny = hasARS || hasUSD;
          const hasPendingARS = pendingInARS > 0 || pendingOutARS > 0;
          const hasPendingUSD = pendingInUSD > 0 || pendingOutUSD > 0;
          const cancelledCount = calendarData?.summary?.cancelledTransactions || 0;

          return (
            <Card className="p-4 space-y-3">
              <div className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span className="text-muted-foreground flex items-center gap-2 flex-wrap" data-testid="text-period-total-count">
                  <span>Real del período: {calendarData.summary.totalTransactions} movimientos</span>
                  {cancelledCount > 0 && (
                    <Badge variant="outline" className="text-[10px] text-muted-foreground border-muted-foreground/30" data-testid="badge-period-cancelled">
                      {cancelledCount} cancelado{cancelledCount === 1 ? '' : 's'} (no suma)
                    </Badge>
                  )}
                </span>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-2" data-testid="text-period-income">
                    {!hasAny && <span>+{formatCurrency(0, primaryCurrency)}</span>}
                    {incomeARS > 0 && <span data-testid="text-period-income-ars">+{formatCurrency(incomeARS, 'ARS')}</span>}
                    {incomeUSD > 0 && <span className="text-emerald-700 dark:text-emerald-300" data-testid="text-period-income-usd">+{formatCurrency(incomeUSD, 'USD')}</span>}
                  </span>
                  <span className="text-red-600 dark:text-red-400 flex items-center gap-2" data-testid="text-period-expense">
                    {!hasAny && <span>-{formatCurrency(0, primaryCurrency)}</span>}
                    {expenseARS > 0 && <span data-testid="text-period-expense-ars">-{formatCurrency(expenseARS, 'ARS')}</span>}
                    {expenseUSD > 0 && <span className="text-red-700 dark:text-red-300" data-testid="text-period-expense-usd">-{formatCurrency(expenseUSD, 'USD')}</span>}
                  </span>
                  <span className="font-semibold flex items-center gap-2" data-testid="text-period-balance">
                    Balance:
                    {!hasAny && <span>{formatCurrency(0, primaryCurrency)}</span>}
                    {hasARS && <span data-testid="text-period-balance-ars">{formatCurrency(balanceARS, 'ARS')}</span>}
                    {hasUSD && <span data-testid="text-period-balance-usd">{formatCurrency(balanceUSD, 'USD')}</span>}
                  </span>
                </div>
              </div>
              {(hasPendingARS || hasPendingUSD) && (
                <div className="flex flex-col gap-1 text-xs text-muted-foreground border-t border-border/40 pt-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-muted-foreground">Comprometido (aún no efectivizado):</span>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    {(pendingInARS > 0 || pendingInUSD > 0) && (
                      <span className="text-cyan-600 dark:text-cyan-400 flex items-center gap-2" data-testid="text-period-pending-receivable">
                        Por cobrar:
                        {pendingInARS > 0 && <span data-testid="text-period-pending-receivable-ars">{formatCurrency(pendingInARS, 'ARS')}</span>}
                        {pendingInUSD > 0 && <span className="text-cyan-700 dark:text-cyan-300" data-testid="text-period-pending-receivable-usd">{formatCurrency(pendingInUSD, 'USD')}</span>}
                      </span>
                    )}
                    {(pendingOutARS > 0 || pendingOutUSD > 0) && (
                      <span className="text-amber-600 dark:text-amber-400 flex items-center gap-2" data-testid="text-period-pending-payable">
                        Por pagar:
                        {pendingOutARS > 0 && <span data-testid="text-period-pending-payable-ars">{formatCurrency(pendingOutARS, 'ARS')}</span>}
                        {pendingOutUSD > 0 && <span className="text-amber-700 dark:text-amber-300" data-testid="text-period-pending-payable-usd">{formatCurrency(pendingOutUSD, 'USD')}</span>}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </Card>
          );
        })()}
      </div>

      <Dialog open={isDetailOpen} onOpenChange={setIsDetailOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>
              Movimientos del {selectedDay ? format(argDayKeyToLocalDate(selectedDay.date), "d 'de' MMMM yyyy", { locale: es }) : ''}
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            {selectedDay && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                    <span className="text-xs text-emerald-600 dark:text-emerald-400">Ingresos</span>
                    <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
                      {selectedDay.totalIncomeARS > 0 && <span>AR${formatCompact(selectedDay.totalIncomeARS)}</span>}
                      {selectedDay.totalIncomeUSD > 0 && <span className="text-emerald-700 dark:text-emerald-300 ml-2">US${formatCompact(selectedDay.totalIncomeUSD)}</span>}
                      {selectedDay.totalIncomeARS === 0 && selectedDay.totalIncomeUSD === 0 && <span>AR$0</span>}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                    <span className="text-xs text-red-600 dark:text-red-400">Egresos</span>
                    <div className="text-lg font-bold text-red-600 dark:text-red-400">
                      {selectedDay.totalExpenseARS > 0 && <span>AR${formatCompact(selectedDay.totalExpenseARS)}</span>}
                      {selectedDay.totalExpenseUSD > 0 && <span className="text-red-700 dark:text-red-300 ml-2">US${formatCompact(selectedDay.totalExpenseUSD)}</span>}
                      {selectedDay.totalExpenseARS === 0 && selectedDay.totalExpenseUSD === 0 && <span>AR$0</span>}
                    </div>
                  </div>
                </div>
                
                <div className="space-y-2">
                  {selectedDay.transactions.map(tx => {
                    const isPending = tx.status === 'scheduled';
                    const isCancelled = tx.status === 'cancelled';
                    const isTransfer = isTransferType(tx.type);
                    const isOrphan = isOrphanTransfer(tx);
                    const counterpartName = tx.transferCounterpart?.account?.name;
                    const originName = tx.account?.name || 'Sin cuenta';
                    const transferAccountsLabel = isTransfer
                      ? (tx.type === 'transfer_out'
                          ? `${originName}${counterpartName ? ` → ${counterpartName}` : ''}`
                          : `${counterpartName ? `${counterpartName} → ` : ''}${originName}`)
                      : null;
                    return (
                      <div
                        key={tx.id}
                        onClick={() => handleTransactionClick(tx.id)}
                        className={`grid grid-cols-[auto_1fr_auto] items-center gap-3 p-3 rounded-lg transition-colors group cursor-pointer ${
                          isOrphan
                            ? 'bg-amber-500/10 border border-dashed border-amber-500/50 hover:bg-amber-500/15'
                            : isCancelled
                              ? 'bg-muted/20 border border-dashed border-muted-foreground/30 hover:bg-muted/30 opacity-60'
                              : isPending
                                ? 'bg-orange-500/10 border border-dashed border-orange-400/40 hover:bg-orange-500/20'
                                : isTransfer
                                  ? 'bg-blue-500/5 border border-dashed border-blue-400/30 hover:bg-blue-500/10'
                                  : 'bg-muted/30 hover:bg-muted/60'
                        }`}
                        data-testid={`calendar-transaction-${tx.id}`}
                      >
                        <div className="flex flex-col gap-1 shrink-0">
                          <Badge className={typeColors[tx.type]} data-testid={`badge-modal-type-${tx.id}`}>
                            {typeLabels[tx.type]}
                          </Badge>
                          {isPending && (
                            <Badge className="bg-orange-500/20 text-orange-600 dark:text-orange-400 border-orange-500/30 text-[9px]">
                              <Timer className="h-2.5 w-2.5 mr-1" />
                              Programado
                            </Badge>
                          )}
                          {isCancelled && (
                            <Badge variant="outline" className="text-[9px] text-muted-foreground border-muted-foreground/40">
                              Cancelado
                            </Badge>
                          )}
                          {isOrphan && (
                            <Badge
                              className="bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-500/40 text-[9px]"
                              title="Esta transferencia interna no tiene contraparte"
                              data-testid={`badge-modal-orphan-${tx.id}`}
                            >
                              <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                              Sin contraparte
                            </Badge>
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className={`font-medium flex items-center gap-2 truncate ${isCancelled ? 'line-through text-muted-foreground' : ''}`}>
                            <span className="truncate">{tx.description}</span>
                            <ExternalLink className="h-3.5 w-3.5 text-primary opacity-50 group-hover:opacity-100 transition-opacity shrink-0" />
                          </p>
                          <p className="text-xs text-muted-foreground truncate" data-testid={`text-modal-meta-${tx.id}`}>
                            {isTransfer
                              ? `${transferAccountsLabel}${tx.transactionNumber ? ` • ${tx.transactionNumber}` : ''}`
                              : `${tx.category} • ${originName}${tx.transactionNumber ? ` • ${tx.transactionNumber}` : ''}`}
                          </p>
                        </div>
                        <p className={`font-semibold text-right whitespace-nowrap shrink-0 ${
                          isCancelled
                            ? 'text-muted-foreground line-through'
                            : isPending
                              ? 'text-orange-600 dark:text-orange-400'
                              : isTransfer
                                ? 'text-blue-600 dark:text-blue-400'
                                : tx.type === 'income' || tx.type === 'receivable'
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-red-600 dark:text-red-400'
                        }`}>
                          {isTransfer
                            ? formatCurrency(normalizeAmountInput(tx.amount), tx.currency || tx.account?.currency)
                            : `${tx.type === 'income' || tx.type === 'receivable' ? '+' : '-'}${formatCurrency(normalizeAmountInput(tx.amount), tx.currency || tx.account?.currency)}`}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}
