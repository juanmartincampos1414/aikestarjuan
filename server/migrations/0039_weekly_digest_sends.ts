import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #504/#506: idempotencia del resumen semanal. El deployment principal es
// Autoscale (escala a cero) y un node-cron in-process no se dispara confiable
// los lunes 6 AM. El envío se dispara ahora "al despertar" la app (ver
// startWeeklyDigestWakeTrigger en server/services/weeklyDigest.ts).
//
// Esta tabla registra una fila por (user_id, week_start) cuando se envía (o se
// reclama el envío de) el resumen de esa semana. Permite un patrón claim-first
// (INSERT ... ON CONFLICT DO NOTHING) para que un reintento del job, o una
// corrida accidental doble, no genere mails duplicados al mismo usuario.
//
// Idempotente: CREATE TABLE IF NOT EXISTS + marcador en _migrations.
export async function createWeeklyDigestSendsTable() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0039_weekly_digest_sends' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: create weekly_digest_sends table...');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS weekly_digest_sends (
      user_id varchar NOT NULL,
      week_start varchar NOT NULL,
      sent_at timestamptz NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, week_start)
    )
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0039_weekly_digest_sends') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: weekly_digest_sends table ready.');
}
