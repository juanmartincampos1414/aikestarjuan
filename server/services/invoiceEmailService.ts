import type { InsertTransaction, Transaction } from "@shared/schema";
import { storage } from "../storage";
import { sendInvoicePdfEmail } from "./email";
import {
  resolveMockInvoiceContext,
  renderMockInvoicePdfToBuffer,
} from "./mockInvoicePdf";

export const MOCK_PDF_PATH_PREFIX_LOCAL = '/api/invoicing/mock-pdf/';

const ALLOWED_PDF_HOST_SUFFIXES = ['.facturita.com', 'facturita.com'];

export function isAllowedPdfUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const ok = ALLOWED_PDF_HOST_SUFFIXES.some(suf => host === suf.replace(/^\./, '') || host.endsWith(suf));
  return ok ? u : null;
}

/**
 * Renders the simulated invoice/credit-note PDF for the given transaction
 * using the unified helper at `./mockInvoicePdf`. Kept here as a thin wrapper
 * so the (legacy) signature stays stable for any external caller.
 */
export async function renderMockInvoicePdfBuffer(
  tx: any,
  _accIgnored: any,
  isCreditNote: boolean,
): Promise<Buffer> {
  const ctx = await resolveMockInvoiceContext(tx, tx.organizationId, isCreditNote);
  return await renderMockInvoicePdfToBuffer(ctx);
}

export interface InvoiceEmailRecipients {
  to: string[];
  cc?: string[];
  bcc?: string[];
  message?: string | null;
}

export interface AttemptInvoiceEmailResult {
  ok: boolean;
  sent: string[];
  failed: string[];
  errorMessage?: string;
  // True when we couldn't even try to send because the PDF couldn't be
  // resolved (download / mock render failure or invalid URL). Lets callers
  // distinguish "the email itself bounced" from "we never reached SendGrid".
  pdfError?: boolean;
}

/**
 * Attempts to send the emitted invoice PDF for a transaction to the given
 * recipients. Resolves the PDF (mock or remote), sends one email per primary
 * recipient (CC/BCC piggyback on the first), and returns a structured result.
 *
 * Does NOT mutate the transaction or create notifications — callers (the route
 * handler and the retry cron) are responsible for persisting status, retry
 * count, audit logs and notifications based on the result.
 */
