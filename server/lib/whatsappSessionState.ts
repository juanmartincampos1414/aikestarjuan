/**
 * Helpers para decidir cuándo mostrarle al usuario un recordatorio de la
 * organización activa al inicio de cada conversación de WhatsApp (Task #209).
 *
 * Diseñado en módulo aparte (no inline en `routes/whatsapp.ts`) para poder
 * importarlo desde tests sin arrastrar todo el handler (storage, openai,
 * twilio, etc.) y para mantener la lógica del banner aislada.
 *
 * Persistencia (Task #211):
 *  - La "última actividad por WhatsApp" del usuario vive en la columna
 *    `users.lastWhatsappMessageAt` (ver `shared/schema.ts`). Antes era un
 *    `Map` in-memory que se reseteaba con cada deploy/reinicio, así que el
 *    banner se volvía a disparar una vez de más por usuario por reinicio.
 *  - Ahora estas funciones son puras: reciben el timestamp persistido y
 *    devuelven el resultado. La escritura del campo la hace el handler en
 *    `routes/whatsapp.ts` vía `storage.updateUser`.
 *
 * Reglas (Task #209):
 *  - Mostrar el banner cuando NO hay registro previo del usuario (primera
 *    interacción luego del welcome) o cuando pasaron más de
 *    `gapMs` desde el último mensaje.
 *  - El cambio de org sigue siendo local a la conversación (Task #207): el
 *    banner solo informa, no persiste nada respecto a la org.
 *
 * Task #210:
 *  - El intervalo del banner es configurable por usuario+org desde
 *    `whatsapp_preferences.org_banner_interval_hours`. `shouldShowOrgBanner`
 *    recibe el gap calculado por el caller (ver `resolveOrgBannerGapMs`).
 *  - Para mantener compat con el llamador anterior y los tests existentes,
 *    si no se pasa `gapMs` se usa `DEFAULT_SESSION_GAP_MS` (6 h).
 *  - Un valor de gap `null` significa "nunca mostrar" (preferencia explícita).
 */

// Default a partir del cual consideramos que arrancó una "nueva conversación"
// y volvemos a mostrar el banner. 6 horas es suficiente para cubrir el
// caso típico (mañana, mediodía, noche) sin ser molesto entre mensajes
// seguidos del mismo día.
export const DEFAULT_ORG_BANNER_INTERVAL_HOURS = 6;
export const DEFAULT_SESSION_GAP_MS =
  DEFAULT_ORG_BANNER_INTERVAL_HOURS * 60 * 60 * 1000;

// Alias retrocompatible: tests y código previo todavía importan SESSION_GAP_MS.
export const SESSION_GAP_MS = DEFAULT_SESSION_GAP_MS;

/**
 * Convierte la preferencia (en horas) a un gap en ms o `null` si está
 * deshabilitada.
 *
 *   - undefined / null → default (6 h)
 *   - 0                → "nunca mostrar" (devuelve null)
 *   - n > 0            → n horas en ms
 *   - n < 0            → tratado como default (defensivo, no debería pasar)
 */
export function resolveOrgBannerGapMs(
  intervalHours: number | null | undefined,
): number | null {
  if (intervalHours === null || intervalHours === undefined) {
    return DEFAULT_SESSION_GAP_MS;
  }
  if (intervalHours === 0) return null;
  if (intervalHours < 0) return DEFAULT_SESSION_GAP_MS;
  return intervalHours * 60 * 60 * 1000;
}

/**
 * ¿Toca mostrar el banner de org activa para este usuario?
 *
 * Pure function (Task #211): recibe el `lastSeen` persistido en
 * `users.lastWhatsappMessageAt` en lugar de leer un Map in-memory.
 *
 * @param lastSeen Última actividad del usuario por WhatsApp. Puede venir
 *                 como `Date` (lo típico desde Drizzle), `number`
 *                 (timestamp en ms, útil para tests) o `null`/`undefined`
 *                 (usuario nunca interactuó).
 * @param now      Timestamp actual en ms (inyectable para tests).
 * @param gapMs    Gap configurado para este usuario+org (Task #210).
 *                 Default: `DEFAULT_SESSION_GAP_MS`. Si es `null`, el
 *                 banner está deshabilitado y siempre devolvemos `false`.
 */
export function shouldShowOrgBanner(
  lastSeen: Date | number | null | undefined,
  now: number = Date.now(),
  gapMs: number | null = DEFAULT_SESSION_GAP_MS,
): boolean {
  // Preferencia "no mostrar nunca".
  if (gapMs === null) return false;
  if (lastSeen === null || lastSeen === undefined) return true;
  const lastMs = typeof lastSeen === 'number' ? lastSeen : lastSeen.getTime();
  return now - lastMs > gapMs;
}

export function buildOrgBannerMessage(orgName: string): string {
  return (
    `📍 Estás registrando movimientos en *${orgName}*.\n` +
    `Mandá _"cambiar org"_ para elegir otra o _"qué org"_ para volver a verla.`
  );
}

// Detecta consultas del tipo "qué org estoy usando" / "cuál es mi org".
// Distinto de `detectGenericOrgSwitchRequest` (que pide cambiarla) y de
// "mis organizaciones" (que lista todas). Solo queremos confirmar la actual.
export function detectShowCurrentOrgRequest(message: string): boolean {
  const lower = message.toLowerCase().trim();
  // Normalizar acentos para que "qué" / "que" / "cuál" / "cual" / "organización"
  // funcionen sin importar cómo el usuario los escriba.
  const normalized = lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const patterns = [
    /^que\s+org(anizacion)?\s*\??$/,
    /^cual\s+(es\s+)?(mi\s+)?org(anizacion)?\s*\??$/,
    /^en\s+que\s+org(anizacion)?\s+estoy\s*\??$/,
    /^que\s+org(anizacion)?\s+estoy\s+(usando|registrando)\s*\??$/,
    /^que\s+empresa\s+(estoy\s+usando|es\s+la\s+actual)\s*\??$/,
    /^cual\s+(es\s+)?(mi\s+)?empresa\s+actual\s*\??$/,
    /^org(anizacion)?\s+actual\s*\??$/,
    /^donde\s+estoy\s+registrando\s*\??$/,
  ];
  return patterns.some((p) => p.test(normalized));
}
