import { db } from '../db';
import { sql } from 'drizzle-orm';

// Crea las tablas de la integración con Tiendanube y agrega las columnas
// external_id / external_source a clients, products y transactions.
//
// Idempotente: CREATE TABLE/INDEX IF NOT EXISTS + ADD COLUMN IF NOT EXISTS +
// marcador en _migrations. En producción el esquema se aplica por estas
// migraciones versionadas (no por db:push).
export async function createTiendanubeTables() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0042_tiendanube' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: Tiendanube integration tables + external_id columns...');

  // Columnas de trazabilidad en entidades sincronizadas
  await db.execute(sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS external_id text`);
  await db.execute(sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS external_source text`);
  await db.execute(sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS external_id text`);
  await db.execute(sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS external_source text`);
  await db.execute(sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS external_id text`);
  await db.execute(sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS external_source text`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS clients_external_idx ON clients (organization_id, external_source, external_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS products_external_idx ON products (organization_id, external_source, external_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS transactions_external_idx ON transactions (organization_id, external_source, external_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tiendanube_connections (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      store_id text NOT NULL,
      store_name text,
      store_url text,
      access_token_encrypted text NOT NULL,
      scope text,
      status text NOT NULL DEFAULT 'connected',
      connected_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
      connected_at timestamp DEFAULT now(),
      last_sync_at timestamp,
      last_error text,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tiendanube_connections_org_unique ON tiendanube_connections (organization_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tiendanube_payment_mappings (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      connection_id varchar NOT NULL REFERENCES tiendanube_connections(id) ON DELETE CASCADE,
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      gateway_name text NOT NULL,
      account_id varchar REFERENCES accounts(id) ON DELETE SET NULL,
      payment_method_id varchar REFERENCES payment_methods(id) ON DELETE SET NULL,
      auto_detected boolean NOT NULL DEFAULT false,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tiendanube_pm_conn_gateway_unique ON tiendanube_payment_mappings (connection_id, gateway_name)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tiendanube_webhook_events (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      connection_id varchar REFERENCES tiendanube_connections(id) ON DELETE CASCADE,
      organization_id varchar REFERENCES organizations(id) ON DELETE CASCADE,
      event text NOT NULL,
      external_resource_id text NOT NULL,
      payload_hash text,
      status text NOT NULL DEFAULT 'received',
      error text,
      received_at timestamp NOT NULL DEFAULT now(),
      processed_at timestamp
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tiendanube_webhook_dedup_unique ON tiendanube_webhook_events (connection_id, event, external_resource_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tiendanube_order_links (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      connection_id varchar NOT NULL REFERENCES tiendanube_connections(id) ON DELETE CASCADE,
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      external_order_id text NOT NULL,
      order_number text,
      transaction_id varchar REFERENCES transactions(id) ON DELETE SET NULL,
      client_id varchar REFERENCES clients(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'synced',
      total_amount numeric(15,2),
      currency text,
      gateway text,
      raw_snapshot jsonb,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS tiendanube_order_conn_order_unique ON tiendanube_order_links (connection_id, external_order_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tiendanube_client_matches (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      connection_id varchar NOT NULL REFERENCES tiendanube_connections(id) ON DELETE CASCADE,
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      external_customer_id text NOT NULL,
      external_data jsonb,
      candidate_client_id varchar REFERENCES clients(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'pending',
      resolved_client_id varchar REFERENCES clients(id) ON DELETE SET NULL,
      resolved_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
      resolved_at timestamp,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS tiendanube_match_conn_customer_idx ON tiendanube_client_matches (connection_id, external_customer_id)`);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0042_tiendanube') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: Tiendanube tables ready.');
}
