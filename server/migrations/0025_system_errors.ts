import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #388: crea la tabla system_errors, contraparte "historial" de las alertas
// de error por email (Task #386). Persiste sólo en producción (gating en
// server/services/errorAlerts.ts) y con datos sensibles ya redactados.
//
// El índice único PARCIAL system_errors_open_fingerprint_idx (UNIQUE(fingerprint)
// WHERE status='open') garantiza como mucho una fila "abierta" por huella, y es
// lo que habilita el upsert atómico (INSERT ... ON CONFLICT) en
// storage.recordSystemError para agrupar repeticiones e incrementar el contador
// sin duplicar filas, incluso ante ráfagas concurrentes de errores idénticos.
//
// Idempotente: CREATE TABLE/INDEX IF NOT EXISTS. Compatible con entornos donde
// la tabla ya se creó manualmente; el marcador en _migrations evita reintentos.
export async function createSystemErrorsTable() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0025_system_errors' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: create system_errors table + indexes...');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS system_errors (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      fingerprint text NOT NULL,
      source text NOT NULL,
      message text NOT NULL,
      stack text,
      status_code integer,
      method text,
      path text,
      user_id varchar,
      user_email text,
      organization_id varchar,
      ip text,
      user_agent text,
      status text NOT NULL DEFAULT 'open',
      occurrence_count integer NOT NULL DEFAULT 1,
      first_seen_at timestamp NOT NULL DEFAULT now(),
      last_seen_at timestamp NOT NULL DEFAULT now(),
      resolved_by varchar,
      resolved_at timestamp
    )
  `);

  // Si una corrida anterior dejó un índice no-único equivalente, lo descartamos
  // para reemplazarlo por el único parcial.
  await db.execute(sql`DROP INDEX IF EXISTS system_errors_fingerprint_status_idx`);

  // Defensivo: si por una corrida previa (sin índice único) quedaron filas
  // "open" duplicadas por huella, conservamos la más reciente y archivamos las
  // demás para que CREATE UNIQUE INDEX no falle. No-op en tabla recién creada.
  await db.execute(sql`
    UPDATE system_errors
    SET status = 'archived'
    WHERE status = 'open'
      AND id NOT IN (
        SELECT DISTINCT ON (fingerprint) id
        FROM system_errors
        WHERE status = 'open'
        ORDER BY fingerprint, last_seen_at DESC
      )
  `);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS system_errors_open_fingerprint_idx
    ON system_errors (fingerprint) WHERE status = 'open'
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS system_errors_status_last_seen_idx
    ON system_errors (status, last_seen_at)
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0025_system_errors') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: system_errors table + indexes ready.');
}