export async function attemptInvoiceEmailSend(
  tx: Transaction,
  recipients: InvoiceEmailRecipients,
): Promise<AttemptInvoiceEmailResult> {
  if (!tx.invoiceUuid || !tx.invoicePdfUrl) {
    return { ok: false, sent: [], failed: recipients.to, errorMessage: 'La factura no está emitida.' };
  }
  const primaryRecipients = recipients.to.filter(Boolean);
  if (primaryRecipients.length === 0) {
    return { ok: false, sent: [], failed: [], errorMessage: 'No hay destinatarios.' };
  }

  const acc = await storage.getInvoicingAccount(tx.organizationId);
  const org = await storage.getOrganization(tx.organizationId).catch(() => null);
  const orgName = (org as any)?.name || acc?.razonSocial || 'Aikestar';

  let pdfBuffer: Buffer | null = null;
  const pdfUrl = tx.invoicePdfUrl;

  try {
    if (pdfUrl.startsWith(MOCK_PDF_PATH_PREFIX_LOCAL)) {
      pdfBuffer = await renderMockInvoicePdfBuffer(tx, null, false);
    } else {
      const safe = isAllowedPdfUrl(pdfUrl);
      if (!safe) {
        return { ok: false, sent: [], failed: primaryRecipients, errorMessage: 'La URL del PDF de la factura no es válida.', pdfError: true };
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const resp = await fetch(safe.toString(), { redirect: 'manual', signal: ctrl.signal as any });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const arr = await resp.arrayBuffer();
      if (arr.byteLength > 10 * 1024 * 1024) throw new Error('PDF demasiado grande');
      pdfBuffer = Buffer.from(arr);
    }
  } catch (e: any) {
    return {
      ok: false,
      sent: [],
      failed: primaryRecipients,
      errorMessage: `No pudimos descargar el PDF de la factura: ${e?.message || 'error desconocido'}`,
      pdfError: true,
    };
  }

  const filename = `${(tx.invoiceVoucherId || tx.invoiceUuid).toString().replace(/[^\w-]/g, '_')}.pdf`;
  const sent: string[] = [];
  const failed: string[] = [];
  for (let i = 0; i < primaryRecipients.length; i++) {
    const to = primaryRecipients[i];
    const ok = await sendInvoicePdfEmail({
      to,
      cc: i === 0 && recipients.cc && recipients.cc.length > 0 ? recipients.cc : undefined,
      bcc: i === 0 && recipients.bcc && recipients.bcc.length > 0 ? recipients.bcc : undefined,
      organizationName: orgName,
      emitterName: acc?.razonSocial || null,
      docType: tx.invoiceDocType || 'Factura',
      voucherNumber: tx.invoiceVoucherId || tx.invoiceNumber || '',
      total: tx.amount,
      currency: tx.currency || 'ARS',
      pdfBuffer: pdfBuffer!,
      pdfFilename: filename,
      isSimulated: !!tx.invoiceSimulated,
      customMessage: recipients.message ?? null,
    });
    if (ok) sent.push(to); else failed.push(to);
  }

  return {
    ok: failed.length === 0,
    sent,
    failed,
    errorMessage: failed.length > 0 ? `No se pudo enviar a: ${failed.join(', ')}` : undefined,
  };
}

// Maximum number of automatic retries the cron will perform for a single
// transaction after the original send failed. After this, the status remains
// 'failed' but the cron stops re-trying — the user can still trigger a manual
// retry which resets this counter. Configurable via env var
// INVOICE_EMAIL_MAX_AUTO_RETRIES (default 2, capped at 10).
function readMaxAutoRetries(): number {
  const raw = process.env.INVOICE_EMAIL_MAX_AUTO_RETRIES;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return 2;
  return Math.min(parsed, 10);
}

// Backoff in minutes for retry attempts 1, 2, ... Index = retry number that
// is about to be attempted (0-based: index 0 = first auto retry). Configurable
// via env var INVOICE_EMAIL_RETRY_BACKOFF_MINUTES (CSV, default "5,30").
function readBackoffMinutes(): number[] {
  const raw = process.env.INVOICE_EMAIL_RETRY_BACKOFF_MINUTES;
  if (!raw) return [5, 30];
  const parts = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
  return parts.length > 0 ? parts : [5, 30];
}

export const MAX_INVOICE_EMAIL_AUTO_RETRIES = readMaxAutoRetries();
const RETRY_BACKOFF_MINUTES = readBackoffMinutes();

export function nextRetryDelayMinutes(retryCount: number): number | null {
  if (retryCount >= MAX_INVOICE_EMAIL_AUTO_RETRIES) return null;
  return RETRY_BACKOFF_MINUTES[Math.min(retryCount, RETRY_BACKOFF_MINUTES.length - 1)];
}

function parseRecipients(raw: string | null): InvoiceEmailRecipients | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    const to: string[] = Array.isArray(obj?.to) ? obj.to.filter((x: unknown) => typeof x === 'string' && x.length > 0) : [];
    if (to.length === 0) return null;
    return {
      to,
      cc: Array.isArray(obj?.cc) ? obj.cc.filter((x: unknown) => typeof x === 'string' && x.length > 0) : [],
      bcc: Array.isArray(obj?.bcc) ? obj.bcc.filter((x: unknown) => typeof x === 'string' && x.length > 0) : [],
      message: typeof obj?.message === 'string' ? obj.message : null,
    };
  } catch {
    return null;
  }
}

/**
 * Iterates over transactions that have a failed email and are due for an
 * automatic retry, attempting to resend the invoice PDF. Updates the
 * transaction status, retry counter, audit log and (on permanent failure)
 * a final notification. Returns simple counters for logging.
 */
