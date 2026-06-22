import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #433: agrega a business_settings la configuración para derivar el gasto
// de adquisición automáticamente desde transacciones etiquetadas (en lugar de
// cargarlo a mano mes a mes). Se elige una organización (los libros propios de
// Aikestar dentro de la app) y qué cuentas / categorías / códigos de análisis
// cuentan como "gasto de adquisición". El gasto por mes se deriva sumando esos
// gastos por mes calendario y se combina con la carga manual (la carga manual
// de un mes tiene prioridad, así no se duplica).
//
// Idempotente: ADD COLUMN IF NOT EXISTS + marcador en _migrations. Prod no usa
// db:push, así que el esquema llega vía estas migraciones versionadas.
export async function addAcquisitionSpendConfigColumns() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0033_acquisition_spend_config' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add acquisition spend config columns...');

  await db.execute(sql`
    ALTER TABLE business_settings
      ADD COLUMN IF NOT EXISTS acquisition_auto_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS acquisition_org_id varchar,
      ADD COLUMN IF NOT EXISTS acquisition_account_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
      ADD COLUMN IF NOT EXISTS acquisition_categories text[] NOT NULL DEFAULT ARRAY[]::text[],
      ADD COLUMN IF NOT EXISTS acquisition_profitability_code_ids text[] NOT NULL DEFAULT ARRAY[]::text[]
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0033_acquisition_spend_config') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: acquisition spend config columns ready.');
}
