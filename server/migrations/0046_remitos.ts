import { db } from '../db';
import { sql } from 'drizzle-orm';

// Crea las tablas de Remitos (comprobante de entrega) + items. Idempotente.
export async function createRemitoTables() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);
  const done = await db.execute(sql`SELECT 1 FROM _migrations WHERE name = '0046_remitos' LIMIT 1`);
  if (done.rowCount && done.rowCount > 0) return;

  console.log('Running migration: remitos tables...');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS remitos (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      number text NOT NULL,
      client_id varchar REFERENCES clients(id) ON DELETE SET NULL,
      client_name text,
      date timestamp NOT NULL DEFAULT now(),
      status text NOT NULL DEFAULT 'emitido',
      notes text,
      linked_quote_id varchar REFERENCES quotes(id) ON DELETE SET NULL,
      linked_work_order_id varchar REFERENCES work_orders(id) ON DELETE SET NULL,
      stock_applied boolean NOT NULL DEFAULT false,
      created_by varchar REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS remitos_org_idx ON remitos (organization_id, date)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS remitos_org_number_unique ON remitos (organization_id, number)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS remito_items (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      remito_id varchar NOT NULL REFERENCES remitos(id) ON DELETE CASCADE,
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      product_id varchar REFERENCES products(id) ON DELETE SET NULL,
      description text NOT NULL,
      quantity numeric(15,2) NOT NULL DEFAULT '1',
      unit_price numeric(15,2),
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS remito_items_remito_idx ON remito_items (remito_id)`);

  await db.execute(sql`INSERT INTO _migrations (name) VALUES ('0046_remitos') ON CONFLICT (name) DO NOTHING`);
  console.log('Migration complete: remitos tables ready.');
}
