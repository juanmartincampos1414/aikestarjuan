import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #363: agrega columnas archived_at (nullable timestamp) a clients,
// suppliers, transaction_categories y profitability_codes para unificar el
// flujo "archivar / eliminar" (ver routes/operations.ts, profitabilityCodes.ts,
// organizations.ts). Tambien crea indices parciales WHERE archived_at IS NULL
// scoping por organization_id, que son los que cubren las queries de listas
// activas (las mas frecuentes).
//
// Idempotente: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
// Compatible con ambientes donde el ALTER ya se aplico manualmente (Neon
// Ohio actual): el INSERT en _migrations marca como aplicada para no
// reintentar en futuros boots.
export async function addArchivedAtColumns() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0024_archived_at_columns' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add archived_at columns + partial indexes...');

  await db.execute(sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS archived_at timestamp`);
  await db.execute(sql`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS archived_at timestamp`);
  await db.execute(sql`ALTER TABLE transaction_categories ADD COLUMN IF NOT EXISTS archived_at timestamp`);
  await db.execute(sql`ALTER TABLE profitability_codes ADD COLUMN IF NOT EXISTS archived_at timestamp`);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS clients_archived_at_idx
    ON clients (organization_id) WHERE archived_at IS NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS suppliers_archived_at_idx
    ON suppliers (organization_id) WHERE archived_at IS NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS transaction_categories_archived_at_idx
    ON transaction_categories (organization_id) WHERE archived_at IS NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS profitability_codes_archived_at_idx
    ON profitability_codes (organization_id) WHERE archived_at IS NULL
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0024_archived_at_columns') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: archived_at columns + partial indexes ready.');
}
