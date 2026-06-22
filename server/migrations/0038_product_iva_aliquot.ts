import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #502: agrega la columna iva_aliquot (decimal) a la tabla products para
// guardar la alícuota de IVA por defecto de cada producto (21, 10.5, 0, etc.).
// Hasta ahora el IVA se elegía recién al emitir la factura; guardarlo en el
// producto evita reescribirlo cada vez.
//
// Idempotente: ADD COLUMN IF NOT EXISTS. NOT NULL con DEFAULT 21 para que los
// productos existentes queden con la alícuota general (21%) sin romper nada.
export async function addProductIvaAliquotColumn() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0038_product_iva_aliquot' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add products.iva_aliquot column...');

  await db.execute(sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS iva_aliquot numeric(5,2) NOT NULL DEFAULT 21`);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0038_product_iva_aliquot') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: products.iva_aliquot ready.');
}
