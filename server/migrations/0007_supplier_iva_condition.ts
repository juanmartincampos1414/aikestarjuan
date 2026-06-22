import { db } from '../db';
import { sql } from 'drizzle-orm';

// Adds `iva_condition` to the suppliers table so we can pre-fill the
// emit-step receiver IVA condition when emitting comprobantes propios
// dirigidos al proveedor (e.g. devoluciones de compra). Mirrors the
// existing column on `clients`.
export async function addSupplierIvaConditionColumn() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0007_supplier_iva_condition' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add suppliers.iva_condition column...');

  await db.execute(sql`
    ALTER TABLE suppliers
    ADD COLUMN IF NOT EXISTS iva_condition text
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0007_supplier_iva_condition') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: suppliers.iva_condition ready.');
}
