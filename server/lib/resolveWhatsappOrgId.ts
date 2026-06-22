/**
 * Resuelve qué organización debe usar el bot de WhatsApp para este usuario.
 *
 * Prioridad:
 *  1. `whatsappDefaultOrganizationId` — la org elegida explícitamente por el
 *     usuario en Configuración → Preferencias de WhatsApp (siempre que siga
 *     siendo miembro).
 *  2. `lastActiveOrganizationId` — fallback histórico para usuarios que
 *     todavía no configuraron una default del bot (se usa la última org que
 *     vieron en la web).
 *  3. `organizations[0]` — última red de seguridad si nada de lo anterior
 *     apunta a una org válida.
 *
 * IMPORTANTE: el bot NO debe sobrescribir `whatsappDefaultOrganizationId`
 * automáticamente. Sólo el usuario la cambia desde la web. Cuando el usuario
 * menciona otra org en un mensaje, el cambio es local a la conversación
 * (variable `effectiveOrgId` en el handler) y NO se persiste.
 *
 * Vive en su propio módulo (no inline en `routes/whatsapp.ts`) para poder
 * importarlo desde tests sin arrastrar todo el bot (storage, openai, etc.).
 */
export function resolveWhatsappOrgId(
  user: { whatsappDefaultOrganizationId?: string | null; lastActiveOrganizationId?: string | null },
  organizations: Array<{ id: string }>,
): string {
  if (!organizations.length) {
    throw new Error('resolveWhatsappOrgId: organizations vacío');
  }
  const defaultOrgId = user.whatsappDefaultOrganizationId;
  if (defaultOrgId && organizations.some(o => o.id === defaultOrgId)) {
    return defaultOrgId;
  }
  const lastOrgId = user.lastActiveOrganizationId;
  if (lastOrgId && organizations.some(o => o.id === lastOrgId)) {
    return lastOrgId;
  }
  return organizations[0].id;
}
