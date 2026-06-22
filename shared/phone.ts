export type NormalizePhoneResult =
  | { ok: true; phone: string; changed: boolean; isArMobile: boolean }
  | { ok: false; reason: 'empty' | 'invalid_format' };

function normalizeArgentineMobile(compact: string): string | null {
  if (!compact) return null;
  const hadPlus = compact.startsWith('+');
  const digits = compact.replace(/\D/g, '');
  if (!digits) return null;

  let arLocal: string | null = null;
  if (digits.startsWith('549')) {
    arLocal = digits.slice(3);
  } else if (digits.startsWith('54') && (hadPlus || digits.length >= 12)) {
    arLocal = digits.slice(2);
  } else if (!hadPlus && digits.length >= 10 && digits.length <= 13) {
    arLocal = digits;
  } else {
    return null;
  }

  if (arLocal.startsWith('0')) arLocal = arLocal.slice(1);
  if (arLocal.length === 11 && arLocal.startsWith('9')) arLocal = arLocal.slice(1);

  const m15 = arLocal.match(/^(\d{2,4})15(\d{6,8})$/);
  if (m15 && m15[1].length + m15[2].length === 10) {
    arLocal = m15[1] + m15[2];
  } else if (/^15\d{8}$/.test(arLocal)) {
    arLocal = '11' + arLocal.slice(2);
  }

  if (/^[1-9]\d{9}$/.test(arLocal)) {
    return '+549' + arLocal;
  }
  return null;
}

export function normalizePhoneInput(input: string | null | undefined): NormalizePhoneResult {
  if (!input) return { ok: false, reason: 'empty' };
  const trimmed = String(input).trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  const compact = trimmed.replace(/[\s\-\(\)\.]/g, '');

  const ar = normalizeArgentineMobile(compact);
  if (ar) {
    return { ok: true, phone: ar, changed: ar !== compact, isArMobile: true };
  }

  const hadPlus = compact.startsWith('+');
  const digits = compact.replace(/\D/g, '');

  // If the user clearly claimed Argentina (+54...) but AR-mobile normalization
  // failed (too short, garbage, etc.), don't silently accept it as a generic
  // E.164 number. Surface the invalid_format error so the UI shows the friendly
  // AR-specific message instead of saving a malformed +54xxx that the bot will
  // never match.
  if (digits.startsWith('54')) {
    return { ok: false, reason: 'invalid_format' };
  }

  if (hadPlus && /^\+[1-9]\d{7,14}$/.test('+' + digits)) {
    const candidate = '+' + digits;
    return { ok: true, phone: candidate, changed: candidate !== compact, isArMobile: false };
  }

  return { ok: false, reason: 'invalid_format' };
}

export function formatArgentineMobilePretty(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (!digits.startsWith('549') || digits.length !== 13) return null;
  const local = digits.slice(3);
  const area = local.slice(0, 2);
  const first = local.slice(2, 6);
  const last = local.slice(6);
  return `+54 9 ${area} ${first}-${last}`;
}

export function isArgentineMobileMissing9(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith('54') && !digits.startsWith('549') && digits.length >= 11 && digits.length <= 12;
}

export function arPhoneCandidates(input: string): string[] {
  const compact = String(input || '').trim().replace(/[\s\-\(\)\.]/g, '');
  if (!compact) return [];
  const digits = compact.replace(/\D/g, '');
  if (!digits) return [];

  const set = new Set<string>([compact, digits, '+' + digits]);

  if (digits.startsWith('549') && digits.length === 13) {
    const without9 = '54' + digits.slice(3);
    set.add(without9);
    set.add('+' + without9);
  }
  if (digits.startsWith('54') && !digits.startsWith('549') && digits.length === 12) {
    const with9 = '549' + digits.slice(2);
    set.add(with9);
    set.add('+' + with9);
  }

  return Array.from(set);
}

// Task #225 — Para mostrar en mensajes de confirmación (email/WhatsApp) sin
// exponer el número entero. Devuelve una versión legible enmascarando los
// dígitos centrales y dejando los últimos 4 visibles. Si el número parece
// un móvil argentino lo enmascaramos sobre la versión "pretty" (+54 9 11
// ••••-7777). Para cualquier otro formato internacional aplicamos un
// enmascarado simple "+CC••••XXXX". Si no podemos parsear nada devolvemos
// "•••• ••••" para no leakear basura.
export function maskPhoneForDisplay(phone: string | null | undefined): string {
  if (!phone) return '•••• ••••';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 4) return '•••• ••••';

  // Móvil AR canónico: +54 9 AA ••••-XXXX
  if (digits.startsWith('549') && digits.length === 13) {
    const local = digits.slice(3);
    const area = local.slice(0, 2);
    const last = local.slice(6);
    return `+54 9 ${area} ••••-${last}`;
  }

  // Resto de los formatos internacionales: tomamos los primeros 1-3 dígitos
  // como código de país (lo que quede después de los últimos 4 hasta un
  // máximo de 3) y enmascaramos el medio.
  const last4 = digits.slice(-4);
  const rest = digits.slice(0, -4);
  const cc = rest.slice(0, Math.min(3, rest.length));
  return `+${cc}••••${last4}`;
}
