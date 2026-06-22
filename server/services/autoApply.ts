import { db } from "../db";
import { storage } from "../storage";
import { transactions } from "@shared/schema";
import { and, eq, inArray, asc } from "drizzle-orm";

export async function autoApplyPaymentToCommitments(params: {
  paymentAmount: number;
  currency: string;
  organizationId: string;
  userId: string;
  entityType: 'supplier' | 'client';
  entityId: string;
  paymentTransactionId: string;
}): Promise<{ appliedCount: number; appliedTotal: number }> {
  const { paymentAmount, currency, organizationId, userId, entityType, entityId, paymentTransactionId } = params;

  const commitmentType = entityType === 'supplier' ? 'payable' : 'receivable';
  const entityColumn = entityType === 'supplier' ? transactions.supplierId : transactions.clientId;

  const normCurrency = (c: string) => (c === 'USD_CASH' || c.toUpperCase().includes('USD')) ? 'USD' : c;
  const paymentCurrencyNorm = normCurrency(currency);

  const pendingCommitments = await db
    .select()
    .from(transactions)
    .where(and(
      eq(transactions.organizationId, organizationId),
      eq(entityColumn, entityId),
      eq(transactions.type, commitmentType),
      eq(transactions.status, 'scheduled'),
    ))
    .orderBy(asc(transactions.date));

  const matchingCommitments = pendingCommitments.filter(c => {
    const cCurrency = normCurrency(c.currency || 'ARS');
    return cCurrency === paymentCurrencyNorm;
  });

  if (matchingCommitments.length === 0) {
    return { appliedCount: 0, appliedTotal: 0 };
  }

  let remaining = paymentAmount;
  let appliedCount = 0;
  let appliedTotal = 0;

  for (const commitment of matchingCommitments) {
    if (remaining <= 0.005) break;

    const commitmentAmount = parseFloat(commitment.amount);

    if (remaining >= commitmentAmount - 0.005) {
      await db.update(transactions).set({
        status: 'completed',
        completedBy: userId,
        completedAt: new Date(),
        autoAppliedByTransactionId: paymentTransactionId,
      }).where(eq(transactions.id, commitment.id));

      await storage.createAuditLog({
        organizationId,
        userId,
        entityType: 'transaction',
        entityId: commitment.id,
        action: 'auto_apply_complete',
        previousData: JSON.stringify({ amount: commitment.amount, status: commitment.status }),
        newData: JSON.stringify({ status: 'completed', appliedByTransactionId: paymentTransactionId }),
      });

      // Task #229: if this commitment was a receivable created with a
      // payment method, complete its payable children too (they were
      // pending at amount = original concept value).
      if (commitmentType === 'receivable' && commitment.paymentMethodId) {
        try {
          await storage.propagateCollectionToPaymentMethodChildren(
            commitment.id,
            1,
            userId,
            paymentTransactionId,
          );
        } catch (propErr) {
          console.error('[AutoApply] Error propagating to payment-method children:', propErr);
        }
      }

      remaining -= commitmentAmount;
      appliedTotal += commitmentAmount;
      appliedCount++;

      console.log(`[AutoApply] Fully applied commitment ${commitment.id} (${commitmentAmount}) from payment ${paymentTransactionId}`);
    } else {
      const newAmount = commitmentAmount - remaining;
      const trackOriginal = commitment.originalAmount ?? commitment.amount;
      const ratio = remaining / commitmentAmount;

      await storage.createAuditLog({
        organizationId,
        userId,
        entityType: 'transaction',
        entityId: commitment.id,
        action: 'auto_apply_partial',
        previousData: JSON.stringify({ amount: commitment.amount, originalAmount: trackOriginal }),
        newData: JSON.stringify({ amount: String(newAmount.toFixed(2)), appliedAmount: remaining.toFixed(2), appliedByTransactionId: paymentTransactionId }),
      });

      await db.update(transactions).set({
        amount: String(newAmount.toFixed(2)),
        originalAmount: trackOriginal,
        autoAppliedByTransactionId: paymentTransactionId,
      }).where(eq(transactions.id, commitment.id));

      // Task #229: prorate children for partial collection.
      if (commitmentType === 'receivable' && commitment.paymentMethodId) {
        try {
          await storage.propagateCollectionToPaymentMethodChildren(
            commitment.id,
            ratio,
            userId,
            paymentTransactionId,
          );
        } catch (propErr) {
          console.error('[AutoApply] Error propagating partial collection to payment-method children:', propErr);
        }
      }

      appliedTotal += remaining;
      appliedCount++;
      remaining = 0;

      console.log(`[AutoApply] Partially applied commitment ${commitment.id}: ${commitmentAmount} → ${newAmount.toFixed(2)} from payment ${paymentTransactionId}`);
    }
  }

  return { appliedCount, appliedTotal };
}
