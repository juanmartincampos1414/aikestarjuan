import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Loader2, ShieldCheck, AlertTriangle, Zap, Pencil, PowerOff, RefreshCw, Replace, Plug, Eye, EyeOff, RotateCcw, HelpCircle, Sparkles } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { fetchWithAuth } from '@/lib/api';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import { SellingPointSetupGuide } from '@/components/SellingPointSetupGuide';
import { RetrySignupDialog } from '@/components/RetrySignupDialog';

const IVA_LABEL: Record<string, string> = {
  responsable_inscripto: 'Responsable Inscripto',
  monotributo: 'Monotributo',
  exento: 'Exento',
};
const ENV_LABEL: Record<string, string> = {
  sandbox: 'Pruebas',
  production: 'Producción',
};

interface SellingPoint { number: number; description?: string | null; isActive?: boolean }
interface Account {
  id: string;
  cuit: string;
  adminCuit: string | null;
  razonSocial: string | null;
  ivaCondition: 'responsable_inscripto' | 'monotributo' | 'exento';
  environment: 'sandbox' | 'production';
  defaultSellingPoint: number | null;
  address: string | null;
  phone: string | null;
  isActive: boolean;
  isSimulated?: boolean;
  lastValidatedAt: string | null;
  lastSyncedAt: string | null;
  notes: string | null;
}
interface AccountResponse {
  configured: boolean;
  envReady: boolean;
  envReason?: string;
  sandboxMockActive?: boolean;
  account: Account | null;
  sellingPoints: SellingPoint[];
}

const DEFAULT_FORM = {
  cuit: '',
  adminCuit: '',
  ivaCondition: 'responsable_inscripto' as Account['ivaCondition'],
  environment: 'sandbox' as Account['environment'],
  claveFiscal: '',
  address: '',
  phone: '',
};

// Sociedades (personas jurídicas) en ARCA arrancan con CUIT 30 o 33.
function isSociedadCuit(cuit: string): boolean {
  return /^(30|33)/.test(cuit);
}

// Personas físicas habilitadas como administradores en ARCA.
function isPersonaFisicaCuitPrefix(cuit: string): boolean {
  return /^(20|23|24|27)/.test(cuit);
}

// Whitelist of safe, ARCA-only user-facing messages. We never echo raw backend
// text directly — if the server returns something that doesn't match a known
// pattern, we fall back to a generic ARCA-safe message.
const SAFE_MESSAGE_ALLOWLIST = [
  'El servicio de facturación electrónica no está disponible en este momento.',
  'No pudimos conectar con ARCA en este momento. Probá de nuevo en unos minutos.',
  'El CUIT no es válido. Verificá los 11 dígitos y la condición frente al IVA.',
  'El CUIT no es válido (verificá los 11 dígitos)',
  'Ingresá tu CUIT para activar la facturación electrónica',
  'Ingresá el CUIT del administrador (persona física habilitada en ARCA para facturar a nombre de la sociedad).',
  'El CUIT del administrador no es válido. Debe empezar con 20, 23, 24 o 27 y tener 11 dígitos.',
  'Verificá que el CUIT del administrador y su clave fiscal sean correctos y que tenga relación habilitada en ARCA para facturar a nombre de la sociedad.',
  'El servicio de ARCA no respondió correctamente. Probá de nuevo en unos minutos.',
  'No pudimos completar la operación con ARCA. Revisá los datos ingresados y probá de nuevo.',
  'Este CUIT ya está asociado a otra cuenta. Contactá a soporte si creés que es un error.',
  'No encontramos ese CUIT. Activá la facturación electrónica para poder emitir.',
];

// Argentine CUIT checksum validator (módulo 11).
// Standard rule: 11 - (sum % 11). If result is 11 → 0; if 10 → 9.
export function isValidCuitChecksum(cuit: string): boolean {
  if (!/^\d{11}$/.test(cuit)) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cuit[i], 10) * weights[i];
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  else if (check === 10) check = 9;
  return check === parseInt(cuit[10], 10);
}

function friendlyError(msg: string): string {
  const trimmed = (msg || '').trim();
  if (!trimmed) {
    return 'No pudimos activar la facturación electrónica. Probá de nuevo en unos minutos.';
  }
  // Pass through only if it matches one of our own safe messages.
  if (SAFE_MESSAGE_ALLOWLIST.some((safe) => trimmed.startsWith(safe))) {
    return trimmed;
  }
  const m = trimmed.toLowerCase();
  if (m.includes('cuit')) {
    return 'El CUIT no es válido. Verificá los 11 dígitos y la condición frente al IVA.';
  }
  if (m.includes('network') || m.includes('conect') || m.includes('fetch')) {
    return 'No pudimos conectar con ARCA. Revisá tu conexión y probá de nuevo.';
  }
  return 'No pudimos activar la facturación electrónica. Probá de nuevo en unos minutos.';
}

