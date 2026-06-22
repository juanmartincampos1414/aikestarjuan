import * as cron from 'node-cron';
import { processFailedInvoiceEmailRetries } from './invoiceEmailService';

let cronJob: ReturnType<typeof cron.schedule> | null = null;
let running = false;

// Mirror of the server-side `INVOICING_ENABLED` feature flag (see
// server/routes/invoicing.ts). When OFF, the retry cron is a no-op so we
// don't keep re-sending invoice emails for previously-emitted vouchers
// while the integration is paused.
function isInvoicingFeatureOn(): boolean {
  return process.env.INVOICING_ENABLED === 'true';
}

export function startInvoiceEmailRetryCron(): void {
  if (!isInvoicingFeatureOn()) {
    console.log('[InvoiceEmailRetryCron] Skipped (INVOICING_ENABLED=false)');
    return;
  }
  if (cronJob) {
    console.log('[InvoiceEmailRetryCron] Already running');
    return;
  }

  // Every 5 minutes — fine-grained enough that the shortest backoff (5 min)
  // is honored quickly, while still light on the database.
  cronJob = cron.schedule('*/5 * * * *', async () => {
    if (running) {
      // Skip overlapping ticks if a previous run is still in flight.
      return;
    }
    running = true;
    const startTime = Date.now();
    try {
      const result = await processFailedInvoiceEmailRetries();
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      if (result.considered > 0) {
        console.log(
          `[InvoiceEmailRetryCron] Done in ${duration}s — considered=${result.considered} retried=${result.retried} succeeded=${result.succeeded} failed=${result.failed} permanentlyFailed=${result.permanentlyFailed}`
        );
      }
    } catch (error) {
      console.error('[InvoiceEmailRetryCron] Error:', error);
    } finally {
      running = false;
    }
  });

  console.log('[InvoiceEmailRetryCron] Started (every 5 minutes)');
}

export function stopInvoiceEmailRetryCron(): void {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log('[InvoiceEmailRetryCron] Stopped');
  }
}

export async function runInvoiceEmailRetryNow(): Promise<{
  considered: number;
  retried: number;
  succeeded: number;
  failed: number;
  permanentlyFailed: number;
}> {
  return await processFailedInvoiceEmailRetries();
}
