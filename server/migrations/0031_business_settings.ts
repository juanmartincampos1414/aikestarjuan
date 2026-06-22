import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #421: crea la tabla singleton business_settings que persiste los valores
// de negocio editables desde el panel /admin: el tipo de cambio USD/ARS de
// referencia y las estimaciones de SaaS (CAC min/max y ratio LTV/CAC). Antes
// vivían fijos en shared/constants.ts y/o en la variable de entorno
// USD_ARS_RATE, lo que obligaba a un deploy para ajustarlos.
//
// Renombrada de 0030 a 0031 durante el rebase sobre main: main ya usaba el
// número 0030 para 0030_mrr_snapshots.
//
// Idempotente: CREATE TABLE IF NOT EXISTS. No siembra ninguna fila: la lectura
// (GET) cae a los defaults cuando la tabla está vacía y el primer guardado desde
// la UI inserta la fila 'global'.
export async function createBusinessSettingsTable() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0031_business_settings' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: create business_settings table...');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS business_settings (
      id varchar PRIMARY KEY DEFAULT 'global',
      usd_ars_rate double precision NOT NULL,
      cac_usd_min double precision NOT NULL,
      cac_usd_max double precision NOT NULL,
      ltv_cac_ratio double precision NOT NULL,
      updated_at timestamp NOT NULL DEFAULT NOW(),
      updated_by varchar REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0031_business_settings') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: business_settings table ready.');
}
