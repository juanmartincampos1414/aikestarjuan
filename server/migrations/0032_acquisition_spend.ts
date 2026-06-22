import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #424: crea la tabla acquisition_spend, que persiste el gasto de
// adquisición (marketing/ventas) por mes calendario ('YYYY-MM'). Permite
// calcular el CAC real = gasto del período / altas del período, en lugar de la
// estimación fija de business_settings.
//
// Idempotente: CREATE TABLE IF NOT EXISTS + registro en _migrations para no
// volver a correr. En producción no se usa db:push; el esquema llega solo por
// estas migraciones versionadas al bootear.
export async function createAcquisitionSpendTable() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0032_acquisition_spend' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: create acquisition_spend table...');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS acquisition_spend (
      month varchar PRIMARY KEY,
      amount_ars double precision NOT NULL,
      updated_at timestamp NOT NULL DEFAULT NOW(),
      updated_by varchar REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0032_acquisition_spend') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: acquisition_spend table ready.');
}
