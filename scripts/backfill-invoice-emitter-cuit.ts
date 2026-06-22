/**
 * Backfill script: invoiceEmitterCuit on historical emitted invoices.
 *
 * Context
 * -------
 * The transactions table now has a `invoice_emitter_cuit` column that stores a
 * snapshot of the emitter (Facturador) CUIT at the moment the invoice was
 * emitted. New emissions populate it automatically; this script fills in the
 * value for invoices that were emitted before that change.
 *
 * Strategy
 * --------
 * For every transaction that has an `invoiceUuid` (i.e. an invoice was emitted
 * or is in flight) and whose `invoiceEmitterCuit` is NULL, we look up the
 * organization's current `invoicing_accounts.cuit` and use that value. This is
 * safe because, historically, each organization has had a single active
 * Facturador CUIT — invoices emitted before this change must have used that
 * CUIT. Organizations without a configured Facturador are skipped (their rows
 * stay NULL and the UI keeps showing "—" for those, which is the same state as
 * before).
 *
 * Idempotent: rows already populated are not touched. Safe to re-run.
 *
 * Usage:
 *   tsx scripts/backfill-invoice-emitter-cuit.ts            # apply
 *   DRY_RUN=1 tsx scripts/backfill-invoice-emitter-cuit.ts  # preview only
 */
import { db, pool } from '../server/db';
import { transactions, invoicingAccounts } from '@shared/schema';
import { and, eq, isNull, isNotNull, sql } from 'drizzle-orm';

async function main() {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

  console.log(`[backfill-invoice-emitter-cuit] starting (dryRun=${dryRun})`);

  const candidatesByOrg = await db
    .select({
      organizationId: transactions.organizationId,
      count: sql<number>`count(*)::int`,
    })
    .from(transactions)
    .where(and(isNotNull(transactions.invoiceUuid), isNull(transactions.invoiceEmitterCuit)))
    .groupBy(transactions.organizationId);

  if (candidatesByOrg.length === 0) {
    console.log('[backfill-invoice-emitter-cuit] nothing to do — no rows missing the snapshot.');
    await pool.end();
    return;
  }

  console.log(
    `[backfill-invoice-emitter-cuit] ${candidatesByOrg.length} organization(s) have invoices to backfill ` +
    `(${candidatesByOrg.reduce((s, r) => s + Number(r.count), 0)} rows total).`,
  );

  let totalUpdated = 0;
  let orgsSkipped = 0;
  let rowsSkipped = 0;

  for (const row of candidatesByOrg) {
    const orgId = row.organizationId;
    const acc = await db
      .select({ cuit: invoicingAccounts.cuit })
      .from(invoicingAccounts)
      .where(eq(invoicingAccounts.organizationId, orgId))
      .limit(1);

    if (acc.length === 0 || !acc[0].cuit) {
      orgsSkipped += 1;
      rowsSkipped += Number(row.count);
      console.warn(
        `  · org=${orgId} → SKIP (${row.count} row(s)): no invoicing_account CUIT on record. ` +
        `These invoices keep invoice_emitter_cuit=NULL and will show "—".`,
      );
      continue;
    }

    const cuit = acc[0].cuit;
    if (dryRun) {
      console.log(`  · org=${orgId} → would update ${row.count} row(s) with CUIT ${cuit}`);
      totalUpdated += Number(row.count);
      continue;
    }

    const updated = await db
      .update(transactions)
      .set({ invoiceEmitterCuit: cuit })
      .where(
        and(
          eq(transactions.organizationId, orgId),
          isNotNull(transactions.invoiceUuid),
          isNull(transactions.invoiceEmitterCuit),
        ),
      )
      .returning({ id: transactions.id });

    totalUpdated += updated.length;
    console.log(`  · org=${orgId} → updated ${updated.length} row(s) with CUIT ${cuit}`);
  }

  console.log('[backfill-invoice-emitter-cuit] done.');
  console.log(`  rows ${dryRun ? 'that would be' : ''} updated: ${totalUpdated}`);
  console.log(`  rows skipped (no invoicing account): ${rowsSkipped} across ${orgsSkipped} org(s)`);

  await pool.end();
}

main().catch(async (err) => {
  console.error('[backfill-invoice-emitter-cuit] fatal error:', err);
  try { await pool.end(); } catch {}
  process.exit(1);
});
