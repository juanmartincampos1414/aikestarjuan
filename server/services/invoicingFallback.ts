/**
 * Pure decision helpers for the invoicing mock/fallback behaviour.
 *
 * Extracted from `server/routes/invoicing.ts` so the critical branches
 * (when do we use the internal mock? when do we refuse to fall back?
 * who can read a simulated PDF?) are easy to unit-test without touching
 * the database, the express layer or the external provider.
 */
import type { InvoicingEnvironment } from '@shared/schema';
import { FacturitaError } from './facturita';

export function isProviderConfigured(): boolean {
  return !!process.env.FACTURITA_API_KEY;
}

export function isSandboxMockForced(): boolean {
  return process.env.INVOICING_SANDBOX_MOCK === '1';
}

/**
 * Production NEVER uses the internal mock. In sandbox the mock is used
 * when explicitly forced or when no API key is configured.
 */
export function shouldUseSandboxMock(env: InvoicingEnvironment): boolean {
  if (env !== 'sandbox') return false;
  return isSandboxMockForced() || !isProviderConfigured();
}

/**
 * After a failed real provider call in sandbox, decide whether to fall back
 * to the internal mock. Production never falls back.
 *
 * Network errors and transient upstream failures (404/502/503/504) are
 * treated as fallback-eligible. Anything else (4xx business errors, 5xx
 * non-transient) must surface to the caller.
 */
export function isMockFallbackEligible(env: InvoicingEnvironment, err: unknown): boolean {
  if (env !== 'sandbox') return false;
  if (!(err instanceof FacturitaError)) return false;
  if (err.code === 'NETWORK') return true;
  return [404, 502, 503, 504].includes(err.status);
}

/**
 * Production may NEVER cancel a simulated invoice through the mock
 * provider. Any historical simulated invoice that ends up in production
 * has to be resolved manually with support.
 */
export interface CreditNoteProductionGuardResult {
  ok: boolean;
  status?: 409;
  message?: string;
}
export function checkCreditNoteProductionGuard(
  env: InvoicingEnvironment,
  wasSimulatedInvoice: boolean,
): CreditNoteProductionGuardResult {
  if (env === 'production' && wasSimulatedInvoice) {
    return {
      ok: false,
      status: 409,
      message:
        'Esta factura se generó en modo de pruebas y no se puede anular en producción. Contactá a soporte.',
    };
  }
  return { ok: true };
}

/**
 * Whether to use the internal mock provider to emit a credit note.
 *
 * - In production, a simulated invoice cannot be cancelled here at all
 *   (`checkCreditNoteProductionGuard` already rejected the request).
 * - In sandbox, if the original invoice was simulated, ONLY the mock can
 *   cancel it (the real provider knows nothing about that uuid).
 * - Otherwise honour the regular sandbox-mock decision.
 */
export function shouldUseMockForCreditNote(
  env: InvoicingEnvironment,
  wasSimulatedInvoice: boolean,
): boolean {
  if (env === 'production') return false;
  if (wasSimulatedInvoice) return true;
  return shouldUseSandboxMock(env);
}

/**
 * Build the partial transaction patch to apply after a credit note is emitted.
 * Crucially: when the mock was used, mark `invoiceSimulated=true` so the UI
 * keeps the "SIMULADO" treatment for the cancelled comprobante.
 */
export function buildCreditNoteUpdatePatch(
  uuid: string,
  usedMock: boolean,
  pdfUrl?: string | null,
): { invoiceCreditNoteUuid: string; invoiceEmissionStatus: 'cancelled'; invoiceSimulated?: true; invoiceCreditNotePdfUrl?: string } {
  return {
    invoiceCreditNoteUuid: uuid,
    invoiceEmissionStatus: 'cancelled',
    ...(usedMock ? { invoiceSimulated: true as const } : {}),
    ...(pdfUrl && typeof pdfUrl === 'string' && pdfUrl.length > 0 ? { invoiceCreditNotePdfUrl: pdfUrl } : {}),
  };
}

/**
 * Authorize a request to read a simulated-invoice PDF.
 *
 * Rules:
 *  - uuid must be a safe slug
 *  - tx must exist and belong to the requesting organization
 *  - the uuid must match either the invoice or its credit note on that tx
 *  - the comprobante must actually be flagged as simulated
 */
export interface MockPdfAccessTx {
  organizationId: string;
  invoiceUuid?: string | null;
  invoiceCreditNoteUuid?: string | null;
  invoiceSimulated?: boolean | null;
}
export interface MockPdfAccessResult {
  ok: boolean;
  status?: 400 | 404;
  message?: string;
}
export function authorizeMockPdfAccess(
  uuid: string | undefined | null,
  tx: MockPdfAccessTx | null | undefined,
  organizationId: string,
): MockPdfAccessResult {
  if (!uuid || !/^[A-Za-z0-9_-]+$/.test(uuid)) {
    return { ok: false, status: 400, message: 'UUID inválido' };
  }
  const notFound = { ok: false, status: 404 as const, message: 'Comprobante no encontrado' };
  if (!tx) return notFound;
  if (tx.organizationId !== organizationId) return notFound;
  if (tx.invoiceUuid !== uuid && tx.invoiceCreditNoteUuid !== uuid) return notFound;
  if (!tx.invoiceSimulated) return notFound;
  return { ok: true };
}
