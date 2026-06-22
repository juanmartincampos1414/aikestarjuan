import { db } from '../db';
import { sql } from 'drizzle-orm';

// Crea las tablas de Órdenes de Trabajo. Idempotente.
export async function createWorkOrderTables() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);
  const done = await db.execute(sql`SELECT 1 FROM _migrations WHERE name = '0045_work_orders' LIMIT 1`);
  if (done.rowCount && done.rowCount > 0) return;

  console.log('Running migration: work order tables...');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS work_orders (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      quote_id varchar REFERENCES quotes(id) ON DELETE SET NULL,
      client_id varchar REFERENCES clients(id) ON DELETE SET NULL,
      title text NOT NULL,
      owner_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'pendiente',
      priority text NOT NULL DEFAULT 'medium',
      scheduled_date timestamp,
      execution_date timestamp,
      technical_notes text,
      hours_worked numeric(10,2) DEFAULT '0',
      linked_transaction_id varchar,
      created_by varchar REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS wo_org_status_idx ON work_orders (organization_id, status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS wo_quote_idx ON work_orders (quote_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS work_order_assignments (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      work_order_id varchar NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
      employee_id varchar NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      assigned_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS wo_assign_wo_idx ON work_order_assignments (work_order_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS work_order_materials (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      work_order_id varchar NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
      product_id varchar REFERENCES products(id) ON DELETE SET NULL,
      description text NOT NULL,
      quantity numeric(15,2) NOT NULL DEFAULT '1',
      unit_cost numeric(15,2) DEFAULT '0',
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS wo_mat_wo_idx ON work_order_materials (work_order_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS work_order_photos (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      work_order_id varchar NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
      url text NOT NULL,
      caption text,
      created_by varchar REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS wo_photo_wo_idx ON work_order_photos (work_order_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS work_order_timeline (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      work_order_id varchar NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
      event text NOT NULL,
      detail jsonb,
      created_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS wo_tl_wo_idx ON work_order_timeline (work_order_id, created_at)`);

  await db.execute(sql`INSERT INTO _migrations (name) VALUES ('0045_work_orders') ON CONFLICT (name) DO NOTHING`);
  console.log('Migration complete: work order tables ready.');
}
