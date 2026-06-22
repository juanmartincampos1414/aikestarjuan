import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { products, stockMovements } from '@shared/schema';
import type { TransactionItem } from '@shared/schema';

// Task #475: unified stock helper for single- and multi-product transactions.
// A transaction's product "lines" come from `transaction_items` when present
// (2+ products) or from the legacy `productId`/`productQuantity` fields (0/1
// product). All stock adjustments iterate over these normalized lines so the
// single-product behavior is preserved exactly while multi-product works.

export interface StockLine {
  productId: string;
  quantity: number;
  profitabilityCodeId?: string | null;
}

function parseValidQuantity(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = parseFloat(String(value));
  if (isNaN(num) || num <= 0) return null;
  return num;
}

// Normalize a transaction (+ its items) into stock lines. Items win when
// present; otherwise fall back to the legacy single-product fields.
export function deriveStockLines(
  tx: { productId?: string | null; productQuantity?: any; profitabilityCodeId?: string | null },
  items?: TransactionItem[] | null,
): StockLine[] {
  if (items && items.length > 0) {
    const lines: StockLine[] = [];
    for (const it of items) {
      if (!it.productId) continue;
      const q = parseValidQuantity(it.quantity);
      if (q === null) continue;
      lines.push({ productId: it.productId, quantity: q, profitabilityCodeId: it.profitabilityCodeId ?? null });
    }
    return lines;
  }
  if (tx.productId) {
    const q = parseValidQuantity(tx.productQuantity);
    if (q !== null) {
      return [{ productId: tx.productId, quantity: q, profitabilityCodeId: tx.profitabilityCodeId ?? null }];
    }
  }
  return [];
}

// Apply or reverse stock for a set of lines. For a sale (income/receivable)
// the "apply" direction is an exit; for a purchase (expense/payable) it is an
// entry. "reverse" inverts that. All lines run inside a single DB transaction.
export async function adjustStockForLines(opts: {
  lines: StockLine[];
  txType: string;
  direction: 'apply' | 'reverse';
  organizationId: string;
  userId?: string | null;
  reason: string;
  tx?: any; // optional existing drizzle transaction to run inside
}): Promise<void> {
  const { lines, txType, direction, organizationId, userId, reason, tx } = opts;
  if (lines.length === 0) return;

  const isPurchase = txType === 'expense' || txType === 'payable';
  const applyType: 'entry' | 'exit' = isPurchase ? 'entry' : 'exit';
  const movementType: 'entry' | 'exit' =
    direction === 'apply' ? applyType : applyType === 'entry' ? 'exit' : 'entry';

  const run = async (database: any) => {
    for (const line of lines) {
      const [product] = await database.select().from(products).where(eq(products.id, line.productId));
      if (!product) continue;
      const currentStock = parseFloat(product.stock || '0');
      const newStock = movementType === 'entry' ? currentStock + line.quantity : currentStock - line.quantity;
      await database.insert(stockMovements).values({
        id: randomUUID(),
        productId: line.productId,
        organizationId,
        type: movementType,
        quantity: String(line.quantity),
        previousStock: String(currentStock),
        newStock: String(newStock),
        reason,
        profitabilityCodeId: line.profitabilityCodeId ?? null,
        createdBy: userId ?? null,
      });
      await database.update(products).set({ stock: String(newStock) }).where(eq(products.id, line.productId));
    }
  };

  if (tx) {
    await run(tx);
  } else {
    await db.transaction(run);
  }
}
