// =============================================================================
// AIKESTAR - Integración con MercadoPago (Suscripciones recurrentes)
// =============================================================================
// Reemplaza a Stripe como pasarela de pago. Usa "preapproval" (Suscripciones)
// de MercadoPago: el usuario autoriza un débito recurrente mensual con 30 días
// de prueba gratis. El alta del usuario se completa cuando la suscripción queda
// "authorized" (vía webhook o al volver del checkout).
//
// Variables de entorno:
//   MP_ACCESS_TOKEN   - Access Token del vendedor (panel de desarrolladores MP)
//   MP_WEBHOOK_SECRET - (opcional) clave secreta del webhook para validar firma
//   APP_BASE_URL      - URL pública de la app (ej. https://app.aikestar.com)
// =============================================================================
import { MercadoPagoConfig, PreApproval, Payment } from "mercadopago";

export function isMercadoPagoEnabled(): boolean {
  return !!process.env.MP_ACCESS_TOKEN;
}

function getClient(): MercadoPagoConfig {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error("MP_ACCESS_TOKEN no está configurado");
  }
  return new MercadoPagoConfig({ accessToken });
}

// URL base pública de la app (para los back_url del checkout).
export function getAppBaseUrl(): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, "");
  const domain = process.env.APP_DOMAIN?.replace(/^\./, "");
  if (domain) return `https://${domain}`;
  return "https://app.aikestar.com";
}

export interface CreateSubscriptionInput {
  planType: string;
  amount: number;            // monto mensual en ARS
  payerEmail: string;
  externalReference: string; // = pendingSignupId
  reason: string;            // texto que ve el usuario (ej. "Aikestar - Plan Team")
  freeTrialDays?: number;    // días de prueba gratis (default 30)
}

export interface CreatedSubscription {
  id: string;
  initPoint: string; // URL a la que se redirige al usuario para autorizar
  status: string;
}

// Crea una suscripción (preapproval) recurrente mensual. Devuelve el init_point
// al que hay que redirigir al usuario para que autorice el débito.
export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<CreatedSubscription> {
  const preapproval = new PreApproval(getClient());
  const backUrl = `${getAppBaseUrl()}/payment-success`;

  const autoRecurring: any = {
    frequency: 1,
    frequency_type: "months",
    transaction_amount: input.amount,
    currency_id: "ARS",
  };
  const trial = input.freeTrialDays ?? 30;
  if (trial > 0) {
    autoRecurring.free_trial = { frequency: trial, frequency_type: "days" };
  }

  // El SDK no tipa `notification_url`, pero la API de preapproval sí lo acepta.
  const body: any = {
    reason: input.reason,
    external_reference: input.externalReference,
    payer_email: input.payerEmail,
    back_url: backUrl,
    notification_url: `${getAppBaseUrl()}/api/mercadopago/webhook`,
    auto_recurring: autoRecurring,
    status: "pending",
  };
  const result = await preapproval.create({ body });

  if (!result.id || !result.init_point) {
    throw new Error("MercadoPago no devolvió init_point para la suscripción");
  }
  return { id: result.id, initPoint: result.init_point, status: result.status || "pending" };
}

export interface PreapprovalInfo {
  id: string;
  status: string;            // 'authorized' | 'pending' | 'cancelled' | 'paused'
  externalReference?: string;
  payerEmail?: string;
  planType?: string;
}

// Consulta una suscripción por id directamente a la API de MercadoPago.
// Se usa en el webhook para confirmar (anti-spoofing): aunque alguien falsee
// la notificación, el estado real se lee desde MP con nuestro Access Token.
export async function getSubscription(id: string): Promise<PreapprovalInfo> {
  const preapproval = new PreApproval(getClient());
  const r: any = await preapproval.get({ id });
  return {
    id: r.id,
    status: r.status,
    externalReference: r.external_reference,
    payerEmail: r.payer_email,
  };
}

// Consulta un pago por id (para notificaciones de tipo 'payment').
export async function getPayment(id: string): Promise<any> {
  const payment = new Payment(getClient());
  return payment.get({ id });
}
