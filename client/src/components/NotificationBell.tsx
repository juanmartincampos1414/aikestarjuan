import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, ArrowDownRight, ArrowUpRight, X, CheckCheck, Check, Clock, AlertTriangle, Calendar, MessageCircle, Sparkles, FileText, Image as ImageIcon, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { fetchWithAuth } from '@/lib/api';
import { useLocation } from 'wouter';
import { CURRENCY_SYMBOLS, type Currency } from '@shared/schema';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import { useOrganization, useSwitchOrganization } from '@/lib/hooks';

interface Notification {
  id: string;
  userId: string;
  organizationId: string;
  type: string;
  priority: string;
  title: string;
  message: string;
  transactionId: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
  imageUrl: string | null;
  attachmentUrl: string | null;
  attachmentName: string | null;
}

interface PendingCommitment {
  id: string;
  type: 'payable' | 'receivable';
  title: string;
  description: string;
  amount: string;
  currency: string;
  dueDate: string;
  daysUntilDue: number;
  priority: 'urgent' | 'warning' | 'info';
  organizationId: string;
  organizationName: string;
}

interface PendingCommitmentsResponse {
  notifications: PendingCommitment[];
  unreadCount: number;
  totalCount: number;
}

const ORG_BADGE_COLORS = [
  { bg: 'bg-blue-100', text: 'text-blue-700', dot: 'bg-blue-500' },
  { bg: 'bg-purple-100', text: 'text-purple-700', dot: 'bg-purple-500' },
  { bg: 'bg-teal-100', text: 'text-teal-700', dot: 'bg-teal-500' },
  { bg: 'bg-orange-100', text: 'text-orange-700', dot: 'bg-orange-500' },
  { bg: 'bg-pink-100', text: 'text-pink-700', dot: 'bg-pink-500' },
  { bg: 'bg-indigo-100', text: 'text-indigo-700', dot: 'bg-indigo-500' },
  { bg: 'bg-cyan-100', text: 'text-cyan-700', dot: 'bg-cyan-500' },
  { bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-500' },
];

function getOrgColor(orgId: string) {
  let hash = 0;
  for (let i = 0; i < orgId.length; i++) {
    hash = ((hash << 5) - hash + orgId.charCodeAt(i)) | 0;
  }
  return ORG_BADGE_COLORS[Math.abs(hash) % ORG_BADGE_COLORS.length];
}

function OrgBadge({ orgId, orgName }: { orgId: string; orgName: string }) {
  const color = getOrgColor(orgId);
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium max-w-[140px] ${color.bg} ${color.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${color.dot}`} />
      <span className="truncate">{orgName}</span>
    </span>
  );
}

export default function NotificationBell() {
  const [isOpen, setIsOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedNotification, setSelectedNotification] = useState<Notification | null>(null);
  const [filterOrgId, setFilterOrgId] = useState<string>('all');
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { data: currentOrg } = useOrganization();
  const currentOrgId = currentOrg?.id;
  const switchOrgMutation = useSwitchOrganization();

  const { data: summaryData, isLoading: loadingSummary } = useQuery<{
    notifications: Notification[];
    unreadCount: number;
    pending: PendingCommitmentsResponse;
  }>({
    queryKey: ['/api/notifications/summary'],
    queryFn: () => fetchWithAuth('/notifications/summary'),
    refetchInterval: isOpen ? 30000 : 60000,
    staleTime: 30000,
  });

  const persistentNotifications = summaryData?.notifications ?? [];
  const unreadCountFromSummary = summaryData?.unreadCount ?? 0;
  const pendingData = summaryData?.pending ?? null;

  const { data: organizations = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['/api/organizations'],
    queryFn: () => fetchWithAuth('/organizations'),
    staleTime: 300000,
  });

  const orgNameMap = Object.fromEntries(organizations.map(o => [o.id, o.name]));

  const markReadMutation = useMutation({
    mutationFn: (id: string) => fetchWithAuth(`/notifications/${id}/read`, { method: 'PATCH' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/notifications/summary'] });
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => fetchWithAuth('/notifications/mark-all-read', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/notifications/summary'] });
    },
  });

  const pendingCommitments = pendingData?.notifications || [];
  const urgentPendingCount = pendingData?.unreadCount || 0;
  const totalPendingCount = pendingData?.totalCount || 0;

  const unreadPersistent = persistentNotifications.filter(n => !n.isRead);
  const readPersistent = persistentNotifications.filter(n => n.isRead);

  const currentOrgPendingCount = pendingCommitments.filter(p => p.organizationId === currentOrgId).length;
  const currentOrgUnreadPersistent = unreadPersistent.filter(n => n.organizationId === currentOrgId);
  const totalBadgeCount = currentOrgUnreadPersistent.length;
  const hasUrgent = urgentPendingCount > 0 || unreadPersistent.some(n => n.priority === 'urgent');

  const filteredUnreadPersistent = filterOrgId === 'all' ? unreadPersistent : unreadPersistent.filter(n => n.organizationId === filterOrgId);
  const filteredReadPersistent = filterOrgId === 'all' ? readPersistent : readPersistent.filter(n => n.organizationId === filterOrgId);
  const filteredPendingCommitments = filterOrgId === 'all' ? pendingCommitments : pendingCommitments.filter(p => p.organizationId === filterOrgId);
  const filteredTotalPendingCount = filterOrgId === 'all' ? totalPendingCount : filteredPendingCommitments.length;

  const isLoading = loadingSummary;

  const handlePendingClick = async (notification: PendingCommitment) => {
    try {
      await fetchWithAuth('/notifications/from-pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transactionId: notification.id,
          organizationId: notification.organizationId,
          type: notification.type,
          title: notification.title,
          description: notification.description,
          amount: notification.amount,
          currency: notification.currency,
          daysUntilDue: notification.daysUntilDue,
        }),
      });
      
      await switchOrgMutation.mutateAsync(notification.organizationId);
      setIsOpen(false);
      setLocation(`/transactions?id=${notification.id}`);
    } catch (error) {
      console.error('Error:', error);
      setIsOpen(false);
      setLocation('/transactions');
    }
  };

  const handlePersistentClick = async (notification: Notification) => {
    if (notification.transactionId) {
      if (!notification.isRead) {
        markReadMutation.mutate(notification.id);
      }
      try {
        await switchOrgMutation.mutateAsync(notification.organizationId);
        setIsOpen(false);
        setLocation(`/transactions?id=${notification.transactionId}`);
      } catch (error) {
        console.error('Error:', error);
        setIsOpen(false);
        setLocation('/transactions');
      }
    } else {
      setSelectedNotification(notification);
    }
  };

  const handleCloseNotificationModal = () => {
    if (selectedNotification && !selectedNotification.isRead) {
      markReadMutation.mutate(selectedNotification.id);
    }
    setSelectedNotification(null);
  };

  const formatAmount = (amount: string, currency: string) => {
    const symbol = CURRENCY_SYMBOLS[currency as Currency] || '$';
    const num = parseFloat(amount);
    if (num >= 1000000) {
      return `${symbol}${(num / 1000000).toFixed(1)}M`;
    }
    if (num >= 1000) {
      return `${symbol}${(num / 1000).toFixed(1)}K`;
    }
    return `${symbol}${num.toLocaleString('es-AR')}`;
  };

  const getPriorityStyles = (priority: string, daysUntilDue: number) => {
    if (daysUntilDue === 0) {
      return 'border-l-yellow-500 bg-gradient-to-r from-yellow-50 to-amber-50 ring-1 ring-yellow-200';
    }
    if (daysUntilDue < 0) {
      return 'border-l-red-500 bg-red-50';
    }
    switch (priority) {
      case 'urgent':
        return 'border-l-red-500 bg-red-50';
      case 'warning':
        return 'border-l-amber-500 bg-amber-50';
      default:
        return 'border-l-blue-500 bg-blue-50';
    }
  };

  const getPersistentStyles = (priority: string, type: string, _isRead: boolean) => {
    if (type === 'whatsapp_launch' || type.startsWith('announcement')) {
      return 'border-l-green-500 bg-gradient-to-r from-green-50 to-emerald-50';
    }
    switch (priority) {
      case 'urgent':
        return 'border-l-red-500 bg-red-50';
      case 'high':
        return 'border-l-amber-500 bg-amber-50';
      default:
        return 'border-l-blue-500 bg-blue-50';
    }
  };

  const getPriorityIcon = (priority: string, type: string) => {
    if (type === 'whatsapp_launch') {
      return <MessageCircle className="h-3.5 w-3.5 text-green-600" />;
    }
    if (type.startsWith('announcement')) {
      return <Sparkles className="h-3.5 w-3.5 text-green-600" />;
    }
    switch (priority) {
      case 'urgent':
        return <AlertTriangle className="h-3.5 w-3.5 text-red-600" />;
      case 'high':
        return <Clock className="h-3.5 w-3.5 text-amber-600" />;
      default:
        return <Calendar className="h-3.5 w-3.5 text-blue-600" />;
    }
  };

  const formatTime = (dateStr: string) => {
    try {
      return formatDistanceToNow(new Date(dateStr), { addSuffix: true, locale: es });
    } catch {
      return '';
    }
  };

  return (
    <>
    <Popover open={isOpen} onOpenChange={(open) => { setIsOpen(open); if (!open) setFilterOrgId('all'); }}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-8 w-8 text-blue-600 hover:text-blue-800 hover:bg-blue-100 rounded-lg"
          data-testid="button-notifications"
        >
          <Bell className="h-4 w-4" />
          {totalBadgeCount > 0 && (
            <span 
              className={`absolute -top-1 -right-1 h-5 min-w-5 px-1 flex items-center justify-center text-[10px] font-bold rounded-full ${
                hasUrgent 
                  ? 'bg-red-500 text-white animate-pulse' 
                  : 'bg-amber-500 text-white'
              }`}
              data-testid="notification-count"
            >
              {totalBadgeCount > 99 ? '99+' : totalBadgeCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent 
        align="end" 
        className="w-96 p-0 max-h-[500px] overflow-hidden"
        data-testid="notifications-dropdown"
      >
        <div className="flex items-center justify-between p-3 border-b bg-gradient-to-r from-cyan-50 to-pink-50">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-gray-800 dark:text-slate-100">Notificaciones</h3>
            {totalBadgeCount > 0 && (
              <span className="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 rounded-full">
                {totalBadgeCount} sin leer
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {unreadPersistent.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-blue-600 hover:text-blue-800"
                onClick={() => markAllReadMutation.mutate()}
                disabled={markAllReadMutation.isPending}
                data-testid="button-mark-all-read"
              >
                <CheckCheck className="h-3.5 w-3.5 mr-1" />
                Marcar todo
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setIsOpen(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex border-b">
          <button
            onClick={() => setShowHistory(false)}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${
              !showHistory 
                ? 'text-blue-600 border-b-2 border-blue-600' 
                : 'text-gray-500 dark:text-slate-400 hover:text-gray-700'
            }`}
          >
            Pendientes ({filteredTotalPendingCount + filteredUnreadPersistent.length})
          </button>
          <button
            onClick={() => setShowHistory(true)}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${
              showHistory 
                ? 'text-blue-600 border-b-2 border-blue-600' 
                : 'text-gray-500 dark:text-slate-400 hover:text-gray-700'
            }`}
          >
            Historial ({filteredReadPersistent.length})
          </button>
        </div>

        {organizations.length > 1 && (
          <div className="flex gap-1.5 px-3 py-2 overflow-x-auto border-b bg-gray-50 dark:bg-slate-900/50 scrollbar-thin">
            <button
              onClick={() => setFilterOrgId('all')}
              className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                filterOrgId === 'all'
                  ? 'bg-gray-800 text-white'
                  : 'bg-white dark:bg-card text-gray-600 dark:text-slate-300 border border-gray-200 dark:border-slate-800 hover:bg-gray-100 dark:hover:bg-slate-800'
              }`}
              data-testid="filter-org-all"
            >
              Todas
            </button>
            {organizations.map((org) => {
              const color = getOrgColor(org.id);
              const isActive = filterOrgId === org.id;
              return (
                <button
                  key={org.id}
                  onClick={() => setFilterOrgId(org.id)}
                  className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors max-w-[140px] ${
                    isActive
                      ? `${color.bg} ${color.text} ring-1 ring-current`
                      : 'bg-white dark:bg-card text-gray-600 dark:text-slate-300 border border-gray-200 dark:border-slate-800 hover:bg-gray-100 dark:hover:bg-slate-800'
                  }`}
                  data-testid={`filter-org-${org.id}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? color.dot : 'bg-gray-400'}`} />
                  <span className="truncate">{org.name}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="overflow-y-auto max-h-[350px]">
          {isLoading ? (
            <div className="p-4 text-center text-gray-500 dark:text-slate-400">
              Cargando...
            </div>
          ) : !showHistory ? (
            (filteredPendingCommitments.length === 0 && filteredUnreadPersistent.length === 0) ? (
              <div className="p-6 text-center">
                <Bell className="h-10 w-10 mx-auto text-gray-300 mb-2" />
                <p className="text-sm text-gray-500 dark:text-slate-400">
                  No hay notificaciones pendientes
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  Te avisaremos cuando tengas novedades
                </p>
              </div>
            ) : (
              <div className="divide-y">
                {filteredUnreadPersistent.map((notification) => (
                  <div
                    key={notification.id}
                    onClick={() => handlePersistentClick(notification)}
                    className={`p-3 border-l-4 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer transition-colors ${getPersistentStyles(notification.priority, notification.type, false)}`}
                    data-testid={`notification-persistent-${notification.id}`}
                  >
                    <div className="flex items-start gap-2">
                      <div className={`p-1.5 rounded-full ${
                        notification.type === 'whatsapp_launch' || notification.type.startsWith('announcement')
                          ? 'bg-green-100'
                          : notification.priority === 'urgent' 
                          ? 'bg-red-100' 
                          : notification.priority === 'high'
                          ? 'bg-amber-100'
                          : 'bg-blue-100'
                      }`}>
                        {getPriorityIcon(notification.priority, notification.type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-medium text-gray-800 dark:text-slate-100 truncate">
                            {notification.title}
                          </p>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              markReadMutation.mutate(notification.id);
                            }}
                            disabled={markReadMutation.isPending}
                          >
                            <Check className="h-3.5 w-3.5 text-gray-400 hover:text-green-600" />
                          </Button>
                        </div>
                        <p className="text-xs text-gray-600 dark:text-slate-300 mt-0.5 line-clamp-3">
                          {notification.message}
                        </p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <p className="text-xs text-gray-400">
                            {formatTime(notification.createdAt)}
                          </p>
                          <OrgBadge orgId={notification.organizationId} orgName={orgNameMap[notification.organizationId] || 'Org'} />
                          {notification.imageUrl && (
                            <span className="flex items-center gap-0.5 text-xs text-blue-500">
                              <ImageIcon className="h-3 w-3" />
                            </span>
                          )}
                          {notification.attachmentUrl && (
                            <span className="flex items-center gap-0.5 text-xs text-blue-500">
                              <FileText className="h-3 w-3" />
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                {/* Compromisos de pago/cobro */}
                {filteredPendingCommitments.map((notification) => (
                  <div
                    key={notification.id}
                    onClick={() => handlePendingClick(notification)}
                    className={`p-3 border-l-4 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer transition-colors ${getPriorityStyles(notification.priority, notification.daysUntilDue)}`}
                    data-testid={`notification-item-${notification.id}`}
                  >
                    <div className="flex items-start gap-2">
                      <div className={`p-1.5 rounded-full ${
                        notification.type === 'payable' 
                          ? 'bg-red-100 text-red-600' 
                          : 'bg-green-100 text-green-600'
                      }`}>
                        {notification.type === 'payable' 
                          ? <ArrowUpRight className="h-3.5 w-3.5" />
                          : <ArrowDownRight className="h-3.5 w-3.5" />
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            <p className="text-sm font-medium text-gray-800 dark:text-slate-100 truncate">
                              {notification.title}
                            </p>
                            {notification.daysUntilDue === 0 && (
                              <span className="px-1.5 py-0.5 text-[10px] font-bold bg-yellow-400 text-yellow-900 rounded-full uppercase shrink-0 animate-pulse">
                                HOY
                              </span>
                            )}
                            {notification.daysUntilDue < 0 && (
                              <span className="px-1.5 py-0.5 text-[10px] font-bold bg-red-500 text-white rounded-full uppercase shrink-0">
                                VENCIDO
                              </span>
                            )}
                          </div>
                          <span className="text-sm font-semibold text-gray-700 dark:text-slate-200 ml-2 whitespace-nowrap">
                            {formatAmount(notification.amount, notification.currency)}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-slate-400 truncate mt-0.5">
                          {notification.description}
                        </p>
                        <div className="flex items-center gap-1 mt-1">
                          <OrgBadge orgId={notification.organizationId} orgName={notification.organizationName} />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : (
            filteredReadPersistent.length === 0 ? (
              <div className="p-6 text-center">
                <Bell className="h-10 w-10 mx-auto text-gray-300 mb-2" />
                <p className="text-sm text-gray-500 dark:text-slate-400">
                  No hay historial de notificaciones
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  Las notificaciones leídas aparecerán aquí
                </p>
              </div>
            ) : (
              <div className="divide-y">
                {filteredReadPersistent.slice(0, 20).map((notification) => (
                  <div
                    key={notification.id}
                    onClick={() => handlePersistentClick(notification)}
                    className={`p-3 border-l-4 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer transition-colors ${getPersistentStyles(notification.priority, notification.type, true)}`}
                    data-testid={`notification-read-${notification.id}`}
                  >
                    <div className="flex items-start gap-2">
                      <div className={`p-1.5 rounded-full ${
                        notification.type === 'whatsapp_launch' || notification.type.startsWith('announcement')
                          ? 'bg-green-50'
                          : 'bg-white dark:bg-card/60'
                      }`}>
                        {getPriorityIcon(notification.priority, notification.type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-600 dark:text-slate-300 truncate">
                          {notification.title}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5 line-clamp-3">
                          {notification.message}
                        </p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <p className="text-xs text-gray-400">
                            {formatTime(notification.createdAt)}
                          </p>
                          <OrgBadge orgId={notification.organizationId} orgName={orgNameMap[notification.organizationId] || 'Org'} />
                          {notification.imageUrl && (
                            <span className="flex items-center gap-0.5 text-xs text-blue-400">
                              <ImageIcon className="h-3 w-3" />
                            </span>
                          )}
                          {notification.attachmentUrl && (
                            <span className="flex items-center gap-0.5 text-xs text-blue-400">
                              <FileText className="h-3 w-3" />
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                {filteredReadPersistent.length > 20 && (
                  <div className="p-2 text-center text-xs text-gray-400">
                    +{filteredReadPersistent.length - 20} más antiguas
                  </div>
                )}
              </div>
            )
          )}
        </div>

        <div className="p-2 border-t bg-gray-50 dark:bg-slate-900">
          <Button 
            variant="ghost" 
            className="w-full text-sm h-8 text-blue-600 hover:text-blue-800"
            onClick={() => {
              setShowHistory(true);
            }}
            data-testid="button-view-all-notifications"
          >
            Ver todo el historial de notificaciones
          </Button>
        </div>
      </PopoverContent>
    </Popover>

    <Dialog open={!!selectedNotification} onOpenChange={(open) => !open && handleCloseNotificationModal()}>
      <DialogContent className="sm:max-w-md max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-full shrink-0 ${
              selectedNotification?.type === 'whatsapp_launch' || selectedNotification?.type?.startsWith('announcement')
                ? 'bg-green-100'
                : selectedNotification?.priority === 'urgent'
                ? 'bg-red-100'
                : selectedNotification?.priority === 'high'
                ? 'bg-amber-100'
                : 'bg-blue-100'
            }`}>
              {selectedNotification && getPriorityIcon(selectedNotification.priority, selectedNotification.type)}
            </div>
            <DialogTitle className="text-lg">
              {selectedNotification?.title}
            </DialogTitle>
          </div>
        </DialogHeader>
        <DialogDescription asChild>
          <div className="space-y-3 overflow-y-auto flex-1 min-h-0">
            <p className="text-sm text-gray-700 dark:text-slate-200 whitespace-pre-wrap">
              {selectedNotification?.message}
            </p>
            
            {selectedNotification?.imageUrl && (
              <div className="mt-3 space-y-2">
                <a
                  href={selectedNotification.imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block group relative"
                  data-testid="link-notification-image-zoom"
                  title="Tocá para ampliar"
                >
                  <img
                    src={selectedNotification.imageUrl}
                    alt="Imagen adjunta"
                    className="max-w-full max-h-64 rounded-lg border object-contain cursor-zoom-in transition-opacity group-hover:opacity-90"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                </a>
                <a
                  href={selectedNotification.imageUrl}
                  download
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-xs text-blue-600 hover:text-blue-700 hover:underline"
                  data-testid="link-notification-image-download"
                >
                  <Download className="h-3.5 w-3.5" />
                  Descargar imagen
                </a>
              </div>
            )}
            
            {selectedNotification?.attachmentUrl && (
              <a 
                href={selectedNotification.attachmentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 p-2 rounded-lg bg-gray-50 dark:bg-slate-900 hover:bg-gray-100 dark:hover:bg-slate-800 border transition-colors"
              >
                <FileText className="h-5 w-5 text-blue-600" />
                <span className="text-sm text-gray-700 dark:text-slate-200 truncate flex-1">
                  {selectedNotification.attachmentName || 'Archivo adjunto'}
                </span>
                <Download className="h-4 w-4 text-gray-400" />
              </a>
            )}
          </div>
        </DialogDescription>
        <div className="flex items-center justify-between mt-4 pt-4 border-t shrink-0">
          <span className="text-xs text-gray-400">
            {selectedNotification && formatTime(selectedNotification.createdAt)}
          </span>
          <Button onClick={handleCloseNotificationModal} data-testid="button-close-notification">
            Entendido
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
