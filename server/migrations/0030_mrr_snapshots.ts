import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #422: crea la tabla mrr_snapshots, que persiste un snapshot mensual del
// MRR (ARS y equivalente referencial en USD) y la cantidad de suscripciones
// activas. Habilita el gráfico de evolución del MRR en /admin.
//
// Una fila por mes (snapshot_month = 'YYYY-MM', hora Argentina), con UNIQUE para
// que el job de snapshots haga upsert atómico (INSERT ... ON CONFLICT) y el mes
// en curso se mantenga fresco sin duplicar filas.
//
// Idempotente: CREATE TABLE IF NOT EXISTS + marcador en _migrations. En
// producción el esquema se aplica solo por estas migraciones versionadas (no se
// corre db:push), así que la tabla debe crearse acá.
export async function createMrrSnapshotsTable() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0030_mrr_snapshots' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: create mrr_snapshots table...');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS mrr_snapshots (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      snapshot_month text NOT NULL UNIQUE,
      mrr_ars double precision NOT NULL,
      mrr_usd double precision NOT NULL,
      active_subscriptions integer NOT NULL,
      usd_ars_rate double precision NOT NULL,
      captured_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0030_mrr_snapshots') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: mrr_snapshots table ready.');
}