export async function processFailedInvoiceEmailRetries(): Promise<{
  considered: number;
  retried: number;
  succeeded: number;
  failed: number;
  permanentlyFailed: number;
}> {
  const due = await storage.findInvoiceEmailsDueForRetry({
    maxRetries: MAX_INVOICE_EMAIL_AUTO_RETRIES,
    backoffMinutes: RETRY_BACKOFF_MINUTES,
    limit: 50,
  });

  let succeeded = 0;
  let failed = 0;
  let permanentlyFailed = 0;
  let retried = 0;

  for (const tx of due) {
    const recipients = parseRecipients(tx.invoiceEmailLastRecipients);
    if (!recipients) {
      // Can't retry without a saved recipient snapshot — mark as permanently
      // failed so we don't keep picking it up forever.
      await storage.updateTransaction(tx.id, {
        invoiceEmailRetryCount: MAX_INVOICE_EMAIL_AUTO_RETRIES,
        invoiceEmailLastError: 'No hay destinatarios guardados para reintentar.',
      } as Partial<InsertTransaction>);
      permanentlyFailed++;
      continue;
    }

    retried++;
    const previousRetryCount = tx.invoiceEmailRetryCount ?? 0;
    const attemptNumber = previousRetryCount + 1;
    const result = await attemptInvoiceEmailSend(tx, recipients);
    const newRetryCount = previousRetryCount + 1;
    const now = new Date();

    if (result.ok) {
      await storage.updateTransaction(tx.id, {
        invoiceEmailStatus: 'sent',
        invoiceEmailLastAttemptAt: now,
        invoiceEmailLastError: null,
        invoiceEmailRetryCount: newRetryCount,
      } as Partial<InsertTransaction>);

      // Close any pending failure notification for this transaction.
      try {
        await storage.markInvoiceEmailFailureNotificationsRead(tx.id);
      } catch (e) {
        console.warn('[invoiceEmailRetry] could not mark prior notifications read', e);
      }

      try {
        await storage.createAuditLog({
          organizationId: tx.organizationId,
          userId: tx.createdBy ?? null,
          entityType: 'transaction',
          entityId: tx.id,
          action: 'invoice_email_retry_succeeded',
          previousData: null,
          newData: JSON.stringify({ attempt: attemptNumber, sent: result.sent }),
        });
      } catch {}

      succeeded++;
    } else {
      const isPermanent = newRetryCount >= MAX_INVOICE_EMAIL_AUTO_RETRIES;
      await storage.updateTransaction(tx.id, {
        invoiceEmailStatus: 'failed',
        invoiceEmailLastAttemptAt: now,
        invoiceEmailLastError: result.errorMessage || 'No se pudo enviar el email.',
        invoiceEmailRetryCount: newRetryCount,
      } as Partial<InsertTransaction>);

      try {
        await storage.createAuditLog({
          organizationId: tx.organizationId,
          userId: tx.createdBy ?? null,
          entityType: 'transaction',
          entityId: tx.id,
          action: 'invoice_email_retry_failed',
          previousData: null,
          newData: JSON.stringify({
            attempt: attemptNumber,
            failed: result.failed,
            error: result.errorMessage,
            permanent: isPermanent,
          }),
        });
      } catch {}

      if (isPermanent) {
        permanentlyFailed++;
        // Notify the user once we give up so they know to retry manually.
        if (tx.createdBy) {
          try {
            const docLabel = `${tx.invoiceDocType || 'Factura'} ${tx.invoiceVoucherId || tx.invoiceNumber || ''}`.trim();
            await storage.createNotification({
              userId: tx.createdBy,
              organizationId: tx.organizationId,
              type: 'invoice_email_failed',
              priority: 'warning',
              title: 'No pudimos enviar la factura por email (reintentos agotados)',
              message: `${docLabel} — falló el envío después de ${MAX_INVOICE_EMAIL_AUTO_RETRIES} reintentos automáticos. Reintentá manualmente desde Oficina → Facturas.`,
              transactionId: tx.id,
              source: 'auto',
            });
          } catch (e) {
            console.warn('[invoiceEmailRetry] could not create permanent-failure notification', e);
          }
        }
      } else {
        failed++;
      }
    }
  }

  return {
    considered: due.length,
    retried,
    succeeded,
    failed,
    permanentlyFailed,
  };
}
