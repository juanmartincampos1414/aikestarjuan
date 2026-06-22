import React, { useState, useRef, useEffect, useReducer } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/api';

async function uploadAdminFile(file: File): Promise<{ url: string; originalName: string }> {
  const contentType = file.type || 'application/octet-stream';

  const { uploadURL, objectPath } = await fetchWithAuth('/uploads/request-url', {
    method: 'POST',
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      contentType,
    }),
  });

  if (!uploadURL || !objectPath) {
    throw new Error('No se pudo preparar la subida');
  }

  const putResponse = await fetch(uploadURL, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': contentType },
  });

  if (!putResponse.ok) {
    throw new Error(`No se pudo subir el archivo al almacenamiento (HTTP ${putResponse.status})`);
  }

  return { url: objectPath, originalName: file.name };
}
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  Users, 
  TrendingUp, 
  AlertCircle, 
  CreditCard,
  Activity,
  Clock,
  Search,
  RefreshCw,
  LogIn,
  LogOut,
  XCircle,
  CheckCircle,
  Shield,
  ShieldOff,
  Bell,
  Send,
  Mail,
  UserCheck,
  Smile,
  Smartphone,
  Image as ImageIcon,
  Paperclip,
  X,
  Upload,
  FileText,
  LifeBuoy,
  KeyRound,
  Copy,
  Check,
  AlertTriangle,
  Archive,
  RotateCcw,
  DollarSign,
  Calculator,
  Target,
  Percent,
  Coins,
  Pencil,
  Save,
  Trash2,
  CalendarClock,
  Maximize2,
  Minimize2,
  ArrowLeft
} from 'lucide-react';
import { SAAS_KPI_ESTIMATES } from '@shared/constants';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Legend } from 'recharts';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

const COMMON_EMOJIS = [
  '😊', '🎉', '✅', '⚠️', '🔔', '💡', '🚀', '📢', '🎁', '💰',
  '📊', '📈', '🔥', '⭐', '❤️', '👍', '🙌', '💪', '🎯', '📝',
  '🔒', '🔓', '⏰', '📅', '✨', '🌟', '💎', '🏆', '🎊', '👋'
];
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { type MetricFilter, METRIC_MODAL_LABELS, userMatchesFilter } from './adminMetricFilter';
import { metricModalReducer, closedMetricModalState } from './adminMetricModalState';
import { MetricUsersModal } from './MetricUsersModal';

