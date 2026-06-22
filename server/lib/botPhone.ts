// Single source of truth for the WhatsApp Business bot phone number.
// Used by `GET /api/whatsapp/bot-info` and the linking wizard so the
// displayed number and the wa.me deeplink can never drift apart.

export const PRODUCTION_BOT_NUMBER_E164 = "+5491124894944";

// Twilio sandbox number — cannot receive customer-initiated chats, so
// we never surface it. Compared on digits-only to tolerate "+", missing
// "+", "whatsapp:" prefix, etc.
const SANDBOX_DIGITS = '14155238886';

export function formatBotDisplay(e164: string): string {
  const cleaned = e164.replace(/[^\d+]/g, '');
  const arMatch = cleaned.match(/^\+54(9?)(\d{2,4})(\d{4})(\d{4})$/);
  if (arMatch) {
    const [, , area, mid, last] = arMatch;
    return `+54 ${area} ${mid}-${last}`;
  }
  return cleaned;
}

export interface BotPhoneInfo {
  e164: string;
  waMe: string;
  display: string;
}

export function getBotPhoneInfo(envValue?: string): BotPhoneInfo {
  const raw = (envValue ?? process.env.TWILIO_WHATSAPP_NUMBER ?? '')
    .replace('whatsapp:', '')
    .trim();
  const rawDigits = raw.replace(/[^\d]/g, '');
  const looksReal = rawDigits.length > 0 && rawDigits !== SANDBOX_DIGITS;
  const e164 = looksReal
    ? (raw.startsWith('+') ? raw : `+${rawDigits}`)
    : PRODUCTION_BOT_NUMBER_E164;
  const waMe = e164.replace(/[^\d]/g, '');
  return { e164, waMe, display: formatBotDisplay(e164) };
}
