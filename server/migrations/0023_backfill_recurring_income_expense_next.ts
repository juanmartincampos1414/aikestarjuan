import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #356: backfill de la próxima cuota pendiente para Ingresos y Egresos
// recurrentes que se crearon antes de que el server generase automáticamente
// el siguiente compromiso. Para cada fila huérfana (income/expense,
// isRecurring=true, frequency NOT NULL) que no tenga ningún descendiente
// scheduled del tipo espejo (receivable/payable) en su misma serie,
// insertamos una fila pendiente con la fecha avanzada según la frecuencia.
//
// Idempotente: se registra en _migrations y además filtra por la ausencia
// del descendiente. Respeta el gating de series cerradas
// (recurrence_total_installments / recurrence_current_installment).
export async function backfillRecurringIncomeExpenseNext() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0023_backfill_recurring_income_expense_next' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: backfill next scheduled commitment for recurring income/expense...');

  // Buscar las series huérfanas. Tomamos como "source" la fila más antigua
  // de la serie (la que tiene recurrence_source_id NULL o se apunta a sí
  // misma). Para cada serie, agarramos la última fila completed conocida
  // para calcular la fecha siguiente.
  const orphans: any = await db.execute(sql`
    WITH series AS (
      SELECT
        COALESCE(recurrence_source_id, id) AS series_id,
        organization_id,
        type,
        currency,
        amount,
        description,
        category,
        account_id,
        client_id,
        supplier_id,
        product_id,
        product_quantity,
        recurrence_frequency,
        recurrence_total_installments,
        recurrence_current_installment,
        date,
        id AS row_id,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(recurrence_source_id, id)
          ORDER BY date DESC, id DESC
        ) AS rn
      FROM transactions
      WHERE is_recurring = true
        AND recurrence_frequency IS NOT NULL
        AND type IN ('income', 'expense')
        AND status = 'completed'
    ),
    latest AS (
      SELECT * FROM series WHERE rn = 1
    )
    SELECT l.*
    FROM latest l
    WHERE NOT EXISTS (
      SELECT 1 FROM transactions t2
      WHERE t2.organization_id = l.organization_id
        AND t2.status = 'scheduled'
        AND t2.is_recurring = true
        AND t2.recurrence_source_id = l.series_id
        AND t2.type IN ('receivable', 'payable')
    )
    AND (
      l.recurrence_total_installments IS NULL
      OR COALESCE(l.recurrence_current_installment, 1) < l.recurrence_total_installments
    )
  `);

  const rows: any[] = (orphans as any).rows || [];
  let created = 0;
  let failures = 0;

  const advanceDate = (d: Date, freq: string): Date => {
    const next = new Date(d);
    switch (freq) {
      case 'weekly': next.setDate(next.getDate() + 7); break;
      case 'biweekly': next.setDate(next.getDate() + 14); break;
      case 'monthly': next.setMonth(next.getMonth() + 1); break;
      case 'quarterly': next.setMonth(next.getMonth() + 3); break;
      case 'yearly': next.setFullYear(next.getFullYear() + 1); break;
      default: next.setMonth(next.getMonth() + 1);
    }
    return next;
  };

  for (const r of rows) {
    try {
      const freq = String(r.recurrence_frequency);
      const sourceDate = new Date(r.date);
      let nextDueDate = advanceDate(sourceDate, freq);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      while (nextDueDate < today) {
        nextDueDate = advanceDate(nextDueDate, freq);
      }

      const mirrorType = r.type === 'income' ? 'receivable' : 'payable';
      const total = r.recurrence_total_installments;
      const current = r.recurrence_current_installment ?? 1;
      const nextInstallment = total != null ? current + 1 : null;

      await db.execute(sql`
        INSERT INTO transactions (
          organization_id, type, amount, currency, description, category,
          date, imputation_date, account_id, client_id, supplier_id,
          product_id, product_quantity, status, is_recurring, is_unique_payment,
          recurrence_frequency, recurrence_source_id,
          recurrence_total_installments, recurrence_current_installment,
          has_invoice
        ) VALUES (
          ${r.organization_id}, ${mirrorType}, ${r.amount}, ${r.currency}, ${r.description}, ${r.category},
          ${nextDueDate.toISOString()}, ${nextDueDate.toISOString()}, ${r.account_id}, ${r.client_id}, ${r.supplier_id},
          ${r.product_id}, ${r.product_quantity}, 'scheduled', true, false,
          ${freq}, ${r.series_id},
          ${total}, ${nextInstallment},
          false
        )
      `);
      created++;
    } catch (err: any) {
      failures++;
      console.error(`[Backfill 0023] Failed to backfill series ${r.series_id}:`, err?.message || err);
    }
  }

  if (failures === 0) {
    // Sólo marcamos como aplicada si todas las series huérfanas pudieron
    // procesarse. Si hubo fallas transitorias, dejamos el marker ausente:
    // la próxima ejecución re-intentará automáticamente (la query filtra
    // por "NOT EXISTS scheduled descendant", así que las series ya
    // pobladas no se duplican).
    await db.execute(
      sql`INSERT INTO _migrations (name) VALUES ('0023_backfill_recurring_income_expense_next') ON CONFLICT (name) DO NOTHING`
    );
    console.log(`Migration complete: backfilled ${created} next scheduled commitments for recurring income/expense (out of ${rows.length} orphan series).`);
  } else {
    console.warn(`Migration 0023 partial: backfilled ${created}/${rows.length}, ${failures} failures. Marker NOT inserted — will retry on next boot.`);
  }
}
