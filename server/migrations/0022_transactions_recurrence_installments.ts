import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #353: agrega counters de cuotas a transacciones recurrentes.
// `recurrence_total_installments` (nullable) — null = serie infinita (legacy).
// `recurrence_current_installment` (nullable) — solo significativo si el total
// es no-nulo; al confirmar la N-ésima cuota el backend deja de generar la
// próxima. Ambas columnas son nullable e idempotentes para no afectar filas
// existentes ni romper deploys donde ya se aplicó ALTER manual.
export async function addTransactionsRecurrenceInstallmentsColumns() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0022_transactions_recurrence_installments' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add transactions.recurrence_total_installments / recurrence_current_installment...');

  await db.execute(sql`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS recurrence_total_installments integer
  `);
  await db.execute(sql`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS recurrence_current_installment integer
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0022_transactions_recurrence_installments') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: transactions recurrence installment counters ready.');
}