interface AdminUser {
  id: string;
  email: string;
  name: string;
  accountType: string;
  isAdmin: boolean;
  createdAt: string;
  deletedAt: string | null;
  phoneNumber: string | null;
  phoneVerified: boolean | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscription: {
    id: string;
    planType: string;
    status: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    paymentFailedAt: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  stripeStatus: string | null;
}

interface AdminMetrics {
  totalUsers: number;
  activeSubscriptions: number;
  trialingSubscriptions: number;
  paymentFailures: number;
  cancelledSubscriptions: number;
  cancelScheduledSubscriptions: number;
  subscriptionsByPlan: Record<string, number>;
  usersWithoutSubscription: number;
  deletedForNonPayment?: number;
  revenue?: {
    mrrArs: number;
    mrrUsd: number;
    arrArs: number;
    arrUsd: number;
    arpuArs: number;
    arpuUsd: number;
    activeCount: number;
    usdArsRate: number;
  };
  estimates?: {
    cacUsdMin: number;
    cacUsdMax: number;
    ltvCacRatio: number;
  };
  churn?: {
    monthlyRatePct: number | null;
    avgLifetimeMonths: number | null;
    ltvArs: number | null;
    ltvUsd: number | null;
    cancellationsInWindow: number;
    monthsWithData: number;
    windowMonths: number;
    hasEnoughData: boolean;
  };
  cac?: {
    cacArs: number | null;
    cacUsd: number | null;
    totalSpendArs: number;
    totalSignups: number;
    monthsWithSpend: number;
    hasEnoughData: boolean;
  };
}

interface AcquisitionSpend {
  month: string;
  amountArs: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface AcquisitionConfig {
  acquisitionAutoEnabled: boolean;
  acquisitionOrgId: string | null;
  acquisitionAccountIds: string[];
  acquisitionCategories: string[];
  acquisitionProfitabilityCodeIds: string[];
}

interface AcquisitionConfigOptions {
  accounts: { id: string; name: string; currency: string }[];
  categories: { name: string }[];
  profitabilityCodes: { id: string; code: string; name: string }[];
}

interface DerivedSpendMonth {
  month: string;
  amountArs: number;
  source: 'manual' | 'auto';
}

interface DerivedSpendResponse {
  enabled: boolean;
  months: DerivedSpendMonth[];
}

interface AdminOrganization {
  id: string;
  name: string;
}

interface BusinessSettings {
  usdArsRate: number;
  cacUsdMin: number;
  cacUsdMax: number;
  ltvCacRatio: number;
  source: 'db' | 'env' | 'default';
  updatedAt: string | null;
}

interface MrrSnapshot {
  id: string;
  snapshotMonth: string; // 'YYYY-MM'
  mrrArs: number;
  mrrUsd: number;
  activeSubscriptions: number;
  usdArsRate: number;
  capturedAt: string;
}

interface SessionLog {
  id: string;
  userId: string;
  action: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  userEmail: string;
  userName: string;
}

interface SystemError {
  id: string;
  fingerprint: string;
  source: string;
  message: string;
  stack: string | null;
  statusCode: number | null;
  method: string | null;
  path: string | null;
  userId: string | null;
  userEmail: string | null;
  organizationId: string | null;
  organizationName: string | null;
  ip: string | null;
  userAgent: string | null;
  status: 'open' | 'resolved' | 'archived';
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

// Opciones del filtro explícito por estado en la pestaña Usuarios. El value ''
// representa "todos" (sin filtro). Reusa el mismo metricFilter que las tarjetas
// para que ambos controles queden siempre en sincronía.
const USER_STATUS_FILTERS: { value: Exclude<MetricFilter, null> | 'all'; label: string }[] = [
  { value: 'all', label: 'Todos los estados' },
  { value: 'active', label: 'Suscripción activa' },
  { value: 'trial', label: 'En prueba' },
  { value: 'payment_failed', label: 'Pagos fallidos' },
  { value: 'cancel_scheduled', label: 'Cancelarán (baja agendada)' },
  { value: 'cancelled', label: 'Canceladas' },
  { value: 'no_subscription', label: 'Sin suscripción' },
  { value: 'deleted', label: 'Eliminadas' },
];

type PhoneFilter = 'has_phone' | 'verified' | 'pending' | null;
type ErrorStatusFilter = 'open' | 'resolved' | 'archived';

const fmtArs = (n: number): string =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(Math.round(n || 0));

const fmtUsd = (n: number): string =>
  'US$ ' + new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(Math.round(n || 0));

// 'YYYY-MM' → 'jun 2026' (mes abreviado en español). Se construye la fecha en
// UTC (día 1) para evitar corrimientos de zona horaria al formatear el mes.
const formatMonthLabel = (month: string): string => {
  const [y, m] = (month || '').split('-').map(Number);
  if (!y || !m) return month || '';
  const d = new Date(Date.UTC(y, m - 1, 1));
  return new Intl.DateTimeFormat('es-AR', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
};

function sourceLabel(source: string): string {
  switch (source) {
    case 'uncaughtException':
      return 'Excepción no atrapada';
    case 'unhandledRejection':
      return 'Promesa sin manejar';
    case 'http':
      return 'Error HTTP (500+)';
    default:
      return source;
  }
}

export default function AdminPage() {
  const [searchTerm, setSearchTerm] = useState('');
  const [metricFilter, setMetricFilter] = useState<MetricFilter>(null);
  const [modalState, dispatchModal] = useReducer(
    metricModalReducer<AdminUser>,
    undefined,
    closedMetricModalState<AdminUser>,
  );
  const { metric: cardModalMetric, maximized: cardModalMaximized, selectedUser: selectedModalUser } = modalState;
  const [planFilter, setPlanFilter] = useState<string | null>(null);
  const [phoneFilter, setPhoneFilter] = useState<PhoneFilter>(null);
  const [notifTitle, setNotifTitle] = useState('');
  const [notifMessage, setNotifMessage] = useState('');
  const [notifRecipients, setNotifRecipients] = useState<'all' | 'selected'>('all');
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sendMethod, setSendMethod] = useState<'app' | 'email' | 'both'>('app');
  const [notifImage, setNotifImage] = useState<File | null>(null);
  const [notifImagePreview, setNotifImagePreview] = useState<string | null>(null);
  const [notifAttachment, setNotifAttachment] = useState<File | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  const [uploadedImageUrl, setUploadedImageUrl] = useState<string | null>(null);
  const [uploadedAttachmentUrl, setUploadedAttachmentUrl] = useState<string | null>(null);
  const [errorStatusFilter, setErrorStatusFilter] = useState<ErrorStatusFilter>('open');
  const [selectedError, setSelectedError] = useState<SystemError | null>(null);
  const [resetEmail, setResetEmail] = useState('');
  const [resetResult, setResetResult] = useState<{ email: string; name: string; resetLink: string; expiresAt: string } | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const messageTextareaRef = useRef<HTMLTextAreaElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
      toast({ title: 'Error', description: 'Solo se permiten imágenes', variant: 'destructive' });
      return;
    }
    
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: 'Error', description: 'La imagen no puede superar 5MB', variant: 'destructive' });
      return;
    }
    
    setNotifImage(file);
    setNotifImagePreview(URL.createObjectURL(file));
    
    setIsUploadingImage(true);
    try {
      const data = await uploadAdminFile(file);
      setUploadedImageUrl(data.url);
      toast({ title: 'Imagen subida', description: 'La imagen se adjuntó correctamente' });
    } catch (error) {
      toast({ title: 'Error', description: 'No se pudo subir la imagen', variant: 'destructive' });
      setNotifImage(null);
      setNotifImagePreview(null);
    } finally {
      setIsUploadingImage(false);
    }
  };

  const handleAttachmentSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const allowedTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'];
    if (!allowedTypes.includes(file.type) && !file.name.endsWith('.pdf') && !file.name.endsWith('.doc') && !file.name.endsWith('.docx') && !file.name.endsWith('.txt')) {
      toast({ title: 'Error', description: 'Solo se permiten PDF, DOC, DOCX o TXT', variant: 'destructive' });
      return;
    }
    
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: 'Error', description: 'El archivo no puede superar 10MB', variant: 'destructive' });
      return;
    }
    
    setNotifAttachment(file);
    
    setIsUploadingAttachment(true);
    try {
      const data = await uploadAdminFile(file);
      setUploadedAttachmentUrl(data.url);
      toast({ title: 'Archivo subido', description: 'El archivo se adjuntó correctamente' });
    } catch (error) {
      toast({ title: 'Error', description: 'No se pudo subir el archivo', variant: 'destructive' });
      setNotifAttachment(null);
    } finally {
      setIsUploadingAttachment(false);
    }
  };

  const insertEmoji = (emoji: string) => {
    const textarea = messageTextareaRef.current;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newMessage = notifMessage.substring(0, start) + emoji + notifMessage.substring(end);
      setNotifMessage(newMessage);
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(start + emoji.length, start + emoji.length);
      }, 0);
    } else {
      setNotifMessage(notifMessage + emoji);
    }
  };

  const clearImage = () => {
    setNotifImage(null);
    setNotifImagePreview(null);
    setUploadedImageUrl(null);
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const clearAttachment = () => {
    setNotifAttachment(null);
    setUploadedAttachmentUrl(null);
    if (attachmentInputRef.current) attachmentInputRef.current.value = '';
  };
  
  const { data: users = [], isLoading: loadingUsers, refetch: refetchUsers } = useQuery<AdminUser[]>({
    queryKey: ['/api/admin/users'],
    queryFn: () => fetchWithAuth('/admin/users'),
  });

  const toggleAdminMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await fetchWithAuth(`/admin/users/${userId}/toggle-admin`, {
        method: 'PATCH',
      });
      return res;
    },
    onSuccess: (data: any) => {
      let description = data.message;
      if (data.isAdmin && data.emailSent === false) {
        description += ' (Email de notificación no enviado' + (data.emailError ? `: ${data.emailError}` : '') + ')';
      } else if (data.isAdmin && data.emailSent === true) {
        description += ' - Email de notificación enviado';
      }
      toast({
        title: data.isAdmin ? 'Admin asignado' : 'Admin removido',
        description,
        variant: data.isAdmin && data.emailSent === false ? 'destructive' : 'default',
      });
      queryClient.invalidateQueries({ queryKey: ['/api/admin/users'] });
    },
    onError: (error: any) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo cambiar el estado de admin',
        variant: 'destructive',
      });
    },
  });

  const { data: metrics, isLoading: loadingMetrics, refetch: refetchMetrics } = useQuery<AdminMetrics>({
    queryKey: ['/api/admin/metrics'],
    queryFn: () => fetchWithAuth('/admin/metrics'),
  });

  const { data: mrrSnapshots = [], isLoading: loadingMrrSnapshots } = useQuery<MrrSnapshot[]>({
    queryKey: ['/api/admin/mrr-snapshots'],
    queryFn: () => fetchWithAuth('/admin/mrr-snapshots'),
  });

  const { data: businessSettings } = useQuery<BusinessSettings>({
    queryKey: ['/api/admin/business-settings'],
    queryFn: () => fetchWithAuth('/admin/business-settings'),
  });

  const [editingKpis, setEditingKpis] = useState(false);
  const [kpiForm, setKpiForm] = useState({ usdArsRate: '', cacUsdMin: '', cacUsdMax: '', ltvCacRatio: '' });

  useEffect(() => {
    if (businessSettings && !editingKpis) {
      setKpiForm({
        usdArsRate: String(businessSettings.usdArsRate),
        cacUsdMin: String(businessSettings.cacUsdMin),
        cacUsdMax: String(businessSettings.cacUsdMax),
        ltvCacRatio: String(businessSettings.ltvCacRatio),
      });
    }
  }, [businessSettings, editingKpis]);

  const saveBusinessSettingsMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        usdArsRate: Number(kpiForm.usdArsRate),
        cacUsdMin: Number(kpiForm.cacUsdMin),
        cacUsdMax: Number(kpiForm.cacUsdMax),
        ltvCacRatio: Number(kpiForm.ltvCacRatio),
      };
      return fetchWithAuth('/admin/business-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      toast({ title: 'Valores actualizados', description: 'El tipo de cambio y las estimaciones se guardaron correctamente.' });
      setEditingKpis(false);
      queryClient.invalidateQueries({ queryKey: ['/api/admin/business-settings'] });
      queryClient.invalidateQueries({ queryKey: ['/api/admin/metrics'] });
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message || 'No se pudieron guardar los valores', variant: 'destructive' });
    },
  });

  const { data: acquisitionSpends = [] } = useQuery<AcquisitionSpend[]>({
    queryKey: ['/api/admin/acquisition-spend'],
    queryFn: () => fetchWithAuth('/admin/acquisition-spend'),
  });

  const [spendForm, setSpendForm] = useState({ month: '', amountArs: '' });

  const saveSpendMutation = useMutation({
    mutationFn: async (payload: { month: string; amountArs: number }) => {
      return fetchWithAuth('/admin/acquisition-spend', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      toast({ title: 'Gasto guardado', description: 'El gasto de adquisición del mes se guardó correctamente.' });
      setSpendForm({ month: '', amountArs: '' });
      queryClient.invalidateQueries({ queryKey: ['/api/admin/acquisition-spend'] });
      queryClient.invalidateQueries({ queryKey: ['/api/admin/metrics'] });
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message || 'No se pudo guardar el gasto', variant: 'destructive' });
    },
  });

  const deleteSpendMutation = useMutation({
    mutationFn: async (month: string) => {
      return fetchWithAuth(`/admin/acquisition-spend/${month}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      toast({ title: 'Gasto eliminado', description: 'Se eliminó el gasto de adquisición del mes.' });
      queryClient.invalidateQueries({ queryKey: ['/api/admin/acquisition-spend'] });
      queryClient.invalidateQueries({ queryKey: ['/api/admin/metrics'] });
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message || 'No se pudo eliminar el gasto', variant: 'destructive' });
    },
  });

  // ===== Derivación automática del gasto de adquisición (Task #433) =====
  const [acqForm, setAcqForm] = useState<AcquisitionConfig>({
    acquisitionAutoEnabled: false,
    acquisitionOrgId: null,
    acquisitionAccountIds: [],
    acquisitionCategories: [],
    acquisitionProfitabilityCodeIds: [],
  });

  const { data: acquisitionConfig } = useQuery<AcquisitionConfig>({
    queryKey: ['/api/admin/acquisition-config'],
    queryFn: () => fetchWithAuth('/admin/acquisition-config'),
  });

  useEffect(() => {
    if (acquisitionConfig) {
      setAcqForm({
        acquisitionAutoEnabled: acquisitionConfig.acquisitionAutoEnabled,
        acquisitionOrgId: acquisitionConfig.acquisitionOrgId,
        acquisitionAccountIds: acquisitionConfig.acquisitionAccountIds || [],
        acquisitionCategories: acquisitionConfig.acquisitionCategories || [],
        acquisitionProfitabilityCodeIds: acquisitionConfig.acquisitionProfitabilityCodeIds || [],
      });
    }
  }, [acquisitionConfig]);

  const { data: adminOrgs = [] } = useQuery<AdminOrganization[]>({
    queryKey: ['/api/admin/organizations'],
    queryFn: () => fetchWithAuth('/admin/organizations'),
  });

  const { data: acqOptions } = useQuery<AcquisitionConfigOptions>({
    queryKey: ['/api/admin/acquisition-config/options', acqForm.acquisitionOrgId],
    queryFn: () => fetchWithAuth(`/admin/acquisition-config/options?orgId=${acqForm.acquisitionOrgId}`),
    enabled: !!acqForm.acquisitionOrgId,
  });

  const { data: derivedSpend } = useQuery<DerivedSpendResponse>({
    queryKey: ['/api/admin/acquisition-spend/derived'],
    queryFn: () => fetchWithAuth('/admin/acquisition-spend/derived'),
  });

  const saveAcqConfigMutation = useMutation({
    mutationFn: async (payload: AcquisitionConfig) => {
      return fetchWithAuth('/admin/acquisition-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      toast({ title: 'Configuración guardada', description: 'La derivación automática del gasto de adquisición se guardó correctamente.' });
      queryClient.invalidateQueries({ queryKey: ['/api/admin/acquisition-config'] });
      queryClient.invalidateQueries({ queryKey: ['/api/admin/acquisition-spend/derived'] });
      queryClient.invalidateQueries({ queryKey: ['/api/admin/metrics'] });
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message || 'No se pudo guardar la configuración', variant: 'destructive' });
    },
  });

  const toggleAcqId = (field: 'acquisitionAccountIds' | 'acquisitionCategories' | 'acquisitionProfitabilityCodeIds', id: string) => {
    setAcqForm((f) => {
      const set = new Set(f[field]);
      if (set.has(id)) set.delete(id); else set.add(id);
      return { ...f, [field]: Array.from(set) };
    });
  };

  const { data: sessionLogs = [], isLoading: loadingSessions, refetch: refetchSessions } = useQuery<SessionLog[]>({
    queryKey: ['/api/admin/session-logs'],
    queryFn: () => fetchWithAuth('/admin/session-logs'),
  });

  const { data: systemErrors = [], isLoading: loadingErrors, refetch: refetchErrors } = useQuery<SystemError[]>({
    queryKey: ['/api/admin/system-errors', errorStatusFilter],
    queryFn: () => fetchWithAuth(`/admin/system-errors?status=${errorStatusFilter}`),
  });

  const updateErrorStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: ErrorStatusFilter }) => {
      return fetchWithAuth(`/admin/system-errors/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    },
    onSuccess: (_data, variables) => {
      const labels: Record<ErrorStatusFilter, string> = {
        open: 'Error reabierto',
        resolved: 'Error marcado como solucionado',
        archived: 'Error archivado',
      };
      toast({ title: labels[variables.status] });
      setSelectedError(null);
      queryClient.invalidateQueries({ queryKey: ['/api/admin/system-errors'] });
    },
    onError: (error: any) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo actualizar el estado del error',
        variant: 'destructive',
      });
    },
  });

  const runMrrSnapshotMutation = useMutation({
    mutationFn: async () => {
      return fetchWithAuth('/admin/mrr-snapshots/run', {
        method: 'POST',
      });
    },
    onSuccess: () => {
      toast({ title: 'Snapshot del MRR actualizado' });
      queryClient.invalidateQueries({ queryKey: ['/api/admin/mrr-snapshots'] });
    },
    onError: (error: any) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo actualizar el snapshot del MRR',
        variant: 'destructive',
      });
    },
  });

  const sendNotificationMutation = useMutation({
    mutationFn: async (data: { 
      title: string; 
      message: string; 
      userIds: string[] | 'all'; 
      sendMethod: 'app' | 'email' | 'both';
      imageUrl?: string | null;
      attachmentUrl?: string | null;
      attachmentName?: string | null;
    }) => {
      return fetchWithAuth('/admin/notifications/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    },
    onSuccess: (data: any) => {
      toast({
        title: 'Notificación enviada',
        description: `Se enviaron ${data.notificationsSent} notificaciones${data.emailsSent > 0 ? ` y ${data.emailsSent} emails` : ''}`,
      });
      setPreviewOpen(false);
      setNotifTitle('');
      setNotifMessage('');
      setSelectedUserIds([]);
      setSendMethod('app');
      clearImage();
      clearAttachment();
    },
    onError: (error: any) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo enviar la notificación',
        variant: 'destructive',
      });
    },
  });

  const generateResetLinkMutation = useMutation({
    mutationFn: async (data: { email: string; sendEmail: boolean }) => {
      return fetchWithAuth('/admin/generate-reset-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    },
    onSuccess: (data: any) => {
      setResetResult({
        email: data.email,
        name: data.name,
        resetLink: data.resetLink,
        expiresAt: data.expiresAt,
      });
      setLinkCopied(false);
      toast({
        title: 'Link generado',
        description: data.emailSent === true
          ? 'El link se generó y también se envió por email.'
          : 'El link se generó. Copialo y enviáselo al cliente.',
      });
    },
    onError: (error: any) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo generar el link',
        variant: 'destructive',
      });
    },
  });

  const handleCopyResetLink = async () => {
    if (!resetResult) return;
    try {
      await navigator.clipboard.writeText(resetResult.resetLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
      toast({ title: 'Copiado', description: 'El link se copió al portapapeles' });
    } catch {
      toast({ title: 'Error', description: 'No se pudo copiar automáticamente, copialo a mano', variant: 'destructive' });
    }
  };

  const handleSendNotification = () => {
    if (!notifTitle.trim() || !notifMessage.trim()) {
      toast({
        title: 'Campos requeridos',
        description: 'Por favor completá el título y el mensaje',
        variant: 'destructive',
      });
      return;
    }
    if (notifRecipients === 'selected' && selectedUserIds.length === 0) {
      toast({
        title: 'Seleccioná usuarios',
        description: 'Debés seleccionar al menos un usuario',
        variant: 'destructive',
      });
      return;
    }
    setPreviewOpen(true);
  };

  const confirmAndSend = () => {
    sendNotificationMutation.mutate({
      title: notifTitle,
      message: notifMessage,
      userIds: notifRecipients === 'all' ? 'all' : selectedUserIds,
      sendMethod,
      imageUrl: uploadedImageUrl,
      attachmentUrl: uploadedAttachmentUrl,
      attachmentName: notifAttachment?.name || null,
    });
  };

  const toggleUserSelection = (userId: string) => {
    setSelectedUserIds(prev => 
      prev.includes(userId) 
        ? prev.filter(id => id !== userId)
        : [...prev, userId]
    );
  };

  const matchesMetricFilter = (user: AdminUser): boolean => userMatchesFilter(user, metricFilter);

  const matchesPlanFilter = (user: AdminUser): boolean => {
    if (!planFilter) return true;
    return user.subscription?.planType === planFilter;
  };

  const matchesPhoneFilter = (user: AdminUser): boolean => {
    if (!phoneFilter) return true;
    const hasPhone = !!(user.phoneNumber && user.phoneNumber.trim().length > 0);
    switch (phoneFilter) {
      case 'has_phone':
        return hasPhone;
      case 'verified':
        return hasPhone && !!user.phoneVerified;
      case 'pending':
        return hasPhone && !user.phoneVerified;
      default:
        return true;
    }
  };

  const normalizePhone = (s: string | null | undefined): string =>
    (s || '').replace(/[^\d]/g, '');

  const formatPhoneDisplay = (phone: string | null | undefined): string => {
    if (!phone) return '';
    const digits = normalizePhone(phone);
    if (digits.startsWith('549') && digits.length >= 12) {
      const area = digits.slice(3, digits.length - 8);
      const first = digits.slice(-8, -4);
      const last = digits.slice(-4);
      return `+54 9 ${area} ${first}-${last}`;
    }
    if (digits.startsWith('54') && digits.length >= 11) {
      const area = digits.slice(2, digits.length - 8);
      const first = digits.slice(-8, -4);
      const last = digits.slice(-4);
      return `+54 ${area} ${first}-${last}`;
    }
    if (digits.length === 0) return phone;
    return phone.startsWith('+') ? phone : `+${digits}`;
  };

  const filteredUsers = users.filter(user => {
    const term = searchTerm.toLowerCase().trim();
    if (!term) {
      return matchesMetricFilter(user) && matchesPlanFilter(user) && matchesPhoneFilter(user);
    }
    const matchesEmailOrName =
      user.email.toLowerCase().includes(term) ||
      user.name.toLowerCase().includes(term);
    const termDigits = normalizePhone(searchTerm);
    const matchesPhone =
      termDigits.length > 0 && normalizePhone(user.phoneNumber).includes(termDigits);
    const matchesSearch = matchesEmailOrName || matchesPhone;
    return matchesSearch && matchesMetricFilter(user) && matchesPlanFilter(user) && matchesPhoneFilter(user);
  }).sort((a, b) => {
    if (a.deletedAt && !b.deletedAt) return 1;
    if (!a.deletedAt && b.deletedAt) return -1;
    return 0;
  });

  // Usuarios que pertenecen a la métrica de la tarjeta clickeada. Usa el mismo
  // criterio (`userMatchesFilter`) que el conteo de la tarjeta, sin aplicar el
  // buscador ni los filtros de plan/celular de la lista de abajo: así el total
  // del modal coincide siempre con el número de la tarjeta.
  const cardModalUsers = cardModalMetric
    ? users
        .filter(user => userMatchesFilter(user, cardModalMetric))
        .sort((a, b) => {
          if (a.deletedAt && !b.deletedAt) return 1;
          if (!a.deletedAt && b.deletedAt) return -1;
          return 0;
        })
    : [];

  const refreshAll = () => {
    refetchUsers();
    refetchMetrics();
    refetchSessions();
    refetchErrors();
  };

  const getStatusBadge = (user: AdminUser) => {
    if (user.deletedAt) {
      return <Badge variant="destructive" className="bg-gray-600">Eliminada</Badge>;
    }
    if (!user.subscription) {
      return <Badge variant="outline" className="text-gray-500 dark:text-slate-400">Sin suscripción</Badge>;
    }
    if (user.subscription.paymentFailedAt) {
      return <Badge variant="destructive">Pago fallido</Badge>;
    }
    if (user.subscription.cancelAtPeriodEnd) {
      return <Badge variant="secondary" className="text-yellow-600">Cancelará</Badge>;
    }
    if (user.subscription.status === 'active') {
      return <Badge className="bg-green-500">Activo</Badge>;
    }
    return <Badge variant="outline">{user.subscription.status}</Badge>;
  };

  const getPlanBadge = (planType: string | undefined) => {
    if (!planType) return null;
    const colors: Record<string, string> = {
      personal: 'bg-blue-100 text-blue-700',
      personal_pro: 'bg-purple-100 text-purple-700',
      solo: 'bg-cyan-100 text-cyan-700',
      team: 'bg-green-100 text-green-700',
      business: 'bg-orange-100 text-orange-700',
      enterprise: 'bg-pink-100 text-pink-700',
    };
    return (
      <Badge className={colors[planType] || 'bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-200'}>
        {planType.replace('_', ' ')}
      </Badge>
    );
  };

  if (loadingUsers || loadingMetrics) {
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-28" />)}
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold">Panel de Administración</h1>
          <p className="text-sm text-muted-foreground">Vista exclusiva para el dueño de la app</p>
        </div>
        <Button onClick={refreshAll} variant="outline" size="sm" className="w-full sm:w-auto">
          <RefreshCw className="h-4 w-4 mr-2" />
          Actualizar
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4 auto-rows-fr">
        <Card
          className={`h-full overflow-hidden cursor-pointer transition-all hover:shadow-md ${metricFilter === 'total' ? 'ring-2 ring-blue-500 shadow-md' : ''}`}
          onClick={() => dispatchModal({ type: 'open', metric: 'total' })}
          data-testid="card-metric-total"
        >
          <CardContent className="p-4 sm:pt-6 h-full">
            <div className="flex items-start justify-between gap-2 h-full">
              <div className="min-w-0">
                <p className="text-xs sm:text-sm text-muted-foreground leading-tight min-h-[2.25rem]">Total Usuarios</p>
                <p className="text-2xl sm:text-3xl font-bold">{metrics?.totalUsers || 0}</p>
              </div>
              <Users className="h-6 w-6 sm:h-8 sm:w-8 text-blue-500 flex-shrink-0" />
            </div>
          </CardContent>
        </Card>

        <Card
          className={`h-full overflow-hidden cursor-pointer transition-all hover:shadow-md ${metricFilter === 'active' ? 'ring-2 ring-green-500 shadow-md' : ''}`}
          onClick={() => dispatchModal({ type: 'open', metric: 'active' })}
          data-testid="card-metric-active"
        >
          <CardContent className="p-4 sm:pt-6 h-full">
            <div className="flex items-start justify-between gap-2 h-full">
              <div className="min-w-0">
                <p className="text-xs sm:text-sm text-muted-foreground leading-tight min-h-[2.25rem]">Suscripciones Activas</p>
                <p className="text-2xl sm:text-3xl font-bold text-green-600">{metrics?.activeSubscriptions || 0}</p>
              </div>
              <CreditCard className="h-6 w-6 sm:h-8 sm:w-8 text-green-500 flex-shrink-0" />
            </div>
          </CardContent>
        </Card>

        <Card
          className={`h-full overflow-hidden cursor-pointer transition-all hover:shadow-md ${metricFilter === 'trial' ? 'ring-2 ring-cyan-500 shadow-md' : ''}`}
          onClick={() => dispatchModal({ type: 'open', metric: 'trial' })}
          data-testid="card-metric-trial"
        >
          <CardContent className="p-4 sm:pt-6 h-full">
            <div className="flex items-start justify-between gap-2 h-full">
              <div className="min-w-0">
                <p className="text-xs sm:text-sm text-muted-foreground leading-tight min-h-[2.25rem]">En Prueba</p>
                <p className="text-2xl sm:text-3xl font-bold text-cyan-600" data-testid="text-trialing-count">{metrics?.trialingSubscriptions || 0}</p>
              </div>
              <Clock className="h-6 w-6 sm:h-8 sm:w-8 text-cyan-500 flex-shrink-0" />
            </div>
          </CardContent>
        </Card>

        <Card
          className={`h-full overflow-hidden cursor-pointer transition-all hover:shadow-md ${metricFilter === 'payment_failed' ? 'ring-2 ring-red-500 shadow-md' : ''}`}
          onClick={() => dispatchModal({ type: 'open', metric: 'payment_failed' })}
          data-testid="card-metric-payment-failed"
        >
          <CardContent className="p-4 sm:pt-6 h-full">
            <div className="flex items-start justify-between gap-2 h-full">
              <div className="min-w-0">
                <p className="text-xs sm:text-sm text-muted-foreground leading-tight min-h-[2.25rem]">Pagos Fallidos</p>
                <p className="text-2xl sm:text-3xl font-bold text-red-600">{metrics?.paymentFailures || 0}</p>
              </div>
              <AlertCircle className="h-6 w-6 sm:h-8 sm:w-8 text-red-500 flex-shrink-0" />
            </div>
          </CardContent>
        </Card>

        <Card
          className={`h-full overflow-hidden cursor-pointer transition-all hover:shadow-md ${metricFilter === 'cancel_scheduled' ? 'ring-2 ring-amber-500 shadow-md' : ''}`}
          onClick={() => dispatchModal({ type: 'open', metric: 'cancel_scheduled' })}
          data-testid="card-metric-cancel-scheduled"
        >
          <CardContent className="p-4 sm:pt-6 h-full">
            <div className="flex items-start justify-between gap-2 h-full">
              <div className="min-w-0">
                <p className="text-xs sm:text-sm text-muted-foreground leading-tight min-h-[2.25rem]">Cancelarán (baja agendada)</p>
                <p className="text-2xl sm:text-3xl font-bold text-amber-600" data-testid="text-cancel-scheduled-count">{metrics?.cancelScheduledSubscriptions || 0}</p>
              </div>
              <CalendarClock className="h-6 w-6 sm:h-8 sm:w-8 text-amber-500 flex-shrink-0" />
            </div>
          </CardContent>
        </Card>

        <Card
          className={`h-full overflow-hidden cursor-pointer transition-all hover:shadow-md ${metricFilter === 'cancelled' ? 'ring-2 ring-yellow-500 shadow-md' : ''}`}
          onClick={() => dispatchModal({ type: 'open', metric: 'cancelled' })}
          data-testid="card-metric-cancelled"
        >
          <CardContent className="p-4 sm:pt-6 h-full">
            <div className="flex items-start justify-between gap-2 h-full">
              <div className="min-w-0">
                <p className="text-xs sm:text-sm text-muted-foreground leading-tight min-h-[2.25rem]">Cancelaciones</p>
                <p className="text-2xl sm:text-3xl font-bold text-yellow-600">{metrics?.cancelledSubscriptions || 0}</p>
                {metrics?.churn?.hasEnoughData && metrics.churn.monthlyRatePct != null && (
                  <p className="text-[11px] text-muted-foreground mt-1" data-testid="text-churn-rate">
                    Churn mensual real {metrics.churn.monthlyRatePct.toFixed(1)}%
                  </p>
                )}
              </div>
              <XCircle className="h-6 w-6 sm:h-8 sm:w-8 text-yellow-500 flex-shrink-0" />
            </div>
          </CardContent>
        </Card>

        <Card
          className="h-full overflow-hidden"
          data-testid="card-metric-deleted-non-payment"
        >
          <CardContent className="p-4 sm:pt-6 h-full">
            <div className="flex items-start justify-between gap-2 h-full">
              <div className="min-w-0">
                <p className="text-xs sm:text-sm text-muted-foreground leading-tight min-h-[2.25rem]">Eliminadas por falta de pago</p>
                <p className="text-2xl sm:text-3xl font-bold text-rose-600" data-testid="text-deleted-non-payment-count">{metrics?.deletedForNonPayment || 0}</p>
                <p className="text-[11px] text-muted-foreground mt-1">Total registrado desde la activación del seguimiento.</p>
              </div>
              <Trash2 className="h-6 w-6 sm:h-8 sm:w-8 text-rose-500 flex-shrink-0" />
            </div>
          </CardContent>
        </Card>
      </div>

      <MetricUsersModal
        metric={cardModalMetric}
        maximized={cardModalMaximized}
        selectedUser={selectedModalUser}
        users={cardModalUsers}
        dispatch={dispatchModal}
        renderPlanBadge={getPlanBadge}
        renderStatusBadge={getStatusBadge}
        formatPhoneDisplay={formatPhoneDisplay}
      />

      {metrics?.subscriptionsByPlan && Object.keys(metrics.subscriptionsByPlan).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Distribución por Plan</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-4">
              {Object.entries(metrics.subscriptionsByPlan).map(([plan, count]) => (
                <div
                  key={plan}
                  className={`flex items-center gap-2 cursor-pointer rounded-md px-2 py-1 transition-all ${planFilter === plan ? 'ring-2 ring-primary bg-muted shadow-sm' : 'hover:bg-muted/50'}`}
                  onClick={() => setPlanFilter(planFilter === plan ? null : plan)}
                  data-testid={`filter-plan-${plan}`}
                >
                  {getPlanBadge(plan)}
                  <span className="font-semibold">{count}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3" data-testid="section-business-kpis">
        <div className="flex flex-wrap items-center gap-2">
          <TrendingUp className="h-5 w-5 text-cyan-500" />
          <h2 className="text-lg font-semibold">KPIs de negocio</h2>
          {metrics?.revenue?.usdArsRate ? (
            <span className="text-xs text-muted-foreground">
              (USD estimado a ${new Intl.NumberFormat('es-AR').format(metrics.revenue.usdArsRate)} por dólar)
            </span>
          ) : null}
          {!editingKpis && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => setEditingKpis(true)}
              data-testid="button-edit-kpis"
            >
              <Pencil className="h-3.5 w-3.5 mr-1.5" />
              Editar valores
            </Button>
          )}
        </div>

        {editingKpis && (
          <Card data-testid="card-edit-kpis">
            <CardContent className="p-4 space-y-4">
              <p className="text-sm text-muted-foreground">
                Editá el tipo de cambio USD/ARS de referencia y las estimaciones de negocio. Estos valores se guardan y tienen prioridad sobre los valores por defecto del sistema.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="kpi-usd-rate">Tipo de cambio USD/ARS</Label>
                  <div className="relative">
                    <span aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">$</span>
                    <Input
                      id="kpi-usd-rate"
                      type="number"
                      min="0"
                      step="any"
                      value={kpiForm.usdArsRate}
                      onChange={(e) => setKpiForm((f) => ({ ...f, usdArsRate: e.target.value }))}
                      className="pl-7"
                      data-testid="input-usd-ars-rate"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">Pesos por dólar.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="kpi-cac-min">CAC mínimo (USD)</Label>
                  <Input
                    id="kpi-cac-min"
                    type="number"
                    min="0"
                    step="any"
                    value={kpiForm.cacUsdMin}
                    onChange={(e) => setKpiForm((f) => ({ ...f, cacUsdMin: e.target.value }))}
                    data-testid="input-cac-min"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="kpi-cac-max">CAC máximo (USD)</Label>
                  <Input
                    id="kpi-cac-max"
                    type="number"
                    min="0"
                    step="any"
                    value={kpiForm.cacUsdMax}
                    onChange={(e) => setKpiForm((f) => ({ ...f, cacUsdMax: e.target.value }))}
                    data-testid="input-cac-max"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="kpi-ltv-cac">Ratio LTV / CAC</Label>
                  <Input
                    id="kpi-ltv-cac"
                    type="number"
                    min="0"
                    step="any"
                    value={kpiForm.ltvCacRatio}
                    onChange={(e) => setKpiForm((f) => ({ ...f, ltvCacRatio: e.target.value }))}
                    data-testid="input-ltv-cac-ratio"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => saveBusinessSettingsMutation.mutate()}
                  disabled={saveBusinessSettingsMutation.isPending}
                  data-testid="button-save-kpis"
                >
                  <Save className="h-4 w-4 mr-1.5" />
                  {saveBusinessSettingsMutation.isPending ? 'Guardando...' : 'Guardar'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setEditingKpis(false)}
                  disabled={saveBusinessSettingsMutation.isPending}
                  data-testid="button-cancel-kpis"
                >
                  Cancelar
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Gasto de adquisición por mes — base del CAC real */}
        <Card data-testid="card-acquisition-spend">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Calculator className="h-5 w-5 text-cyan-500" />
              <CardTitle className="text-lg">Gasto de adquisición por mes</CardTitle>
            </div>
            <CardDescription>
              Registrá cuánto gastaste en adquirir clientes (marketing/ventas) cada mes, en pesos. Con esto el CAC se calcula con datos reales: gasto del período dividido por las altas del período.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="spend-month">Mes</Label>
                <Input
                  id="spend-month"
                  type="month"
                  value={spendForm.month}
                  onChange={(e) => setSpendForm((f) => ({ ...f, month: e.target.value }))}
                  data-testid="input-spend-month"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="spend-amount">Gasto (ARS)</Label>
                <div className="relative">
                  <span aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">$</span>
                  <Input
                    id="spend-amount"
                    type="number"
                    min="0"
                    step="any"
                    placeholder="0"
                    value={spendForm.amountArs}
                    onChange={(e) => setSpendForm((f) => ({ ...f, amountArs: e.target.value }))}
                    className="pl-7"
                    data-testid="input-spend-amount"
                  />
                </div>
              </div>
              <Button
                onClick={() => {
                  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(spendForm.month)) {
                    toast({ title: 'Mes inválido', description: 'Elegí un mes válido.', variant: 'destructive' });
                    return;
                  }
                  const amount = Number(spendForm.amountArs);
                  if (!Number.isFinite(amount) || amount < 0) {
                    toast({ title: 'Monto inválido', description: 'Ingresá un monto válido en pesos.', variant: 'destructive' });
                    return;
                  }
                  saveSpendMutation.mutate({ month: spendForm.month, amountArs: amount });
                }}
                disabled={saveSpendMutation.isPending}
                data-testid="button-save-spend"
              >
                <Save className="h-4 w-4 mr-1.5" />
                {saveSpendMutation.isPending ? 'Guardando...' : 'Guardar mes'}
              </Button>
            </div>

            {acquisitionSpends.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="empty-acquisition-spend">
                Todavía no cargaste ningún gasto de adquisición. Mientras tanto, el CAC se muestra como estimación.
              </p>
            ) : (
              <div className="divide-y border rounded-md" data-testid="list-acquisition-spend">
                {acquisitionSpends.map((spend) => (
                  <div
                    key={spend.month}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                    data-testid={`row-spend-${spend.month}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-sm font-medium tabular-nums" data-testid={`text-spend-month-${spend.month}`}>{spend.month}</span>
                      <span className="text-sm text-muted-foreground tabular-nums" data-testid={`text-spend-amount-${spend.month}`}>{fmtArs(spend.amountArs)}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSpendForm({ month: spend.month, amountArs: String(spend.amountArs) })}
                        data-testid={`button-edit-spend-${spend.month}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteSpendMutation.mutate(spend.month)}
                        disabled={deleteSpendMutation.isPending}
                        data-testid={`button-delete-spend-${spend.month}`}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Derivación automática del gasto de adquisición desde gastos etiquetados */}
        <Card data-testid="card-acquisition-config">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Calculator className="h-5 w-5 text-cyan-500" />
              <CardTitle className="text-lg">Derivación automática del gasto</CardTitle>
            </div>
            <CardDescription>
              En vez de cargar el gasto a mano, elegí una organización (tus libros propios dentro de la app) y marcá qué cuentas, categorías de gasto o códigos de análisis cuentan como gasto de adquisición. El gasto por mes se suma solo a partir de esos movimientos. La carga manual de un mes tiene prioridad sobre el derivado, así nunca se duplica.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <Switch
                id="acq-auto-enabled"
                checked={acqForm.acquisitionAutoEnabled}
                onCheckedChange={(checked) => setAcqForm((f) => ({ ...f, acquisitionAutoEnabled: checked }))}
                data-testid="switch-acq-auto-enabled"
              />
              <Label htmlFor="acq-auto-enabled">Calcular el gasto de adquisición automáticamente</Label>
            </div>

            <div className="space-y-1.5 max-w-sm">
              <Label htmlFor="acq-org">Organización (libros propios)</Label>
              <Select
                value={acqForm.acquisitionOrgId ?? ''}
                onValueChange={(value) => setAcqForm((f) => ({
                  ...f,
                  acquisitionOrgId: value,
                  // Al cambiar de organización, las etiquetas anteriores ya no
                  // aplican (los ids son de otra organización).
                  acquisitionAccountIds: [],
                  acquisitionCategories: [],
                  acquisitionProfitabilityCodeIds: [],
                }))}
              >
                <SelectTrigger id="acq-org" data-testid="select-acq-org">
                  <SelectValue placeholder="Elegí una organización" />
                </SelectTrigger>
                <SelectContent>
                  {adminOrgs.map((org) => (
                    <SelectItem key={org.id} value={org.id} data-testid={`option-acq-org-${org.id}`}>
                      {org.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {acqForm.acquisitionOrgId && acqOptions && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <p className="text-sm font-medium">Cuentas</p>
                  <div className="border rounded-md divide-y max-h-48 overflow-y-auto" data-testid="list-acq-accounts">
                    {acqOptions.accounts.length === 0 ? (
                      <p className="text-xs text-muted-foreground p-2">Sin cuentas.</p>
                    ) : acqOptions.accounts.map((a) => (
                      <label key={a.id} className="flex items-center gap-2 px-2 py-1.5 cursor-pointer text-sm">
                        <Checkbox
                          checked={acqForm.acquisitionAccountIds.includes(a.id)}
                          onCheckedChange={() => toggleAcqId('acquisitionAccountIds', a.id)}
                          data-testid={`checkbox-acq-account-${a.id}`}
                        />
                        <span className="truncate">{a.name} <span className="text-muted-foreground">({a.currency})</span></span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">Categorías de gasto</p>
                  <div className="border rounded-md divide-y max-h-48 overflow-y-auto" data-testid="list-acq-categories">
                    {acqOptions.categories.length === 0 ? (
                      <p className="text-xs text-muted-foreground p-2">Sin categorías.</p>
                    ) : acqOptions.categories.map((c) => (
                      <label key={c.name} className="flex items-center gap-2 px-2 py-1.5 cursor-pointer text-sm">
                        <Checkbox
                          checked={acqForm.acquisitionCategories.includes(c.name)}
                          onCheckedChange={() => toggleAcqId('acquisitionCategories', c.name)}
                          data-testid={`checkbox-acq-category-${c.name}`}
                        />
                        <span className="truncate">{c.name}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">Códigos de análisis</p>
                  <div className="border rounded-md divide-y max-h-48 overflow-y-auto" data-testid="list-acq-codes">
                    {acqOptions.profitabilityCodes.length === 0 ? (
                      <p className="text-xs text-muted-foreground p-2">Sin códigos.</p>
                    ) : acqOptions.profitabilityCodes.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 px-2 py-1.5 cursor-pointer text-sm">
                        <Checkbox
                          checked={acqForm.acquisitionProfitabilityCodeIds.includes(c.id)}
                          onCheckedChange={() => toggleAcqId('acquisitionProfitabilityCodeIds', c.id)}
                          data-testid={`checkbox-acq-code-${c.id}`}
                        />
                        <span className="truncate">{c.code} — {c.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <Button
              onClick={() => {
                if (acqForm.acquisitionAutoEnabled && !acqForm.acquisitionOrgId) {
                  toast({ title: 'Falta la organización', description: 'Elegí una organización para derivar el gasto automáticamente.', variant: 'destructive' });
                  return;
                }
                saveAcqConfigMutation.mutate(acqForm);
              }}
              disabled={saveAcqConfigMutation.isPending}
              data-testid="button-save-acq-config"
            >
              <Save className="h-4 w-4 mr-1.5" />
              {saveAcqConfigMutation.isPending ? 'Guardando...' : 'Guardar configuración'}
            </Button>

            {derivedSpend && derivedSpend.months.length > 0 && (
              <div className="space-y-2 pt-2">
                <p className="text-sm font-medium">Gasto por mes que usa el CAC (manual + automático)</p>
                <div className="divide-y border rounded-md" data-testid="list-derived-spend">
                  {derivedSpend.months.map((m) => (
                    <div
                      key={m.month}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                      data-testid={`row-derived-${m.month}`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-sm font-medium tabular-nums">{m.month}</span>
                        <span className="text-sm text-muted-foreground tabular-nums">{fmtArs(m.amountArs)}</span>
                      </div>
                      <Badge variant={m.source === 'manual' ? 'secondary' : 'outline'} className="text-[10px]" data-testid={`badge-derived-source-${m.month}`}>
                        {m.source === 'manual' ? 'Manual' : 'Automático'}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {/* MRR — dato real */}
          <Card className="overflow-hidden" data-testid="card-kpi-mrr">
            <CardContent className="p-4 sm:pt-6">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-xs sm:text-sm text-muted-foreground">MRR</p>
                    <Badge variant="secondary" className="text-[10px]">Datos reales</Badge>
                  </div>
                  <p className="text-2xl sm:text-3xl font-bold" data-testid="text-mrr-ars">{fmtArs(metrics?.revenue?.mrrArs || 0)}</p>
                  <p className="text-sm text-muted-foreground" data-testid="text-mrr-usd">≈ {fmtUsd(metrics?.revenue?.mrrUsd || 0)}</p>
                  <p className="text-[11px] text-muted-foreground mt-1">Ingreso mensual recurrente de las suscripciones activas.</p>
                </div>
                <DollarSign className="h-6 w-6 sm:h-8 sm:w-8 text-cyan-500 flex-shrink-0" />
              </div>
            </CardContent>
          </Card>

          {/* ARR — dato real */}
          <Card className="overflow-hidden" data-testid="card-kpi-arr">
            <CardContent className="p-4 sm:pt-6">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-xs sm:text-sm text-muted-foreground">ARR</p>
                    <Badge variant="secondary" className="text-[10px]">Datos reales</Badge>
                  </div>
                  <p className="text-2xl sm:text-3xl font-bold" data-testid="text-arr-ars">{fmtArs(metrics?.revenue?.arrArs || 0)}</p>
                  <p className="text-sm text-muted-foreground" data-testid="text-arr-usd">≈ {fmtUsd(metrics?.revenue?.arrUsd || 0)}</p>
                  <p className="text-[11px] text-muted-foreground mt-1">Ingreso anual recurrente (MRR x 12).</p>
                </div>
                <TrendingUp className="h-6 w-6 sm:h-8 sm:w-8 text-cyan-500 flex-shrink-0" />
              </div>
            </CardContent>
          </Card>

          {/* ARPU — dato real */}
          <Card className="overflow-hidden" data-testid="card-kpi-arpu">
            <CardContent className="p-4 sm:pt-6">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-xs sm:text-sm text-muted-foreground">Ticket promedio (ARPU)</p>
                    <Badge variant="secondary" className="text-[10px]">Datos reales</Badge>
                  </div>
                  <p className="text-2xl sm:text-3xl font-bold" data-testid="text-arpu-ars">{fmtArs(metrics?.revenue?.arpuArs || 0)}</p>
                  <p className="text-sm text-muted-foreground" data-testid="text-arpu-usd">≈ {fmtUsd(metrics?.revenue?.arpuUsd || 0)}</p>
                  <p className="text-[11px] text-muted-foreground mt-1">MRR dividido por las {metrics?.revenue?.activeCount || 0} suscripciones activas.</p>
                </div>
                <Coins className="h-6 w-6 sm:h-8 sm:w-8 text-cyan-500 flex-shrink-0" />
              </div>
            </CardContent>
          </Card>

          {/* CAC — real cuando hay gasto de adquisición cargado; si no, estimado */}
          {(() => {
            const cac = metrics?.cac;
            const est = metrics?.estimates ?? SAAS_KPI_ESTIMATES;
            const cacReal = cac?.hasEnoughData && cac.cacUsd != null && cac.cacArs != null;
            return (
              <Card className={`overflow-hidden ${cacReal ? '' : 'border-dashed'}`} data-testid="card-kpi-cac">
                <CardContent className="p-4 sm:pt-6">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-xs sm:text-sm text-muted-foreground">CAC</p>
                        <Badge variant="outline" className="text-[10px]">{cacReal ? 'Real' : 'Estimado'}</Badge>
                      </div>
                      {cacReal ? (
                        <>
                          <p className="text-2xl sm:text-3xl font-bold" data-testid="text-cac">{fmtArs(cac!.cacArs!)}</p>
                          <p className="text-sm text-muted-foreground" data-testid="text-cac-usd">≈ {fmtUsd(cac!.cacUsd!)}</p>
                          <p className="text-[11px] text-muted-foreground mt-1">
                            Costo de adquirir un cliente = gasto de adquisición ({fmtArs(cac!.totalSpendArs)}) / {cac!.totalSignups} altas en {cac!.monthsWithSpend} {cac!.monthsWithSpend === 1 ? 'mes' : 'meses'} con gasto.
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="text-2xl sm:text-3xl font-bold" data-testid="text-cac">
                            US$ {est.cacUsdMin}–{est.cacUsdMax}
                          </p>
                          <p className="text-[11px] text-muted-foreground mt-1">Costo de adquirir un cliente. Estimación: cargá el gasto de adquisición por mes para calcularlo con datos reales.</p>
                        </>
                      )}
                    </div>
                    <Calculator className="h-6 w-6 sm:h-8 sm:w-8 text-muted-foreground flex-shrink-0" />
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* LTV — real (ARPU / churn) cuando hay historial; si no, estimado */}
          {(() => {
            const churn = metrics?.churn;
            const est = metrics?.estimates ?? SAAS_KPI_ESTIMATES;
            const ltvReal = churn?.hasEnoughData && churn.ltvUsd != null && churn.ltvArs != null;
            return (
              <Card className={`overflow-hidden ${ltvReal ? '' : 'border-dashed'}`} data-testid="card-kpi-ltv">
                <CardContent className="p-4 sm:pt-6">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-xs sm:text-sm text-muted-foreground">LTV</p>
                        <Badge variant="outline" className="text-[10px]">{ltvReal ? 'Real' : 'Estimado'}</Badge>
                      </div>
                      {ltvReal ? (
                        <>
                          <p className="text-2xl sm:text-3xl font-bold" data-testid="text-ltv">{fmtArs(churn!.ltvArs!)}</p>
                          <p className="text-sm text-muted-foreground" data-testid="text-ltv-usd">≈ {fmtUsd(churn!.ltvUsd!)}</p>
                          <p className="text-[11px] text-muted-foreground mt-1">
                            Valor de vida del cliente = ARPU / churn mensual ({churn!.monthlyRatePct!.toFixed(1)}%). Permanencia media ~{Math.round(churn!.avgLifetimeMonths!)} meses.
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="text-2xl sm:text-3xl font-bold" data-testid="text-ltv">
                            US$ {est.cacUsdMin * est.ltvCacRatio}–{est.cacUsdMax * est.ltvCacRatio}
                          </p>
                          <p className="text-[11px] text-muted-foreground mt-1">Valor de vida del cliente (ticket promedio x permanencia). Estimado: aún no hay suficiente historial de bajas para calcular el churn real.</p>
                        </>
                      )}
                    </div>
                    <Target className="h-6 w-6 sm:h-8 sm:w-8 text-muted-foreground flex-shrink-0" />
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* LTV/CAC — totalmente real cuando hay LTV y CAC reales; si solo hay
              LTV real, usa el CAC estimado; si no, estimación pura. */}
          {(() => {
            const churn = metrics?.churn;
            const cac = metrics?.cac;
            const est = metrics?.estimates ?? SAAS_KPI_ESTIMATES;
            const ltvReal = churn?.hasEnoughData && churn.ltvUsd != null;
            const cacReal = cac?.hasEnoughData && cac.cacUsd != null && cac.cacUsd > 0;
            const fullyReal = ltvReal && cacReal;
            const ratio = fullyReal ? churn!.ltvUsd! / cac!.cacUsd! : null;
            const ratioMax = ltvReal && !cacReal ? churn!.ltvUsd! / est.cacUsdMin : null;
            const ratioMin = ltvReal && !cacReal ? churn!.ltvUsd! / est.cacUsdMax : null;
            const badge = fullyReal ? 'Real' : ltvReal ? 'CAC estimado' : 'Estimado';
            return (
              <Card className={`overflow-hidden ${fullyReal ? '' : 'border-dashed'}`} data-testid="card-kpi-ltv-cac">
                <CardContent className="p-4 sm:pt-6">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-xs sm:text-sm text-muted-foreground">LTV / CAC</p>
                        <Badge variant="outline" className="text-[10px]">{badge}</Badge>
                      </div>
                      {fullyReal ? (
                        <>
                          <p className="text-2xl sm:text-3xl font-bold" data-testid="text-ltv-cac">{Math.round(ratio!)}:1</p>
                          <p className="text-[11px] text-muted-foreground mt-1">LTV real dividido por el CAC real ({fmtUsd(cac!.cacUsd!)}). Relación de eficiencia 100% basada en datos.</p>
                        </>
                      ) : ltvReal ? (
                        <>
                          <p className="text-2xl sm:text-3xl font-bold" data-testid="text-ltv-cac">{Math.round(ratioMin!)}–{Math.round(ratioMax!)}:1</p>
                          <p className="text-[11px] text-muted-foreground mt-1">LTV real dividido por el CAC estimado (US$ {est.cacUsdMin}–{est.cacUsdMax}). Cargá el gasto de adquisición para usar el CAC real.</p>
                        </>
                      ) : (
                        <>
                          <p className="text-2xl sm:text-3xl font-bold" data-testid="text-ltv-cac">{est.ltvCacRatio}:1</p>
                          <p className="text-[11px] text-muted-foreground mt-1">Relación de eficiencia entre valor de vida y costo de adquisición. Estimación.</p>
                        </>
                      )}
                    </div>
                    <Percent className="h-6 w-6 sm:h-8 sm:w-8 text-muted-foreground flex-shrink-0" />
                  </div>
                </CardContent>
              </Card>
            );
          })()}
        </div>
      </div>

      {/* Evolución del MRR en el tiempo */}
      <Card data-testid="card-mrr-evolution">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-cyan-500" />
            <CardTitle className="text-lg">Evolución del MRR</CardTitle>
            <Badge variant="secondary" className="text-[10px]">Datos reales</Badge>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => runMrrSnapshotMutation.mutate()}
              disabled={runMrrSnapshotMutation.isPending}
              data-testid="button-run-mrr-snapshot"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${runMrrSnapshotMutation.isPending ? 'animate-spin' : ''}`} />
              Actualizar ahora
            </Button>
          </div>
          <CardDescription>
            Ingreso mensual recurrente (ARS) y cantidad de suscripciones activas registrados mes a mes. Se guarda un snapshot mensual automáticamente.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadingMrrSnapshots ? (
            <Skeleton className="h-[280px] w-full" />
          ) : mrrSnapshots.length === 0 ? (
            <div className="h-[280px] flex flex-col items-center justify-center text-center gap-1" data-testid="empty-mrr-evolution">
              <TrendingUp className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Todavía no hay snapshots del MRR.</p>
              <p className="text-xs text-muted-foreground">Se registra uno automáticamente cada mes; el primero aparece en breve.</p>
            </div>
          ) : mrrSnapshots.length === 1 ? (
            // Con un solo snapshot no se puede dibujar una línea de evolución
            // (hace falta al menos dos meses). En vez de mostrar un gráfico que
            // se ve vacío, mostramos el valor actual de forma prominente.
            <div className="h-[280px] flex flex-col items-center justify-center gap-4 text-center" data-testid="single-mrr-evolution">
              <p className="text-xs text-muted-foreground">{formatMonthLabel(mrrSnapshots[0].snapshotMonth)}</p>
              <div className="flex flex-wrap items-center justify-center gap-8">
                <div>
                  <p className="text-xs sm:text-sm text-muted-foreground">MRR actual</p>
                  <p className="text-3xl sm:text-4xl font-bold text-primary" data-testid="text-mrr-current">{fmtArs(mrrSnapshots[0].mrrArs)}</p>
                </div>
                <div>
                  <p className="text-xs sm:text-sm text-muted-foreground">Suscripciones activas</p>
                  <p className="text-3xl sm:text-4xl font-bold" data-testid="text-active-subs-current">{mrrSnapshots[0].activeSubscriptions}</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground max-w-md">
                El gráfico de evolución aparece cuando haya al menos dos meses registrados.
              </p>
            </div>
          ) : (
            <div className="h-[280px] w-full" data-testid="chart-mrr-evolution">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={mrrSnapshots} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis
                    dataKey="snapshotMonth"
                    tickFormatter={formatMonthLabel}
                    tick={{ fontSize: 12 }}
                    stroke="currentColor"
                    className="text-muted-foreground"
                  />
                  <YAxis
                    yAxisId="mrr"
                    tickFormatter={(v) => fmtArs(Number(v))}
                    tick={{ fontSize: 12 }}
                    width={90}
                    stroke="currentColor"
                    className="text-muted-foreground"
                  />
                  <YAxis
                    yAxisId="subs"
                    orientation="right"
                    allowDecimals={false}
                    tick={{ fontSize: 12 }}
                    width={40}
                    stroke="currentColor"
                    className="text-muted-foreground"
                  />
                  <RechartsTooltip
                    formatter={(value: any, name: any) =>
                      name === 'Suscripciones activas'
                        ? [Number(value), 'Suscripciones activas']
                        : [fmtArs(Number(value)), 'MRR']
                    }
                    labelFormatter={(label: any) => formatMonthLabel(String(label))}
                    contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    yAxisId="mrr"
                    type="monotone"
                    dataKey="mrrArs"
                    name="MRR"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                  />
                  <Line
                    yAxisId="subs"
                    type="monotone"
                    dataKey="activeSubscriptions"
                    name="Suscripciones activas"
                    stroke="hsl(var(--chart-3))"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="users" className="space-y-4">
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 sticky top-0 md:static bg-background z-20 py-3 shadow-sm border-b border-border/50 md:shadow-none md:border-b-0">
          <TabsList className="w-max sm:w-auto">
            <TabsTrigger value="users" className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm px-2 sm:px-3">
              <Users className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span className="whitespace-nowrap">Usuarios ({users.length})</span>
            </TabsTrigger>
            <TabsTrigger value="sessions" className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm px-2 sm:px-3">
              <Activity className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span className="whitespace-nowrap">Sesiones ({sessionLogs.length})</span>
            </TabsTrigger>
            <TabsTrigger value="notifications" className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm px-2 sm:px-3">
              <Bell className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span className="whitespace-nowrap">Notificaciones</span>
            </TabsTrigger>
            <TabsTrigger value="errors" className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm px-2 sm:px-3">
              <AlertTriangle className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span className="whitespace-nowrap">Errores</span>
            </TabsTrigger>
            <TabsTrigger value="support" className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm px-2 sm:px-3">
              <LifeBuoy className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span className="whitespace-nowrap">Soporte</span>
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="users">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <CardTitle className="text-lg">Lista de Usuarios</CardTitle>
                  {(metricFilter || planFilter || phoneFilter || searchTerm.trim()) && (
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs" data-testid="badge-filter-count">
                        {filteredUsers.length} de {users.length}
                      </Badge>
                      {(metricFilter || planFilter || phoneFilter) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => { setMetricFilter(null); setPlanFilter(null); setPhoneFilter(null); }}
                          data-testid="button-clear-filters"
                        >
                          <X className="h-3 w-3 mr-1" />
                          Limpiar filtros
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <div className="relative w-full sm:w-64">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Buscar por email, nombre o celular..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-9"
                    data-testid="input-admin-search"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-3">
                <span className="text-xs text-muted-foreground mr-1">Estado:</span>
                <Select
                  value={metricFilter ?? 'all'}
                  onValueChange={(v) => setMetricFilter(v === 'all' ? null : (v as MetricFilter))}
                >
                  <SelectTrigger className="h-7 w-[200px] text-xs" data-testid="select-user-status-filter">
                    <SelectValue placeholder="Todos los estados" />
                  </SelectTrigger>
                  <SelectContent>
                    {USER_STATUS_FILTERS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value} className="text-xs" data-testid={`option-status-${opt.value}`}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-3">
                <span className="text-xs text-muted-foreground mr-1">Celular:</span>
                <Button
                  variant={phoneFilter === 'has_phone' ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 px-2 text-xs gap-1"
                  onClick={() => setPhoneFilter(phoneFilter === 'has_phone' ? null : 'has_phone')}
                  data-testid="filter-phone-has"
                >
                  <Smartphone className="h-3 w-3" />
                  Con celular
                </Button>
                <Button
                  variant={phoneFilter === 'verified' ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 px-2 text-xs gap-1"
                  onClick={() => setPhoneFilter(phoneFilter === 'verified' ? null : 'verified')}
                  data-testid="filter-phone-verified"
                >
                  <CheckCircle className="h-3 w-3" />
                  Verificado
                </Button>
                <Button
                  variant={phoneFilter === 'pending' ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 px-2 text-xs gap-1"
                  onClick={() => setPhoneFilter(phoneFilter === 'pending' ? null : 'pending')}
                  data-testid="filter-phone-pending"
                >
                  <Clock className="h-3 w-3" />
                  Pendiente de verificar
                </Button>
              </div>
            </CardHeader>
            <CardContent className="px-3 sm:px-6">
              {/* Mobile view: Cards */}
              <div className="block sm:hidden space-y-3">
                {filteredUsers.map((user) => (
                  <div key={user.id} className="border rounded-lg p-3 space-y-2 bg-muted/20">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{user.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                        <p
                          className="text-xs text-muted-foreground truncate flex items-center gap-1"
                          data-testid={`text-phone-mobile-${user.id}`}
                        >
                          {user.phoneNumber ? (
                            <>
                              <span>{formatPhoneDisplay(user.phoneNumber)}</span>
                              {user.phoneVerified && (
                                <span
                                  className="inline-flex items-center text-[10px] px-1.5 py-0 rounded-full font-medium bg-green-50 text-green-700 border border-green-200"
                                  title="Celular verificado"
                                >
                                  Verificado
                                </span>
                              )}
                            </>
                          ) : (
                            <span>—</span>
                          )}
                        </p>
                        {user.isAdmin && (
                          <Badge variant="outline" className="text-xs mt-1">Admin</Badge>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1 ml-2">
                        {getPlanBadge(user.subscription?.planType)}
                        {getStatusBadge(user)}
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground pt-2 border-t">
                      <span>Registrado: {format(new Date(user.createdAt), 'dd/MM/yyyy', { locale: es })}</span>
                      {user.deletedAt ? (
                        <span className="text-red-400">Eliminada: {format(new Date(user.deletedAt), 'dd/MM/yyyy', { locale: es })}</span>
                      ) : user.subscription?.currentPeriodEnd && (
                        <span>Hasta: {format(new Date(user.subscription.currentPeriodEnd), 'dd/MM/yyyy', { locale: es })}</span>
                      )}
                    </div>
                    <Button
                      variant={user.isAdmin ? "destructive" : "outline"}
                      size="sm"
                      className="w-full"
                      onClick={() => toggleAdminMutation.mutate(user.id)}
                      disabled={toggleAdminMutation.isPending}
                      data-testid={`button-toggle-admin-${user.id}`}
                    >
                      {user.isAdmin ? (
                        <>
                          <ShieldOff className="h-3 w-3 mr-1" />
                          Quitar Admin
                        </>
                      ) : (
                        <>
                          <Shield className="h-3 w-3 mr-1" />
                          Hacer Admin
                        </>
                      )}
                    </Button>
                  </div>
                ))}
                {filteredUsers.length === 0 && (
                  <div className="py-8 text-center text-muted-foreground">
                    No se encontraron usuarios
                  </div>
                )}
              </div>

              {/* Desktop view: Table */}
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-3 px-2">Usuario</th>
                      <th className="text-left py-3 px-2">Celular</th>
                      <th className="text-left py-3 px-2">Plan</th>
                      <th className="text-left py-3 px-2">Estado</th>
                      <th className="text-left py-3 px-2">Registrado</th>
                      <th className="text-left py-3 px-2">Período Actual</th>
                      <th className="text-left py-3 px-2">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map((user) => (
                      <tr key={user.id} className="border-b hover:bg-muted/50">
                        <td className="py-3 px-2">
                          <div>
                            <p className="font-medium">{user.name}</p>
                            <p className="text-xs text-muted-foreground">{user.email}</p>
                            {user.isAdmin && (
                              <Badge variant="outline" className="text-xs mt-1">Admin</Badge>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-2" data-testid={`cell-phone-${user.id}`}>
                          {user.phoneNumber ? (
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs text-foreground/80 whitespace-nowrap">
                                {formatPhoneDisplay(user.phoneNumber)}
                              </span>
                              {user.phoneVerified && (
                                <span
                                  className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-green-50 text-green-700 border border-green-200"
                                  title="Celular verificado"
                                  data-testid={`badge-phone-verified-${user.id}`}
                                >
                                  Verificado
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-3 px-2">
                          {getPlanBadge(user.subscription?.planType)}
                        </td>
                        <td className="py-3 px-2">
                          {getStatusBadge(user)}
                        </td>
                        <td className="py-3 px-2 text-muted-foreground">
                          {format(new Date(user.createdAt), 'dd/MM/yyyy', { locale: es })}
                        </td>
                        <td className="py-3 px-2 text-xs text-muted-foreground">
                          {user.deletedAt ? (
                            <span className="text-red-400">
                              Eliminada {format(new Date(user.deletedAt), 'dd/MM/yyyy', { locale: es })}
                            </span>
                          ) : user.subscription?.currentPeriodEnd ? (
                            <span>
                              Hasta {format(new Date(user.subscription.currentPeriodEnd), 'dd/MM/yyyy', { locale: es })}
                            </span>
                          ) : (
                            '-'
                          )}
                        </td>
                        <td className="py-3 px-2">
                          <Button
                            variant={user.isAdmin ? "destructive" : "outline"}
                            size="sm"
                            onClick={() => toggleAdminMutation.mutate(user.id)}
                            disabled={toggleAdminMutation.isPending}
                            data-testid={`button-toggle-admin-${user.id}`}
                          >
                            {user.isAdmin ? (
                              <>
                                <ShieldOff className="h-3 w-3 mr-1" />
                                Quitar Admin
                              </>
                            ) : (
                              <>
                                <Shield className="h-3 w-3 mr-1" />
                                Hacer Admin
                              </>
                            )}
                          </Button>
                        </td>
                      </tr>
                    ))}
                    {filteredUsers.length === 0 && (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-muted-foreground">
                          No se encontraron usuarios
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sessions">
          <Card>
            <CardHeader>
              <CardTitle>Historial de Sesiones</CardTitle>
              <CardDescription>Últimos ingresos y salidas de usuarios</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingSessions ? (
                <div className="space-y-2">
                  {[1,2,3].map(i => <Skeleton key={i} className="h-12" />)}
                </div>
              ) : sessionLogs.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">
                  <Activity className="h-12 w-12 mx-auto mb-2 opacity-50" />
                  <p>No hay registros de sesiones aún</p>
                  <p className="text-xs mt-1">Los próximos logins/logouts aparecerán aquí</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {sessionLogs.map((log) => (
                    <div key={log.id} className="flex items-center justify-between p-2 sm:p-3 border rounded-lg gap-2">
                      <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
                        {log.action === 'login' ? (
                          <LogIn className="h-4 w-4 sm:h-5 sm:w-5 text-green-500 flex-shrink-0" />
                        ) : (
                          <LogOut className="h-4 w-4 sm:h-5 sm:w-5 text-red-500 flex-shrink-0" />
                        )}
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">{log.userName}</p>
                          <p className="text-xs text-muted-foreground truncate">{log.userEmail}</p>
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-xs sm:text-sm">
                          {log.action === 'login' ? 'Ingresó' : 'Salió'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {format(new Date(log.createdAt), "dd/MM/yyyy HH:mm", { locale: es })}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Send className="h-5 w-5" />
                Enviar Notificación
              </CardTitle>
              <CardDescription>
                Enviá notificaciones de información a los usuarios de la plataforma
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="notif-title">Título</Label>
                  <Input
                    id="notif-title"
                    placeholder="Ej: Nueva funcionalidad disponible"
                    value={notifTitle}
                    onChange={(e) => setNotifTitle(e.target.value)}
                    data-testid="input-notif-title"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="notif-message">Mensaje</Label>
                  <div className="relative">
                    <Textarea
                      id="notif-message"
                      ref={messageTextareaRef}
                      placeholder="Escribí el contenido de la notificación..."
                      value={notifMessage}
                      onChange={(e) => setNotifMessage(e.target.value)}
                      rows={4}
                      data-testid="input-notif-message"
                    />
                    <div className="flex items-center gap-1 mt-2">
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button type="button" variant="ghost" size="sm" className="h-8 px-2">
                            <Smile className="h-4 w-4" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-64 p-2">
                          <p className="text-xs text-muted-foreground mb-2">Emojis</p>
                          <div className="grid grid-cols-10 gap-1">
                            {COMMON_EMOJIS.map((emoji) => (
                              <button
                                key={emoji}
                                type="button"
                                onClick={() => insertEmoji(emoji)}
                                className="text-lg hover:bg-gray-100 dark:hover:bg-slate-800 rounded p-1 transition-colors"
                              >
                                {emoji}
                              </button>
                            ))}
                          </div>
                        </PopoverContent>
                      </Popover>
                      <span className="text-xs text-muted-foreground">Hacé clic para insertar emojis</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <Label>Adjuntos (opcional)</Label>
                  <div className="flex flex-wrap gap-2">
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleImageSelect}
                      className="hidden"
                    />
                    <input
                      ref={attachmentInputRef}
                      type="file"
                      accept=".pdf,.doc,.docx,.txt"
                      onChange={handleAttachmentSelect}
                      className="hidden"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => imageInputRef.current?.click()}
                      disabled={isUploadingImage || !!notifImage}
                    >
                      {isUploadingImage ? (
                        <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <ImageIcon className="h-4 w-4 mr-2" />
                      )}
                      {notifImage ? 'Imagen adjuntada' : 'Agregar imagen'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => attachmentInputRef.current?.click()}
                      disabled={isUploadingAttachment || !!notifAttachment}
                    >
                      {isUploadingAttachment ? (
                        <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Paperclip className="h-4 w-4 mr-2" />
                      )}
                      {notifAttachment ? 'Archivo adjuntado' : 'Agregar archivo'}
                    </Button>
                  </div>
                  
                  {(notifImagePreview || notifAttachment) && (
                    <div className="flex flex-wrap gap-3 p-3 bg-gray-50 dark:bg-slate-900 rounded-lg">
                      {notifImagePreview && (
                        <div className="relative">
                          <img 
                            src={notifImagePreview} 
                            alt="Preview" 
                            className="h-20 w-20 object-cover rounded-lg border"
                          />
                          <button
                            type="button"
                            onClick={clearImage}
                            className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 hover:bg-red-600"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                      {notifAttachment && (
                        <div className="relative flex items-center gap-2 p-2 bg-white dark:bg-card rounded-lg border">
                          <FileText className="h-5 w-5 text-blue-500" />
                          <span className="text-sm truncate max-w-[150px]">{notifAttachment.name}</span>
                          <button
                            type="button"
                            onClick={clearAttachment}
                            className="bg-red-500 text-white rounded-full p-1 hover:bg-red-600 ml-1"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>Destinatarios</Label>
                  <Select value={notifRecipients} onValueChange={(v) => setNotifRecipients(v as 'all' | 'selected')}>
                    <SelectTrigger data-testid="select-recipients">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">
                        <div className="flex items-center gap-2">
                          <Users className="h-4 w-4" />
                          Todos los usuarios ({users.length})
                        </div>
                      </SelectItem>
                      <SelectItem value="selected">
                        <div className="flex items-center gap-2">
                          <UserCheck className="h-4 w-4" />
                          Usuarios seleccionados
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {notifRecipients === 'selected' && (() => {
                  const q = userSearchQuery.trim().toLowerCase();
                  const filteredUsers = q
                    ? users.filter((u: any) =>
                        (u.name || '').toLowerCase().includes(q) ||
                        (u.email || '').toLowerCase().includes(q)
                      )
                    : users;
                  const selectedNotShown = users.filter((u: any) =>
                    selectedUserIds.includes(u.id) && !filteredUsers.some((f: any) => f.id === u.id)
                  );
                  return (
                    <div className="space-y-2">
                      <Label>Seleccioná usuarios ({selectedUserIds.length} seleccionados)</Label>
                      <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                        <Input
                          type="text"
                          placeholder="Buscar por nombre o email..."
                          value={userSearchQuery}
                          onChange={(e) => setUserSearchQuery(e.target.value)}
                          className="pl-8 pr-8"
                          data-testid="input-user-search"
                        />
                        {userSearchQuery && (
                          <button
                            type="button"
                            onClick={() => setUserSearchQuery('')}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                            data-testid="button-clear-user-search"
                            aria-label="Limpiar búsqueda"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                      <div className="border rounded-md max-h-48 overflow-y-auto" data-testid="list-users">
                        {filteredUsers.length === 0 && selectedNotShown.length === 0 ? (
                          <div className="p-4 text-center text-sm text-gray-500 dark:text-slate-400" data-testid="text-no-users-found">
                            No se encontraron usuarios
                          </div>
                        ) : (
                          <>
                            {filteredUsers.map((user: any) => (
                              <div
                                key={user.id}
                                onClick={() => toggleUserSelection(user.id)}
                                className={`flex items-center gap-3 p-2 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer border-b last:border-b-0 ${
                                  selectedUserIds.includes(user.id) ? 'bg-blue-50' : ''
                                }`}
                                data-testid={`row-user-${user.id}`}
                              >
                                <Checkbox
                                  checked={selectedUserIds.includes(user.id)}
                                  onCheckedChange={() => toggleUserSelection(user.id)}
                                  onClick={(e) => e.stopPropagation()}
                                />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium truncate">{user.name || user.email}</p>
                                  <p className="text-xs text-gray-500 dark:text-slate-400 truncate">{user.email}</p>
                                </div>
                              </div>
                            ))}
                            {selectedNotShown.length > 0 && (
                              <div className="border-t bg-gray-50 dark:bg-slate-900/50">
                                <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-gray-500 dark:text-slate-400">
                                  Seleccionados fuera del filtro
                                </div>
                                {selectedNotShown.map((user: any) => (
                                  <div
                                    key={user.id}
                                    onClick={() => toggleUserSelection(user.id)}
                                    className="flex items-center gap-3 p-2 hover:bg-gray-100 dark:hover:bg-slate-800 cursor-pointer border-b last:border-b-0 bg-blue-50"
                                    data-testid={`row-user-selected-hidden-${user.id}`}
                                  >
                                    <Checkbox
                                      checked={true}
                                      onCheckedChange={() => toggleUserSelection(user.id)}
                                      onClick={(e) => e.stopPropagation()}
                                    />
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-medium truncate">{user.name || user.email}</p>
                                      <p className="text-xs text-gray-500 dark:text-slate-400 truncate">{user.email}</p>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                      {q && (
                        <p className="text-xs text-gray-500 dark:text-slate-400" data-testid="text-search-results-count">
                          Mostrando {filteredUsers.length} de {users.length} usuarios
                        </p>
                      )}
                    </div>
                  );
                })()}

                <div className="space-y-2">
                  <Label className="text-sm font-medium">Método de envío</Label>
                  <div className="grid grid-cols-1 gap-2">
                    <label 
                      className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${sendMethod === 'app' ? 'bg-cyan-50 border-cyan-300' : 'bg-gray-50 dark:bg-slate-900 border-gray-200 dark:border-slate-800 hover:bg-gray-100 dark:hover:bg-slate-800'}`}
                      data-testid="radio-send-app"
                    >
                      <input
                        type="radio"
                        name="sendMethod"
                        value="app"
                        checked={sendMethod === 'app'}
                        onChange={() => setSendMethod('app')}
                        className="h-4 w-4 text-cyan-600"
                      />
                      <div className="flex-1">
                        <div className="flex items-center gap-2 font-medium text-sm">
                          <Bell className="h-4 w-4" />
                          Solo notificación en la app
                        </div>
                        <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                          Los usuarios verán la notificación en la campanita
                        </p>
                      </div>
                    </label>
                    
                    <label 
                      className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${sendMethod === 'email' ? 'bg-cyan-50 border-cyan-300' : 'bg-gray-50 dark:bg-slate-900 border-gray-200 dark:border-slate-800 hover:bg-gray-100 dark:hover:bg-slate-800'}`}
                      data-testid="radio-send-email"
                    >
                      <input
                        type="radio"
                        name="sendMethod"
                        value="email"
                        checked={sendMethod === 'email'}
                        onChange={() => setSendMethod('email')}
                        className="h-4 w-4 text-cyan-600"
                      />
                      <div className="flex-1">
                        <div className="flex items-center gap-2 font-medium text-sm">
                          <Mail className="h-4 w-4" />
                          Solo email
                        </div>
                        <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                          Los usuarios recibirán un email (sin notificación en la app)
                        </p>
                      </div>
                    </label>
                    
                    <label 
                      className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${sendMethod === 'both' ? 'bg-cyan-50 border-cyan-300' : 'bg-gray-50 dark:bg-slate-900 border-gray-200 dark:border-slate-800 hover:bg-gray-100 dark:hover:bg-slate-800'}`}
                      data-testid="radio-send-both"
                    >
                      <input
                        type="radio"
                        name="sendMethod"
                        value="both"
                        checked={sendMethod === 'both'}
                        onChange={() => setSendMethod('both')}
                        className="h-4 w-4 text-cyan-600"
                      />
                      <div className="flex-1">
                        <div className="flex items-center gap-2 font-medium text-sm">
                          <Bell className="h-4 w-4" />
                          <span>+</span>
                          <Mail className="h-4 w-4" />
                          Ambos (app + email)
                        </div>
                        <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                          Los usuarios recibirán notificación en la app y también email
                        </p>
                      </div>
                    </label>
                  </div>
                </div>
              </div>

              <Button
                onClick={handleSendNotification}
                disabled={sendNotificationMutation.isPending || !notifTitle.trim() || !notifMessage.trim()}
                className="w-full"
                data-testid="button-send-notification"
              >
                {sendNotificationMutation.isPending ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    Enviando...
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4 mr-2" />
                    Enviar Notificación
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="errors">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <AlertTriangle className="h-5 w-5 text-amber-500" />
                    Errores del sistema
                  </CardTitle>
                  <CardDescription className="mt-1">
                    Errores graves registrados en producción (los mismos que se avisan por email). Los datos sensibles están enmascarados.
                  </CardDescription>
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  {([
                    { value: 'open', label: 'Pendientes' },
                    { value: 'resolved', label: 'Solucionados' },
                    { value: 'archived', label: 'Archivados' },
                  ] as { value: ErrorStatusFilter; label: string }[]).map((opt) => (
                    <Button
                      key={opt.value}
                      variant={errorStatusFilter === opt.value ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setErrorStatusFilter(opt.value)}
                      data-testid={`button-error-filter-${opt.value}`}
                    >
                      {opt.label}
                    </Button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {loadingErrors ? (
                <div className="space-y-2">
                  {[1,2,3].map(i => <Skeleton key={i} className="h-16" />)}
                </div>
              ) : systemErrors.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground" data-testid="text-no-errors">
                  <CheckCircle className="h-12 w-12 mx-auto mb-2 opacity-50 text-green-500" />
                  <p>No hay errores {errorStatusFilter === 'open' ? 'pendientes' : errorStatusFilter === 'resolved' ? 'solucionados' : 'archivados'}</p>
                  <p className="text-xs mt-1">Los errores graves del sistema en producción aparecerán acá</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {systemErrors.map((err) => (
                    <button
                      key={err.id}
                      onClick={() => setSelectedError(err)}
                      className="w-full text-left p-3 border rounded-lg hover:bg-muted/50 transition-colors"
                      data-testid={`card-error-${err.id}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant="outline" className="text-xs">{sourceLabel(err.source)}</Badge>
                            {err.statusCode != null && (
                              <Badge variant="secondary" className="text-xs">HTTP {err.statusCode}</Badge>
                            )}
                            {err.occurrenceCount > 1 && (
                              <Badge variant="destructive" className="text-xs" data-testid={`badge-error-count-${err.id}`}>
                                {err.occurrenceCount} veces
                              </Badge>
                            )}
                          </div>
                          <p className="font-medium text-sm mt-1.5 line-clamp-2" data-testid={`text-error-message-${err.id}`}>
                            {err.message}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1 truncate">
                            {(err.method || '') + ' ' + (err.path || '')}{err.userEmail ? ` · ${err.userEmail}` : ' · anónimo'}
                          </p>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-xs text-muted-foreground">Última vez</p>
                          <p className="text-xs">{format(new Date(err.lastSeenAt), "dd/MM/yyyy HH:mm", { locale: es })}</p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="support">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-5 w-5" />
                Generar link de recupero de contraseña
              </CardTitle>
              <CardDescription>
                Si a un cliente no le llega el email de recupero (por ejemplo, le cae en spam), generá un link
                válido acá y enviáselo directo por WhatsApp. El link vence en 1 hora y es de un solo uso.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="reset-email">Email del cliente</Label>
                  <Input
                    id="reset-email"
                    type="email"
                    placeholder="cliente@ejemplo.com"
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && resetEmail.trim() && !generateResetLinkMutation.isPending) {
                        generateResetLinkMutation.mutate({ email: resetEmail.trim(), sendEmail: false });
                      }
                    }}
                    data-testid="input-reset-email"
                  />
                </div>
                <Button
                  onClick={() => generateResetLinkMutation.mutate({ email: resetEmail.trim(), sendEmail: false })}
                  disabled={!resetEmail.trim() || generateResetLinkMutation.isPending}
                  data-testid="button-generate-reset-link"
                >
                  {generateResetLinkMutation.isPending ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Generando...
                    </>
                  ) : (
                    <>
                      <KeyRound className="h-4 w-4 mr-2" />
                      Generar link
                    </>
                  )}
                </Button>
              </div>

              {resetResult && (
                <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-3" data-testid="container-reset-result">
                  <div className="text-sm">
                    <span className="text-muted-foreground">Cuenta: </span>
                    <span className="font-medium" data-testid="text-reset-account">{resetResult.name} ({resetResult.email})</span>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Link de recupero</Label>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <Input
                        readOnly
                        value={resetResult.resetLink}
                        className="font-mono text-xs"
                        onFocus={(e) => e.currentTarget.select()}
                        data-testid="text-reset-link"
                      />
                      <Button variant="outline" onClick={handleCopyResetLink} data-testid="button-copy-reset-link">
                        {linkCopied ? (
                          <>
                            <Check className="h-4 w-4 mr-2" />
                            Copiado
                          </>
                        ) : (
                          <>
                            <Copy className="h-4 w-4 mr-2" />
                            Copiar
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Vence: {new Date(resetResult.expiresAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}.
                    Enviáselo al cliente por WhatsApp. Al abrirlo va a poder elegir una contraseña nueva.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={!!selectedError} onOpenChange={(open) => { if (!open) setSelectedError(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-error-detail">
          {selectedError && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                  Detalle del error
                </DialogTitle>
                <DialogDescription>
                  {sourceLabel(selectedError.source)}
                  {selectedError.statusCode != null ? ` · HTTP ${selectedError.statusCode}` : ''}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div>
                  <Label className="text-xs text-muted-foreground">Mensaje</Label>
                  <p className="text-sm font-medium mt-0.5" data-testid="text-detail-message">{selectedError.message}</p>
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <Label className="text-xs text-muted-foreground">Ocurrencias</Label>
                    <p data-testid="text-detail-count">{selectedError.occurrenceCount}</p>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Operación</Label>
                    <p className="break-all">{(selectedError.method || '—') + ' ' + (selectedError.path || '')}</p>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Primera vez</Label>
                    <p>{format(new Date(selectedError.firstSeenAt), "dd/MM/yyyy HH:mm", { locale: es })}</p>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Última vez</Label>
                    <p>{format(new Date(selectedError.lastSeenAt), "dd/MM/yyyy HH:mm", { locale: es })}</p>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Usuario</Label>
                    <p className="break-all">{selectedError.userEmail || selectedError.userId || 'Anónimo'}</p>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Organización</Label>
                    <p className="break-all">{selectedError.organizationName || selectedError.organizationId || '—'}</p>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">IP</Label>
                    <p className="break-all">{selectedError.ip || '—'}</p>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Navegador / dispositivo</Label>
                    <p className="break-all text-xs">{selectedError.userAgent || '—'}</p>
                  </div>
                </div>

                {selectedError.stack && (
                  <div>
                    <Label className="text-xs text-muted-foreground">Detalle técnico (stack)</Label>
                    <pre className="mt-1 p-3 bg-muted rounded-lg text-xs overflow-x-auto whitespace-pre-wrap break-all max-h-64" data-testid="text-detail-stack">
                      {selectedError.stack}
                    </pre>
                  </div>
                )}

                {selectedError.status === 'resolved' && selectedError.resolvedAt && (
                  <p className="text-xs text-muted-foreground">
                    Solucionado el {format(new Date(selectedError.resolvedAt), "dd/MM/yyyy HH:mm", { locale: es })}
                  </p>
                )}
              </div>

              <DialogFooter className="flex-col sm:flex-row gap-2">
                {selectedError.status !== 'open' && (
                  <Button
                    variant="outline"
                    onClick={() => updateErrorStatusMutation.mutate({ id: selectedError.id, status: 'open' })}
                    disabled={updateErrorStatusMutation.isPending}
                    data-testid="button-reopen-error"
                  >
                    <RotateCcw className="h-4 w-4 mr-1" />
                    Reabrir
                  </Button>
                )}
                {selectedError.status !== 'archived' && (
                  <Button
                    variant="outline"
                    onClick={() => updateErrorStatusMutation.mutate({ id: selectedError.id, status: 'archived' })}
                    disabled={updateErrorStatusMutation.isPending}
                    data-testid="button-archive-error"
                  >
                    <Archive className="h-4 w-4 mr-1" />
                    Archivar
                  </Button>
                )}
                {selectedError.status !== 'resolved' && (
                  <Button
                    onClick={() => updateErrorStatusMutation.mutate({ id: selectedError.id, status: 'resolved' })}
                    disabled={updateErrorStatusMutation.isPending}
                    data-testid="button-resolve-error"
                  >
                    <CheckCircle className="h-4 w-4 mr-1" />
                    Marcar solucionado
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={previewOpen} onOpenChange={(open) => { if (!sendNotificationMutation.isPending) setPreviewOpen(open); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-notification-preview">
          <DialogHeader>
            <DialogTitle>Vista previa de la notificación</DialogTitle>
            <DialogDescription>
              Revisá cómo se va a ver y a quién se le va a enviar antes de confirmar.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {(sendMethod === 'app' || sendMethod === 'both') && (
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400 flex items-center gap-1.5">
                  <Bell className="h-3.5 w-3.5" /> Cómo se verá en la app
                </div>
                <div className="rounded-lg border bg-white dark:bg-card p-3 shadow-sm" data-testid="preview-app">
                  <div className="flex items-start gap-3">
                    <div className="h-8 w-8 rounded-full bg-cyan-100 flex items-center justify-center flex-shrink-0">
                      <Bell className="h-4 w-4 text-cyan-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 dark:text-slate-50 break-words" data-testid="preview-app-title">
                        {notifTitle || '(sin título)'}
                      </p>
                      <p className="text-sm text-gray-700 dark:text-slate-200 mt-0.5 whitespace-pre-wrap break-words" data-testid="preview-app-message">
                        {notifMessage || '(sin mensaje)'}
                      </p>
                      {notifImagePreview && (
                        <img
                          src={notifImagePreview}
                          alt="Imagen adjunta"
                          className="mt-2 max-h-48 rounded-md border object-contain"
                          data-testid="preview-app-image"
                        />
                      )}
                      {notifAttachment && (
                        <div className="mt-2 flex items-center gap-2 p-2 rounded-md bg-gray-50 dark:bg-slate-900 border text-sm" data-testid="preview-app-attachment">
                          <FileText className="h-4 w-4 text-blue-600" />
                          <span className="truncate text-gray-700 dark:text-slate-200">{notifAttachment.name}</span>
                        </div>
                      )}
                      <p className="text-[11px] text-gray-400 mt-1.5">Hace un instante</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {(sendMethod === 'email' || sendMethod === 'both') && (
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400 flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5" /> Cómo se verá en el email
                </div>
                <div className="rounded-lg border bg-white dark:bg-card shadow-sm overflow-hidden" data-testid="preview-email">
                  <div className="px-4 py-2 border-b bg-gray-50 dark:bg-slate-900">
                    <p className="text-xs text-gray-500 dark:text-slate-400">
                      <span className="font-medium text-gray-700 dark:text-slate-200">Asunto:</span>{' '}
                      <span data-testid="preview-email-subject">{notifTitle || '(sin asunto)'}</span>
                    </p>
                    <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                      <span className="font-medium text-gray-700 dark:text-slate-200">De:</span> Aikestar
                    </p>
                  </div>
                  <div className="p-4">
                    <p className="text-sm text-gray-800 dark:text-slate-100 whitespace-pre-wrap break-words" data-testid="preview-email-body">
                      {notifMessage || '(sin mensaje)'}
                    </p>
                    {notifImagePreview && (
                      <img
                        src={notifImagePreview}
                        alt="Imagen adjunta"
                        className="mt-3 max-h-48 rounded-md border object-contain"
                        data-testid="preview-email-image"
                      />
                    )}
                    {notifAttachment && (
                      <div className="mt-3 flex items-center gap-2 p-2 rounded-md bg-gray-50 dark:bg-slate-900 border text-sm" data-testid="preview-email-attachment">
                        <FileText className="h-4 w-4 text-blue-600" />
                        <span className="truncate text-gray-700 dark:text-slate-200">{notifAttachment.name}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">Resumen de envío</div>
              <div className="rounded-lg border bg-gray-50 dark:bg-slate-900/50 p-3 text-sm space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-gray-600 dark:text-slate-300">Método</span>
                  <span className="font-medium text-gray-900 dark:text-slate-50" data-testid="preview-method">
                    {sendMethod === 'app' && 'Solo notificación en la app'}
                    {sendMethod === 'email' && 'Solo email'}
                    {sendMethod === 'both' && 'App + email'}
                  </span>
                </div>
                <div className="flex items-start justify-between gap-2">
                  <span className="text-gray-600 dark:text-slate-300 pt-0.5">Destinatarios</span>
                  <span className="font-medium text-gray-900 dark:text-slate-50 text-right" data-testid="preview-recipients-count">
                    {notifRecipients === 'all'
                      ? `Todos los usuarios (${users.length})`
                      : `${selectedUserIds.length} ${selectedUserIds.length === 1 ? 'usuario seleccionado' : 'usuarios seleccionados'}`}
                  </span>
                </div>
                {notifRecipients === 'selected' && selectedUserIds.length > 0 && (
                  <div className="border-t pt-2 max-h-40 overflow-y-auto space-y-1" data-testid="preview-recipients-list">
                    {users
                      .filter((u: any) => selectedUserIds.includes(u.id))
                      .map((u: any) => (
                        <div key={u.id} className="flex items-center justify-between gap-2 text-xs" data-testid={`preview-recipient-${u.id}`}>
                          <span className="font-medium text-gray-800 dark:text-slate-100 truncate">{u.name || u.email}</span>
                          <span className="text-gray-500 dark:text-slate-400 truncate">{u.email}</span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => setPreviewOpen(false)}
              disabled={sendNotificationMutation.isPending}
              data-testid="button-preview-back"
            >
              Volver a editar
            </Button>
            <Button
              onClick={confirmAndSend}
              disabled={sendNotificationMutation.isPending}
              data-testid="button-preview-confirm"
            >
              {sendNotificationMutation.isPending ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  Enviando...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  Confirmar y enviar
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