export default function FacturadorSection({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(DEFAULT_FORM);
  const [editing, setEditing] = useState(false);
  const [changingCuit, setChangingCuit] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [confirmChangeCuit, setConfirmChangeCuit] = useState(false);
  const [confirmResetSp, setConfirmResetSp] = useState(false);
  const [showClaveFiscal, setShowClaveFiscal] = useState(false);
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [showRetrySignup, setShowRetrySignup] = useState(false);
  const autoSyncedRef = useRef<string | null>(null);

  // Task #313 — el selector de PV debe ser "vivo": queremos que, cada vez
  // que el usuario entra a Facturador o vuelve a la pestaña, refresquemos
  // el listado de PVs contra nuestro propio backend (que a su vez tiene un
  // sync silencioso contra ARCA al montarse). El query global tiene
  // `staleTime: Infinity` y `refetchOnWindowFocus: false` por default, lo
  // que dejaba el cache colgado indefinidamente — exactamente el problema
  // del cliente del agency que veía el PV viejo después de re-configurar
  // en ARCA. Override local: 10 s de stale + refetch on mount + refetch on
  // window focus, sin polling agresivo (un sync activo en cada acción del
  // usuario es suficiente y evita pegarle a ARCA en loop).
  const { data, isLoading } = useQuery<AccountResponse>({
    queryKey: ['/api/invoicing/account'],
    queryFn: async () => fetchWithAuth('/invoicing/account'),
    staleTime: 10_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });

  const acc = data?.account;
  const envReady = data?.envReady ?? false;
  const sellingPoints = data?.sellingPoints || [];
  const isActivated = !!acc && acc.isActive;
  const sandboxMockActive = !!data?.sandboxMockActive;
  const showMockBanner = sandboxMockActive && (acc?.environment === 'sandbox' || (!acc && form.environment === 'sandbox'));

  useEffect(() => {
    // Only sync server data into the form when the user is NOT actively editing,
    // to avoid wiping their unsaved changes on background refetches.
    if (acc && !editing) {
      setForm({
        cuit: acc.cuit,
        adminCuit: acc.adminCuit ?? '',
        ivaCondition: acc.ivaCondition,
        environment: acc.environment,
        claveFiscal: '',
        address: acc.address ?? '',
        phone: acc.phone ?? '',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acc?.id, acc?.cuit, acc?.adminCuit, acc?.ivaCondition, acc?.environment, acc?.address, acc?.phone, editing]);

  const activate = useMutation({
    mutationFn: async () => {
      const cuitDigits = form.cuit.replace(/\D/g, '');
      const adminCuitDigits = form.adminCuit.replace(/\D/g, '');
      return fetchWithAuth('/invoicing/signup', {
        method: 'POST',
        body: JSON.stringify({
          cuit: cuitDigits,
          adminCuit: isSociedadCuit(cuitDigits) && adminCuitDigits ? adminCuitDigits : undefined,
          ivaCondition: form.ivaCondition,
          environment: form.environment,
          address: form.address.trim() || null,
          phone: form.phone.trim() || null,
          claveFiscal: form.environment === 'production' && form.claveFiscal ? form.claveFiscal : undefined,
          // No mandamos `sellingPoint`: dejamos que Facturitas/ARCA cree el PV
          // RECE nuevo. Confirmado con Tomás Behringer (mayo 2026) — antes de
          // tener certificado del usuario no podemos saber qué PVs sirven para
          // web services, así que indicar uno acá lleva al caso del PV 1
          // "Factura en Línea" inservible para emisión.
        }),
      });
    },
    onSuccess: (res: any) => {
      toast({
        title: '¡Facturación electrónica activada!',
        description: res?.razonSocial
          ? `${res.razonSocial} · ${res.ivaCondition ? IVA_LABEL[res.ivaCondition] || 'Condición IVA detectada' : ''}`
          : 'Ya podés emitir facturas ante ARCA.',
      });
      setEditing(false);
      setChangingCuit(false);
      setForm((f) => ({ ...f, claveFiscal: '' }));
      queryClient.invalidateQueries({ queryKey: ['/api/invoicing/account'] });
    },
    onError: (e: Error) =>
      toast({ title: 'No pudimos activar la facturación', description: friendlyError(e.message), variant: 'destructive' }),
  });

  const silentSync = useMutation({
    mutationFn: async () => fetchWithAuth('/invoicing/selling-points/sync', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/invoicing/account'] });
    },
  });

  const manualSync = useMutation({
    mutationFn: async () => fetchWithAuth('/invoicing/selling-points/sync', { method: 'POST' }),
    onSuccess: () => {
      toast({ title: 'Puntos de venta actualizados' });
      queryClient.invalidateQueries({ queryKey: ['/api/invoicing/account'] });
    },
    onError: (e: Error) =>
      toast({ title: 'No se pudieron actualizar', description: friendlyError(e.message), variant: 'destructive' }),
  });

  const promoteToReal = useMutation({
    mutationFn: async () =>
      fetchWithAuth('/invoicing/signup', {
        method: 'POST',
        body: JSON.stringify({ forceReal: true }),
      }),
    onSuccess: (res: any) => {
      toast({
        title: '¡Conectado con ARCA!',
        description: res?.razonSocial
          ? `${res.razonSocial} · ya podés emitir facturas reales.`
          : 'Tu facturación quedó conectada con ARCA.',
      });
      queryClient.invalidateQueries({ queryKey: ['/api/invoicing/account'] });
    },
    onError: (e: Error) =>
      toast({
        title: 'No pudimos conectar con ARCA',
        description: friendlyError(e.message),
        variant: 'destructive',
      }),
  });

  const updateDefaultSellingPoint = useMutation({
    mutationFn: async (defaultSellingPoint: number) =>
      fetchWithAuth('/invoicing/account', {
        method: 'PATCH',
        body: JSON.stringify({ defaultSellingPoint }),
      }),
    onSuccess: () => {
      toast({ title: 'Punto de venta por defecto actualizado' });
      queryClient.invalidateQueries({ queryKey: ['/api/invoicing/account'] });
    },
    onError: (e: Error) =>
      toast({ title: 'No pudimos cambiar el punto de venta', description: friendlyError(e.message), variant: 'destructive' }),
  });

  const resetSellingPoint = useMutation({
    mutationFn: async () => fetchWithAuth('/invoicing/selling-points/reset', { method: 'POST' }),
    onSuccess: (res: any) => {
      const activeCount = typeof res?.activeCount === 'number' ? res.activeCount : null;
      toast({
        title: 'Punto de venta reiniciado',
        description: activeCount != null
          ? `Encontramos ${activeCount} punto${activeCount === 1 ? '' : 's'} de venta activo${activeCount === 1 ? '' : 's'} en ARCA. Elegí cuál querés usar.`
          : 'Volvimos a consultar tus puntos de venta en ARCA. Elegí cuál querés usar.',
      });
      setConfirmResetSp(false);
      queryClient.invalidateQueries({ queryKey: ['/api/invoicing/account'] });
    },
    onError: (e: Error) =>
      toast({ title: 'No pudimos reiniciar el punto de venta', description: friendlyError(e.message), variant: 'destructive' }),
  });

  const deactivate = useMutation({
    mutationFn: async () => fetchWithAuth('/invoicing/deactivate', { method: 'POST' }),
    onSuccess: () => {
      toast({ title: 'Facturación electrónica desactivada' });
      setConfirmDeactivate(false);
      queryClient.invalidateQueries({ queryKey: ['/api/invoicing/account'] });
    },
    onError: (e: Error) =>
      toast({ title: 'No pudimos desactivar', description: friendlyError(e.message), variant: 'destructive' }),
  });

  // Auto-sync silently once per load when activated
  useEffect(() => {
    if (isActivated && acc && autoSyncedRef.current !== acc.id) {
      autoSyncedRef.current = acc.id;
      silentSync.mutate();
    }
  }, [isActivated, acc?.id]);

  // ----------------------------------------------------------------------
  // Nota (mayo 2026, conversación con Tomás Behringer de Facturitas): el
  // wizard ya NO le pide al usuario que elija un punto de venta antes del
  // signup. ARCA no nos deja leer los PVs de un CUIT hasta que el alta en
  // Facturitas se ejecuta (para eso se necesita el certificado del usuario,
  // que recién se obtiene tras el registro). Si dejamos al usuario elegir
  // pre-signup, lo único disponible suele ser el PV 1 "Factura en Línea",
  // que es justamente el que no sirve para emisión por web service. La
  // recomendación de Tomás: cuando recibimos cuit+clave sin selling_point,
  // su sistema crea un PV RECE nuevo en ARCA automáticamente. El selector
  // post-signup (selectDefaultSellingPoint, más abajo) sigue existiendo
  // para usuarios con múltiples PVs RECE legítimos que quieren cambiar el
  // por defecto.
  // ----------------------------------------------------------------------
  // Early credentials validation (Task #303). In production with all the
  // fiscal inputs filled in, hit /api/invoicing/credentials/validate to
  // anticipate the BAD_CREDENTIALS error (clave fiscal sin permisos sobre
  // el CUIT) BEFORE the user clicks "Activar". 5xx/Network responses are
  // treated as "skipped" and never block activation — matching the
  // selling-points preview policy.
  // ----------------------------------------------------------------------
  type CredValidationState =
    | { kind: 'idle' }
    | { kind: 'validating' }
    | { kind: 'ok' }
    | { kind: 'skipped'; reason: string }
    | { kind: 'bad_credentials'; message: string };
  const [credValidation, setCredValidation] = useState<CredValidationState>({ kind: 'idle' });
  const credValidationReqId = useRef(0);

  const previewCuitDigits = form.cuit.replace(/\D/g, '');
  const previewCuitValid = previewCuitDigits.length === 11 && isValidCuitChecksum(previewCuitDigits);
  const isFormVisible = !isActivated || editing;
  const previewAdminCuitDigits = form.adminCuit.replace(/\D/g, '');
  const previewIsSociedad = isSociedadCuit(previewCuitDigits);
  const previewAdminCuitValid = previewAdminCuitDigits.length === 11
    && isPersonaFisicaCuitPrefix(previewAdminCuitDigits)
    && isValidCuitChecksum(previewAdminCuitDigits);
  // Eligibility matches the activation gate (production + valid CUIT +
  // adminCuit if sociedad + non-empty clave fiscal) so we never enable
  // "Activar" without first probing credentials. Short claves still trigger
  // a validation request; the server cache + 1.2 s debounce keep upstream
  // load bounded while the user is editing.
  const credValidationEligible =
    isFormVisible &&
    envReady &&
    form.environment === 'production' &&
    previewCuitValid &&
    (!previewIsSociedad || previewAdminCuitValid) &&
    form.claveFiscal.length >= 1;

  // Reset whenever the relevant inputs change; debounce the actual call so
  // we don't hammer the provider while the user is typing.
  useEffect(() => {
    if (!credValidationEligible) {
      // Bump the request id so any in-flight validation triggered for a
      // now-stale set of inputs (e.g. user switched env from production
      // to sandbox while a request was in flight) cannot overwrite state
      // when it resolves. Without this, a late BAD_CREDENTIALS could
      // block activation in sandbox.
      credValidationReqId.current += 1;
      setCredValidation({ kind: 'idle' });
      return;
    }
    setCredValidation({ kind: 'validating' });
    const reqId = ++credValidationReqId.current;
    const handle = setTimeout(async () => {
      try {
        const res = await fetchWithAuth('/invoicing/credentials/validate', {
          method: 'POST',
          body: JSON.stringify({
            cuit: previewCuitDigits,
            adminCuit: previewIsSociedad ? previewAdminCuitDigits : undefined,
            claveFiscal: form.claveFiscal,
            environment: 'production',
            ivaCondition: form.ivaCondition,
          }),
        });
        if (reqId !== credValidationReqId.current) return;
        if (res && res.ok === false && res.code === 'BAD_CREDENTIALS') {
          setCredValidation({
            kind: 'bad_credentials',
            message: typeof res.message === 'string' && res.message
              ? res.message
              : 'Tu clave fiscal no tiene permisos sobre este CUIT en AFIP.',
          });
          return;
        }
        if (res && res.ok === true && res.skipped) {
          setCredValidation({ kind: 'skipped', reason: String(res.reason || 'unknown') });
          return;
        }
        setCredValidation({ kind: 'ok' });
      } catch {
        // Network or 5xx — never block on this, matches the existing
        // "fail-open" policy for the selling-points preview.
        if (reqId !== credValidationReqId.current) return;
        setCredValidation({ kind: 'skipped', reason: 'network' });
      }
    }, 1200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    credValidationEligible,
    previewCuitDigits,
    previewAdminCuitDigits,
    previewIsSociedad,
    form.claveFiscal,
    form.environment,
    form.ivaCondition,
  ]);

  // Only honour the BAD_CREDENTIALS / validating states when the current
  // form actually requires credential validation (production + eligible
  // inputs). Otherwise a stale response that arrived AFTER the user
  // switched env to sandbox could keep activation blocked.
  const credentialsRejected =
    credValidationEligible && credValidation.kind === 'bad_credentials';
  const credentialsValidating =
    credValidationEligible && credValidation.kind === 'validating';

  if (isLoading) return <div className="text-sm text-muted-foreground">Cargando…</div>;

  const cuitDigits = form.cuit.replace(/\D/g, '');
  const cuitInputState: 'empty' | 'incomplete' | 'invalid' | 'valid' =
    cuitDigits.length === 0
      ? 'empty'
      : cuitDigits.length < 11
        ? 'incomplete'
        : !isValidCuitChecksum(cuitDigits)
          ? 'invalid'
          : 'valid';

  // Sociedad (CUIT 30/33) requires the personal CUIT of the administrator.
  const isSociedad = isSociedadCuit(cuitDigits);
  const adminCuitDigits = form.adminCuit.replace(/\D/g, '');
  const adminCuitInputState: 'empty' | 'incomplete' | 'invalid' | 'valid' =
    adminCuitDigits.length === 0
      ? 'empty'
      : adminCuitDigits.length < 11
        ? 'incomplete'
        : !isPersonaFisicaCuitPrefix(adminCuitDigits) || !isValidCuitChecksum(adminCuitDigits)
          ? 'invalid'
          : 'valid';

  const claveFiscalRequired = form.environment === 'production' && !form.claveFiscal;
  const adminCuitMissing = isSociedad && cuitInputState === 'valid' && adminCuitInputState !== 'valid';
  const canActivate =
    canEdit &&
    envReady &&
    cuitInputState === 'valid' &&
    !adminCuitMissing &&
    !claveFiscalRequired &&
    !credentialsRejected &&
    !credentialsValidating;

  // Concrete reason why the activation button is disabled (drives helper text + tooltip)
  let disabledReason: string | null = null;
  if (!canEdit) {
    disabledReason = 'No tenés permisos para modificar esta configuración.';
  } else if (!envReady) {
    disabledReason = 'El servicio de facturación electrónica no está disponible en este momento.';
  } else if (cuitInputState === 'empty') {
    disabledReason = 'Ingresá tu CUIT para continuar.';
  } else if (cuitInputState === 'incomplete') {
    disabledReason = `Completá los 11 dígitos del CUIT (${cuitDigits.length}/11).`;
  } else if (cuitInputState === 'invalid') {
    disabledReason = 'El CUIT no es válido. Revisá los dígitos.';
  } else if (isSociedad && adminCuitInputState === 'empty') {
    disabledReason = 'Ingresá el CUIT del administrador (persona física) para continuar.';
  } else if (isSociedad && adminCuitInputState === 'incomplete') {
    disabledReason = `Completá los 11 dígitos del CUIT del administrador (${adminCuitDigits.length}/11).`;
  } else if (isSociedad && adminCuitInputState === 'invalid') {
    disabledReason = 'El CUIT del administrador no es válido. Debe empezar con 20, 23, 24 o 27.';
  } else if (claveFiscalRequired) {
    disabledReason = 'Ingresá tu clave fiscal de ARCA para activar en producción.';
  } else if (credentialsValidating) {
    disabledReason = 'Verificando tu clave fiscal contra ARCA…';
  } else if (credentialsRejected && credValidation.kind === 'bad_credentials') {
    disabledReason = credValidation.message;
  }

  // -----------------------------------------------------------------------
  // Render: activated (and not editing) → green status card
  // -----------------------------------------------------------------------
  if (isActivated && !editing) {
    const canPromoteToReal = !!acc?.isSimulated && !sandboxMockActive && envReady;
    return (
      <div className="space-y-4" data-testid="facturador-section">
        <Card className="border-cyan-500/40 bg-gradient-to-br from-cyan-500/5 to-pink-500/5">
          <CardContent className="pt-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-full bg-gradient-to-br from-cyan-500 to-pink-500 flex items-center justify-center shrink-0">
                  <ShieldCheck className="h-5 w-5 text-white" />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-lg" data-testid="text-emitter-name">
                      {acc!.razonSocial || 'Emisor sin razón social'}
                    </h3>
                    <Badge variant={acc!.environment === 'production' ? 'destructive' : 'secondary'}>
                      {ENV_LABEL[acc!.environment]}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    CUIT <strong>{acc!.cuit}</strong> · {IVA_LABEL[acc!.ivaCondition]}
                  </p>
                  {acc!.defaultSellingPoint != null && (
                    <p className="text-xs text-muted-foreground">
                      Punto de venta: <strong>{acc!.defaultSellingPoint}</strong>
                    </p>
                  )}
                  {acc!.address && (
                    <p className="text-xs text-muted-foreground" data-testid="text-emitter-address">
                      Domicilio: <strong>{acc!.address}</strong>
                    </p>
                  )}
                  {acc!.phone && (
                    <p className="text-xs text-muted-foreground" data-testid="text-emitter-phone">
                      Teléfono: <strong>{acc!.phone}</strong>
                    </p>
                  )}
                  <p className="text-xs text-cyan-600 dark:text-cyan-400 font-medium flex items-center gap-1.5 pt-1">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {sandboxMockActive
                      ? 'Modo de pruebas interno — los comprobantes se generan como SIMULADOS sin contactar a ARCA'
                      : 'Conectado con ARCA — listo para emitir facturas A, B y C'}
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditing(true)}
                  disabled={!canEdit}
                  data-testid="button-edit-invoicing"
                >
                  <Pencil className="h-3.5 w-3.5 mr-1.5" />
                  Editar
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmChangeCuit(true)}
                  disabled={!canEdit}
                  data-testid="button-change-cuit"
                >
                  <Replace className="h-3.5 w-3.5 mr-1.5" />
                  Cambiar CUIT
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDeactivate(true)}
                  disabled={!canEdit}
                  data-testid="button-deactivate-invoicing"
                  className="text-muted-foreground hover:text-red-500"
                >
                  <PowerOff className="h-3.5 w-3.5 mr-1.5" />
                  Desactivar
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {(() => {
          // Banner preventivo: cubre dos casos donde el monotributista en
          // producción no tiene un PV compatible con emisión por web service:
          //   (a) Default cacheado PV 1 — bug viejo de Task #300 donde el
          //       signup mandaba `selling_point: 1` y ARCA dejaba al usuario
          //       con un PV de tipo "Factura en Línea Monotributo".
          //   (b) Default en null y cero PVs activos — signup post-fix
          //       Task #300 donde Facturitas/ARCA no devolvió ningún PV
          //       compatible (caso típico: CUIT que ya existía en Facturitas
          //       de un alta vieja, o propagación incompleta del PV nuevo).
          // En ambos escenarios el Retry Signup es la próxima acción correcta.
          // Cuando Facturitas exponga el endpoint que devuelve el sistema de
          // cada PV (en evaluación con Tomás Behringer, mayo 2026), esta
          // heurística pasa a detección exacta y este bloque debería filtrar
          // por `sp.system !== 'web_service'` en vez de por número.
          const activeSellingPoints = sellingPoints.filter((sp) => sp.isActive);
          const defaultIsLegacyPv1 = acc!.defaultSellingPoint === 1;
          const defaultIsMissing = acc!.defaultSellingPoint == null;
          // Caso (a): default cacheado en PV 1 con 0/1 PV activos — bug viejo
          //           Task #300, PV "Factura en Línea".
          // Caso (b): default en null Y exactamente 0 PV activos — signup
          //           post-fix donde ARCA no devolvió ningún PV compatible.
          // No queremos disparar el banner cuando hay un PV activo
          // distinto de 1 (sería un alta exitosa con número >= 2).
          const matchesLegacyPv1 = defaultIsLegacyPv1 && activeSellingPoints.length <= 1;
          const matchesNoCompatiblePv = defaultIsMissing && activeSellingPoints.length === 0;
          const showPvWarning =
            !sandboxMockActive &&
            acc!.ivaCondition === 'monotributo' &&
            acc!.environment === 'production' &&
            (matchesLegacyPv1 || matchesNoCompatiblePv);
          if (!showPvWarning) return null;
          const noActivePv = matchesNoCompatiblePv;
          return (
            <Alert
              data-testid="alert-incompatible-selling-point-warning"
              className="border-amber-500/50 bg-amber-500/5"
            >
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <AlertDescription className="space-y-2">
                {noActivePv ? (
                  <p>
                    <strong>Todavía no podés emitir facturas.</strong> ARCA no nos
                    devolvió ningún punto de venta compatible con emisión electrónica
                    por web service. Esto suele pasar cuando el CUIT ya tenía un alta
                    previa y ARCA no creó uno nuevo automáticamente.
                  </p>
                ) : (
                  <p>
                    <strong>¿No podés emitir facturas?</strong> Tu único punto de venta es
                    el PV 1, que en ARCA suele estar configurado como{' '}
                    <strong>"Factura en Línea"</strong> — un sistema que solo permite
                    cargar facturas a mano desde el portal y no es compatible con
                    emisión electrónica por web service.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Probá primero el reintento automático: nuestro proveedor le pide a
                  ARCA que cree un punto de venta nuevo compatible. Si no funciona, te
                  dejamos los pasos para crearlo a mano (5 minutos en ARCA).
                </p>
                <div className="pt-1 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => setShowRetrySignup(true)}
                    data-testid="button-open-retry-signup"
                    className="bg-gradient-to-r from-pink-500 to-cyan-500 hover:opacity-90 text-white"
                  >
                    <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                    Reintentar alta automática
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowSetupGuide(true)}
                    data-testid="button-open-setup-guide"
                    className="border-amber-500/60 hover:bg-amber-500/10"
                  >
                    <HelpCircle className="h-3.5 w-3.5 mr-1.5" />
                    Crearlo manualmente
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          );
        })()}

        {canPromoteToReal && (
          <Alert data-testid="alert-promote-real" className="border-cyan-500/50 bg-cyan-500/5">
            <Plug className="h-4 w-4 text-cyan-500" />
            <AlertDescription className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
              <span className="flex-1">
                <strong>ARCA volvió a estar disponible.</strong> Tu cuenta está en modo
                simulado. Conectala con ARCA real para emitir facturas con validez fiscal.
                Las facturas anteriores se conservan tal cual (siguen marcadas como simuladas).
              </span>
              <Button
                size="sm"
                onClick={() => promoteToReal.mutate()}
                disabled={!canEdit || promoteToReal.isPending}
                data-testid="button-promote-real"
                className="bg-gradient-to-r from-pink-500 to-cyan-500 hover:opacity-90 text-white"
              >
                {promoteToReal.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                    Conectando…
                  </>
                ) : (
                  <>
                    <Plug className="h-4 w-4 mr-1.5" />
                    Conectar con ARCA real
                  </>
                )}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {(() => {
          const activeSellingPoints = sellingPoints.filter((sp) => sp.isActive);
          // Estado vacío explícito: la cuenta está activa pero ARCA no nos
          // devuelve ningún PV ACTIVO (Task #313). Cubre dos casos: (a) la
          // lista está totalmente vacía, y (b) hay PVs cacheados pero todos
          // marcados como inactive en ARCA. Sin esto, en el caso (b)
          // veríamos badges grises pero ningún selector y volveríamos a la
          // ambigüedad que este task viene a eliminar.
          if (activeSellingPoints.length === 0) {
            const onlyInactive = sellingPoints.length > 0;
            return (
              <Alert data-testid="alert-no-selling-points" className="border-amber-500/40 bg-amber-500/5">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                <AlertDescription className="space-y-2">
                  <p>
                    <strong>
                      {onlyInactive
                        ? 'Tus puntos de venta en ARCA están todos inactivos.'
                        : 'Todavía no tenés puntos de venta activos en ARCA.'}
                    </strong>
                    {onlyInactive
                      ? ' Volvé a activar un punto de venta para "Servicio Web" desde el portal de ARCA (Administrador de Relaciones de Clave Fiscal → "Puntos de Venta") o creá uno nuevo. Cuando lo tengas listo, tocá "Refrescar" y aparecerá acá.'
                      : ' Creá un punto de venta para "Servicio Web" desde el portal de ARCA (Administrador de Relaciones de Clave Fiscal → "Puntos de Venta"). Cuando lo tengas listo, tocá "Refrescar" y aparecerá acá.'}
                  </p>
                  {onlyInactive && (
                    <div className="flex flex-wrap gap-1.5" data-testid="list-inactive-selling-points">
                      {sellingPoints.map((sp) => (
                        <Badge
                          key={sp.number}
                          variant="outline"
                          data-testid={`badge-sp-inactive-${sp.number}`}
                          className="text-xs"
                        >
                          PV {sp.number}{sp.description ? ` · ${sp.description}` : ''} · inactivo
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => manualSync.mutate()}
                      disabled={!canEdit || manualSync.isPending}
                      data-testid="button-refresh-empty-selling-points"
                    >
                      {manualSync.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      Refrescar
                    </Button>
                    <a
                      href="https://www.afip.gob.ar/landing/default.asp"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-cyan-600 dark:text-cyan-400 underline underline-offset-2"
                      data-testid="link-arca-portal"
                    >
                      Abrir portal de ARCA
                    </a>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmResetSp(true)}
                      disabled={!canEdit || resetSellingPoint.isPending}
                      data-testid="button-reset-selling-point-empty"
                      className="text-xs h-8"
                      title="Borrar el punto de venta por defecto y volver a preguntar a ARCA"
                    >
                      {resetSellingPoint.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      Reiniciar punto de venta
                    </Button>
                    {acc?.lastSyncedAt && (
                      <span
                        className="text-xs text-muted-foreground"
                        data-testid="text-last-synced-empty"
                      >
                        Última consulta {formatDistanceToNow(new Date(acc.lastSyncedAt), { addSuffix: true, locale: es })}
                      </span>
                    )}
                  </div>
                </AlertDescription>
              </Alert>
            );
          }
          return (
            <div className="px-1 space-y-3">
              <div>
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <p className="text-xs text-muted-foreground">Puntos de venta disponibles</p>
                  <button
                    onClick={() => manualSync.mutate()}
                    disabled={manualSync.isPending}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    data-testid="button-refresh-selling-points"
                    title="Actualizar puntos de venta"
                  >
                    {manualSync.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                  </button>
                  {acc?.lastSyncedAt && (
                    <span
                      className="text-[11px] text-muted-foreground"
                      data-testid="text-last-synced"
                    >
                      · actualizado {formatDistanceToNow(new Date(acc.lastSyncedAt), { addSuffix: true, locale: es })}
                    </span>
                  )}
                  <button
                    onClick={() => setConfirmResetSp(true)}
                    disabled={!canEdit || resetSellingPoint.isPending}
                    className="ml-auto text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors disabled:opacity-50"
                    data-testid="button-reset-selling-point"
                    title="Reiniciar el punto de venta por defecto y volver a consultar ARCA"
                  >
                    {resetSellingPoint.isPending ? (
                      <span className="inline-flex items-center gap-1">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Reiniciando…
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <RotateCcw className="h-3 w-3" />
                        Reiniciar punto de venta
                      </span>
                    )}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {sellingPoints.map((sp) => (
                    <Badge
                      key={sp.number}
                      variant={sp.isActive ? 'default' : 'outline'}
                      data-testid={`badge-sp-${sp.number}`}
                      className="text-xs"
                    >
                      PV {sp.number}{sp.description ? ` · ${sp.description}` : ''}
                    </Badge>
                  ))}
                </div>
              </div>
              {activeSellingPoints.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <Label htmlFor="select-default-sp" className="text-xs text-muted-foreground">
                    Punto de venta por defecto
                  </Label>
                  <Select
                    value={acc!.defaultSellingPoint != null ? String(acc!.defaultSellingPoint) : undefined}
                    onValueChange={(value) => {
                      const next = parseInt(value, 10);
                      if (!Number.isFinite(next) || next === acc!.defaultSellingPoint) return;
                      updateDefaultSellingPoint.mutate(next);
                    }}
                    disabled={!canEdit || updateDefaultSellingPoint.isPending}
                  >
                    <SelectTrigger
                      id="select-default-sp"
                      className="h-8 w-auto min-w-[180px] text-xs"
                      data-testid="select-default-selling-point"
                    >
                      <SelectValue placeholder="Elegí un punto de venta" />
                    </SelectTrigger>
                    <SelectContent>
                      {activeSellingPoints.map((sp) => (
                        <SelectItem
                          key={sp.number}
                          value={String(sp.number)}
                          data-testid={`option-default-sp-${sp.number}`}
                        >
                          PV {sp.number}{sp.description ? ` · ${sp.description}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {updateDefaultSellingPoint.isPending && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  )}
                </div>
              )}
            </div>
          );
        })()}

        <AlertDialog open={confirmChangeCuit} onOpenChange={setConfirmChangeCuit}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>¿Cambiar el CUIT activado?</AlertDialogTitle>
              <AlertDialogDescription>
                Vas a poder ingresar otro CUIT y volver a activarlo ante ARCA.
                Las facturas ya emitidas seguirán asociadas al CUIT anterior y se
                conservan tal cual en tu historial.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-change-cuit-cancel">Cancelar</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setChangingCuit(true);
                  setEditing(true);
                  setForm({
                    cuit: '',
                    adminCuit: '',
                    ivaCondition: acc!.ivaCondition,
                    environment: acc!.environment,
                    claveFiscal: '',
                    address: acc!.address ?? '',
                    phone: acc!.phone ?? '',
                  });
                  setConfirmChangeCuit(false);
                }}
                data-testid="button-change-cuit-confirm"
              >
                Sí, cambiar CUIT
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={confirmResetSp} onOpenChange={setConfirmResetSp}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>¿Reiniciar el punto de venta?</AlertDialogTitle>
              <AlertDialogDescription>
                Borramos el punto de venta por defecto guardado y volvemos a consultar tu lista en ARCA.
                Es útil cuando creaste o desactivaste un punto de venta en ARCA y querés que Aikestar
                empiece de cero con esa información. Después vas a poder elegir cuál usar por defecto.
                Las facturas ya emitidas no se tocan.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-reset-sp-cancel">Cancelar</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => resetSellingPoint.mutate()}
                disabled={resetSellingPoint.isPending}
                data-testid="button-reset-sp-confirm"
              >
                {resetSellingPoint.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Sí, reiniciar
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={confirmDeactivate} onOpenChange={setConfirmDeactivate}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>¿Desactivar la facturación electrónica?</AlertDialogTitle>
              <AlertDialogDescription>
                Dejás de poder emitir facturas desde Aikestar. Las facturas ya emitidas y sus datos se conservan. Podés volver a activarla cuando quieras.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-deactivate-cancel">Cancelar</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deactivate.mutate()}
                disabled={deactivate.isPending}
                data-testid="button-deactivate-confirm"
                className="bg-red-500 hover:bg-red-600"
              >
                {deactivate.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Sí, desactivar
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <SellingPointSetupGuide open={showSetupGuide} onOpenChange={setShowSetupGuide} />
        <RetrySignupDialog
          open={showRetrySignup}
          onOpenChange={setShowRetrySignup}
          onFallbackToManual={() => setShowSetupGuide(true)}
        />
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Render: activation form (new or editing)
  // -----------------------------------------------------------------------
  return (
    <div className="space-y-5" data-testid="facturador-section">
      <div>
        <p className="text-sm text-muted-foreground">
          Emití facturas electrónicas ante ARCA (ex-AFIP) directamente desde Aikestar.
          Completá tus datos y activamos todo por vos.
        </p>
      </div>

      {changingCuit && acc && (
        <Alert data-testid="alert-changing-cuit" className="border-pink-500/40">
          <AlertTriangle className="h-4 w-4 text-pink-500" />
          <AlertDescription>
            Estás por cambiar el CUIT activado (actual: <strong>{acc.cuit}</strong>).
            Las facturas ya emitidas seguirán asociadas al CUIT anterior y se conservan en tu historial.
          </AlertDescription>
        </Alert>
      )}

      {!envReady && (
        <Alert variant="destructive" data-testid="alert-env-missing">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {data?.envReason || 'El servicio de facturación electrónica no está disponible en este momento.'}
          </AlertDescription>
        </Alert>
      )}

      {showMockBanner && (
        <Alert data-testid="alert-sandbox-mock" className="border-pink-500/40 bg-pink-500/5">
          <AlertTriangle className="h-4 w-4 text-pink-500" />
          <AlertDescription>
            <strong>Modo de pruebas interno activo.</strong> Mientras ARCA no esté disponible,
            los comprobantes se generan como <strong>SIMULADOS</strong>, sin validez fiscal,
            para que puedas probar todo el flujo. Cuando vuelva a estar disponible, podés pasar a producción.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="invoicing-cuit">CUIT de tu empresa</Label>
              <Input
                id="invoicing-cuit"
                data-testid="input-invoicing-cuit"
                value={form.cuit}
                onChange={(e) => setForm({ ...form, cuit: e.target.value.replace(/\D/g, '').slice(0, 11) })}
                placeholder="20123456789"
                disabled={!canEdit || (isActivated && editing && !changingCuit)}
                inputMode="numeric"
                aria-invalid={cuitInputState === 'invalid' || cuitInputState === 'incomplete'}
                className={
                  cuitInputState === 'invalid' || cuitInputState === 'incomplete'
                    ? 'border-red-500 focus-visible:ring-red-500'
                    : cuitInputState === 'valid'
                      ? 'border-emerald-500/60 focus-visible:ring-emerald-500'
                      : ''
                }
              />
              {cuitInputState === 'empty' && (
                <p className="text-xs text-muted-foreground mt-1">11 dígitos, sin guiones</p>
              )}
              {cuitInputState === 'incomplete' && (
                <p className="text-xs text-red-500 mt-1" data-testid="text-cuit-counter">
                  {cuitDigits.length}/11 dígitos — completá los dígitos restantes
                </p>
              )}
              {cuitInputState === 'invalid' && (
                <p className="text-xs text-red-500 mt-1" data-testid="text-cuit-invalid">
                  El CUIT no es válido. Revisá los dígitos.
                </p>
              )}
              {cuitInputState === 'valid' && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1" data-testid="text-cuit-valid">
                  {isSociedad ? 'CUIT de la sociedad válido' : 'CUIT válido'}
                </p>
              )}
            </div>

            {isSociedad && (
              <div>
                <Label htmlFor="invoicing-admin-cuit">
                  CUIT del administrador (persona física) <span className="text-pink-500">*</span>
                </Label>
                <Input
                  id="invoicing-admin-cuit"
                  data-testid="input-invoicing-admin-cuit"
                  value={form.adminCuit}
                  onChange={(e) => setForm({ ...form, adminCuit: e.target.value.replace(/\D/g, '').slice(0, 11) })}
                  placeholder="20123456789"
                  disabled={!canEdit}
                  inputMode="numeric"
                  aria-invalid={adminCuitInputState === 'invalid' || adminCuitInputState === 'incomplete'}
                  className={
                    adminCuitInputState === 'invalid' || adminCuitInputState === 'incomplete'
                      ? 'border-red-500 focus-visible:ring-red-500'
                      : adminCuitInputState === 'valid'
                        ? 'border-emerald-500/60 focus-visible:ring-emerald-500'
                        : ''
                  }
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Es la persona con clave fiscal nivel 3 habilitada para facturar a nombre de la sociedad. Su CUIT debe empezar con 20, 23, 24 o 27.
                </p>
                {adminCuitInputState === 'incomplete' && (
                  <p className="text-xs text-red-500 mt-1" data-testid="text-admin-cuit-counter">
                    {adminCuitDigits.length}/11 dígitos — completá los dígitos restantes
                  </p>
                )}
                {adminCuitInputState === 'invalid' && (
                  <p className="text-xs text-red-500 mt-1" data-testid="text-admin-cuit-invalid">
                    El CUIT no es válido. Debe empezar con 20, 23, 24 o 27.
                  </p>
                )}
                {adminCuitInputState === 'valid' && (
                  <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1" data-testid="text-admin-cuit-valid">
                    CUIT del administrador válido
                  </p>
                )}
              </div>
            )}

            <div>
              <Label>Condición frente al IVA</Label>
              <Select
                value={form.ivaCondition}
                onValueChange={(v) => setForm({ ...form, ivaCondition: v as Account['ivaCondition'] })}
                disabled={!canEdit}
              >
                <SelectTrigger data-testid="select-invoicing-iva"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="responsable_inscripto">Responsable Inscripto</SelectItem>
                  <SelectItem value="monotributo">Monotributo</SelectItem>
                  <SelectItem value="exento">Exento</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                Si no coincide, ARCA nos devuelve la correcta y la actualizamos.
              </p>
            </div>

            <div>
              <Label>Ambiente</Label>
              <Select
                value={form.environment}
                onValueChange={(v) => setForm({ ...form, environment: v as Account['environment'] })}
                disabled={!canEdit}
              >
                <SelectTrigger data-testid="select-invoicing-env"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sandbox">Pruebas (sin validez fiscal)</SelectItem>
                  <SelectItem value="production">Producción (validez fiscal real)</SelectItem>
                </SelectContent>
              </Select>
              {form.environment === 'production' && (
                <p className="text-xs text-pink-500 mt-1">
                  Las facturas en producción tienen validez fiscal real ante ARCA.
                </p>
              )}
            </div>

            <div
              className="rounded-md border border-cyan-500/30 bg-cyan-500/5 p-3 text-xs text-muted-foreground"
              data-testid="text-selling-point-info"
            >
              <p>
                <strong className="text-foreground">Punto de venta:</strong> lo crea
                ARCA automáticamente al activar. Cuando termines el alta vas a poder
                ver tus puntos de venta acá abajo y elegir cuál usar por defecto.
              </p>
            </div>

            <div>
              <Label htmlFor="invoicing-address">Domicilio comercial (opcional)</Label>
              <Input
                id="invoicing-address"
                data-testid="input-invoicing-address"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value.slice(0, 200) })}
                placeholder="Av. Corrientes 1234, CABA"
                disabled={!canEdit}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Aparecerá en el encabezado del comprobante.
              </p>
            </div>

            <div>
              <Label htmlFor="invoicing-phone">Teléfono (opcional)</Label>
              <Input
                id="invoicing-phone"
                data-testid="input-invoicing-phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value.slice(0, 30) })}
                placeholder="+54 11 5555 5555"
                disabled={!canEdit}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Si lo cargás, lo mostramos en el comprobante.
              </p>
            </div>

            {form.environment === 'production' && (
              <div>
                <Label htmlFor="invoicing-clave">
                  {isSociedad ? 'Clave fiscal del administrador' : 'Clave fiscal ARCA'} <span className="text-pink-500">*</span>
                </Label>
                <div className="relative">
                  <Input
                    id="invoicing-clave"
                    type={showClaveFiscal ? 'text' : 'password'}
                    data-testid="input-invoicing-clave"
                    value={form.claveFiscal}
                    onChange={(e) => setForm({ ...form, claveFiscal: e.target.value })}
                    placeholder="Se usa solo para activar"
                    disabled={!canEdit}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowClaveFiscal((v) => !v)}
                    disabled={!canEdit}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                    data-testid="toggle-invoicing-clave"
                    aria-label={showClaveFiscal ? 'Ocultar clave fiscal' : 'Mostrar clave fiscal'}
                  >
                    {showClaveFiscal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {isSociedad
                    ? 'Es la clave fiscal del administrador (la persona física cuyo CUIT ingresaste arriba). Se usa una sola vez para habilitar la emisión. No queda guardada.'
                    : 'Se usa una sola vez para habilitar la emisión. No queda guardada.'}
                </p>
                {credentialsValidating && (
                  <p
                    className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5"
                    data-testid="text-clave-validating"
                  >
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Verificando tu clave fiscal contra ARCA…
                  </p>
                )}
                {credValidation.kind === 'ok' && (
                  <p
                    className="text-xs text-emerald-600 dark:text-emerald-400 mt-1 flex items-center gap-1.5"
                    data-testid="text-clave-ok"
                  >
                    <ShieldCheck className="h-3 w-3" />
                    Tus credenciales tienen permisos sobre este CUIT en ARCA.
                  </p>
                )}
                {credValidation.kind === 'bad_credentials' && (
                  <Alert
                    variant="destructive"
                    className="mt-2"
                    data-testid="alert-bad-credentials"
                  >
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>{credValidation.message}</AlertDescription>
                  </Alert>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-2">
            {editing && (
              <Button
                variant="outline"
                onClick={() => { setEditing(false); setChangingCuit(false); }}
                disabled={activate.isPending}
                className="sm:w-auto"
                data-testid="button-cancel-edit"
              >
                Cancelar
              </Button>
            )}
            <span
              className="flex-1"
              title={!canActivate && disabledReason ? disabledReason : undefined}
            >
            <Button
              data-testid="button-activate-invoicing"
              onClick={() => activate.mutate()}
              disabled={!canActivate || activate.isPending}
              size="lg"
              className="w-full bg-gradient-to-r from-pink-500 to-cyan-500 hover:opacity-90 text-white font-semibold h-12 text-base"
            >
              {activate.isPending ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin mr-2" />
                  Activando con ARCA…
                </>
              ) : (
                <>
                  <Zap className="h-5 w-5 mr-2" />
                  {changingCuit ? 'Activar nuevo CUIT' : (isActivated ? 'Guardar cambios' : 'Activar facturación electrónica')}
                </>
              )}
            </Button>
            </span>
          </div>

          {!canActivate && !activate.isPending && disabledReason && (
            <p
              className="text-xs text-amber-600 dark:text-amber-400 text-center pt-1 flex items-center justify-center gap-1.5"
              data-testid="text-activate-blocked-reason"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              {disabledReason}
            </p>
          )}

          {canActivate && !isActivated && (
            <p className="text-xs text-muted-foreground text-center pt-1">
              Validamos tu CUIT ante ARCA, traemos tu razón social y punto de venta automáticamente.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
