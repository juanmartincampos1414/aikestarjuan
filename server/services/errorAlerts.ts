// Alertas de errores graves del sistema.
// Captura errores 500+ del servidor y caídas inesperadas del proceso, y envía un
// email inmediato y detallado al equipo. Características clave:
//  - Sólo se dispara en producción (salvo override por variable de entorno).
//  - Freno anti-spam: errores idénticos (mismo origen + operación + mensaje) no se
//    reenvían durante una ventana corta, para no inundar la casilla.
//  - "Fire and forget": nunca lanza ni demora la respuesta al usuario.
import { sendSystemErrorAlertEmail } from './email';
import { storage } from '../storage';

const DEFAULT_RECIPIENT = 'eparedes@ssitechnologiesgroup.com';
const DEDUPE_WINDOW_MS = Number(process.env.ERROR_ALERT_DEDUPE_MS) || 10 * 60 * 1000;

const recentAlerts = new Map<string, number>();

function alertsEnabled(): boolean {
  if (process.env.ERROR_ALERT_DISABLED === '1') return false;
  if (process.env.ERROR_ALERT_FORCE === '1') return true;
  return process.env.NODE_ENV === 'production';
}

function getRecipient(): string {
  return (process.env.ERROR_ALERT_EMAIL || DEFAULT_RECIPIENT).trim();
}

// Enmascara secretos/datos sensibles que pudieran venir embebidos en el mensaje,
// el stack o la URL del error (tokens Bearer, JWT, contraseñas, api keys, cookies,
// códigos, query params sensibles). El email de alerta sí incluye email/IP del
// usuario porque son parte del alcance pedido, pero nunca credenciales/tokens.
function redactSecrets(input: string | null | undefined): string {
  if (!input) return '';
  let s = String(input);
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/\-]+=*/gi, 'Bearer [REDACTADO]');
  s = s.replace(/eyJ[A-Za-z0-9._\-]+/g, '[JWT_REDACTADO]');
  s = s.replace(
    /(password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|auth|cookie|session|csrf|recovery|code)(["']?\s*[:=]\s*["']?)([^"'\s,&}]+)/gi,
    (_m, key, sep) => `${key}${sep}[REDACTADO]`,
  );
  return s;
}

// Normaliza una ruta para el dedupe: descarta la query string y reemplaza ids
// dinámicos (uuid y numéricos) para que errores equivalentes compartan clave.
function normalizePath(path?: string | null): string {
  if (!path) return '';
  let p = path.split('?')[0];
  p = p.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id');
  p = p.replace(/\/\d+/g, '/:id');
  return p;
}

function shouldThrottle(key: string): boolean {
  const now = Date.now();
  for (const [k, t] of recentAlerts) {
    if (now - t > DEDUPE_WINDOW_MS) recentAlerts.delete(k);
  }
  const last = recentAlerts.get(key);
  if (last && now - last < DEDUPE_WINDOW_MS) return true;
  recentAlerts.set(key, now);
  return false;
}

function sourceLabel(source: SystemErrorReport['source']): string {
  switch (source) {
    case 'uncaughtException':
      return 'Excepción no atrapada (uncaughtException)';
    case 'unhandledRejection':
      return 'Promesa rechazada sin manejar (unhandledRejection)';
    case 'whatsappLock':
      return 'Bot WhatsApp: candado liberado a la fuerza';
    default:
      return 'Error HTTP del servidor (500+)';
  }
}

export interface SystemErrorReport {
  source: 'http' | 'uncaughtException' | 'unhandledRejection' | 'whatsappLock';
  message: string;
  stack?: string | null;
  statusCode?: number | null;
  method?: string | null;
  path?: string | null;
  userId?: string | null;
  organizationId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

// Huella estable del error: origen + ruta normalizada + mensaje (redactado y
// recortado). Sirve tanto para el freno anti-spam del email (en memoria) como
// para agrupar repeticiones en la persistencia (en base), de modo que un mismo
// error no genere filas duplicadas.
function fingerprintOf(report: SystemErrorReport): string {
  return `${report.source}|${normalizePath(report.path)}|${redactSecrets(report.message).slice(0, 200)}`;
}

// Punto de entrada sincrónico y seguro: decide si corresponde reportar y delega
// el trabajo (persistencia + email) en segundo plano. Nunca lanza.
export function reportSystemError(report: SystemErrorReport): void {
  try {
    if (!alertsEnabled()) return;
    void dispatch(report);
  } catch {
    // El reporter de errores jamás debe romper el flujo principal.
  }
}

async function dispatch(report: SystemErrorReport): Promise<void> {
  const fingerprint = fingerprintOf(report);

  let userEmail: string | null = null;
  if (report.userId) {
    try {
      const u = await storage.getUser(report.userId);
      userEmail = u?.email ?? null;
    } catch {
      // Si no se puede resolver el usuario, se reporta igual con el id.
    }
  }

  const safeMessage = redactSecrets(report.message);
  const safeStack = redactSecrets(report.stack);
  const safePath = redactSecrets(report.path) || null;

  // 1) Persistir SIEMPRE (con datos sensibles redactados). La persistencia
  //    agrupa por huella e incrementa el contador, así que el panel refleja
  //    todas las ocurrencias aunque el email esté frenado por anti-spam.
  try {
    await storage.recordSystemError({
      fingerprint,
      source: report.source,
      message: safeMessage || '(sin mensaje)',
      stack: safeStack || null,
      statusCode: report.statusCode ?? null,
      method: report.method ?? null,
      path: safePath,
      userId: report.userId ?? null,
      userEmail,
      organizationId: report.organizationId ?? null,
      ip: report.ip ?? null,
      userAgent: report.userAgent ?? null,
      status: 'open',
    });
  } catch (e: any) {
    console.error('[ErrorAlert] No se pudo persistir el error:', e?.message || e);
  }

  // 2) Enviar email sólo si no está frenado por el anti-spam en memoria.
  if (shouldThrottle(fingerprint)) return;

  try {
    await sendSystemErrorAlertEmail({
      recipient: getRecipient(),
      source: sourceLabel(report.source),
      message: safeMessage,
      stack: safeStack,
      statusCode: report.statusCode ?? null,
      method: report.method ?? null,
      path: safePath,
      userId: report.userId ?? null,
      userEmail,
      organizationId: report.organizationId ?? null,
      ip: report.ip ?? null,
      userAgent: report.userAgent ?? null,
      occurredAt: new Date(),
    });
  } catch (e: any) {
    console.error('[ErrorAlert] No se pudo enviar la alerta de error:', e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// Task #459 — Avisar cuando el candado del bot de WhatsApp se libera a la fuerza.
//
// El arreglo del freeze del bot (Task #458) agrega salvavidas que liberan el
// candado de conversación destruyendo la conexión cuando la base queda colgada:
// timeout del unlock ("release_timeout") y el watchdog por tope de retención
// ("watchdog"). Esos eventos son síntoma de inestabilidad de la conexión Neon.
//
// Política de alcance:
//  - SIEMPRE se persiste cada evento en el panel de errores del sistema (tabla
//    system_errors), agrupado por tipo, para que quede contable/consultable —
//    incluso cuando no se manda email. Así, una sola liberación forzada aislada
//    queda registrada pero no genera ruido por correo.
//  - SÓLO se envía email cuando la FRECUENCIA supera un umbral dentro de una
//    ventana (varias liberaciones forzadas en pocos minutos = la inestabilidad
//    de Neon volvió), con un cooldown para no repetir el aviso por la misma racha.
//  - Gateado por `alertsEnabled()` (sólo producción salvo override), igual que el
//    resto de las alertas de error del sistema.

export type WhatsappLockForceReleaseKind = 'watchdog' | 'release_timeout' | 'ttl_reclaim';

const WA_LOCK_WINDOW_MS =
  Number(process.env.WHATSAPP_LOCK_ALERT_WINDOW_MS) || 15 * 60 * 1000;
const WA_LOCK_THRESHOLD =
  Number(process.env.WHATSAPP_LOCK_ALERT_THRESHOLD) || 3;
const WA_LOCK_EMAIL_COOLDOWN_MS =
  Number(process.env.WHATSAPP_LOCK_ALERT_COOLDOWN_MS) || 30 * 60 * 1000;

// Timestamps (epoch ms) de las liberaciones forzadas recientes. Sirve para
// medir la frecuencia dentro de la ventana. In-memory por instancia: bajo
// Autoscale multi-réplica cada nodo cuenta lo suyo, lo que es aceptable acá
// porque un solo nodo con la conexión inestable ya alcanza el umbral.
const waLockEvents: number[] = [];
let waLockLastEmailAt = 0;

function waLockKindLabel(kind: WhatsappLockForceReleaseKind): string {
  switch (kind) {
    case 'watchdog':
      return 'watchdog disparado (handler colgado)';
    case 'release_timeout':
      return 'timeout/fallo del release (unlock colgado)';
    case 'ttl_reclaim':
      return 'candado vencido reclamado por TTL (handler previo no liberó)';
    default:
      return 'liberación forzada';
  }
}

export interface WhatsappLockForceReleaseEvent {
  kind: WhatsappLockForceReleaseKind;
  reason: string;
  key: string;
  organizationId?: string | null;
  userId?: string | null;
  holdMs?: number | null;
}

// Punto de entrada sincrónico y seguro. Registra el evento y, si la frecuencia
// lo amerita, dispara el email. Nunca lanza ni demora al caller.
export function reportWhatsappLockForceRelease(event: WhatsappLockForceReleaseEvent): void {
  try {
    if (!alertsEnabled()) return;
    void dispatchWhatsappLockEvent(event);
  } catch {
    // El reporter jamás debe romper el flujo del bot.
  }
}

async function dispatchWhatsappLockEvent(event: WhatsappLockForceReleaseEvent): Promise<void> {
  const kindLabel = waLockKindLabel(event.kind);
  // Huella por TIPO de evento (no por key de usuario/org) para que el panel
  // agrupe todas las liberaciones forzadas del mismo tipo en una sola fila con
  // contador, en vez de una fila por usuario.
  const message = `Candado del bot de WhatsApp liberado a la fuerza: ${kindLabel}`;
  const fingerprint = `whatsappLock|${event.kind}|${message}`;
  const detail = [
    `Tipo: ${kindLabel}`,
    `Motivo: ${redactSecrets(event.reason)}`,
    `Clave (org:user): ${redactSecrets(event.key)}`,
    event.holdMs != null ? `Retención: ${event.holdMs}ms` : null,
  ]
    .filter(Boolean)
    .join('\n');

  // 1) Persistir SIEMPRE en el panel (queda contable aunque no se mande email).
  try {
    await storage.recordSystemError({
      fingerprint,
      source: 'whatsappLock',
      message,
      stack: detail,
      statusCode: null,
      method: null,
      path: '/api/whatsapp/webhook',
      userId: event.userId ?? null,
      userEmail: null,
      organizationId: event.organizationId ?? null,
      ip: null,
      userAgent: null,
      status: 'open',
    });
  } catch (e: any) {
    console.error('[WhatsAppLockAlert] No se pudo persistir el evento:', e?.message || e);
  }

  // 2) Medir frecuencia en la ventana deslizante.
  const now = Date.now();
  waLockEvents.push(now);
  while (waLockEvents.length > 0 && now - waLockEvents[0] > WA_LOCK_WINDOW_MS) {
    waLockEvents.shift();
  }
  const countInWindow = waLockEvents.length;

  // 3) Email sólo si se superó el umbral y pasó el cooldown desde el último aviso.
  if (countInWindow < WA_LOCK_THRESHOLD) return;
  if (now - waLockLastEmailAt < WA_LOCK_EMAIL_COOLDOWN_MS) return;
  waLockLastEmailAt = now;

  const windowMinutes = Math.round(WA_LOCK_WINDOW_MS / 60000);
  const summary =
    `Se detectaron ${countInWindow} liberaciones forzadas del candado del bot de ` +
    `WhatsApp en los últimos ${windowMinutes} min (umbral: ${WA_LOCK_THRESHOLD}). ` +
    `Probable inestabilidad de la conexión Neon. Último evento: ${kindLabel}.`;

  try {
    await sendSystemErrorAlertEmail({
      recipient: getRecipient(),
      source: sourceLabel('whatsappLock'),
      message: summary,
      stack: detail,
      statusCode: null,
      method: null,
      path: '/api/whatsapp/webhook',
      userId: event.userId ?? null,
      userEmail: null,
      organizationId: event.organizationId ?? null,
      ip: null,
      userAgent: null,
      occurredAt: new Date(),
    });
  } catch (e: any) {
    console.error('[WhatsAppLockAlert] No se pudo enviar la alerta:', e?.message || e);
  }
}
